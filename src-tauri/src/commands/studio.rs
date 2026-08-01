use std::{collections::{hash_map::DefaultHasher, HashSet}, fs::File, hash::{Hash, Hasher}, io::{BufRead, BufReader, Read}, path::Path, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
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
pub struct StudioSettings { pub process_policy: String, pub suspend_background: bool, pub cache_limit_mb: u32, pub onboarding_completed: bool, #[serde(default)] pub connected_providers: Vec<String> }

impl Default for StudioSettings { fn default() -> Self { Self { process_policy: "Economy".into(), suspend_background: true, cache_limit_mb: 100, onboarding_completed: false, connected_providers: Vec::new() } } }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStats { pub active_processes: usize }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfiguration { pub model: Option<String>, pub thinking_level: Option<String>, pub session_name: Option<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot { pub project: ProjectSummary, pub messages: Vec<Value>, pub model: Option<String>, pub thinking_level: Option<String>, pub title: Option<String> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment { data_url: String, media_type: String }

/// OMP forwards the prompt verbatim to the provider, so a text-only prompt stays a plain string
/// and only image prompts are promoted to Anthropic-style content blocks.
fn build_prompt_message(message: &str, images: &[ImageAttachment]) -> Value {
    if images.is_empty() { return json!(message); }
    let mut content: Vec<Value> = Vec::with_capacity(images.len() + 1);
    if !message.is_empty() { content.push(json!({ "type": "text", "text": message })); }
    for image in images {
        let data = image.data_url.split_once(',').map_or(image.data_url.as_str(), |(_, payload)| payload);
        if data.is_empty() { continue; }
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": image.media_type, "data": data } }));
    }
    json!(content)
}

/// WebKitGTK hands the webview an empty `clipboardData` for images, so a browser-side Ctrl+V can
/// never see a copied screenshot on Linux. Reading the system clipboard natively is the only path.
/// Kept async so Tauri runs it off the main thread — `read_image` can deadlock there on Linux.
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<Option<String>, String> {
    let Ok(image) = app.clipboard().read_image() else { return Ok(None) };
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 { return Ok(None); }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(image.rgba(), width, height, ExtendedColorType::Rgba8)
        .map_err(|error| format!("Could not encode the clipboard image: {error}"))?;
    Ok(Some(format!("data:image/png;base64,{}", STANDARD.encode(&png))))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedAttachment { pub file_name: String, pub path: String, pub media_type: Option<String>, pub data_url: Option<String> }

const MAX_INLINE_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

/// Images are inlined so the model can actually see them; every other file is handed over as a path
/// for OMP to read with its own tools, which keeps multi-megabyte binaries out of the RPC frame.
#[tauri::command]
pub async fn load_attachment(path: String) -> Result<LoadedAttachment, String> {
    let file = Path::new(&path);
    let file_name = file.file_name().and_then(|name| name.to_str()).unwrap_or("attachment").to_owned();
    let metadata = tokio::fs::metadata(file).await.map_err(|error| format!("Cannot read {file_name}: {error}"))?;
    if !metadata.is_file() { return Err(format!("{file_name} is not a file")); }
    let media_type = match file.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    };
    let Some(media_type) = media_type else { return Ok(LoadedAttachment { file_name, path, media_type: None, data_url: None }) };
    if metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return Ok(LoadedAttachment { file_name, path, media_type: None, data_url: None });
    }
    let bytes = tokio::fs::read(file).await.map_err(|error| format!("Cannot read {file_name}: {error}"))?;
    Ok(LoadedAttachment { file_name, path, media_type: Some(media_type.to_owned()), data_url: Some(format!("data:{media_type};base64,{}", STANDARD.encode(&bytes))) })
}

#[tauri::command]
pub async fn detect_omp_capabilities() -> Result<OmpCapabilities, String> { command_result(capabilities::detect().await) }

#[tauri::command]
pub fn get_studio_settings(state: State<'_, AppState>) -> Result<StudioSettings, String> { command_result(state.database.get_json("global", "studioSettings").map(|value| value.unwrap_or_default())) }

#[tauri::command]
pub async fn save_studio_settings(settings: StudioSettings, state: State<'_, AppState>) -> Result<(), String> {
    if !matches!(settings.process_policy.as_str(), "Economy" | "Balanced" | "Parallel") || !matches!(settings.cache_limit_mb, 50 | 100 | 200) { return Err("Invalid settings".into()); }
    let mut settings = settings;
    // Connected providers are managed exclusively by the provider login/logout commands; never let a settings save clobber them.
    let existing: StudioSettings = state.database.get_json("global", "studioSettings").map_err(|error| error.to_string())?.unwrap_or_default();
    settings.connected_providers = existing.connected_providers;
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
pub async fn catalog_readme(package_id: String, state: State<'_, AppState>) -> Result<String, String> { command_result(state.catalog.readme(&package_id).await) }

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
pub fn create_project(parent_path: String, name: String, state: State<'_, AppState>) -> Result<ProjectSummary, String> { command_result(create_project_inner(parent_path, name, &state)) }
fn create_project_inner(parent_path: String, name: String, state: &AppState) -> StudioResult<ProjectSummary> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 || name == "." || name == ".." || name.chars().any(|value| value.is_control() || std::path::is_separator(value)) {
        return Err(StudioError::InvalidPath("invalid project name".into()));
    }
    let parent = Path::new(&parent_path).canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
    if !parent.is_dir() { return Err(StudioError::InvalidPath("parent is not a directory".into())); }
    let target = parent.join(name);
    if target.exists() { return Err(StudioError::InvalidPath("a file or folder with this name already exists".into())); }
    std::fs::create_dir_all(&target).map_err(|error| StudioError::InvalidPath(error.to_string()))?;
    open_project_inner(target.to_string_lossy().into_owned(), state)
}

#[tauri::command]
pub fn recent_projects(state: State<'_, AppState>) -> Result<Vec<StoredProject>, String> { command_result(state.database.recent_projects()) }

/// OMP keeps refining the auto-generated name well after a run settles, and it does so by rewriting
/// the header of the transcript rather than notifying anyone. Reading that header is the only way
/// the sidebar can show the current name for sessions that are not running.
#[tauri::command]
pub async fn recent_sessions(state: State<'_, AppState>) -> Result<Vec<StoredSession>, String> {
    let active = state.active_session.read().await;
    let mut sessions = command_result(state.database.recent_sessions(active.as_deref()))?;
    for session in &mut sessions {
        let Some(recorded) = session.omp_session_path.as_deref().and_then(|path| transcript_title(Path::new(path))) else { continue };
        let Some(title) = storable_title(&session.id, &recorded).filter(|title| *title != session.title.as_str()) else { continue };
        if let Err(error) = state.database.sync_session_title(&session.id, title) { tracing::warn!(%error, "Could not store the session name OMP recorded"); }
        session.title = title.to_owned();
    }
    Ok(sessions)
}

/// The transcript opens with a padded title record so OMP can rewrite the name in place; only that
/// first line is read, and anything else means the file predates the convention.
fn transcript_title(path: &Path) -> Option<String> {
    let mut line = String::new();
    BufReader::new(File::open(path).ok()?).take(8 * 1024).read_line(&mut line).ok()?;
    let record: Value = serde_json::from_str(line.trim()).ok()?;
    (record.get("type")?.as_str()? == "title").then(|| record.get("title")?.as_str().map(str::to_owned))?
}

/// OMP owns the session title: it auto-generates one from the conversation and records whether the
/// name came from itself or the user. Pushing renames back keeps the two from diverging on resume,
/// and marks the title user-owned so OMP stops re-titling it.
#[tauri::command]
pub async fn set_session_title(session_id: String, title: String, state: State<'_, AppState>) -> Result<(), String> {
    let title = storable_title(&session_id, &title).ok_or_else(|| "Invalid session title".to_string())?;
    command_result(state.database.update_session_title(&session_id, title))?;
    if let Err(error) = state.manager.request(&session_id, json!({ "type": "set_session_name", "name": title }), Duration::from_secs(10)).await {
        tracing::warn!(%error, "OMP did not record the session rename");
    }
    Ok(())
}

/// A title is only worth storing when it can round-trip through the sidebar: bounded, non-blank and
/// free of control characters that would break the single-line rendering.
fn storable_title<'a>(session_id: &str, title: &'a str) -> Option<&'a str> {
    let title = title.trim();
    let usable = !session_id.trim().is_empty() && session_id.len() <= 128 && !title.is_empty() && title.len() <= 240 && !title.chars().any(char::is_control);
    usable.then_some(title)
}

#[tauri::command]
pub async fn start_session(app: AppHandle, project_id: String, project_path: String, advisor_enabled: bool, state: State<'_, AppState>) -> Result<String, String> {
    if project_id.trim().is_empty() { return Err("Invalid project id".into()); }
    let session_id = Uuid::new_v4().to_string();
    command_result(state.manager.start(app, session_id.clone(), Path::new(&project_path), None, advisor_enabled).await)?;
    let session_path = refresh_session_path(&session_id, &state).await;
    if let Err(error) = state.database.save_session(&session_id, &project_id, "New session", session_path.as_deref()) { state.manager.stop(&session_id).await; return Err(error.to_string()); }
    *state.active_session.write().await = Some(session_id.clone());
    Ok(session_id)
}

#[tauri::command]
pub async fn resume_session(app: AppHandle, session_id: String, advisor_enabled: bool, state: State<'_, AppState>) -> Result<ProjectSummary, String> {
    let launch = state.database.session_launch(&session_id).map_err(|error| error.to_string())?.ok_or_else(|| "Unknown session".to_string())?;
    let session_path = launch.omp_session_path.as_deref().ok_or_else(|| "This session predates OMP history tracking and cannot be resumed.".to_string())?;
    command_result(state.manager.start(app, launch.id.clone(), Path::new(&launch.project_path), Some(Path::new(session_path)), advisor_enabled).await)?;
    *state.active_session.write().await = Some(launch.id);
    Ok(ProjectSummary { id: launch.project_id, name: launch.project_name, path: launch.project_path })
}

/// Booting OMP costs tens of seconds once extensions load, yet none of that boot is needed to
/// *display* a stored session: the transcript on disk already holds the whole conversation. The UI
/// renders this snapshot at once and lets `resume_session` warm the process behind it.
#[tauri::command]
pub async fn session_snapshot(session_id: String, state: State<'_, AppState>) -> Result<SessionSnapshot, String> {
    let launch = state.database.session_launch(&session_id).map_err(|error| error.to_string())?.ok_or_else(|| "Unknown session".to_string())?;
    let session_path = launch.omp_session_path.as_deref().ok_or_else(|| "This session predates OMP history tracking and cannot be resumed.".to_string())?;
    let (messages, model, thinking_level, title) = parse_transcript(Path::new(session_path));
    Ok(SessionSnapshot { project: ProjectSummary { id: launch.project_id, name: launch.project_name, path: launch.project_path }, messages, model, thinking_level, title })
}

// Transcripts are append-only and unbounded; 64 MiB matches the protocol-v2 frame ceiling, so a
// snapshot never costs more memory than the live session could have handed back in a single frame.
const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;

/// Every record the view needs is already on disk, so the snapshot is rebuilt without an OMP
/// process. Unknown records and unparsable lines are skipped instead of fatal: one corrupt line
/// must not cost the user the rest of the conversation, and a missing file is still resumable.
fn parse_transcript(path: &Path) -> (Vec<Value>, Option<String>, Option<String>, Option<String>) {
    let (mut messages, mut model, mut thinking_level, mut title) = (Vec::new(), None, None, None);
    let Ok(file) = File::open(path) else { return (messages, model, thinking_level, title) };
    for line in BufReader::new(file).take(MAX_TRANSCRIPT_BYTES).lines() {
        let Ok(line) = line else { break };
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else { continue };
        match record.get("type").and_then(Value::as_str).unwrap_or_default() {
            "message" => if let Some(Value::Object(inner)) = record.get("message") {
                let mut message = inner.clone();
                // The wrapper carries the id `get_messages` reports; the inner object has none of its own.
                if let Some(id) = record.get("id") { message.entry("id").or_insert_with(|| id.clone()); }
                messages.push(Value::Object(message));
            },
            "model_change" => model = record.get("model").and_then(Value::as_str).map(str::to_owned).or(model),
            "thinking_level_change" => thinking_level = record.get("thinkingLevel").and_then(Value::as_str).map(str::to_owned).or(thinking_level),
            "title" => title = record.get("title").and_then(Value::as_str).map(str::to_owned).or(title),
            _ => {}
        }
    }
    (messages, model, thinking_level, title)
}

#[tauri::command]
pub async fn stop_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> { state.manager.stop(&session_id).await; let mut active = state.active_session.write().await; if active.as_deref() == Some(&session_id) { *active = None; } Ok(()) }

#[tauri::command]
pub async fn delete_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 { return Err("Invalid session id".into()); }
    state.manager.stop(&session_id).await;
    { let mut active = state.active_session.write().await; if active.as_deref() == Some(&session_id) { *active = None; } }
    command_result(state.database.delete_session(&session_id))
}

#[tauri::command]
pub async fn send_prompt(session_id: String, message: String, images: Vec<ImageAttachment>, state: State<'_, AppState>) -> Result<bool, String> {
    if message.trim().is_empty() && images.is_empty() { return Err("Prompt must contain text or images".into()); }
    if message.len() > 200_000 { return Err("Prompt text exceeds 200000 characters".into()); }
    let payload = build_prompt_message(&message, &images);
    let data = command_result(state.manager.request(&session_id, json!({ "type": "prompt", "message": payload }), Duration::from_secs(10)).await)?;
    if let Some(path) = refresh_session_path(&session_id, &state).await { state.database.update_session_path(&session_id, &path).map_err(|error| error.to_string())?; }
    Ok(agent_invoked(&data))
}

#[tauri::command]
pub async fn conversation_history(session_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let data = command_result(state.manager.request(&session_id, json!({ "type": "get_messages" }), Duration::from_secs(10)).await)?;
    data.get("messages").and_then(Value::as_array).cloned().ok_or_else(|| "OMP returned an invalid message history".to_string())
}

fn parse_session_configuration(data: &Value) -> SessionConfiguration {
    let model = data.get("model").and_then(|value| {
        let provider = value.get("provider")?.as_str()?;
        let model_id = value.get("id")?.as_str()?;
        (!provider.is_empty() && !model_id.is_empty()).then(|| format!("{provider}/{model_id}"))
    });
    let thinking_level = data.get("thinkingLevel").and_then(Value::as_str).map(str::to_owned);
    // OMP only publishes a name once it has seen enough of the conversation to summarize it.
    let session_name = data.get("sessionName").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned);
    SessionConfiguration { model, thinking_level, session_name }
}

/// Reading the configuration also mirrors the name the running session reports, so the sidebar
/// follows a rename as soon as OMP applies it instead of waiting for the next transcript sweep.
#[tauri::command]
pub async fn session_configuration(session_id: String, state: State<'_, AppState>) -> Result<SessionConfiguration, String> {
    let data = command_result(state.manager.request(&session_id, json!({ "type": "get_state" }), Duration::from_secs(10)).await)?;
    let configuration = parse_session_configuration(&data);
    if let Some(title) = configuration.session_name.as_deref().and_then(|name| storable_title(&session_id, name)) {
        if let Err(error) = state.database.sync_session_title(&session_id, title) { tracing::warn!(%error, "Could not mirror the OMP session name into the local history"); }
    }
    Ok(configuration)
}

#[tauri::command]
pub async fn available_commands(session_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let data = command_result(state.manager.request(&session_id, json!({ "type": "get_available_commands" }), Duration::from_secs(10)).await)?;
    Ok(data.get("commands").and_then(Value::as_array).cloned().unwrap_or_default())
}

async fn refresh_session_path(session_id: &str, state: &AppState) -> Option<String> {
    state.manager.request(session_id, json!({ "type": "get_state" }), Duration::from_secs(10)).await.ok()?.get("sessionFile")?.as_str().map(str::to_owned)
}

#[tauri::command]
pub async fn steer_prompt(session_id: String, message: String, images: Vec<ImageAttachment>, state: State<'_, AppState>) -> Result<bool, String> { send_interaction(&session_id, &message, &images, "steer", &state).await }

#[tauri::command]
pub async fn follow_up_prompt(session_id: String, message: String, images: Vec<ImageAttachment>, state: State<'_, AppState>) -> Result<bool, String> { send_interaction(&session_id, &message, &images, "follow_up", &state).await }

/// OMP omits `agentInvoked` for ordinary prompts and only reports `false` when it handled the
/// input as a command without starting a turn, so an absent flag must read as a running turn.
fn agent_invoked(data: &Value) -> bool { data.get("agentInvoked").and_then(Value::as_bool).unwrap_or(true) }

async fn send_interaction(session_id: &str, message: &str, images: &[ImageAttachment], kind: &str, state: &AppState) -> Result<bool, String> {
    if message.trim().is_empty() && images.is_empty() { return Err("Message must contain text or images".into()); }
    if message.len() > 200_000 { return Err("Message text exceeds 200000 characters".into()); }
    let payload = build_prompt_message(message, images);
    command_result(state.manager.request(session_id, json!({ "type": kind, "message": payload }), Duration::from_secs(300)).await).map(|data| agent_invoked(&data))
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

fn normalize_thinking_level(level: &str) -> Result<String, String> {
    let trimmed = level.trim();
    let normalized = match trimmed { "Off" => "off", "Minimal" => "minimal", "Low" => "low", "Medium" => "medium", "High" => "high", "Very High" | "Ultracode" => "xhigh", "Max" => "max", value => value };
    if normalized.is_empty() || normalized.len() > 32 || !normalized.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '-' | '_')) { return Err("Unsupported thinking level".into()); }
    Ok(normalized.to_owned())
}

#[tauri::command]
pub async fn set_thinking_level(session_id: String, level: String, state: State<'_, AppState>) -> Result<(), String> {
    let normalized = normalize_thinking_level(&level)?;
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
pub async fn provider_login(provider_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let provider = validate_provider_id(&provider_id)?;
    broker_login(provider).await?;
    add_connected_provider(&state, provider)
}

#[tauri::command]
pub async fn provider_api_key_login(provider_id: String, api_key: String, state: State<'_, AppState>) -> Result<(), String> {
    let provider = validate_provider_id(&provider_id)?;
    if api_key.trim().is_empty() || api_key.len() > 512 || api_key.chars().any(char::is_control) { return Err("Invalid API key".into()); }
    broker_api_key_login(provider, api_key.trim()).await?;
    add_connected_provider(&state, provider)
}

/// API-key providers do not use OAuth: `omp auth-broker login <provider>` prints the key dashboard
/// URL then reads the key from stdin. We pipe the key in, close stdin, and scan stdout for the
/// success/failure banner, falling back to the process exit code.
async fn broker_api_key_login(provider: &str, api_key: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new("omp")
        .args(["auth-broker", "login", provider])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(api_key.as_bytes()).await.map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").await.map_err(|error| error.to_string())?;
        drop(stdin);
    }
    // `wait_with_output` drains stdout and stderr concurrently, so a verbose broker cannot deadlock
    // on a full pipe. API-key login is a single prompt, so there is nothing to stream interactively.
    let output = match tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await {
        Ok(result) => result.map_err(|error| error.to_string())?,
        Err(_) => return Err("Timed out waiting for the OMP broker to accept the API key".to_owned()),
    };
    let combined = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let succeeded = combined.lines().any(|line| { let lower = line.to_lowercase(); lower.contains("success") || line.contains('✓') });
    if succeeded || output.status.success() { return Ok(()); }
    let last_error = combined.lines().rev().map(str::trim).find(|line| { let lower = line.to_lowercase(); lower.contains("failed") || lower.contains("invalid") || lower.contains("error") });
    Err(last_error.map(str::to_owned).unwrap_or_else(|| "API key login failed".to_owned()))
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
pub async fn provider_logout(provider_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let provider = validate_provider_id(&provider_id)?;
    let output = Command::new("omp").args(["auth-broker", "logout", provider]).output().await.map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
    remove_connected_provider(&state, provider)
}

/// Persist a provider id in the app's own settings so the "Logged in" badge survives navigation.
/// OMP owns the actual credentials; this list is only a UI hint managed by login/logout.
fn add_connected_provider(state: &AppState, provider: &str) -> Result<(), String> {
    let mut settings: StudioSettings = state.database.get_json("global", "studioSettings").map_err(|error| error.to_string())?.unwrap_or_default();
    if !settings.connected_providers.iter().any(|entry| entry == provider) { settings.connected_providers.push(provider.to_owned()); }
    state.database.put_json("global", "studioSettings", &settings).map_err(|error| error.to_string())
}

fn remove_connected_provider(state: &AppState, provider: &str) -> Result<(), String> {
    let mut settings: StudioSettings = state.database.get_json("global", "studioSettings").map_err(|error| error.to_string())?.unwrap_or_default();
    settings.connected_providers.retain(|entry| entry != provider);
    state.database.put_json("global", "studioSettings", &settings).map_err(|error| error.to_string())
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

fn package_command_action<'a>(package_id: &str, requested: &'a str) -> &'a str {
    let marketplace_qualified = package_id.rfind('@').is_some_and(|index| index > 0 && index + 1 < package_id.len());
    if requested == "upgrade" && !marketplace_qualified { "install" } else { requested }
}

#[tauri::command]
pub async fn manage_package(package_id: String, action: String, scope: String, project_path: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    if package_id.is_empty() || !package_id.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.' | '/' | '@')) { return Err("Invalid package id".into()); }
    if !matches!(action.as_str(), "install" | "uninstall" | "upgrade" | "enable" | "disable") { return Err("Invalid package action".into()); }
    if !matches!(scope.as_str(), "user" | "project") { return Err("Invalid package scope".into()); }
    let omp_action = package_command_action(&package_id, &action);
    let mut command = Command::new("omp"); command.args(["plugin", omp_action, &package_id, "--scope", &scope]);
    if let Some(path) = augmented_path() { command.env("PATH", path); }
    if scope == "project" { let path = project_path.ok_or_else(|| "Project scope requires a project path".to_string())?; let canonical = Path::new(&path).canonicalize().map_err(|error| error.to_string())?; command.current_dir(canonical); }
    let output = command.output().await.map_err(|error| error.to_string())?;
    // `omp plugin` prints a `✘ Failed …` line yet still exits 0, so trust the output markers, not just the code.
    let combined = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let lines: Vec<&str> = combined.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let start = lines.iter().position(|line| line.starts_with('✘') || line.contains("Failed to ") || line.starts_with("Error:") || line.contains(": Error:"));
    if !output.status.success() || start.is_some() {
        // Validation failures print the headline on one line and the actual reasons on the following
        // lines, so gather a few lines of context rather than just the marker line.
        let mut detail = start.map(|index| lines[index..].iter().take(6).map(|line| line.trim_start_matches('✘').trim()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        if detail.is_empty() { detail = String::from_utf8_lossy(&output.stderr).trim().to_owned(); }
        // Drop omp's "Failed to install <pkg>:" prefix and "Error:" noise so the UI shows one clean reason.
        let reason = detail.split_once(": ").filter(|(head, _)| head.starts_with("Failed to ")).map_or(detail.as_str(), |(_, tail)| tail).trim();
        let reason = reason.strip_prefix("Error:").unwrap_or(reason).trim().trim_end_matches(':').trim();
        return Err(if reason.is_empty() {
            format!("omp could not {action} {package_id}")
        } else if reason.contains("bun") {
            format!("{reason}. Installing Pi packages needs the bun runtime — install it from https://bun.sh and make sure `bun` is on your PATH, then retry.")
        } else {
            reason.to_owned()
        });
    }
    state.catalog.invalidate().await; Ok(())
}

/// GUI processes launched from a desktop entry inherit a minimal PATH that usually omits user tool
/// managers (bun, mise, volta, …). `omp plugin install` shells out to `bun`, so prepend the common
/// user bin directories before spawning to match what the user has in an interactive shell.
fn augmented_path() -> Option<std::ffi::OsString> {
    let mut entries: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for suffix in [".bun/bin", ".local/bin", ".local/share/mise/shims", ".deno/bin", ".volta/bin", ".npm-global/bin", "bin"] {
            entries.push(home.join(suffix));
        }
    }
    for fixed in ["/usr/local/bin", "/opt/homebrew/bin"] { entries.push(std::path::PathBuf::from(fixed)); }
    if let Some(existing) = std::env::var_os("PATH") { entries.extend(std::env::split_paths(&existing)); }
    std::env::join_paths(entries).ok()
}

fn outcome_label(outcome: &ConsumeResetOutcome) -> &'static str { match outcome { ConsumeResetOutcome::Reset => "reset", ConsumeResetOutcome::AlreadyRedeemed => "alreadyRedeemed", ConsumeResetOutcome::NothingToReset => "nothingToReset", ConsumeResetOutcome::NoCredit => "noCredit" } }
fn parse_outcome(value: &str) -> Result<ConsumeResetOutcome, String> { match value { "reset" => Ok(ConsumeResetOutcome::Reset), "alreadyRedeemed" => Ok(ConsumeResetOutcome::AlreadyRedeemed), "nothingToReset" => Ok(ConsumeResetOutcome::NothingToReset), "noCredit" => Ok(ConsumeResetOutcome::NoCredit), _ => Err("Stored reset outcome is invalid".into()) } }
fn default_roles() -> Vec<RoleMapping> { vec![RoleMapping { id: "default".into(), label: "Default".into(), description: "Fallback role".into(), model: String::new(), thinking: "Medium".into(), tone: "purple".into() }] }

#[cfg(test)]
mod tests {
    use super::{agent_invoked, build_prompt_message, load_attachment, normalize_thinking_level, package_command_action, parse_session_configuration, parse_transcript, storable_title, transcript_title, ImageAttachment};

    #[test]
    fn inlines_images_and_hands_other_files_over_as_paths() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let dir = std::env::temp_dir().join(format!("omp-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let png = dir.join("shot.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let loaded = runtime.block_on(load_attachment(png.to_string_lossy().into_owned())).unwrap();
        assert_eq!(loaded.file_name, "shot.png");
        assert_eq!(loaded.media_type.as_deref(), Some("image/png"));
        assert!(loaded.data_url.unwrap().starts_with("data:image/png;base64,"));

        // A non-image is never inlined: OMP opens it from the path instead.
        let doc = dir.join("notes.pdf");
        std::fs::write(&doc, b"%PDF-1.7").unwrap();
        let loaded = runtime.block_on(load_attachment(doc.to_string_lossy().into_owned())).unwrap();
        assert_eq!(loaded.file_name, "notes.pdf");
        assert!(loaded.media_type.is_none() && loaded.data_url.is_none());
        assert_eq!(loaded.path, doc.to_string_lossy());

        assert!(runtime.block_on(load_attachment(dir.to_string_lossy().into_owned())).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn normalizes_legacy_labels_and_forwards_omp_values() {
        assert_eq!(normalize_thinking_level("Very High").unwrap(), "xhigh");
        assert_eq!(normalize_thinking_level("xhigh").unwrap(), "xhigh");
        assert_eq!(normalize_thinking_level("provider-level-7").unwrap(), "provider-level-7");
        assert!(normalize_thinking_level("High\nmalicious").is_err());
        assert!(normalize_thinking_level("").is_err());
    }

    #[test]
    fn parses_runtime_model_and_effort() {
        let configuration = parse_session_configuration(&serde_json::json!({ "model": { "provider": "anthropic", "id": "claude-fable-5" }, "thinkingLevel": "xhigh" }));
        assert_eq!(configuration.model.as_deref(), Some("anthropic/claude-fable-5"));
        assert_eq!(configuration.thinking_level.as_deref(), Some("xhigh"));
        assert!(parse_session_configuration(&serde_json::json!({ "model": null })).model.is_none());
    }

    #[test]
    fn adopts_the_name_omp_generated_for_the_session() {
        let named = parse_session_configuration(&serde_json::json!({ "sessionName": "Add image support to prompts", "thinkingLevel": "high" }));
        assert_eq!(named.session_name.as_deref(), Some("Add image support to prompts"));
        // OMP omits the name until it has summarized the exchange, and must never yield a blank title.
        assert!(parse_session_configuration(&serde_json::json!({ "thinkingLevel": "high" })).session_name.is_none());
        assert!(parse_session_configuration(&serde_json::json!({ "sessionName": "   " })).session_name.is_none());
    }

    #[test]
    fn treats_a_missing_agent_invoked_flag_as_a_started_turn() {
        assert!(!agent_invoked(&serde_json::json!({ "agentInvoked": false })));
        assert!(agent_invoked(&serde_json::json!({ "agentInvoked": true })));
        assert!(agent_invoked(&serde_json::Value::Null));
        assert!(agent_invoked(&serde_json::json!({ "sessionFile": "/tmp/session.json" })));
    }

    #[test]
    fn only_renderable_titles_reach_stored_history() {
        assert_eq!(storable_title("session-1", "  Add image support  "), Some("Add image support"));
        assert_eq!(storable_title("session-1", "   "), None);
        assert_eq!(storable_title("session-1", "Add image\nsupport"), None);
        assert_eq!(storable_title("   ", "Add image support"), None);
        assert_eq!(storable_title("session-1", &"x".repeat(241)), None);
    }

    #[test]
    fn reads_the_current_name_from_the_transcript_header() {
        let dir = std::env::temp_dir().join(format!("omp-transcript-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let titled = dir.join("titled.jsonl");
        // OMP pads the record so it can rewrite a longer name in place without rewriting the file.
        std::fs::write(&titled, "{\"type\":\"title\",\"v\":1,\"title\":\"Add image support to prompts\",\"source\":\"auto\",\"pad\":\"      \"}\n{\"type\":\"session\",\"version\":3}\n").unwrap();
        assert_eq!(transcript_title(&titled).as_deref(), Some("Add image support to prompts"));

        let untitled = dir.join("untitled.jsonl");
        std::fs::write(&untitled, "{\"type\":\"session\",\"version\":3}\n").unwrap();
        assert_eq!(transcript_title(&untitled), None);
        assert_eq!(transcript_title(&dir.join("missing.jsonl")), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rebuilds_a_stored_conversation_from_the_transcript() {
        let dir = std::env::temp_dir().join(format!("omp-snapshot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join("session.jsonl");
        std::fs::write(&transcript, concat!(
            "{\"type\":\"title\",\"v\":1,\"title\":\"Add image support to prompts\",\"source\":\"auto\",\"pad\":\"      \"}\n",
            "{\"type\":\"model_change\",\"model\":\"anthropic/claude-fable-5\",\"role\":\"default\"}\n",
            "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
            "{\"type\":\"custom\",\"customType\":\"tool_execution_start\",\"toolName\":\"read\"}\n",
            "{\"type\":\"thinking_level_change\",\"thinkingLevel\":\"max\",\"configured\":\"max\"}\n",
            "{\"type\":\"message\",\"id\":\"m2\",\"message\":{\"role\":\"assistant\",\"content\":\"hi\"}}\n",
            "{\"type\":\"model_change\",\"model\":\"anthropic/claude-opus-4-8\",\"role\":\"default\"}\n",
            "a half-written line OMP never finished\n",
        )).unwrap();

        let (messages, model, thinking_level, title) = parse_transcript(&transcript);
        // Telemetry records share the file with the conversation; only the messages may reach the UI.
        assert_eq!(messages, vec![
            serde_json::json!({ "id": "m1", "role": "user", "content": "hello" }),
            serde_json::json!({ "id": "m2", "role": "assistant", "content": "hi" }),
        ]);
        assert_eq!(model.as_deref(), Some("anthropic/claude-opus-4-8"));
        assert_eq!(thinking_level.as_deref(), Some("max"));
        assert_eq!(title.as_deref(), Some("Add image support to prompts"));

        // A transcript OMP has not written yet still resumes, just with nothing to show.
        let (messages, model, thinking_level, title) = parse_transcript(&dir.join("missing.jsonl"));
        assert!(messages.is_empty() && model.is_none() && thinking_level.is_none() && title.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn text_only_prompts_stay_plain_strings() {
        assert_eq!(build_prompt_message("hello", &[]), serde_json::json!("hello"));
    }

    #[test]
    fn image_prompts_become_content_blocks_with_stripped_data_urls() {
        let images = vec![ImageAttachment { data_url: "data:image/png;base64,QUJD".into(), media_type: "image/png".into() }];
        assert_eq!(build_prompt_message("look", &images), serde_json::json!([
            { "type": "text", "text": "look" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "QUJD" } },
        ]));
    }

    #[test]
    fn image_only_prompts_omit_the_empty_text_block() {
        let images = vec![ImageAttachment { data_url: "data:image/jpeg;base64,WFla".into(), media_type: "image/jpeg".into() }];
        assert_eq!(build_prompt_message("", &images), serde_json::json!([
            { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "WFla" } },
        ]));
    }

    #[test]
    fn routes_selected_npm_upgrades_through_install() {
        assert_eq!(package_command_action("pi-lens", "upgrade"), "install");
        assert_eq!(package_command_action("@scope/pi-package", "upgrade"), "install");
    }

    #[test]
    fn preserves_marketplace_and_non_upgrade_actions() {
        assert_eq!(package_command_action("studio-tool@official", "upgrade"), "upgrade");
        assert_eq!(package_command_action("@scope/studio-tool@official", "upgrade"), "upgrade");
        assert_eq!(package_command_action("pi-lens", "uninstall"), "uninstall");
    }

    #[test]
    fn payload_free_attachments_are_dropped() {
        let images = vec![ImageAttachment { data_url: "data:image/png;base64,".into(), media_type: "image/png".into() }];
        assert_eq!(build_prompt_message("only text survives", &images), serde_json::json!([
            { "type": "text", "text": "only text survives" },
        ]));
    }
}
