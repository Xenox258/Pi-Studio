use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

use parking_lot::Mutex as SyncMutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock, Semaphore},
    time::timeout,
};
use uuid::Uuid;

use crate::errors::{StudioError, StudioResult};
use super::protocol::{ChunkAssembler, OmpFrame, ParsedOmpFrame};

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<StudioResult<Value>>>>>;
type StartRegistry = SyncMutex<HashMap<String, Arc<Semaphore>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OmpEventPayload<'a> {
    session_id: &'a str,
    raw: &'a Value,
}

fn emit_frame(app: &AppHandle, session_id: &str, frame: &ParsedOmpFrame) {
    let _ = app.emit("omp-frame", OmpEventPayload { session_id, raw: &frame.raw });
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProcessPolicy {
    #[default]
    Economy,
    Balanced,
    Parallel { max_processes: usize },
}

impl ProcessPolicy {
    fn limit(&self) -> usize {
        match self { Self::Economy => 2, Self::Balanced => 3, Self::Parallel { max_processes } => (*max_processes).max(2) }
    }
}

pub struct OmpProcess {
    child: Child,
    stdin: ChildStdin,
    pending: PendingMap,
}

#[derive(Default)]
pub struct OmpProcessManager {
    processes: RwLock<HashMap<String, Arc<Mutex<OmpProcess>>>>,
    policy: RwLock<ProcessPolicy>,
    lru: Mutex<Vec<String>>,
    starting: StartRegistry,
}

// Clearing the marker from Drop covers every exit path out of `start`, including the `?` returns and
// the ready timeout, so a boot that fails cannot wedge later attempts on the same session id.
struct StartGuard<'a> { registry: &'a StartRegistry, session_id: String, gate: Arc<Semaphore> }

impl Drop for StartGuard<'_> {
    fn drop(&mut self) { self.registry.lock().remove(&self.session_id); self.gate.close(); }
}

// OMP can spend 40s+ loading extensions on a cold start, and resuming a session additionally
// replays its transcript before emitting `ready`. A short deadline here surfaces as
// "unable to resume session" on the client, so we allow a generous startup window.
const READY_TIMEOUT: Duration = Duration::from_secs(300);

// Protocol v2 adds `rpc_chunk` framing, lifting the effective response ceiling from 1 MiB to 64 MiB.
const PROTOCOL_VERSION: u64 = 2;
const NEGOTIATE_TIMEOUT: Duration = Duration::from_secs(10);

impl OmpProcessManager {
    pub fn new(policy: ProcessPolicy) -> Self { Self { processes: RwLock::new(HashMap::new()), policy: RwLock::new(policy), lru: Mutex::new(Vec::new()), starting: StartRegistry::new(HashMap::new()) } }
    pub async fn set_policy(&self, policy: ProcessPolicy) {
        *self.policy.write().await = policy;
    }

    pub async fn active_count(&self) -> usize { self.processes.read().await.len() }

    async fn touch(&self, session_id: &str) {
        let mut lru = self.lru.lock().await;
        lru.retain(|id| id != session_id);
        lru.push(session_id.to_owned());
    }

