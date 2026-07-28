use std::{sync::Arc, time::{Duration, Instant}};

use serde_json::{json, Value};
use tokio::{process::Command, sync::RwLock};

use crate::{errors::{StudioError, StudioResult}, omp::manager::OmpProcessManager};
use super::domain::{parse_snapshot, ConsumeResetOutcome, ConsumeResetRequest, UsageSnapshot, UsageSource};

pub struct UsageService {
    manager: Arc<OmpProcessManager>,
    cache: RwLock<Option<(Instant, UsageSnapshot)>>,
}

impl UsageService {
    pub fn new(manager: Arc<OmpProcessManager>) -> Self { Self { manager, cache: RwLock::new(None) } }

    pub async fn get(&self, session_id: Option<&str>, force_refresh: bool) -> StudioResult<UsageSnapshot> {
        if !force_refresh {
            if let Some((fetched, snapshot)) = &*self.cache.read().await {
                if fetched.elapsed() < Duration::from_secs(30) { let mut cached = snapshot.clone(); cached.source = UsageSource::Cache; return Ok(cached); }
            }
        }
        let rpc_read = rpc_usage_support().await.0;
        let (value, source) = if let Some(session_id) = session_id.filter(|_| rpc_read) {
            let value = self.manager.request(session_id, json!({ "type": "get_usage", "forceRefresh": force_refresh }), Duration::from_secs(20)).await?;
            (extract_snapshot(value)?, UsageSource::OmpRpc)
        } else {
            if force_refresh {
                let invalidation = Command::new("omp").args(["usage", "invalidate"]).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
                if !invalidation.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&invalidation.stderr).trim().to_owned())); }
            }
            let output = Command::new("omp").args(["usage", "--json"]).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
            if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
            (serde_json::from_slice(&output.stdout)?, UsageSource::OmpCli)
        };
        let snapshot = parse_snapshot(value, source)?;
        *self.cache.write().await = Some((Instant::now(), snapshot.clone()));
        Ok(snapshot)
    }

    pub async fn consume_reset(&self, session_id: &str, request: &ConsumeResetRequest) -> StudioResult<ConsumeResetOutcome> {
        request.validate()?;
        if !rpc_usage_support().await.1 { return Err(StudioError::Omp("Installed OMP does not expose RPC reset support".into())); }
        let value = self.manager.request(session_id, json!({ "type": "consume_usage_reset", "providerId": "openai-codex", "credentialId": request.credential_id, "creditId": request.credit_id, "idempotencyKey": request.idempotency_key }), Duration::from_secs(30)).await?;
        *self.cache.write().await = None;
        let outcome = value.get("outcome").and_then(Value::as_str).or_else(|| value.as_str()).ok_or_else(|| StudioError::Protocol("reset response is missing outcome".into()))?;
        match outcome { "reset" => Ok(ConsumeResetOutcome::Reset), "already_redeemed" | "alreadyRedeemed" => Ok(ConsumeResetOutcome::AlreadyRedeemed), "nothing_to_reset" | "nothingToReset" => Ok(ConsumeResetOutcome::NothingToReset), "no_credit" | "noCredit" => Ok(ConsumeResetOutcome::NoCredit), other => Err(StudioError::Protocol(format!("unknown reset outcome: {other}"))) }
    }
}

fn extract_snapshot(value: Value) -> StudioResult<Value> {
    if let Some(snapshot) = value.get("snapshot") { Ok(snapshot.clone()) } else if value.get("providers").is_some() { Ok(value) } else { Err(StudioError::Protocol("usage response does not contain a snapshot".into())) }
}

async fn rpc_usage_support() -> (bool, bool) {
    let output = match Command::new("omp").args(["usage", "--help"]).output().await { Ok(output) if output.status.success() => output, _ => return (false, false) };
    let help = String::from_utf8_lossy(&output.stdout);
    (help.contains("get_usage"), help.contains("consume_usage_reset"))
}
