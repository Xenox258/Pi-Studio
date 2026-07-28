use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// OMP caps a single RPC frame at 1 MiB. Under protocol v1 an oversized `response` is *replaced*
/// by an "RPC response exceeded the transport limit" error, which makes long sessions unreadable.
/// Protocol v2 instead splits the frame into ordered `rpc_chunk` frames that we rebuild here.
#[derive(Default)]
pub struct ChunkAssembler {
    active: Option<ChunkSequence>,
}

struct ChunkSequence {
    chunk_id: String,
    count: u64,
    byte_length: usize,
    next_index: u64,
    payload: Vec<u8>,
}

impl ChunkAssembler {
    /// Feeds one decoded stdout frame. Returns `Ok(None)` while a chunk sequence is still
    /// incomplete, and the rebuilt frame once its final chunk arrives.
    pub fn push(&mut self, raw: Value) -> Result<Option<Value>, String> {
        if raw.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            if self.active.take().is_some() { return Err("rpc chunk sequence interrupted".into()); }
            return Ok(Some(raw));
        }
        let chunk_id = raw.get("chunkId").and_then(Value::as_str).ok_or("rpc chunk is missing chunkId")?;
        let index = raw.get("index").and_then(Value::as_u64).ok_or("rpc chunk is missing index")?;
        let count = raw.get("count").and_then(Value::as_u64).ok_or("rpc chunk is missing count")?;
        let byte_length = raw.get("byteLength").and_then(Value::as_u64).ok_or("rpc chunk is missing byteLength")? as usize;
        let data = raw.get("data").and_then(Value::as_str).ok_or("rpc chunk is missing data")?;
        if chunk_id.is_empty() || chunk_id.len() > 128 || count < 2 || index >= count {
            self.active = None;
            return Err("invalid rpc chunk metadata".into());
        }
        let decoded = STANDARD.decode(data).map_err(|_| "invalid rpc chunk data".to_string())?;
        if self.active.is_none() {
            if index != 0 { return Err("rpc chunk sequence must start at index 0".into()); }
            self.active = Some(ChunkSequence { chunk_id: chunk_id.to_owned(), count, byte_length, next_index: 0, payload: Vec::with_capacity(byte_length) });
        }
        let sequence = self.active.as_mut().expect("sequence is active");
        if sequence.chunk_id != chunk_id || sequence.count != count || sequence.byte_length != byte_length || sequence.next_index != index {
            self.active = None;
            return Err("rpc chunk sequence mismatch".into());
        }
        sequence.payload.extend_from_slice(&decoded);
        sequence.next_index += 1;
        if sequence.payload.len() > sequence.byte_length {
            self.active = None;
            return Err("rpc chunk sequence exceeds declared length".into());
        }
        if sequence.next_index < sequence.count { return Ok(None); }
        let sequence = self.active.take().expect("sequence is active");
        if sequence.payload.len() != sequence.byte_length { return Err("rpc chunk sequence length mismatch".into()); }
        serde_json::from_slice(&sequence.payload).map(Some).map_err(|error| format!("rebuilt rpc frame is not valid JSON: {error}"))
    }
}

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
        Ok(Self::from_value(serde_json::from_str(line)?))
    }

    pub fn from_value(raw: Value) -> Self {
        let typed = serde_json::from_value(raw.clone()).unwrap_or(OmpFrame::Unknown);
        Self { typed, raw }
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

    fn chunk(id: &str, index: u64, count: u64, byte_length: usize, data: &[u8]) -> Value {
        serde_json::json!({ "type": "rpc_chunk", "chunkId": id, "index": index, "count": count, "byteLength": byte_length, "data": STANDARD.encode(data) })
    }

    #[test]
    fn passes_unchunked_frames_straight_through() {
        let mut assembler = ChunkAssembler::default();
        let frame = serde_json::json!({ "type": "ready" });
        assert_eq!(assembler.push(frame.clone()).unwrap(), Some(frame));
    }

    #[test]
    fn rebuilds_a_split_response() {
        let payload = br#"{"type":"response","id":"m1","command":"get_messages","success":true}"#;
        let (head, tail) = payload.split_at(30);
        let mut assembler = ChunkAssembler::default();
        assert_eq!(assembler.push(chunk("c1", 0, 2, payload.len(), head)).unwrap(), None);
        let rebuilt = assembler.push(chunk("c1", 1, 2, payload.len(), tail)).unwrap().expect("final chunk completes the frame");
        assert_eq!(rebuilt["command"], "get_messages");
        assert_eq!(rebuilt["success"], true);
    }

    #[test]
    fn rejects_out_of_order_and_interrupted_sequences() {
        let mut assembler = ChunkAssembler::default();
        assert!(assembler.push(chunk("c1", 1, 2, 10, b"tail")).is_err());

        let mut assembler = ChunkAssembler::default();
        assert_eq!(assembler.push(chunk("c1", 0, 2, 10, b"head")).unwrap(), None);
        assert!(assembler.push(serde_json::json!({ "type": "ready" })).is_err());
        // The aborted sequence must not poison the stream that follows it.
        assert_eq!(assembler.push(serde_json::json!({ "type": "ready" })).unwrap(), Some(serde_json::json!({ "type": "ready" })));
    }

    #[test]
    fn rejects_a_declared_length_mismatch() {
        let mut assembler = ChunkAssembler::default();
        assert_eq!(assembler.push(chunk("c1", 0, 2, 99, b"head")).unwrap(), None);
        assert!(assembler.push(chunk("c1", 1, 2, 99, b"tail")).is_err());
    }
}
