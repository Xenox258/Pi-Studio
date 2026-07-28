use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OmpFrame {
    Ready,
    Response { id: Option<String>, command: String, success: bool, data: Option<Value>, error: Option<String> },
    AgentStart,
    AgentEnd { messages: Vec<Value> },
    MessageUpdate { #[serde(rename = "assistantMessageEvent")] assistant_message_event: Value, message: Value },
    ToolExecutionStart { #[serde(flatten)] payload: Value },
    ToolExecutionUpdate { #[serde(flatten)] payload: Value },
    ToolExecutionEnd { #[serde(flatten)] payload: Value },
    ExtensionUiRequest { id: String, method: String, #[serde(flatten)] payload: Value },
    UsageUpdated { snapshot: Value },
    WorkflowModeChanged { mode: String },
    AdvisorStateChanged { enabled: bool, status: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedOmpFrame {
    pub typed: OmpFrame,
    pub raw: Value,
}

impl ParsedOmpFrame {
    pub fn parse(line: &str) -> serde_json::Result<Self> {
        let raw: Value = serde_json::from_str(line)?;
        let typed = serde_json::from_value(raw.clone()).unwrap_or(OmpFrame::Unknown);
        Ok(Self { typed, raw })
    }


    pub fn is_ready(&self) -> bool {
        matches!(self.typed, OmpFrame::Ready)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_unknown_frames() {
        let frame = ParsedOmpFrame::parse(r#"{"type":"future_event","value":7}"#).unwrap();
        assert!(matches!(frame.typed, OmpFrame::Unknown));
        assert_eq!(frame.raw["value"], 7);
    }

    #[test]
    fn parses_response_id() {
        let frame = ParsedOmpFrame::parse(r#"{"type":"response","id":"r1","command":"ping","success":true}"#).unwrap();
        assert!(matches!(frame.typed, OmpFrame::Response { id: Some(ref id), .. } if id == "r1"));
    }
}