    // Claims the boot for `session_id`, or hands back the gate of the boot already in flight; the gate
    // holds no permits and only releases its waiters once the owning guard closes it.
    fn begin_start(&self, session_id: &str) -> Result<StartGuard<'_>, Arc<Semaphore>> {
        let mut starting = self.starting.lock();
        if let Some(gate) = starting.get(session_id) { return Err(gate.clone()); }
        let gate = Arc::new(Semaphore::new(0));
        starting.insert(session_id.to_owned(), gate.clone());
        Ok(StartGuard { registry: &self.starting, session_id: session_id.to_owned(), gate })
    }

    pub async fn start(&self, app: AppHandle, session_id: String, project_path: &Path, resume_path: Option<&Path>, advisor_enabled: bool) -> StudioResult<()> {
        if self.processes.read().await.contains_key(&session_id) { self.touch(&session_id).await; return Ok(()); }
        // The map above is only populated after the ~30s ready handshake, so a second attach for the
        // same session would spawn a second child; the two then contend and miss the ready deadline.
        let _starting = match self.begin_start(&session_id) {
            Ok(guard) => guard,
            Err(gate) => { let _ = gate.acquire().await; return if self.processes.read().await.contains_key(&session_id) { self.touch(&session_id).await; Ok(()) } else { Err(StudioError::OmpUnavailable("the session failed to start".into())) }; }
        };
        // Keep recently used sessions warm; evict the least-recently-used process when at capacity so
        // switching back to a recent session skips OMP's slow cold start.
        let capacity = self.policy.read().await.limit();
        while self.active_count().await >= capacity {
            let victim = self.lru.lock().await.first().cloned();
            match victim { Some(id) => self.stop(&id).await, None => break }
        }
        let canonical = project_path.canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
        if !canonical.is_dir() { return Err(StudioError::InvalidPath("project is not a directory".into())); }
        let mut command = Command::new("omp");
        command.args(["--mode", "rpc"]);
        if advisor_enabled { command.arg("--advisor"); }
        if let Some(path) = resume_path {
            let session_file = path.canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
            if !session_file.is_file() { return Err(StudioError::InvalidPath("OMP session file does not exist".into())); }
            command.arg("--resume").arg(session_file);
        }
        let mut child = command.current_dir(canonical).kill_on_drop(true).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| StudioError::OmpUnavailable("stdin unavailable".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| StudioError::OmpUnavailable("stdout unavailable".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| StudioError::OmpUnavailable("stderr unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        let ready_frame = timeout(READY_TIMEOUT, async {
            while let Some(line) = lines.next_line().await? {
                if let Ok(frame) = ParsedOmpFrame::parse(&line) {
                    let is_ready = frame.is_ready();
                    let raw = frame.raw.clone();
                    emit_frame(&app, &session_id, &frame);
                    if is_ready { return Ok::<Option<Value>, std::io::Error>(Some(raw)); }
                }
            }
            Ok(None)
        }).await.map_err(|_| StudioError::Timeout("ready".into()))??;
        let Some(ready_raw) = ready_frame else { return Err(StudioError::OmpUnavailable("OMP exited before ready".into())); };
        let supports_chunked_frames = ready_raw.get("supportedProtocolVersions").and_then(Value::as_array).is_some_and(|versions| versions.iter().any(|version| version.as_u64() == Some(PROTOCOL_VERSION)));
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let read_pending = pending.clone();
        let read_app = app.clone();
        let read_session_id = session_id.clone();
        tokio::spawn(async move {
            let mut assembler = ChunkAssembler::default();
            while let Ok(Some(line)) = lines.next_line().await {
                let raw: Value = match serde_json::from_str(&line) {
                    Ok(raw) => raw,
                    Err(error) => { tracing::warn!(%error, "ignored malformed OMP stdout line"); continue }
                };
                let raw = match assembler.push(raw) {
                    Ok(Some(raw)) => raw,
                    Ok(None) => continue,
                    Err(error) => { tracing::warn!(%error, "dropped OMP chunk sequence"); continue }
                };
                let frame = ParsedOmpFrame::from_value(raw);
                if let OmpFrame::Response { id: Some(id), success, data, error, .. } = &frame.typed {
                    if let Some(sender) = read_pending.lock().await.remove(id) {
                        let response = if *success { Ok(data.clone().unwrap_or(Value::Null)) } else { Err(StudioError::Omp(error.clone().unwrap_or_else(|| "unknown OMP error".into()))) };
                        let _ = sender.send(response);
                    }
                }
                emit_frame(&read_app, &read_session_id, &frame);
            }
            for (_, sender) in read_pending.lock().await.drain() { let _ = sender.send(Err(StudioError::OmpUnavailable("OMP process closed".into()))); }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await { tracing::warn!(target: "omp_stderr", "{}", line); }
        });
        self.touch(&session_id).await;
        self.processes.write().await.insert(session_id.clone(), Arc::new(Mutex::new(OmpProcess { child, stdin, pending })));
        // Without this handshake OMP stays on protocol v1, where any response above 1 MiB is
        // replaced by "RPC response exceeded the transport limit" — long transcripts never load.
        if supports_chunked_frames {
            if let Err(error) = self.request(&session_id, json!({ "type": "negotiate_protocol", "protocolVersion": PROTOCOL_VERSION }), NEGOTIATE_TIMEOUT).await {
                tracing::warn!(%error, "OMP refused chunked frames; large transcripts may not load");
            }
        }
        Ok(())
    }

    pub async fn request(&self, session_id: &str, mut payload: Value, deadline: Duration) -> StudioResult<Value> {
        let process = self.processes.read().await.get(session_id).cloned().ok_or_else(|| StudioError::InvalidInput("session is not active".into()))?;
        self.touch(session_id).await;
        let id = payload.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        payload["id"] = json!(id);
        let (sender, receiver) = oneshot::channel();
        let mut process = process.lock().await;
        process.pending.lock().await.insert(id.clone(), sender);
        let mut frame = serde_json::to_vec(&payload)?; frame.push(b'\n');
        if let Err(error) = process.stdin.write_all(&frame).await { process.pending.lock().await.remove(&id); return Err(error.into()); }
        process.stdin.flush().await?;
        drop(process);
        match timeout(deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(StudioError::OmpUnavailable("response channel closed".into())),
            Err(_) => { if let Some(process) = self.processes.read().await.get(session_id).cloned() { process.lock().await.pending.lock().await.remove(&id); } Err(StudioError::Timeout(payload.get("type").and_then(Value::as_str).unwrap_or("request").into())) }
        }
    }

    pub async fn stop(&self, session_id: &str) {
        self.lru.lock().await.retain(|id| id != session_id);
        if let Some(process) = self.processes.write().await.remove(session_id) {
            let mut process = process.lock().await;
            for (_, sender) in process.pending.lock().await.drain() { let _ = sender.send(Err(StudioError::OmpUnavailable("session stopped".into()))); }
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
        }
    }

    pub async fn stop_all(&self) {
        let sessions: Vec<String> = self.processes.read().await.keys().cloned().collect();
        for session in sessions { self.stop(&session).await; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn start_is_single_flight_per_session() {
        let manager = OmpProcessManager::default();
        let Ok(booting) = manager.begin_start("a") else { panic!("the first caller owns the boot") };
        let Err(gate) = manager.begin_start("a") else { panic!("a concurrent caller must see the boot in flight") };
        assert!(manager.begin_start("b").is_ok(), "a different session id boots in parallel");
        drop(booting);
        assert!(gate.acquire().await.is_err(), "finishing the boot releases the waiter");
        assert!(manager.begin_start("a").is_ok(), "a finished boot leaves no marker behind");
    }
}
