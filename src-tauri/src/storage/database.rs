use std::{fs, path::Path, sync::Mutex};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::errors::{StudioError, StudioResult};

pub struct Database { connection: Mutex<Connection> }

pub enum ResetAttempt { New, Pending, Completed(String) }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProject { pub id: String, pub name: String, pub path: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession { pub id: String, pub title: String, pub project_id: String, pub updated_at: String, pub active: bool, #[serde(skip)] pub omp_session_path: Option<String> }

#[derive(Debug)]
pub struct SessionLaunch {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub omp_session_path: Option<String>,
}

impl Database {
    pub fn open(path: &Path) -> StudioResult<Self> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version < 1 {
            connection.execute_batch("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, opened_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,key));
            CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage_cache (cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_cache (cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reset_attempts (idempotency_key TEXT PRIMARY KEY, credential_id TEXT NOT NULL, credit_id TEXT NOT NULL, outcome TEXT, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL);")?;
            connection.pragma_update(None, "user_version", 1)?;
        }
        if version < 2 {
            connection.execute_batch("ALTER TABLE sessions ADD COLUMN omp_session_path TEXT;")?;
            connection.pragma_update(None, "user_version", 2)?;
        }
        Ok(Self { connection: Mutex::new(connection) })
    }

    pub fn save_project(&self, id: &str, name: &str, path: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("INSERT INTO projects(id,name,path,opened_at) VALUES (?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET name=excluded.name, opened_at=excluded.opened_at", params![id, name, path, Utc::now().to_rfc3339()])?; Ok(()) })
    }

    pub fn recent_projects(&self) -> StudioResult<Vec<StoredProject>> {
        self.with_connection(|connection| { let mut statement = connection.prepare("SELECT id,name,path FROM projects ORDER BY opened_at DESC LIMIT 50")?; let rows = statement.query_map([], |row| Ok(StoredProject { id: row.get(0)?, name: row.get(1)?, path: row.get(2)? }))?; rows.collect::<Result<Vec<_>, _>>().map_err(StudioError::from) })
    }

