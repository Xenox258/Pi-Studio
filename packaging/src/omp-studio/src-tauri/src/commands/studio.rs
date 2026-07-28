use std::{collections::{hash_map::DefaultHasher, HashSet}, hash::{Hash, Hasher}, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    errors::{command_result, StudioError, StudioResult},
    omp::manager::ProcessPolicy,
    services::{capabilities::{self, OmpCapabilities}, catalog::{CatalogMarketplace, CatalogPackage}, git::{self, GitSnapshot}, github::GithubSnapshot, models::{self, OmpModel, OmpProvider}},
    state::AppState,
    storage::database::{ResetAttempt, StoredProject, StoredSession},
    usage::domain::{ConsumeResetOutcome, ConsumeResetRequest, UsageSnapshot},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary { pub id: String, pub name: String, pub path: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleMapping { pub id: String, pub label: String, pub description: String, pub model: String, pub thinking: String, pub tone: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StudioSettings { pub process_policy: String, pub suspend_background: bool, pub cache_limit_mb: u32, pub onboarding_completed: bool }

impl Default for StudioSettings { fn default() -> Self { Self { process_policy: "Economy".into(), suspend_background: true, cache_limit_mb: 100, onboarding_completed: false } } }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStats { pub active_processes: usize }

#[tauri::command]
pub async fn detect_omp_capabilities() -> Result<OmpCapabilities, String> { command_result(capabilities::detect().await) }

#[tauri::command]
pub fn get_studio_settings(state: State<'_, AppState>) -> Result<StudioSettings, String> { command_result(state.database.get_json("global", "studioSettings").map(|value| value.unwrap_or_default())) }

#[tauri::command]
pub async fn save_studio_settings(settings: StudioSettings, state: State<'_, AppState>) -> Result<(), String> {
    if !matches!(settings.process_policy.as_str(), "Economy" | "Balanced" | "Parallel") || !matches!(settings.cache_limit_mb, 50 | 100 | 200) { return Err("Invalid settings".into()); }
    let policy = match settings.process_policy.as_str() { "Economy" => ProcessPolicy::Economy, "Balanced" => ProcessPolicy::Balanced, _ => ProcessPolicy::Parallel { max_processes: 4 } };
    state.manager.set_policy(policy).await; command_result(state.database.put_json("global", "studioSettings", &settings).and_then(|_| state.database.prune_caches(settings.cache_limit_mb)))
}

#[tauri::command]
pub async fn runtime_stats(state: State<'_, AppState>) -> Result<RuntimeStats, String> { Ok(RuntimeStats { active_processes: state.manager.active_count().await }) }

#[tauri::command]
pub async fn catalog_packages(mode: String, state: State<'_, AppState>) -> Result<Vec<CatalogPackage>, String> { command_result(state.catalog.list(&mode).await) }

#[tauri::command]
pub async fn catalog_marketplaces(state: State<'_, AppState>) -> Result<Vec<CatalogMarketplace>, String> { command_result(state.catalog.marketplaces().await) }

#[tauri::command]
pub async fn add_catalog_marketplace(source: String, state: State<'_, AppState>) -> Result<(), String> { command_result(state.catalog.add_marketplace(&source).await) }

#[tauri::command]
pub async fn available_models() -> Result<Vec<OmpModel>, String> { command_result(models::available().await) }

#[tauri::command]
pub async fn available_providers() -> Result<Vec<OmpProvider>, String> { command_result(models::available_providers().await) }

#[tauri::command]
pub fn open_project(path: String, state: State<'_, AppState>) -> Result<ProjectSummary, String> { command_result(open_project_inner(path, &state)) }
fn open_project_inner(path: String, state: &AppState) -> StudioResult<ProjectSummary> {
    let canonical = Path::new(&path).canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
    if !canonical.is_dir() { return Err(StudioError::InvalidPath("project is not a directory".into())); }
    let name = canonical.file_name().and_then(|value| value.to_str()).ok_or_else(|| StudioError::InvalidPath("project has no valid name".into()))?.to_owned();
    let path = canonical.to_string_lossy().into_owned(); let mut hasher = DefaultHasher::new(); path.hash(&mut hasher); let id = format!("project-{:x}", hasher.finish());
    state.database.save_project(&id, &name, &path)?; Ok(ProjectSummary { id, name, path })
}

#[tauri::command]
pub fn recent_projects(state: State<'_, AppState>) -> Result<Vec<StoredProject>, String> { command_result(state.database.recent_projects()) }

#[tauri::command]
pub async fn recent_sessions(state: State<'_, AppState>) -> Result<Vec<StoredSession>, String> { let active = state.active_session.read().await; command_result(state.database.recent_sessions(active.as_deref())) }

#[tauri::command]
pub async fn start_session(app: AppHandle, project_id: String, project_path: String, state: State<'_, AppState>) -> Result<String, String> {
    if project_id.trim().is_empty() { return Err("Invalid project id".into()); }
    let title = Path::new(&project_path).file_name().and_then(|value| value.to_str()).ok_or_else(|| "Project path has no valid name".to_string())?.to_owned();
    let session_id = Uuid::new_v4().to_string(); command_result(state.manager.start(app, session_id.clone(), Path::new(&project_path)).await)?;
    if let Err(error) = state.database.save_session(&session_id, &project_id, &title) { state.manager.stop(&session_id).await; return Err(error.to_string()); }
    *state.active_session.write().await = Some(session_id.clone()); Ok(session_id)
}

#[tauri::command]
pub async fn stop_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> { state.manager.stop(&session_id).await; let mut active = state.active_session.write().await; if active.as_deref() == Some(&session_id) { *active = None; } Ok(()) }

#[tauri::command]
pub async fn send_prompt(session_id: String, message: String, state: State<'_, AppState>) -> Result<(), String> {
    if message.trim().is_empty() || message.len() > 200_000 { return Err("Prompt must contain between 1 and 200000 characters".into()); }
    command_result(state.manager.request(&session_id, json!({ "type": "prompt", "message": message }), Duration::from_secs(300)).await).map(|_| ())
}

#[tauri::command]
pub async fn steer_prompt(session_id: String, message: String, state: State<'_, AppState>) -> Result<(), String> { send_interaction(&session_id, &message, "steer", &state).await }

#[tauri::command]
pub async fn follow_up_prompt(session_id: String, message: String, state: State<'_, AppState>) -> Result<(), String> { send_interaction(&session_id, &message, "follow_up", &state).await }

async fn send_interaction(session_id: &str, message: &str, kind: &str, state: &AppState) -> Result<(), String> {
    if message.trim().is_empty() || message.len() > 200_000 { return Err("Message must contain between 1 and 200000 characters".into()); }
    command_result(state.manager.request(session_id, json!({ "type": kind, "message": message }), Duration::from_secs(300)).await).map(|_| ())
}

#[tauri::command]
pub async fn stop_run(session_id: String, state: State<'_, AppState>) -> Result<(), String> { command_result(state.manager.request(&session_id, json!({ "type": "abort" }), Duration::from_secs(10)).await).map(|_| ()) }

#[tauri::command]
pub async fn set_workflow_mode(session_id: String, mode: String, state: State<'_, AppState>) -> Result<(), String> {
    if !matches!(mode.as_str(), "plan" | "build") { return Err("Unsupported workflow mode".into()); }
    let _ = (session_id, state);
    Err("The installed OMP RPC protocol does not support changing workflow mode during a session.".into())
}

#[tauri::command]
pub async fn set_advisor_enabled(session_id: String, enabled: bool, state: State<'_, AppState>) -> Result<(), String> { command_result(state.manager.request(&session_id, json!({ "type": "prompt", "message": if enabled { "/advisor on" } else { "/advisor off" } }), Duration::from_secs(10)).await).map(|_| ()) }

#[tauri::command]
pub async fn set_model(session_id: String, model: String, state: State<'_, AppState>) -> Result<(), String> {
    if model.trim().is_empty() || model.len() > 256 || model.chars().any(char::is_control) { return Err("Invalid model".into()); }
    let (provider, model_id) = model.split_once('/').filter(|(provider, model_id)| !provider.is_empty() && !model_id.is_empty()).ok_or_else(|| "Model must use provider/model-id format".to_string())?;
    command_result(state.manager.request(&session_id, json!({ "type": "set_model", "provider": provider, "modelId": model_id }), Duration::from_secs(10)).await).map(|_| ())
}

#[tauri::command]
pub async fn set_thinking_level(session_id: String, level: String, state: State<'_, AppState>) -> Result<(), String> {
    let normalized = match level.as_str() { "Off" => "off", "Minimal" => "minimal", "Low" => "low", "Medium" => "medium", "High" => "high", "Very High" => "xhigh", "Max" => "max", _ => return Err("Unsupported thinking level".into()) };
    command_result(state.manager.request(&session_id, json!({ "type": "set_thinking_level", "level": normalized }), Duration::from_secs(10)).await).map(|_| ())
}

#[tauri::command]
pub async fn usage_get_snapshot(session_id: Option<String>, force_refresh: bool, state: State<'_, AppState>) -> Result<UsageSnapshot, String> { command_result(state.usage.get(session_id.as_deref(), force_refresh).await) }

#[tauri::command]
pub async fn usage_consume_reset(request: ConsumeResetRequest, state: State<'_, AppState>) -> Result<ConsumeResetOutcome, String> {
    request.validate().map_err(|error| error.to_string())?;
    match state.database.begin_reset(&request.idempotency_key, &request.credential_id, &request.credit_id).map_err(|error| error.to_string())? {
        ResetAttempt::Completed(outcome) => return parse_outcome(&outcome),
        ResetAttempt::Pending => return Err("A reset with this idempotency key is already in progress".into()),
        ResetAttempt::New => {}
    }
    let session = match state.active_session.read().await.clone() { Some(session) => session, None => { let _ = state.database.cancel_reset(&request.idempotency_key); return Err("An active OMP session is required to consume a reset".into()); } };
    let outcome = match state.usage.consume_reset(&session, &request).await { Ok(outcome) => outcome, Err(error) => { let _ = state.database.cancel_reset(&request.idempotency_key); return Err(error.to_string()); } };
    let label = outcome_label(&outcome); state.database.finish_reset(&request.idempotency_key, label).map_err(|error| error.to_string())?; Ok(outcome)
}

#[tauri::command]
pub fn get_role_mappings(scope: String, state: State<'_, AppState>) -> Result<Vec<RoleMapping>, String> {
    validate_scope(&scope)?;
    let scoped = state.database.get_json(&scope, "roles").map_err(|error| error.to_string())?;
    if let Some(roles) = scoped { return Ok(roles); }
    if scope != "global" { if let Some(roles) = state.database.get_json("global", "roles").map_err(|error| error.to_string())? { return Ok(roles); } }
    Ok(default_roles())
}

#[tauri::command]
pub fn save_role_mappings(scope: String, roles: Vec<RoleMapping>, state: State<'_, AppState>) -> Result<(), String> {
    validate_scope(&scope)?;
    if roles.is_empty() || roles.len() > 64 { return Err("Role mappings must contain between 1 and 64 roles".into()); }
    let mut ids = HashSet::with_capacity(roles.len());
    for role in &roles {
        if !ids.insert(role.id.as_str()) || [&role.id, &role.label, &role.description, &role.model, &role.thinking].iter().any(|value| value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control)) { return Err("Role mappings are invalid or contain duplicate ids".into()); }
        if !matches!(role.thinking.as_str(), "Off" | "Minimal" | "Low" | "Medium" | "High" | "Very High" | "Max") { return Err("Unsupported thinking level".into()); }
    }
    command_result(state.database.put_json(&scope, "roles", &roles))
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if scope == "global" { return Ok(()); }
    let suffix = scope.strip_prefix("project:").or_else(|| scope.strip_prefix("session:"));
    if suffix.is_some_and(|value| !value.is_empty() && value.len() <= 128 && value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))) { Ok(()) } else { Err("Invalid role scope".into()) }
}

#[tauri::command]
pub async fn git_snapshot(project_path: String) -> Result<GitSnapshot, String> { command_result(git::snapshot(&project_path).await) }

#[tauri::command]
pub async fn github_snapshot(project_path: String, state: State<'_, AppState>) -> Result<GithubSnapshot, String> { command_result(state.github.snapshot(&project_path).await) }

#[tauri::command]
pub async fn git_diff(project_path: String, file_path: String) -> Result<String, String> { command_result(git::diff(&project_path, &file_path).await) }

#[tauri::command]
pub fn read_project_file(project_path: String, file_path: String) -> Result<String, String> { command_result(git::read_file(&project_path, &file_path)) }

#[tauri::command]
pub async fn provider_login(provider_id: String) -> Result<(), String> {
    let provider = validate_provider_id(&provider_id)?;
    broker_login(provider).await
}

/// `omp auth-broker login` is an interactive OAuth flow: it prints an authorization URL, boots a
/// localhost callback server, then blocks on a readline paste fallback. We must keep stdin open
/// (otherwise the readline aborts with `ERR_USE_AFTER_CLOSE` before the browser can redirect),
/// surface the URL in the user's browser, and wait for the callback server to complete the login.
async fn broker_login(provider: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let mut child = Command::new("omp")
        .args(["auth-broker", "login", provider])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let _stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| "OMP broker login produced no output".to_string())?;
    let mut stderr_handle = child.stderr.take();
    let run = async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut opened = false;
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            if !opened {
                if let Some(url) = line.split_whitespace().find(|token| token.starts_with("https://")) {
                    open_browser(url);
                    opened = true;
                }
            }
        }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        let mut stderr = String::new();
        if let Some(mut handle) = stderr_handle.take() { let _ = handle.read_to_string(&mut stderr).await; }
        Ok::<_, String>((status, stderr))
    };
    match tokio::time::timeout(Duration::from_secs(300), run).await {
        Ok(Ok((status, _))) if status.success() => Ok(()),
        Ok(Ok((_, stderr))) => Err(if stderr.trim().is_empty() { "OMP broker login did not complete".to_owned() } else { stderr.trim().to_owned() }),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("Timed out waiting for browser authentication".to_owned()),
    }
}

/// Open a validated https URL in the user's default browser via the platform opener. The URL is
/// passed as a single argument (never through a shell), so it cannot inject additional commands.
fn open_browser(url: &str) {
    #[cfg(target_os = "linux")]
    let mut command = { let mut c = std::process::Command::new("xdg-open"); c.arg(url); c };
    #[cfg(target_os = "macos")]
    let mut command = { let mut c = std::process::Command::new("open"); c.arg(url); c };
    #[cfg(target_os = "windows")]
    let mut command = { let mut c = std::process::Command::new("rundll32"); c.args(["url.dll,FileProtocolHandler", url]); c };
    let _ = command.spawn();
}

#[tauri::command]
pub async fn provider_logout(provider_id: String) -> Result<(), String> {
    let provider = validate_provider_id(&provider_id)?;
    let output = Command::new("omp").args(["auth-broker", "logout", provider]).output().await.map_err(|error| error.to_string())?;
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()) }
}

#[tauri::command]
pub async fn provider_test(provider_id: String) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    let output = Command::new("omp").args(["auth-broker", "status", "--json"]).output().await.map_err(|error| error.to_string())?;
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    Ok(status.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false))
}

fn validate_provider_id(provider_id: &str) -> Result<&str, String> {
    if provider_id.is_empty() || provider_id.len() > 128 || !provider_id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.')) {
        return Err("Invalid OMP provider id".into());
    }
    Ok(provider_id)
}

#[tauri::command]
pub async fn manage_package(package_id: String, action: String, scope: String, project_path: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    if package_id.is_empty() || !package_id.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.' | '/' | '@')) { return Err("Invalid package id".into()); }
    if !matches!(action.as_str(), "install" | "uninstall" | "upgrade" | "enable" | "disable") { return Err("Invalid package action".into()); }
    if !matches!(scope.as_str(), "user" | "project") { return Err("Invalid package scope".into()); }
    let mut command = Command::new("omp"); command.args(["plugin", &action, &package_id, "--scope", &scope]);
    if scope == "project" { let path = project_path.ok_or_else(|| "Project scope requires a project path".to_string())?; let canonical = Path::new(&path).canonicalize().map_err(|error| error.to_string())?; command.current_dir(canonical); }
    let output = command.output().await.map_err(|error| error.to_string())?; if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
    state.catalog.invalidate().await; Ok(())
}

fn outcome_label(outcome: &ConsumeResetOutcome) -> &'static str { match outcome { ConsumeResetOutcome::Reset => "reset", ConsumeResetOutcome::AlreadyRedeemed => "alreadyRedeemed", ConsumeResetOutcome::NothingToReset => "nothingToReset", ConsumeResetOutcome::NoCredit => "noCredit" } }
fn parse_outcome(value: &str) -> Result<ConsumeResetOutcome, String> { match value { "reset" => Ok(ConsumeResetOutcome::Reset), "alreadyRedeemed" => Ok(ConsumeResetOutcome::AlreadyRedeemed), "nothingToReset" => Ok(ConsumeResetOutcome::NothingToReset), "noCredit" => Ok(ConsumeResetOutcome::NoCredit), _ => Err("Stored reset outcome is invalid".into()) } }
fn default_roles() -> Vec<RoleMapping> { vec![RoleMapping { id: "default".into(), label: "Default".into(), description: "Fallback role".into(), model: String::new(), thinking: "Medium".into(), tone: "purple".into() }] }
