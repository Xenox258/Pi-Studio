use thiserror::Error;

#[derive(Debug, Error)]
pub enum StudioError {
    #[error("OMP is not installed or could not be started: {0}")]
    OmpUnavailable(String),
    #[error("OMP RPC timed out while waiting for {0}")]
    Timeout(String),
    #[error("OMP RPC protocol error: {0}")]
    Protocol(String),
    #[error("OMP request failed: {0}")]
    Omp(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Project path is outside the opened project: {0}")]
    InvalidPath(String),
    #[error("Storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type StudioResult<T> = Result<T, StudioError>;

pub fn command_result<T>(result: StudioResult<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}
