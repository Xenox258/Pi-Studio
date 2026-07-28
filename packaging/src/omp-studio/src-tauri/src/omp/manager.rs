use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::timeout,
};
use uuid::Uuid;

use crate::errors::{StudioError, StudioResult};
use super::protocol::{OmpFrame, ParsedOmpFrame};

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<StudioResult<Value>>>>>;

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
        match self { Self::Economy => 1, Self::Balanced => 2, Self::Parallel { max_processes } => (*max_processes).max(1) }
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
}

impl OmpProcessManager {
    pub fn new(policy: ProcessPolicy) -> Self { Self { processes: RwLock::new(HashMap::new()), policy: RwLock::new(policy) } }
    pub async fn set_policy(&self, policy: ProcessPolicy) {
        *self.policy.write().await = policy;
    }

    pub async fn active_count(&self) -> usize { self.processes.read().await.len() }

    pub async fn start(&self, app: AppHandle, session_id: String, project_path: &Path) -> StudioResult<()> {
        if self.processes.read().await.contains_key(&session_id) { return Ok(()); }
        let policy = self.policy.read().await.clone();
        if matches!(policy, ProcessPolicy::Economy) { self.stop_all().await; }
        if self.active_count().await >= policy.limit() {
            return Err(StudioError::InvalidInput(format!("process limit ({}) reached", policy.limit())));
        }
        let canonical = project_path.canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
        if !canonical.is_dir() { return Err(StudioError::InvalidPath("project is not a directory".into())); }
        let mut child = Command::new("omp").arg("--mode").arg("rpc").current_dir(canonical).kill_on_drop(true).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| StudioError::OmpUnavailable("stdin unavailable".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| StudioError::OmpUnavailable("stdout unavailable".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| StudioError::OmpUnavailable("stderr unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = timeout(Duration::from_secs(10), async {
            while let Some(line) = lines.next_line().await? {
                if let Ok(frame) = ParsedOmpFrame::parse(&line) {
                    let _ = app.emit("omp-frame", &frame);
                    if frame.is_ready() { return Ok::<bool, std::io::Error>(true); }
                }
            }
            Ok(false)
        }).await.map_err(|_| StudioError::Timeout("ready".into()))??;
        if !ready { return Err(StudioError::OmpUnavailable("OMP exited before ready".into())); }
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let read_pending = pending.clone();
        let read_app = app.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                match ParsedOmpFrame::parse(&line) {
                    Ok(frame) => {
                        if let OmpFrame::Response { id: Some(id), success, data, error, .. } = &frame.typed {
                            if let Some(sender) = read_pending.lock().await.remove(id) {
                                let response = if *success { Ok(data.clone().unwrap_or(Value::Null)) } else { Err(StudioError::Omp(error.clone().unwrap_or_else(|| "unknown OMP error".into()))) };
                                let _ = sender.send(response);
                            }
                        }
                        let _ = read_app.emit("omp-frame", frame);
                    }
                    Err(error) => tracing::warn!(%error, "ignored malformed OMP stdout line"),
                }
            }
            for (_, sender) in read_pending.lock().await.drain() { let _ = sender.send(Err(StudioError::OmpUnavailable("OMP process closed".into()))); }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await { tracing::warn!(target: "omp_stderr", "{}", line); }
        });
        self.processes.write().await.insert(session_id, Arc::new(Mutex::new(OmpProcess { child, stdin, pending })));
        Ok(())
    }

    pub async fn request(&self, session_id: &str, mut payload: Value, deadline: Duration) -> StudioResult<Value> {
        let process = self.processes.read().await.get(session_id).cloned().ok_or_else(|| StudioError::InvalidInput("session is not active".into()))?;
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
