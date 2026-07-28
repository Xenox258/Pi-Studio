use std::{collections::HashMap, path::{Path, PathBuf}, time::{Duration, Instant}};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{process::Command, sync::RwLock};

use crate::{errors::StudioResult, services::git::validate_project};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSnapshot { pub available: bool, pub repository: Option<String>, pub url: Option<String>, pub pull_request: Option<String>, pub checked_at: String }

#[derive(Default)]
pub struct GithubService { cache: RwLock<HashMap<PathBuf, (Instant, GithubSnapshot)>> }

impl GithubService {
  pub async fn snapshot(&self, project_path: &str) -> StudioResult<GithubSnapshot> {
    let project = validate_project(project_path)?;
    if let Some((at, value)) = self.cache.read().await.get(&project) { if at.elapsed() < Duration::from_secs(120) { return Ok(value.clone()); } }
    let value = fetch(&project).await; self.cache.write().await.insert(project, (Instant::now(), value.clone())); Ok(value)
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository { name_with_owner: String, url: String }

async fn fetch(project: &Path) -> GithubSnapshot {
  let output = Command::new("gh").args(["repo", "view", "--json", "nameWithOwner,url"]).current_dir(project).output().await;
  match output {
    Ok(result) if result.status.success() => match serde_json::from_slice::<Repository>(&result.stdout) {
      Ok(repository) => GithubSnapshot { available: true, repository: Some(repository.name_with_owner), url: Some(repository.url), pull_request: pull_request(project).await, checked_at: Utc::now().to_rfc3339() },
      Err(_) => unavailable(),
    },
    _ => unavailable(),
  }
}

async fn pull_request(project: &Path) -> Option<String> {
  let output = Command::new("gh").args(["pr", "view", "--json", "number,title", "--jq", r#"#\(.number) \(.title)"#]).current_dir(project).output().await.ok()?;
  output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned()).filter(|value| !value.is_empty())
}

fn unavailable() -> GithubSnapshot { GithubSnapshot { available: false, repository: None, url: None, pull_request: None, checked_at: Utc::now().to_rfc3339() } }
