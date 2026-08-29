//! Session JSONL 导出（WI-12）
//!
//! 将单个 Chat V2 会话导出为一行一个 JSON 对象的 JSONL 时间线，
//! 供离线回放、外部分析与数据携带使用。
//!
//! 格式规范（记录类型、行序状态机、脱敏与 round-trip 验收标准）见
//! `docs/dev/optimization0824/WI-12-session-jsonl-spec.md`。
//!
//! ## 实现要点
//! - 行序状态机 `header (message block*)* compaction* footer`，逐行流式写出
//!   （`io::Write`），块按消息逐条加载（`get_message_blocks_with_conn`，
//!   `block_index` 升序），内存峰值 O(单条消息) 的块数据；
//! - 嵌入对象直接复用 `types.rs` 的 serde 序列化（camelCase），不另定义
//!   消息 schema；
//! - 默认脱敏（`redactSecrets=true`）：`task_audit::redact_secrets` 递归打码
//!   秘钥字段与 URL 内 token/password，`_meta` / 变体 meta 经
//!   `without_skill_runtime_contents` 剥离技能全文快照，附件剥离
//!   `previewUrl`（不内联 base64）；`redactSecrets=false` 仅供本机调试，
//!   此时导出与 `load_session_full_v2` 严格 round-trip 等价；
//! - `blockIds` 引用但 DB 缺失的块：跳过并记日志，不中断导出。

use std::collections::HashSet;
use std::io::Write;

use chrono::{SecondsFormat, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::database::ChatV2Database;
use super::error::{ChatV2Error, ChatV2Result};
use super::repo::ChatV2Repo;
use super::task_audit::redact_secrets;
use super::types::{ChatMessage, MessageMeta};

/// 导出文件 header 行声明的 schema 版本（见规范 §3.1）。
pub const SESSION_EXPORT_SCHEMA_VERSION: u32 = 1;

/// 导出参数（会被原样回显进 header 行的 `options` 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionExportOptions {
    /// true：全量导出 `message.variants` 及所有变体的块；
    /// false：只保留 active 变体链（`ChatMessage::get_active_block_ids` 语义）。
    pub include_all_variants: bool,
    /// 是否在 header 中嵌入 `SessionState`（chat 参数 / features 等）。
    pub include_session_state: bool,
    /// 是否导出 `compaction` 记录行。
    pub include_compactions: bool,
    /// 是否对 toolInput/toolOutput 等做秘钥打码 + 技能全文快照剥离（规范 §5.2）。
    /// 默认开启；关闭仅供本机调试。
    pub redact_secrets: bool,
}

impl Default for SessionExportOptions {
    fn default() -> Self {
        Self {
            include_all_variants: true,
            include_session_state: true,
            include_compactions: true,
            redact_secrets: true,
        }
    }
}

/// 导出结果摘要，与 footer 行字段一致（规范 §3.5），供调用方直接回传前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportSummary {
    pub session_id: String,
    pub schema_version: u32,
    pub message_count: u32,
    pub block_count: u32,
    pub compaction_count: u32,
    /// 实际写出的字节数（含换行符）。
    pub bytes_written: u64,
    /// v1 实现不主动截断，恒为 false；保留给未来「预算内导出」。
    pub truncated: bool,
}

/// 将 `session_id` 对应的会话按 JSONL 规范流式写入 `writer`。
///
/// ## 契约（规范 §6）
/// - 逐行写出 `header (message block*)* compaction* footer`，禁止整文件缓冲；
/// - 会话不存在 ⇒ `ChatV2Error::SessionNotFound`；
/// - 写入失败 ⇒ `ChatV2Error::IoError`；
/// - `blockIds` 引用了 DB 缺失块时跳过并记日志，不中断导出。
///
/// 数据全部经由 `ChatV2Repo` 的既有访问器读取，嵌入对象直接复用
/// `types.rs` 的 serde 序列化，不另定义消息 schema。
pub fn export_session_jsonl<W: Write>(
    db: &ChatV2Database,
    session_id: &str,
    options: &SessionExportOptions,
    writer: &mut W,
) -> ChatV2Result<SessionExportSummary> {
    let conn = db.get_conn_safe()?;
    export_session_jsonl_with_conn(&conn, session_id, options, writer)
}

