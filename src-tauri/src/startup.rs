use std::{ffi::OsStr, fmt::Display, sync::OnceLock, time::Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const DIAGNOSTICS_ENV: &str = "OMP_STUDIO_STARTUP_DIAGNOSTICS";
const OMP_STARTUP_PREFIX: &str = "[startup]";

static DIAGNOSTICS_ENABLED: OnceLock<bool> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum StartupStatus {
    Started,
    Completed,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupProgress<'a> {
    component: &'a str,
    phase: &'a str,
    status: StartupStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

pub(crate) fn enabled() -> bool {
    *DIAGNOSTICS_ENABLED.get_or_init(|| std::env::var_os(DIAGNOSTICS_ENV).is_some_and(|value| value == OsStr::new("1")))
}

pub(crate) fn register_app(app: &AppHandle) {
    if enabled() {
        let _ = APP_HANDLE.set(app.clone());
    }
}

fn emit(component: &str, phase: &str, status: StartupStatus, duration_ms: Option<u64>, message: Option<&str>) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("startup-progress", StartupProgress { component, phase, status, duration_ms, message });
    }
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

pub(crate) struct StartupPhase {
    component: &'static str,
    phase: &'static str,
    started_at: Option<Instant>,
}

impl StartupPhase {
    pub(crate) fn begin(component: &'static str, phase: &'static str) -> Self {
        let started_at = enabled().then(Instant::now);
        if started_at.is_some() {
            emit(component, phase, StartupStatus::Started, None, None);
        }
        Self { component, phase, started_at }
    }

    pub(crate) fn completed(self) {
        let Some(started_at) = self.started_at else { return };
        let duration_ms = elapsed_ms(started_at);
        eprintln!("[startup] {}: {} ms", self.phase, duration_ms);
        emit(self.component, self.phase, StartupStatus::Completed, Some(duration_ms), None);
    }

    pub(crate) fn failed(self, error: &impl Display) {
        let Some(started_at) = self.started_at else { return };
        let duration_ms = elapsed_ms(started_at);
        let message = error.to_string();
        eprintln!("[startup] {}: {} ms", self.phase, duration_ms);
        emit(self.component, self.phase, StartupStatus::Failed, Some(duration_ms), Some(&message));
    }
}

fn parse_omp_startup_payload(payload: &str) -> Option<(&str, u64)> {
    let (phase, duration) = payload.rsplit_once(": ")?;
    let phase = phase.trim();
    let duration_ms = duration.strip_suffix(" ms")?.parse().ok()?;
    (!phase.is_empty()).then_some((phase, duration_ms))
}

pub(crate) fn relay_omp_startup_line(session_id: &str, line: &str) -> bool {
    let Some(suffix) = line.strip_prefix(OMP_STARTUP_PREFIX) else { return false };
    let payload = match suffix.strip_prefix(' ') {
        Some(payload) => payload,
        None if suffix.is_empty() => suffix,
        None => return false,
    };
    if !enabled() {
        return true;
    }

    eprintln!("{line}");
    if let Some((phase, duration_ms)) = parse_omp_startup_payload(payload) {
        let message = format!("session {session_id}: {line}");
        emit("omp", phase, StartupStatus::Completed, Some(duration_ms), Some(&message));
    }
    true
}
