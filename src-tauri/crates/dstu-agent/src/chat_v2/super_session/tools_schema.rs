//! Super 会话 4 个工具的 schema（`McpToolSchema` 的 JSON 形态：`name` / `description` /
//! `inputSchema`，camelCase，可直接 `serde_json::from_value::<McpToolSchema>`）。
//!
//! 命名沿用内建工具惯例：schema 名带 `builtin-` 前缀（与 `builtin-subagent_call` 等一致），
//! `tool_descriptors.rs` 中的 descriptor 用裸名（`super_dispatch_worker` …）。

use serde_json::{json, Value};

pub const SUPER_DISPATCH_WORKER: &str = "builtin-super_dispatch_worker";
pub const SUPER_MESSAGE_WORKER: &str = "builtin-super_message_worker";
pub const SUPER_CLOSE_WORKER: &str = "builtin-super_close_worker";
pub const SUPER_LIST_WORKERS: &str = "builtin-super_list_workers";

pub const SUPER_TOOL_NAMES: [&str; 4] = [
    SUPER_DISPATCH_WORKER,
    SUPER_MESSAGE_WORKER,
    SUPER_CLOSE_WORKER,
    SUPER_LIST_WORKERS,
];

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

/// 4 个 Super 工具 schema，顺序与 [`SUPER_TOOL_NAMES`] 一致。
pub fn super_tool_schemas() -> Vec<Value> {
    vec![
        tool(
            SUPER_DISPATCH_WORKER,
            "Dispatch a background Worker for a self-contained task and return immediately (never waits). \
             The Worker runs in its own isolated context; its final result arrives later as an inbox event \
             message in this conversation. Use for multi-step research, retrieval, analysis or batch work. \
             Do not dispatch a second Worker for a task that already has one running — use super_message_worker instead.",
            json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short human-readable title for the task (shown to the user), e.g. \"整理本周错题\"."
                    },
                    "task": {
                        "type": "string",
                        "description": "Complete, self-contained brief: goal, scope, constraints and the expected deliverable. The Worker cannot see this conversation."
                    },
                    "context": {
                        "type": "string",
                        "description": "Optional extra background copied from the conversation (facts, ids, prior findings) the Worker needs."
                    },
                    "profile": {
                        "type": "string",
                        "description": "Optional Worker profile id. Default \"explorer\" (read-only retrieval and analysis)."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional model override for the Worker. Omit to use the profile default."
                    }
                },
                "required": ["title", "task"]
            }),
        ),
        tool(
            SUPER_MESSAGE_WORKER,
            "Send a follow-up instruction to an existing Worker (adds requirements, corrections or the user's follow-up question). \
             The Worker resumes with its previous context; its new result arrives later as an inbox event.",
            json!({
                "type": "object",
                "properties": {
                    "worker_id": {
                        "type": "string",
                        "description": "Worker id as listed in the Worker roster / super_list_workers."
                    },
                    "message": {
                        "type": "string",
                        "description": "The instruction to deliver to the Worker."
                    }
                },
                "required": ["worker_id", "message"]
            }),
        ),
        tool(
            SUPER_CLOSE_WORKER,
            "Stop and close a Worker that is no longer needed (task abandoned, superseded or finished). \
             A running Worker is cancelled; no further results will be reported for it.",
            json!({
                "type": "object",
                "properties": {
                    "worker_id": {
                        "type": "string",
                        "description": "Worker id to close."
                    }
                },
                "required": ["worker_id"]
            }),
        ),
        tool(
            SUPER_LIST_WORKERS,
            "List this conversation's Workers with id, title, status and latest result summary.",
            json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::McpToolSchema;

    #[test]
    fn schemas_match_names_and_deserialize() {
        let schemas = super_tool_schemas();
        assert_eq!(schemas.len(), SUPER_TOOL_NAMES.len());
        for (raw, name) in schemas.into_iter().zip(SUPER_TOOL_NAMES) {
            let parsed: McpToolSchema = serde_json::from_value(raw).expect("valid McpToolSchema");
            assert_eq!(parsed.name, name);
            assert!(parsed.server_id.is_none());
            assert!(parsed.description.as_deref().is_some_and(|d| !d.is_empty()));
            let input = parsed.input_schema.expect("input schema");
            assert_eq!(input["type"], "object");
            assert!(name.starts_with("builtin-super_"));
        }
    }

    #[test]
    fn dispatch_requires_title_and_task() {
        let dispatch = &super_tool_schemas()[0];
        assert_eq!(
            dispatch["inputSchema"]["required"],
            json!(["title", "task"])
        );
        for key in ["title", "task", "context", "profile", "model"] {
            assert!(
                dispatch["inputSchema"]["properties"].get(key).is_some(),
                "{key}"
            );
        }
    }
}
