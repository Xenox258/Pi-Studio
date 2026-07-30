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

use crate::{errors::{StudioError, StudioResult}, startup::{self, StartupPhase}};
use super::protocol::{ChunkAssembler, OmpFrame, ParsedOmpFrame};

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<StudioResult<Value>>>>>;
type StartRegistry = SyncMutex<HashMap<String, Arc<Semaphore>>>;
type ProcessGeneration = Uuid;
type ProcessMap = HashMap<String, ProcessEntry<Arc<Mutex<OmpProcess>>>>;

struct ProcessEntry<T> {
    generation: ProcessGeneration,
    process: T,
}

struct LruEntry {
    session_id: String,
    generation: ProcessGeneration,
}

fn touch_generation(lru: &mut Vec<LruEntry>, session_id: &str, generation: ProcessGeneration) {
    lru.retain(|entry| entry.session_id != session_id);
    lru.push(LruEntry { session_id: session_id.to_owned(), generation });
}

fn register_generation<T>(processes: &mut HashMap<String, ProcessEntry<T>>, lru: &mut Vec<LruEntry>, session_id: String, generation: ProcessGeneration, process: T) {
    touch_generation(lru, &session_id, generation);
    processes.insert(session_id, ProcessEntry { generation, process });
}

fn remove_session<T>(processes: &mut HashMap<String, ProcessEntry<T>>, lru: &mut Vec<LruEntry>, session_id: &str) -> Option<ProcessEntry<T>> {
    let entry = processes.remove(session_id)?;
    lru.retain(|candidate| candidate.session_id != session_id || candidate.generation != entry.generation);
    Some(entry)
}

fn remove_generation<T>(processes: &mut HashMap<String, ProcessEntry<T>>, lru: &mut Vec<LruEntry>, session_id: &str, generation: ProcessGeneration) -> Option<ProcessEntry<T>> {
    let is_current = processes.get(session_id).is_some_and(|entry| entry.generation == generation);
    is_current.then(|| remove_session(processes, lru, session_id)).flatten()
}

async fn fail_pending(pending: &PendingMap, message: &str) {
    for (_, sender) in pending.lock().await.drain() {
        let _ = sender.send(Err(StudioError::OmpUnavailable(message.into())));
    }
}

async fn retire_generation(processes: &RwLock<ProcessMap>, lru: &Mutex<Vec<LruEntry>>, session_id: &str, generation: ProcessGeneration) -> Option<ProcessEntry<Arc<Mutex<OmpProcess>>>> {
    let mut processes = processes.write().await;
    let mut lru = lru.lock().await;
    remove_generation(&mut processes, &mut lru, session_id, generation)
}

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
    closed: bool,
}

#[derive(Default)]
pub struct OmpProcessManager {
    processes: Arc<RwLock<ProcessMap>>,
    policy: RwLock<ProcessPolicy>,
    lru: Arc<Mutex<Vec<LruEntry>>>,
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
    pub fn new(policy: ProcessPolicy) -> Self { Self { processes: Arc::new(RwLock::new(HashMap::new())), policy: RwLock::new(policy), lru: Arc::new(Mutex::new(Vec::new())), starting: StartRegistry::new(HashMap::new()) } }
    pub async fn set_policy(&self, policy: ProcessPolicy) {
        *self.policy.write().await = policy;
    }

    pub async fn active_count(&self) -> usize { self.processes.read().await.len() }

