//! Session JSONL 导出（WI-12 stub）
//!
//! 将单个 Chat V2 会话导出为一行一个 JSON 对象的 JSONL 时间线，
//! 供离线回放、外部分析与数据携带使用。
//!
//! 格式规范（记录类型、行序状态机、脱敏与 round-trip 验收标准）见
//! `docs/dev/optimization0824/WI-12-session-jsonl-spec.md`。
//!
//! 本模块当前只提供 API 骨架：类型 + 函数签名在编译期固定下来，
//! 实现体排期 R12+（调用会 `todo!` panic，尚未接入任何 command）。

use std::io::Write;

use serde::{Deserialize, Serialize};

use super::database::ChatV2Database;
use super::error::ChatV2Result;

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
/// 数据全部经由 `ChatV2Repo` 的 `*_v2` 访问器读取（get_session_v2 /
/// get_session_messages_v2 / get_session_blocks_v2 / list_compactions_with_conn），
/// 嵌入对象直接复用 `types.rs` 的 serde 序列化，不另定义消息 schema。
pub fn export_session_jsonl<W: Write>(
    db: &ChatV2Database,
    session_id: &str,
    options: &SessionExportOptions,
    writer: &mut W,
) -> ChatV2Result<SessionExportSummary> {
    let _ = (db, session_id, options, writer);
    todo!("WI-12 R12+: implement per docs/dev/optimization0824/WI-12-session-jsonl-spec.md")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    // WI-12 R12+ 实现轮占位（对应规范 §7 验收标准，实现前保持 ignore）
    // ------------------------------------------------------------------

    /// 验收 §7.1：行序满足 `header (message block*)* compaction* footer` 状态机，
    /// footer 计数与实际行数一致。
    #[test]
    #[ignore = "WI-12 stub：待 export_session_jsonl 实现（R12+）"]
    fn export_line_order_and_footer_counts() {
        todo!("构造含多变体+工具块+压缩记录的内存会话，逐行断言 type 序列与计数");
    }

    /// 验收 §7.2：JSONL 重建结果与 load_session_full_v2 serde 等价（round-trip）。
    #[test]
    #[ignore = "WI-12 stub：待 export_session_jsonl 实现（R12+）"]
    fn export_round_trips_against_load_session_full() {
        todo!("导出后解析重建 (session, messages, blocks)，与 DB 加载结果比对 JSON 值");
    }

    /// 验收 §7.3：默认脱敏下导出内容不含 URL 秘钥 / 技能全文快照。
    #[test]
    #[ignore = "WI-12 stub：待 export_session_jsonl 实现（R12+）"]
    fn export_redacts_secrets_by_default() {
        todo!("复用 task_audit 脱敏语料，断言导出文本无 password/token 命中");
    }

    /// 会话不存在时返回 SessionNotFound 而非空文件。
    #[test]
    #[ignore = "WI-12 stub：待 export_session_jsonl 实现（R12+）"]
    fn export_missing_session_returns_session_not_found() {
        todo!("对空库调用 export_session_jsonl，断言 Err(ChatV2Error::SessionNotFound)");
    }
}