/// `export_session_jsonl` 的连接级实现（repo 惯例的 `_with_conn` 变体）。
pub fn export_session_jsonl_with_conn<W: Write>(
    conn: &Connection,
    session_id: &str,
    options: &SessionExportOptions,
    writer: &mut W,
) -> ChatV2Result<SessionExportSummary> {
    let session = ChatV2Repo::get_session_with_conn(conn, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    let mut bytes_written: u64 = 0;

    // ---- header（规范 §3.1）----
    let mut header = serde_json::json!({
        "type": "header",
        "schemaVersion": SESSION_EXPORT_SCHEMA_VERSION,
        "exportedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        "generator": {
            "app": "deep-student",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "options": options,
        "session": to_export_value(&session, options.redact_secrets)?,
    });
    if options.include_session_state {
        if let Some(state) = ChatV2Repo::load_session_state_with_conn(conn, session_id)? {
            header["state"] = to_export_value(&state, options.redact_secrets)?;
        }
    }
    write_record(writer, &header, &mut bytes_written)?;

    // ---- message + block 行（规范 §3.2 / §3.3）----
    let messages = ChatV2Repo::get_session_messages_with_conn(conn, session_id)?;
    let mut message_count: u32 = 0;
    let mut block_count: u32 = 0;

    for message in &messages {
        let record = serde_json::json!({
            "type": "message",
            "message": message_export_value(message, options)?,
        });
        write_record(writer, &record, &mut bytes_written)?;
        message_count += 1;

        // 块按 block_index 升序紧跟所属消息（物理行序仅为流式友好，
        // 渲染顺序权威仍是 blockIds，见规范 §5.3）。
        let db_blocks = ChatV2Repo::get_message_blocks_with_conn(conn, &message.id)?;
        let present: HashSet<&str> = db_blocks.iter().map(|b| b.id.as_str()).collect();
        let referenced = referenced_block_ids(message, options.include_all_variants);
        for block_id in &referenced {
            if !present.contains(block_id) {
                log::warn!(
                    "[ChatV2::session_export] session {} message {} references missing block {}; skipped",
                    session_id,
                    message.id,
                    block_id
                );
            }
        }

        for block in &db_blocks {
            if !options.include_all_variants && !referenced.contains(block.id.as_str()) {
                // 非激活变体的块在 includeAllVariants=false 时不导出（规范 §5.1）。
                continue;
            }
            let record = serde_json::json!({
                "type": "block",
                "messageId": message.id,
                "block": to_export_value(block, options.redact_secrets)?,
            });
            write_record(writer, &record, &mut bytes_written)?;
            block_count += 1;
        }
    }

    // ---- compaction 行（规范 §3.4）----
    let mut compaction_count: u32 = 0;
    if options.include_compactions {
        for compaction in ChatV2Repo::list_compactions_with_conn(conn, session_id)? {
            let record = serde_json::json!({
                "type": "compaction",
                "record": to_export_value(&compaction, options.redact_secrets)?,
            });
            write_record(writer, &record, &mut bytes_written)?;
            compaction_count += 1;
        }
    }

    // ---- footer（规范 §3.5）----
    let footer = serde_json::json!({
        "type": "footer",
        "messageCount": message_count,
        "blockCount": block_count,
        "compactionCount": compaction_count,
        "truncated": false,
    });
    write_record(writer, &footer, &mut bytes_written)?;
    writer.flush().map_err(io_error)?;

    Ok(SessionExportSummary {
        session_id: session.id,
        schema_version: SESSION_EXPORT_SCHEMA_VERSION,
        message_count,
        block_count,
        compaction_count,
        bytes_written,
        truncated: false,
    })
}

/// 序列化一行记录并写出（含 `\n`），累加实际字节数。
fn write_record<W: Write>(
    writer: &mut W,
    record: &Value,
    bytes_written: &mut u64,
) -> ChatV2Result<()> {
    // serde_json 会转义字符串内换行，单行内不会出现裸 `\n`（规范 §2）。
    let line = serde_json::to_string(record)?;
    writer.write_all(line.as_bytes()).map_err(io_error)?;
    writer.write_all(b"\n").map_err(io_error)?;
    *bytes_written += line.len() as u64 + 1;
    Ok(())
}

fn io_error(e: std::io::Error) -> ChatV2Error {
    ChatV2Error::IoError(e.to_string())
}

/// serde 序列化 + 可选递归脱敏（`task_audit::redact_secrets`）。
fn to_export_value<T: Serialize>(value: &T, redact: bool) -> ChatV2Result<Value> {
    let mut json = serde_json::to_value(value)?;
    if redact {
        redact_secrets(&mut json);
    }
    Ok(json)
}

/// 生成 message 行的嵌入对象：变体裁剪（§5.1）+ 脱敏（§5.2）。
fn message_export_value(
    message: &ChatMessage,
    options: &SessionExportOptions,
) -> ChatV2Result<Value> {
    let mut message = message.clone();

    if !options.include_all_variants {
        // 只保留激活变体；找不到激活项时整体回退主干 blockIds
        // （与 get_active_block_ids 的回退语义一致）。
        if let Some(variants) = message.variants.take() {
            let active_id = message.active_variant_id.clone();
            let active: Vec<_> = variants
                .into_iter()
                .filter(|v| Some(v.id.as_str()) == active_id.as_deref())
                .collect();
            message.variants = if active.is_empty() {
                None
            } else {
                Some(active)
            };
        }
    }

    if options.redact_secrets {
        message.meta = message
            .meta
            .as_ref()
            .map(MessageMeta::without_skill_runtime_contents);
        if let Some(variants) = &mut message.variants {
            for variant in variants.iter_mut() {
                *variant = variant.without_skill_runtime_contents();
            }
        }
    }

    let mut json = serde_json::to_value(&message)?;
    if options.redact_secrets {
        strip_attachment_previews(&mut json);
        redact_secrets(&mut json);
    }
    Ok(json)
}

/// 附件只保留 `AttachmentMeta` 引用字段，剥离可能内联 base64 的 previewUrl
/// （与 canonical_content「稳定引用而非持久化 base64」的设计对齐，规范 §5.2）。
fn strip_attachment_previews(message_json: &mut Value) {
    if let Some(attachments) = message_json
        .get_mut("attachments")
        .and_then(Value::as_array_mut)
    {
        for attachment in attachments {
            if let Some(fields) = attachment.as_object_mut() {
                fields.remove("previewUrl");
            }
        }
    }
}

/// 消息声明引用的块 ID 集合（用于缺块日志与激活链过滤）。
fn referenced_block_ids(message: &ChatMessage, include_all_variants: bool) -> HashSet<&str> {
    if include_all_variants {
        let mut ids: HashSet<&str> = message.block_ids.iter().map(String::as_str).collect();
        if let Some(variants) = &message.variants {
            for variant in variants {
                ids.extend(variant.block_ids.iter().map(String::as_str));
            }
        }
        ids
    } else {
        message
            .get_active_block_ids()
            .iter()
            .map(String::as_str)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::chat_v2::repo::ChatV2Repo;
    use crate::chat_v2::types::{
        variant_status, AttachmentMeta, ChatMessage, ChatSession, CompactionRecord, MessageBlock,
        MessageMeta, ReplaySkillPayloadSnapshot, SessionState, Variant,
    };

    /// 默认参数即规范推荐档：全变体 + 状态 + 压缩记录 + 脱敏。
    #[test]
    fn default_options_match_spec_defaults() {
        let opts = SessionExportOptions::default();
        assert!(opts.include_all_variants);
        assert!(opts.include_session_state);
        assert!(opts.include_compactions);
        assert!(opts.redact_secrets);
        assert_eq!(SESSION_EXPORT_SCHEMA_VERSION, 1);
    }

    /// options 走 camelCase + default，前端可只传增量字段。
    #[test]
    fn options_deserialize_from_partial_camel_case_json() {
        let opts: SessionExportOptions =
            serde_json::from_str(r#"{"includeAllVariants":false}"#).unwrap();
        assert!(!opts.include_all_variants);
        assert!(opts.redact_secrets, "未显式关闭时脱敏必须保持默认开启");
    }

    // ------------------------------------------------------------------
    // 测试基建：生产一致迁移路径的临时库 + 富会话夹具
    // ------------------------------------------------------------------

    fn setup_chat_db() -> (tempfile::TempDir, ChatV2Database) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::tempdir().expect("create ChatV2 test directory");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("apply production ChatV2 migrations");
        let db = ChatV2Database::new(temp_dir.path()).expect("open migrated ChatV2 database");
        (temp_dir, db)
    }

    const SESSION_ID: &str = "sess_export_fixture";
    const USER_MSG_ID: &str = "msg_export_user";
    const ASSISTANT_MSG_ID: &str = "msg_export_assistant";
    const ACTIVE_VARIANT_ID: &str = "var_active";
    const INACTIVE_VARIANT_ID: &str = "var_inactive";
    const SECRET_API_KEY: &str = "sk-secret-abc123";
    const SECRET_URL: &str = "https://user:hunter2@example.test/data?token=leaked&safe=yes";
    const SKILL_BODY: &str = "FULL SKILL BODY: never persist in exports";
    const PREVIEW_BASE64: &str = "data:image/png;base64,AAAABBBB";

    /// 含多变体 + 工具块（带秘钥）+ 附件 + 会话状态 + 压缩记录的会话，
    /// 覆盖规范 §7 验收标准所需的全部形态。
    fn seed_rich_session(db: &ChatV2Database) {
        let mut session = ChatSession::new(SESSION_ID.to_string(), "general_chat".to_string());
        session.title = Some("Export fixture".to_string());
        session.metadata = Some(json!({"origin": "unit-test"}));
        ChatV2Repo::create_session_v2(db, &session).expect("persist session");

        // 会话状态：input_value 带 URL 秘钥，验证 header.state 也被脱敏。
        let state = SessionState {
            session_id: SESSION_ID.to_string(),
            chat_params: None,
            features: Some(HashMap::from([("webSearch".to_string(), true)])),
            mode_state: None,
            input_value: Some(SECRET_URL.to_string()),
            panel_states: None,
            updated_at: "2026-08-24T00:00:00Z".to_string(),
            pending_context_refs_json: None,
            loaded_skill_ids_json: None,
            active_skill_ids_json: None,
            skill_state_json: None,
        };
        ChatV2Repo::save_session_state_v2(db, SESSION_ID, &state).expect("persist state");

        // 用户消息：内容块 + 附件（previewUrl 内联 base64）。
        let mut user = ChatMessage::new_user(SESSION_ID.to_string(), Vec::new());
        user.id = USER_MSG_ID.to_string();
        user.timestamp = 1_000;
        let mut user_block = MessageBlock::new_content(user.id.clone(), 0);
        user_block.id = "blk_user_content".to_string();
        user_block.content = Some("please search this".to_string());
        user_block.set_success();
        user.block_ids = vec![user_block.id.clone()];
        user.attachments = Some(vec![AttachmentMeta {
            id: "att_1".to_string(),
            name: "notes.png".to_string(),
            r#type: "image".to_string(),
            mime_type: "image/png".to_string(),
            size: 8,
            preview_url: Some(PREVIEW_BASE64.to_string()),
            status: "ready".to_string(),
            error: None,
        }]);
        ChatV2Repo::create_message_v2(db, &user).expect("persist user message");
        ChatV2Repo::create_block_v2(db, &user_block).expect("persist user block");

        // 助手消息：双变体。激活变体含 thinking + content + 带秘钥的工具块，
        // 非激活变体一个 content 块；_meta 与变体 meta 均带技能全文快照。
        let skill_runtime = ReplaySkillPayloadSnapshot {
            active_skill_ids: vec!["skill-a".to_string()],
            execution_allowed_tools: None,
            skill_contents: HashMap::from([("skill-a".to_string(), SKILL_BODY.to_string())]),
            skill_dependencies: HashMap::new(),
            skill_embedded_tools: HashMap::new(),
            mcp_tool_schemas: Vec::new(),
            selected_mcp_servers: Vec::new(),
        };

        let mut assistant = ChatMessage::new_assistant(SESSION_ID.to_string());
        assistant.id = ASSISTANT_MSG_ID.to_string();
        assistant.timestamp = 2_000;
        assistant.meta = Some(MessageMeta {
            model_id: Some("model-x".to_string()),
            chat_params: Some(json!({"temperature": 0.5, "apiKey": SECRET_API_KEY})),
            skill_runtime_before: Some(skill_runtime.clone()),
            ..MessageMeta::default()
        });

        let mut thinking = MessageBlock::new_thinking(assistant.id.clone(), 0);
        thinking.id = "blk_active_thinking".to_string();
        thinking.content = Some("private reasoning".to_string());
        thinking.set_success();

        let mut answer = MessageBlock::new_content(assistant.id.clone(), 1);
        answer.id = "blk_active_answer".to_string();
        answer.content = Some("final answer".to_string());
        answer.set_success();

        let mut tool = MessageBlock::new_tool(
            assistant.id.clone(),
            "web_search",
            json!({"query": "rust jsonl", "apiKey": SECRET_API_KEY}),
            2,
        );
        tool.id = "blk_active_tool".to_string();
        tool.tool_output = Some(json!({"url": SECRET_URL, "hits": 3}));
        tool.set_success();

        let mut inactive_answer = MessageBlock::new_content(assistant.id.clone(), 3);
        inactive_answer.id = "blk_inactive_answer".to_string();
        inactive_answer.content = Some("alternative answer".to_string());
        inactive_answer.set_success();

        let mut active_variant =
            Variant::new_with_id(ACTIVE_VARIANT_ID.to_string(), "model-x".to_string());
        active_variant.block_ids = vec![thinking.id.clone(), answer.id.clone(), tool.id.clone()];
        active_variant.status = variant_status::SUCCESS.to_string();
        active_variant.created_at = 2_000;

        let mut inactive_variant =
            Variant::new_with_id(INACTIVE_VARIANT_ID.to_string(), "model-y".to_string());
        inactive_variant.block_ids = vec![inactive_answer.id.clone()];
        inactive_variant.status = variant_status::SUCCESS.to_string();
        inactive_variant.created_at = 2_001;

        assistant.block_ids = active_variant.block_ids.clone();
        assistant.active_variant_id = Some(ACTIVE_VARIANT_ID.to_string());
        assistant.variants = Some(vec![active_variant, inactive_variant]);
        ChatV2Repo::create_message_v2(db, &assistant).expect("persist assistant message");
        for block in [&thinking, &answer, &tool, &inactive_answer] {
            ChatV2Repo::create_block_v2(db, block).expect("persist assistant block");
        }

        // 压缩记录。
        let compaction = CompactionRecord {
            id: "cmp_export_1".to_string(),
            session_id: SESSION_ID.to_string(),
            summary_message_id: ASSISTANT_MSG_ID.to_string(),
            tail_start_message_id: USER_MSG_ID.to_string(),
            tail_start_time_created: 1_000,
            reason: "auto".to_string(),
            is_auto: true,
            is_overflow: false,
            tokens_before: Some(1_200),
            tokens_after: Some(300),
            model_id: Some("model-x".to_string()),
            model_config_id: None,
            previous_compaction_id: None,
            range_start_message_id: None,
            range_end_message_id: None,
            compacted_message_count: Some(1),
            created_at: 3_000,
        };
        let conn = db.get_conn_safe().expect("get conn");
        ChatV2Repo::create_compaction_with_conn(&conn, &compaction).expect("persist compaction");
    }

    fn export_to_lines(
        db: &ChatV2Database,
        options: &SessionExportOptions,
    ) -> (SessionExportSummary, Vec<Value>, String) {
        let mut buffer: Vec<u8> = Vec::new();
        let summary = export_session_jsonl(db, SESSION_ID, options, &mut buffer)
            .expect("export should succeed");
        let text = String::from_utf8(buffer).expect("export must be valid UTF-8");
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("every line must be one JSON object"))
            .collect();
        (summary, lines, text)
    }

    fn line_type(line: &Value) -> &str {
        line["type"].as_str().expect("record must carry type")
    }

    // ------------------------------------------------------------------
    // 验收 §7.1：行序状态机 + footer 计数
    // ------------------------------------------------------------------

    #[test]
    fn export_line_order_and_footer_counts() {
        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let (summary, lines, text) = export_to_lines(&db, &SessionExportOptions::default());

        // header 恰为首行，footer 恰为末行。
        assert_eq!(line_type(&lines[0]), "header");
        assert_eq!(lines[0]["schemaVersion"], 1);
        assert_eq!(lines[0]["session"]["id"], SESSION_ID);
        assert_eq!(lines[0]["options"]["redactSecrets"], true);
        assert_eq!(lines[0]["generator"]["app"], "deep-student");
        assert!(
            lines[0]["state"].is_object(),
            "includeSessionState=true 时 header 必须嵌入 state"
        );
        assert_eq!(line_type(lines.last().unwrap()), "footer");

        // 行序满足 header (message block*)* compaction* footer 状态机，
        // 且每个 block 行归属其前面最近的 message 行。
        let mut current_message_id: Option<String> = None;
        let mut seen_compaction = false;
        let mut message_lines = 0u32;
        let mut block_lines = 0u32;
        let mut compaction_lines = 0u32;
        for line in &lines[1..lines.len() - 1] {
            match line_type(line) {
                "message" => {
                    assert!(!seen_compaction, "message 行不得出现在 compaction 之后");
                    current_message_id = Some(line["message"]["id"].as_str().unwrap().to_string());
                    message_lines += 1;
                }
                "block" => {
                    assert!(!seen_compaction, "block 行不得出现在 compaction 之后");
                    let owner = current_message_id
                        .as_deref()
                        .expect("block 行前必须已有 message 行");
                    assert_eq!(line["messageId"], owner);
                    assert_eq!(line["block"]["messageId"], owner);
                    block_lines += 1;
                }
                "compaction" => {
                    seen_compaction = true;
                    compaction_lines += 1;
                }
                other => panic!("unexpected record type in body: {}", other),
            }
        }

        // 全变体导出：1 用户块 + 激活变体 3 块 + 非激活变体 1 块 = 5。
        let footer = lines.last().unwrap();
        assert_eq!(footer["messageCount"], 2);
        assert_eq!(footer["blockCount"], 5);
        assert_eq!(footer["compactionCount"], 1);
        assert_eq!(footer["truncated"], false);
        assert_eq!(message_lines, 2);
        assert_eq!(block_lines, 5);
        assert_eq!(compaction_lines, 1);

        // summary 与 footer 一致，bytes_written 为实际输出字节数。
        assert_eq!(summary.session_id, SESSION_ID);
        assert_eq!(summary.schema_version, 1);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.block_count, 5);
        assert_eq!(summary.compaction_count, 1);
        assert!(!summary.truncated);
        assert_eq!(summary.bytes_written, text.len() as u64);
    }

    /// 空会话仍必须生成可校验的 header + footer，所有计数为零。
    #[test]
    fn export_empty_session_writes_header_and_zero_count_footer() {
        let (_tmp, db) = setup_chat_db();
        let session = ChatSession::new(SESSION_ID.to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_v2(&db, &session).expect("persist empty session");

        let (summary, lines, text) = export_to_lines(&db, &SessionExportOptions::default());

        assert_eq!(lines.len(), 2, "空会话只能写出 header 与 footer");
        assert_eq!(line_type(&lines[0]), "header");
        assert_eq!(lines[0]["session"]["id"], SESSION_ID);
        assert!(
            lines[0].get("state").is_none(),
            "没有持久化状态时不得写出空 state"
        );

        let footer = &lines[1];
        assert_eq!(line_type(footer), "footer");
        assert_eq!(footer["messageCount"], 0);
        assert_eq!(footer["blockCount"], 0);
        assert_eq!(footer["compactionCount"], 0);
        assert_eq!(footer["truncated"], false);

        assert_eq!(summary.session_id, SESSION_ID);
        assert_eq!(summary.message_count, 0);
        assert_eq!(summary.block_count, 0);
        assert_eq!(summary.compaction_count, 0);
        assert!(!summary.truncated);
        assert_eq!(summary.bytes_written, text.len() as u64);
        assert!(text.ends_with('\n'), "JSONL 末行必须以 LF 结束");
    }

    // ------------------------------------------------------------------
    // 验收 §7.2：redact 关闭时与 load_session_full_v2 严格 round-trip
    // ------------------------------------------------------------------

    #[test]
    fn export_round_trips_against_load_session_full() {
        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let options = SessionExportOptions {
            redact_secrets: false,
            ..SessionExportOptions::default()
        };
        let (_summary, lines, _text) = export_to_lines(&db, &options);

        let expected = ChatV2Repo::load_session_full_v2(&db, SESSION_ID).expect("load full");

        // session / state 与 header 嵌入对象逐字段等价。
        assert_eq!(
            lines[0]["session"],
            serde_json::to_value(&expected.session).unwrap()
        );
        assert_eq!(
            lines[0]["state"],
            serde_json::to_value(expected.state.as_ref().expect("state seeded")).unwrap()
        );

        // messages 按序等价。
        let exported_messages: Vec<Value> = lines
            .iter()
            .filter(|l| line_type(l) == "message")
            .map(|l| l["message"].clone())
            .collect();
        let expected_messages: Vec<Value> = expected
            .messages
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        assert_eq!(exported_messages, expected_messages);

        // blocks 集合等价（物理行序不同：导出按消息分组，忽略顺序按 id 对齐）。
        let mut exported_blocks: Vec<Value> = lines
            .iter()
            .filter(|l| line_type(l) == "block")
            .map(|l| l["block"].clone())
            .collect();
        let mut expected_blocks: Vec<Value> = expected
            .blocks
            .iter()
            .map(|b| serde_json::to_value(b).unwrap())
            .collect();
        let by_id = |v: &Value| v["id"].as_str().unwrap().to_string();
        exported_blocks.sort_by_key(by_id);
        expected_blocks.sort_by_key(by_id);
        assert_eq!(exported_blocks, expected_blocks);
    }

    // ------------------------------------------------------------------
    // 验收 §7.3：默认脱敏
    // ------------------------------------------------------------------

    #[test]
    fn export_redacts_secrets_by_default() {
        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let (_summary, lines, text) = export_to_lines(&db, &SessionExportOptions::default());

        // 秘钥值（API key、URL password、URL token）与技能全文、base64 预览均不得出现。
        assert!(!text.contains(SECRET_API_KEY), "apiKey 值必须被打码");
        assert!(!text.contains("hunter2"), "URL password 必须被打码");
        assert!(!text.contains("token=leaked"), "URL token 参数必须被打码");
        assert!(!text.contains(SKILL_BODY), "技能全文快照必须被剥离");
        assert!(
            !text.contains(PREVIEW_BASE64),
            "附件 previewUrl 不得内联导出"
        );
        // 非敏感内容保持原样。
        assert!(text.contains("safe=yes"), "非敏感 query 参数应保留");
        assert!(text.contains("final answer"));
        assert!(text.contains("[REDACTED]"));

        // 技能快照只留骨架：activeSkillIds 保留，skillContents 清空。
        let assistant_line = lines
            .iter()
            .find(|l| line_type(l) == "message" && l["message"]["id"] == ASSISTANT_MSG_ID)
            .expect("assistant message exported");
        let runtime = &assistant_line["message"]["_meta"]["skillRuntimeBefore"];
        assert_eq!(runtime["activeSkillIds"], json!(["skill-a"]));
        assert!(
            runtime.get("skillContents").is_none(),
            "skillContents 剥离后（空 map skip 序列化）不得出现"
        );

        // 附件保留引用字段。
        let user_line = lines
            .iter()
            .find(|l| line_type(l) == "message" && l["message"]["id"] == USER_MSG_ID)
            .expect("user message exported");
        let attachment = &user_line["message"]["attachments"][0];
        assert_eq!(attachment["name"], "notes.png");
        assert_eq!(attachment["mimeType"], "image/png");
        assert!(attachment.get("previewUrl").is_none());
    }

    // ------------------------------------------------------------------
    // 变体裁剪（规范 §5.1）
    // ------------------------------------------------------------------

    #[test]
    fn export_active_variant_only_prunes_variants_and_blocks() {
        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let options = SessionExportOptions {
            include_all_variants: false,
            ..SessionExportOptions::default()
        };
        let (summary, lines, text) = export_to_lines(&db, &options);

        // 消息行只保留激活变体。
        let assistant_line = lines
            .iter()
            .find(|l| line_type(l) == "message" && l["message"]["id"] == ASSISTANT_MSG_ID)
            .expect("assistant message exported");
        let variants = assistant_line["message"]["variants"]
            .as_array()
            .expect("variants pruned but present");
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0]["id"], ACTIVE_VARIANT_ID);

        // 非激活变体的块不导出：1 用户块 + 激活变体 3 块 = 4。
        assert_eq!(summary.block_count, 4);
        assert!(!text.contains("blk_inactive_answer"));
        assert!(!text.contains("alternative answer"));
        assert_eq!(lines.last().unwrap()["blockCount"], 4);
    }

    // ------------------------------------------------------------------
    // 容错与错误路径
    // ------------------------------------------------------------------

    /// 会话不存在时返回 SessionNotFound 而非空文件。
    #[test]
    fn export_missing_session_returns_session_not_found() {
        let (_tmp, db) = setup_chat_db();

        let mut buffer: Vec<u8> = Vec::new();
        let result = export_session_jsonl(
            &db,
            "sess_does_not_exist",
            &SessionExportOptions::default(),
            &mut buffer,
        );
        match result {
            Err(ChatV2Error::SessionNotFound(id)) => assert_eq!(id, "sess_does_not_exist"),
            other => panic!(
                "expected SessionNotFound, got {:?}",
                other.map(|s| s.session_id)
            ),
        }
        assert!(buffer.is_empty(), "会话不存在时不得写出任何行");
    }

    /// blockIds 引用了 DB 缺失块：跳过并继续导出，footer 计数只含实际写出的块。
    #[test]
    fn export_skips_missing_referenced_blocks() {
        let (_tmp, db) = setup_chat_db();

        let session = ChatSession::new(SESSION_ID.to_string(), "general_chat".to_string());
        ChatV2Repo::create_session_v2(&db, &session).expect("persist session");

        let mut message = ChatMessage::new_user(SESSION_ID.to_string(), Vec::new());
        message.id = "msg_ghost_ref".to_string();
        message.timestamp = 1_000;
        let mut real_block = MessageBlock::new_content(message.id.clone(), 0);
        real_block.id = "blk_real".to_string();
        real_block.content = Some("still exported".to_string());
        real_block.set_success();
        message.block_ids = vec![real_block.id.clone(), "blk_ghost_missing".to_string()];
        ChatV2Repo::create_message_v2(&db, &message).expect("persist message");
        ChatV2Repo::create_block_v2(&db, &real_block).expect("persist block");

        let (summary, lines, _text) = export_to_lines(&db, &SessionExportOptions::default());
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.block_count, 1, "缺失块跳过，不中断也不计数");
        let footer = lines.last().unwrap();
        assert_eq!(footer["blockCount"], 1);
        // message 行本身保留 blockIds 原貌（含缺失引用），供消费者自行发现。
        let message_line = &lines[1];
        assert_eq!(
            message_line["message"]["blockIds"],
            json!(["blk_real", "blk_ghost_missing"])
        );
    }

    /// header 可裁剪：不含 state；compaction 行可整体关闭。
    #[test]
    fn export_honors_state_and_compaction_toggles() {
        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let options = SessionExportOptions {
            include_session_state: false,
            include_compactions: false,
            ..SessionExportOptions::default()
        };
        let (summary, lines, _text) = export_to_lines(&db, &options);

        assert!(
            lines[0].get("state").is_none(),
            "includeSessionState=false 时 header 不得嵌入 state"
        );
        assert_eq!(summary.compaction_count, 0);
        assert!(lines.iter().all(|l| line_type(l) != "compaction"));
        assert_eq!(lines.last().unwrap()["compactionCount"], 0);
    }

    /// 写失败必须映射为 ChatV2Error::IoError（规范 §6）。
    #[test]
    fn export_write_failure_maps_to_io_error() {
        struct FailingWriter;
        impl Write for FailingWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let (_tmp, db) = setup_chat_db();
        seed_rich_session(&db);

        let result = export_session_jsonl(
            &db,
            SESSION_ID,
            &SessionExportOptions::default(),
            &mut FailingWriter,
        );
        assert!(
            matches!(result, Err(ChatV2Error::IoError(_))),
            "write failure must surface as IoError"
        );
    }
}