    async fn active_process(&self, session_id: &str) -> Option<(ProcessGeneration, Arc<Mutex<OmpProcess>>)> {
        let processes = self.processes.read().await;
        let entry = processes.get(session_id)?;
        let process = entry.process.clone();
        let generation = entry.generation;
        touch_generation(&mut *self.lru.lock().await, session_id, generation);
        Some((generation, process))
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
        if self.active_process(&session_id).await.is_some() { return Ok(()); }
        // The map above is only populated after the ~30s ready handshake, so a second attach for the
        // same session would spawn a second child; the two then contend and miss the ready deadline.
        let mut may_retry_failed_owner = true;
        let _starting = loop {
            match self.begin_start(&session_id) {
                Ok(guard) => break guard,
                Err(gate) => {
                    let _ = gate.acquire().await;
                    if self.active_process(&session_id).await.is_some() { return Ok(()); }
                    if may_retry_failed_owner {
                        may_retry_failed_owner = false;
                        continue;
                    }
                    return Err(StudioError::OmpUnavailable("concurrent OMP startup attempts failed".into()));
                }
            }
        };
        // Keep recently used sessions warm; evict the least-recently-used process when at capacity so
        // switching back to a recent session skips OMP's slow cold start.
        let capacity = self.policy.read().await.limit();
        while self.active_count().await >= capacity {
            let victim = self.lru.lock().await.first().map(|entry| entry.session_id.clone());
            match victim { Some(id) => self.stop(&id).await, None => break }
        }
        let canonical = project_path.canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
        if !canonical.is_dir() { return Err(StudioError::InvalidPath("project is not a directory".into())); }
        let mut command = Command::new("omp");
        command.args(["--mode", "rpc"]);
        if startup::enabled() { command.env("PI_DEBUG_STARTUP", "1"); }
        if advisor_enabled { command.arg("--advisor"); }
        if let Some(path) = resume_path {
            let session_file = path.canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
            if !session_file.is_file() { return Err(StudioError::InvalidPath("OMP session file does not exist".into())); }
            command.arg("--resume").arg(session_file);
        }
        let spawn = StartupPhase::begin("omp", "spawn");
        let mut child = match command.current_dir(canonical).kill_on_drop(true).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
            Ok(child) => { spawn.completed(); child }
            Err(error) => {
                let error = StudioError::OmpUnavailable(error.to_string());
                spawn.failed(&error);
                return Err(error);
            }
        };
        let stderr = child.stderr.take().ok_or_else(|| StudioError::OmpUnavailable("stderr unavailable".into()))?;
        let stderr_session_id = session_id.clone();
        tokio::spawn(async move {
            let mut stderr = BufReader::new(stderr);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match stderr.read_until(b'\n', &mut buffer).await {
                    Ok(0) => break,
                    Ok(_) => {
                        while matches!(buffer.last(), Some(b'\n' | b'\r')) { buffer.pop(); }
                        let line = String::from_utf8_lossy(&buffer);
                        if startup::relay_omp_startup_line(&stderr_session_id, &line) { continue; }
                        tracing::warn!(target: "omp_stderr", session_id = %stderr_session_id, "{}", line);
                    }
                    Err(error) => {
                        tracing::warn!(target: "omp_stderr", session_id = %stderr_session_id, %error, "failed to read OMP stderr");
                        break;
                    }
                }
            }
        });
        let stdin = child.stdin.take().ok_or_else(|| StudioError::OmpUnavailable("stdin unavailable".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| StudioError::OmpUnavailable("stdout unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = StartupPhase::begin("omp", "ready");
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
        }).await;
        let ready_raw = match ready_frame {
            Ok(Ok(Some(raw))) => { ready.completed(); raw }
            Ok(Ok(None)) => {
                let error = StudioError::OmpUnavailable("OMP exited before ready".into());
                ready.failed(&error);
                return Err(error);
            }
            Ok(Err(error)) => { ready.failed(&error); return Err(error.into()); }
            Err(_) => {
                let error = StudioError::Timeout("ready".into());
                ready.failed(&error);
                return Err(error);
            }
        };
        let supports_chunked_frames = ready_raw.get("supportedProtocolVersions").and_then(Value::as_array).is_some_and(|versions| versions.iter().any(|version| version.as_u64() == Some(PROTOCOL_VERSION)));
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let generation = Uuid::new_v4();
        let process = Arc::new(Mutex::new(OmpProcess { child, stdin, pending: pending.clone(), closed: false }));
        {
            let mut processes = self.processes.write().await;
            let mut lru = self.lru.lock().await;
            register_generation(&mut processes, &mut lru, session_id.clone(), generation, process.clone());
        }
        let read_pending = pending.clone();
        let read_process = process.clone();
        let read_processes = self.processes.clone();
        let read_lru = self.lru.clone();
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
            let _ = retire_generation(&read_processes, &read_lru, &read_session_id, generation).await;
            read_process.lock().await.closed = true;
            fail_pending(&read_pending, "OMP process closed").await;
        });
        // Without this handshake OMP stays on protocol v1, where any response above 1 MiB is
        // replaced by "RPC response exceeded the transport limit" — long transcripts never load.
        if supports_chunked_frames {
            let negotiation = StartupPhase::begin("omp", "protocol-negotiation");
            match self.request(&session_id, json!({ "type": "negotiate_protocol", "protocolVersion": PROTOCOL_VERSION }), NEGOTIATE_TIMEOUT).await {
                Ok(_) => negotiation.completed(),
                Err(error) => {
                    negotiation.failed(&error);
                    tracing::warn!(%error, "OMP refused chunked frames; large transcripts may not load");
                }
            }
        }
        Ok(())
    }

    pub async fn request(&self, session_id: &str, mut payload: Value, deadline: Duration) -> StudioResult<Value> {
        let (_, process) = self.active_process(session_id).await.ok_or_else(|| StudioError::InvalidInput("session is not active".into()))?;
        let id = payload.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        payload["id"] = json!(id);
        let (sender, receiver) = oneshot::channel();
        let mut process_guard = process.lock().await;
        if process_guard.closed { return Err(StudioError::OmpUnavailable("OMP process closed".into())); }
        let pending = process_guard.pending.clone();
        pending.lock().await.insert(id.clone(), sender);
        let mut frame = serde_json::to_vec(&payload)?; frame.push(b'\n');
        if let Err(error) = process_guard.stdin.write_all(&frame).await { pending.lock().await.remove(&id); return Err(error.into()); }
        if let Err(error) = process_guard.stdin.flush().await { pending.lock().await.remove(&id); return Err(error.into()); }
        drop(process_guard);
        match timeout(deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(StudioError::OmpUnavailable("response channel closed".into())),
            Err(_) => { pending.lock().await.remove(&id); Err(StudioError::Timeout(payload.get("type").and_then(Value::as_str).unwrap_or("request").into())) }
        }
    }

    pub async fn stop(&self, session_id: &str) {
        let entry = {
            let mut processes = self.processes.write().await;
            let mut lru = self.lru.lock().await;
            remove_session(&mut processes, &mut lru, session_id)
        };
        if let Some(entry) = entry {
            let mut process = entry.process.lock().await;
            process.closed = true;
            fail_pending(&process.pending, "session stopped").await;
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

    #[tokio::test]
    async fn reader_close_retires_generation_fails_pending_and_allows_respawn() {
        let generation = Uuid::from_u128(1);
        let replacement_generation = Uuid::from_u128(2);
        let mut processes = HashMap::new();
        let mut lru = Vec::new();
        register_generation(&mut processes, &mut lru, "session".into(), generation, "closed");

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert("request".into(), sender);

        let removed = remove_generation(&mut processes, &mut lru, "session", generation);
        fail_pending(&pending, "OMP process closed").await;

        assert_eq!(removed.map(|entry| entry.process), Some("closed"));
        assert!(processes.is_empty(), "the closed generation is no longer active");
        assert!(lru.is_empty(), "the closed generation is no longer an eviction candidate");
        match receiver.await.expect("the pending request receives a result") {
            Err(StudioError::OmpUnavailable(message)) => assert_eq!(message, "OMP process closed"),
            other => panic!("unexpected pending result: {other:?}"),
        }

        register_generation(&mut processes, &mut lru, "session".into(), replacement_generation, "replacement");
        assert_eq!(processes.get("session").map(|entry| entry.process), Some("replacement"));
        assert_eq!(lru.len(), 1);
        assert_eq!(lru[0].generation, replacement_generation);
    }

    #[test]
    fn stale_reader_cannot_remove_child_registered_after_clean_stop() {
        let old_generation = Uuid::from_u128(1);
        let new_generation = Uuid::from_u128(2);
        let mut processes = HashMap::new();
        let mut lru = Vec::new();
        register_generation(&mut processes, &mut lru, "session".into(), old_generation, "old");

        let stopped = remove_session(&mut processes, &mut lru, "session");
        assert_eq!(stopped.map(|entry| entry.process), Some("old"));
        assert!(lru.is_empty(), "clean stop removes its LRU generation");

        register_generation(&mut processes, &mut lru, "session".into(), new_generation, "new");
        assert!(remove_generation(&mut processes, &mut lru, "session", old_generation).is_none());
        let current = processes.get("session").expect("the replacement remains active");
        assert_eq!(current.generation, new_generation);
        assert_eq!(current.process, "new");
        assert_eq!(lru.len(), 1);
        assert_eq!(lru[0].generation, new_generation);
    }
}