    pub fn save_session(&self, id: &str, project_id: &str, title: &str, omp_session_path: Option<&str>) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("INSERT INTO sessions(id,project_id,title,updated_at,omp_session_path) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, omp_session_path=COALESCE(excluded.omp_session_path,sessions.omp_session_path)", params![id, project_id, title, Utc::now().to_rfc3339(), omp_session_path])?; Ok(()) })
    }

    pub fn update_session_path(&self, id: &str, omp_session_path: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("UPDATE sessions SET omp_session_path=?2,updated_at=?3 WHERE id=?1", params![id, omp_session_path, Utc::now().to_rfc3339()])?; Ok(()) })
    }

    pub fn update_session_title(&self, id: &str, title: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("UPDATE sessions SET title=?2,updated_at=?3 WHERE id=?1", params![id, title, Utc::now().to_rfc3339()])?; Ok(()) })
    }

    /// Mirroring the name OMP settled on is bookkeeping, not activity, so the history order stays
    /// anchored to when the session was actually used.
    pub fn sync_session_title(&self, id: &str, title: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("UPDATE sessions SET title=?2 WHERE id=?1", params![id, title])?; Ok(()) })
    }

    pub fn delete_session(&self, id: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("DELETE FROM sessions WHERE id=?1", [id])?; Ok(()) })
    }

    pub fn session_launch(&self, id: &str) -> StudioResult<Option<SessionLaunch>> {
        self.with_connection(|connection| connection.query_row("SELECT s.id,s.project_id,p.name,p.path,s.omp_session_path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1", [id], |row| Ok(SessionLaunch { id: row.get(0)?, project_id: row.get(1)?, project_name: row.get(2)?, project_path: row.get(3)?, omp_session_path: row.get(4)? })).optional().map_err(StudioError::from))
    }

    pub fn recent_sessions(&self, active_id: Option<&str>) -> StudioResult<Vec<StoredSession>> {
        self.with_connection(|connection| { let mut statement = connection.prepare("SELECT id,title,project_id,updated_at,omp_session_path FROM sessions ORDER BY updated_at DESC LIMIT 100")?; let rows = statement.query_map([], |row| { let id: String = row.get(0)?; Ok(StoredSession { active: active_id == Some(id.as_str()), id, title: row.get(1)?, project_id: row.get(2)?, updated_at: row.get(3)?, omp_session_path: row.get(4)? }) })?; rows.collect::<Result<Vec<_>, _>>().map_err(StudioError::from) })
    }

    pub fn put_json<T: Serialize>(&self, scope: &str, key: &str, value: &T) -> StudioResult<()> {
        let value = serde_json::to_string(value)?;
        self.with_connection(|connection| { connection.execute("INSERT INTO settings(scope,key,value,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![scope, key, value, Utc::now().to_rfc3339()])?; Ok(()) })
    }

    pub fn get_json<T: DeserializeOwned>(&self, scope: &str, key: &str) -> StudioResult<Option<T>> {
        self.with_connection(|connection| { let value: Option<String> = connection.query_row("SELECT value FROM settings WHERE scope=?1 AND key=?2", params![scope,key], |row| row.get(0)).optional()?; value.map(|raw| serde_json::from_str(&raw).map_err(StudioError::from)).transpose() })
    }

    pub fn prune_caches(&self, max_mb: u32) -> StudioResult<()> {
        let table_budget = i64::from(max_mb) * 1024 * 1024 / 2;
        self.with_connection(|connection| {
            connection.execute("DELETE FROM usage_cache WHERE cache_key IN (SELECT cache_key FROM (SELECT cache_key, SUM(LENGTH(value)) OVER (ORDER BY fetched_at DESC ROWS UNBOUNDED PRECEDING) AS used FROM usage_cache) WHERE used > ?1)", [table_budget])?;
            connection.execute("DELETE FROM catalog_cache WHERE cache_key IN (SELECT cache_key FROM (SELECT cache_key, SUM(LENGTH(value)) OVER (ORDER BY fetched_at DESC ROWS UNBOUNDED PRECEDING) AS used FROM catalog_cache) WHERE used > ?1)", [table_budget])?; Ok(())
        })
    }

    pub fn begin_reset(&self, idempotency_key: &str, credential_id: &str, credit_id: &str) -> StudioResult<ResetAttempt> {
        self.with_connection(|connection| {
            let existing: Option<Option<String>> = connection.query_row("SELECT outcome FROM reset_attempts WHERE idempotency_key=?1", [idempotency_key], |row| row.get(0)).optional()?;
            if let Some(outcome) = existing { return Ok(outcome.map(ResetAttempt::Completed).unwrap_or(ResetAttempt::Pending)); }
            connection.execute("INSERT INTO reset_attempts(idempotency_key,credential_id,credit_id,created_at) VALUES (?1,?2,?3,?4)", params![idempotency_key, credential_id, credit_id, Utc::now().to_rfc3339()])?;
            Ok(ResetAttempt::New)
        })
    }

    pub fn finish_reset(&self, idempotency_key: &str, outcome: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("UPDATE reset_attempts SET outcome=?2 WHERE idempotency_key=?1", params![idempotency_key,outcome])?; Ok(()) })
    }

    pub fn cancel_reset(&self, idempotency_key: &str) -> StudioResult<()> {
        self.with_connection(|connection| { connection.execute("DELETE FROM reset_attempts WHERE idempotency_key=?1 AND outcome IS NULL", [idempotency_key])?; Ok(()) })
    }

    fn with_connection<T>(&self, operation: impl FnOnce(&Connection) -> StudioResult<T>) -> StudioResult<T> {
        let connection = self.connection.lock().map_err(|_| StudioError::Storage(rusqlite::Error::InvalidQuery))?; operation(&connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn persists_json_settings() { let database = Database::open(Path::new(":memory:")).unwrap(); database.put_json("global", "value", &vec![1,2]).unwrap(); assert_eq!(database.get_json::<Vec<i32>>("global", "value").unwrap(), Some(vec![1,2])); }
    #[test] fn migrates_and_persists_history() { let database = Database::open(Path::new(":memory:")).unwrap(); database.save_project("project-1", "Project", "/tmp/project").unwrap(); database.save_session("session-1", "project-1", "New session", Some("/tmp/session.jsonl")).unwrap(); database.update_session_title("session-1", "First prompt").unwrap(); assert_eq!(database.recent_projects().unwrap()[0].id, "project-1"); let sessions = database.recent_sessions(Some("session-1")).unwrap(); assert_eq!(sessions[0].project_id, "project-1"); assert_eq!(sessions[0].title, "First prompt"); assert!(sessions[0].active); let launch = database.session_launch("session-1").unwrap().unwrap(); assert_eq!(launch.omp_session_path.as_deref(), Some("/tmp/session.jsonl")); let version: u32 = database.with_connection(|connection| Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)).unwrap(); assert_eq!(version, 2); }
    #[test] fn mirroring_a_name_does_not_reorder_history() { let database = Database::open(Path::new(":memory:")).unwrap(); database.save_project("project-1", "Project", "/tmp/project").unwrap(); database.save_session("old", "project-1", "Old", Some("/tmp/old.jsonl")).unwrap(); database.save_session("recent", "project-1", "Recent", Some("/tmp/recent.jsonl")).unwrap(); database.sync_session_title("old", "Renamed by OMP").unwrap(); let sessions = database.recent_sessions(None).unwrap(); assert_eq!(sessions[0].id, "recent"); assert_eq!(sessions[1].title, "Renamed by OMP"); assert_eq!(sessions[1].omp_session_path.as_deref(), Some("/tmp/old.jsonl")); }
    #[test] fn cancelled_reset_can_retry() { let database = Database::open(Path::new(":memory:")).unwrap(); assert!(matches!(database.begin_reset("attempt", "credential", "credit").unwrap(), ResetAttempt::New)); assert!(matches!(database.begin_reset("attempt", "credential", "credit").unwrap(), ResetAttempt::Pending)); database.cancel_reset("attempt").unwrap(); assert!(matches!(database.begin_reset("attempt", "credential", "credit").unwrap(), ResetAttempt::New)); }
}
