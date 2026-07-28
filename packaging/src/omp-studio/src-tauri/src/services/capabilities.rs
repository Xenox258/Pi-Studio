use serde::Serialize;
use tokio::process::Command;

use crate::errors::{StudioError, StudioResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpCapabilities {
    pub version: Option<String>, pub rpc: bool, pub workflow_mode_control: bool, pub advisor_control: bool, pub login_control: bool, pub extension_ui: bool, pub subagent_events: bool, pub usage_cli_json: bool, pub usage_rpc_read: bool, pub usage_rpc_reset: bool, pub usage_events: bool,
}

pub async fn detect() -> StudioResult<OmpCapabilities> {
    let version = output(&["--version"]).await?;
    let help = output(&["--help"]).await.unwrap_or_default();
    let usage_help = output(&["usage", "--help"]).await.unwrap_or_default();
    let combined = format!("{help}\n{usage_help}").to_lowercase();
    Ok(OmpCapabilities {
        version: Some(version), rpc: combined.contains("rpc") || help.contains("--mode"),
        workflow_mode_control: combined.contains("set_workflow_mode") || combined.contains("workflow mode"),
        advisor_control: combined.contains("advisor"), login_control: combined.contains("login"),
        extension_ui: combined.contains("extension"), subagent_events: combined.contains("subagent"),
        usage_cli_json: usage_help.contains("--json"), usage_rpc_read: combined.contains("get_usage"),
        usage_rpc_reset: combined.contains("consume_usage_reset"), usage_events: combined.contains("usage_updated"),
    })
}

async fn output(args: &[&str]) -> StudioResult<String> {
    let output = Command::new("omp").args(args).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
    if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
