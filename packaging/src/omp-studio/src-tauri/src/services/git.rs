use std::{fs, path::{Component, Path, PathBuf}};

use serde::Serialize;
use tokio::process::Command;

use crate::errors::{StudioError, StudioResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub remote_url: Option<String>,
    pub clean: bool,
    pub changed_files: Vec<ChangedFile>,
    pub last_commit: Option<String>,
    pub branches: Vec<String>,
    pub worktrees: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile { pub path: String, pub additions: u32, pub deletions: u32 }

pub async fn snapshot(project_path: &str) -> StudioResult<GitSnapshot> {
    let project = validate_project(project_path)?;
    let branch = git(&project, &["branch", "--show-current"]).await?;
    let remote_url = git_optional(&project, &["remote", "get-url", "origin"]).await;
    let status = git(&project, &["status", "--porcelain=v1"]).await?;
    let numstat = git(&project, &["diff", "--numstat"]).await.unwrap_or_default();
    let changed_files = numstat.lines().filter_map(|line| { let mut parts = line.splitn(3, '\t'); let additions = parts.next()?.parse().unwrap_or(0); let deletions = parts.next()?.parse().unwrap_or(0); let path = parts.next()?.to_owned(); Some(ChangedFile { path, additions, deletions }) }).collect();
    let last_commit = git_optional(&project, &["log", "-1", "--pretty=%s"]).await;
    let branches = git(&project, &["branch", "--format=%(refname:short)"]).await.unwrap_or_default().lines().map(str::to_owned).collect();
    let worktrees = git(&project, &["worktree", "list", "--porcelain"]).await.unwrap_or_default().lines().filter_map(|line| line.strip_prefix("worktree " ).map(str::to_owned)).collect();
    Ok(GitSnapshot { branch, remote_url, clean: status.is_empty(), changed_files, last_commit, branches, worktrees })
}

pub async fn diff(project_path: &str, file_path: &str) -> StudioResult<String> {
    let project = validate_project(project_path)?; validate_relative(&project, file_path)?;
    git(&project, &["diff", "--", file_path]).await
}

pub fn read_file(project_path: &str, file_path: &str) -> StudioResult<String> {
    let project = validate_project(project_path)?; let file = validate_relative(&project, file_path)?;
    let metadata = fs::metadata(&file)?; if !metadata.is_file() || metadata.len() > 2_000_000 { return Err(StudioError::InvalidInput("file must be text and at most 2 MB".into())); }
    fs::read_to_string(file).map_err(StudioError::from)
}

fn validate_relative(project: &Path, path: &str) -> StudioResult<PathBuf> {
    let relative = Path::new(path);
    if path.is_empty() || path.chars().any(char::is_control) || relative.components().any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))) { return Err(StudioError::InvalidPath("invalid project-relative path".into())); }
    let canonical = project.join(relative).canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
    if !canonical.starts_with(project) { return Err(StudioError::InvalidPath("path leaves the project".into())); } Ok(canonical)
}

pub(crate) fn validate_project(path: &str) -> StudioResult<PathBuf> {
    if path.is_empty() || path.chars().any(char::is_control) { return Err(StudioError::InvalidPath("invalid project path".into())); }
    let canonical = Path::new(path).canonicalize().map_err(|error| StudioError::InvalidPath(error.to_string()))?;
    if !canonical.is_dir() { return Err(StudioError::InvalidPath("project is not a directory".into())); }
    Ok(canonical)
}

async fn git(project: &Path, args: &[&str]) -> StudioResult<String> {
    let output = Command::new("git").args(args).current_dir(project).output().await?;
    if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn git_optional(project: &Path, args: &[&str]) -> Option<String> { git(project, args).await.ok().filter(|value| !value.is_empty()) }
