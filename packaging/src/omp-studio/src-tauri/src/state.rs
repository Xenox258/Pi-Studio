use std::{path::Path, sync::Arc};

use tokio::sync::RwLock;

use crate::{errors::StudioResult, omp::manager::{OmpProcessManager, ProcessPolicy}, services::{catalog::CatalogService, github::GithubService}, storage::database::Database, usage::service::UsageService};

pub struct AppState {
    pub manager: Arc<OmpProcessManager>,
    pub usage: UsageService,
    pub database: Arc<Database>,
    pub active_session: RwLock<Option<String>>,
    pub github: GithubService,
    pub catalog: CatalogService,
}

impl AppState {
    pub fn new(data_dir: &Path) -> StudioResult<Self> {
        let database = Arc::new(Database::open(&data_dir.join("omp-studio.sqlite3"))?);
        let settings: Option<serde_json::Value> = database.get_json("global", "studioSettings")?;
        let policy = match settings.as_ref().and_then(|value| value.get("processPolicy")).and_then(serde_json::Value::as_str) { Some("Balanced") => ProcessPolicy::Balanced, Some("Parallel") => ProcessPolicy::Parallel { max_processes: 4 }, _ => ProcessPolicy::Economy };
        let manager = Arc::new(OmpProcessManager::new(policy));
        let usage = UsageService::new(manager.clone());
        Ok(Self { manager, usage, database, active_session: RwLock::new(None), github: GithubService::default(), catalog: CatalogService::default() })
    }
}
