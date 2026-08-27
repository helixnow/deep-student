//! P1: 上下文压缩 Agent
//!
//! 触发条件：provider 返回的真实 usage 接近上下文上限（single-round）时设置
//! `ctx.needs_compaction`；由外层 pipeline 循环在下一次 LLM 调用前执行本模块。
//!
//! ## 算法（参考 参考实现 compaction.ts）
//!
//! ```
//! ┌─ 首 2 user turn（逐字保留，作为任务锚点）
//! ├─ [COMPACTION_SUMMARY block]（新插入）
//! ├─ 末 N turn（逐字保留，≥ usable * tail_preserve_ratio）
//! └─ 当前用户消息
//! ```
//!
//! ## 签名保真
//! tail 起点对齐 user turn 边界；扫描 tail 内部的 assistant 消息，若含活跃
//! `thought_signature`（Gemini 3）或 Anthropic 签名则把整个 turn 包进 tail。
//!
//! ## 失败兜底
//! 摘要 LLM 调用失败 → 把 `needs_compaction` 清零，本轮改走 FIFO 截断，
//! 不阻塞用户发消息。
//!
//! ## 子模块划分
//! - [`budget`]：触发参数、token 预算估算与检查点 A/B 判定
//! - [`segmentation`]：turn 划分、签名保真扫描与 tail 选择
//! - [`prompts`]：摘要模板、结构校验、标识符审计与消息渲染
//! - [`memory_flush`]：被压缩区间的记忆冲刷台账与恢复 worker
//!
//! 本文件保留压缩主编排（`run_compaction_for_session`）、结构化结果类型与
//! `apply_compaction_view` 历史过滤；对外 API 通过下方 re-export 保持不变。

mod budget;
mod memory_flush;
mod prompts;
mod segmentation;
#[cfg(test)]
mod test_fixtures;

pub use budget::{
    effective_usable_tokens, estimate_json_tokens, usable_tokens, DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_OUTPUT, HEAD_USER_TURNS, MAX_TAIL_TOKENS, MIN_TAIL_TOKENS, TAIL_PRESERVE_RATIO,
    TRIGGER_RATIO,
};
pub(crate) use budget::{should_compact, should_compact_after_tool};
pub(crate) use prompts::{
    compaction_profile_for_mode, extract_opaque_identifiers, missing_identifiers,
    IDENTIFIER_AUDIT_MAX, IDENTIFIER_AUDIT_RECENT_MESSAGES,
};

use self::budget::{
    estimate_message_tokens, MAX_SUMMARY_INPUT_TOKENS, MIN_SUMMARY_INPUT_TOKENS,
    SUMMARY_INPUT_RATIO,
};
use self::memory_flush::{
    build_memory_flush_segment_id, enqueue_memory_flush_with_conn, split_memory_flush_segment,
    PendingMemoryFlush,
};
use self::prompts::{
    actual_model_from_raw_response, build_compaction_prompt, escape_untrusted_prompt_data,
    make_summary_system_message, render_messages_for_prompt, summary_is_structurally_valid,
    truncate_text_to_token_budget,
};
use self::segmentation::{select_tail, split_into_turns, split_summary_ranges};
use super::ChatV2Pipeline;
use crate::chat_v2::context::PipelineContext;
use crate::chat_v2::error::{ChatV2Error, ChatV2Result};
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{
    block_status, block_types, ChatMessage, CompactionRecord, MessageBlock, MessageRole,
};
use crate::llm_manager::ApiConfig;
use crate::models::ChatMessage as LegacyChatMessage;
use chrono::Utc;
use log::{debug, info, warn};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;

// ============================================================================
// 压缩结果（结构化，供手动命令返回值与自动路径事件上报共用）
// ============================================================================

/// 细分原因码。`as_code()` 输出的 camelCase 字符串是与前端约定死的契约，
/// 修改需同步前端（手动压缩响应 + compaction_failed 事件 payload）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionSkipReason {
    /// 触发标志未置位（仅内部 run_compaction 短路使用）
    NotTriggered,
    /// 会话过短（消息/turn 数不足）
    SessionTooShort,
    /// 没有可压缩的增量区间（tail 选择失败 / middle 为空）
    NoCompactibleRange,
    /// 可用 token 预算过小，无法安全摘要
    UsableTooSmall,
    /// 同会话已有 compaction 在跑（互斥锁占用）
    LockBusy,
    /// 未提供有效摘要模型
    NoModel,
    /// 摘要 LLM 调用失败或输出未通过校验
    SummaryFailed,
    /// 被取消（cancellation token）
    Cancelled,
    /// 落盘前发现 lineage / 源区间已变化，摘要被丢弃
    StaleLineage,
    /// DB 等内部硬错误（仅事件上报使用，命令层此情形返回 Err）
    InternalError,
}

impl CompactionSkipReason {
    pub fn as_code(&self) -> &'static str {
        match self {
            Self::NotTriggered => "notTriggered",
            Self::SessionTooShort => "sessionTooShort",
            Self::NoCompactibleRange => "noCompactibleRange",
            Self::UsableTooSmall => "usableTooSmall",
            Self::LockBusy => "lockBusy",
            Self::NoModel => "noModel",
            Self::SummaryFailed => "summaryFailed",
            Self::Cancelled => "cancelled",
            Self::StaleLineage => "staleLineage",
            Self::InternalError => "internalError",
        }
    }
}

/// 压缩执行结果。取代旧的 `Ok(bool)`：把 `Ok(false)` 的多种混杂含义
/// （会话过短/锁占用/LLM 失败/取消/lineage 失效）拆开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionOutcome {
    /// 落盘了一条压缩记录
    Compacted,
    /// 无需压缩（会话本身不满足压缩条件，非异常）
    NotNeeded(CompactionSkipReason),
    /// 条件不满足而跳过（锁占用/预算过小/无模型/被取消）
    Skipped(CompactionSkipReason),
    /// 压缩尝试了但失败（摘要失败/lineage 失效）
    Failed(CompactionSkipReason),
}

impl CompactionOutcome {
    /// 与前端约定的 status 契约："compacted" | "notNeeded" | "skipped" | "failed"
    pub fn status_code(&self) -> &'static str {
        match self {
            Self::Compacted => "compacted",
            Self::NotNeeded(_) => "notNeeded",
            Self::Skipped(_) => "skipped",
            Self::Failed(_) => "failed",
        }
    }

    pub fn reason_code(&self) -> Option<&'static str> {
        match self {
            Self::Compacted => None,
            Self::NotNeeded(r) | Self::Skipped(r) | Self::Failed(r) => Some(r.as_code()),
        }
    }

    pub fn did_compact(&self) -> bool {
        matches!(self, Self::Compacted)
    }

    pub fn is_failed(&self) -> bool {
        matches!(self, Self::Failed(_))
    }
}

// ============================================================================
// 主流程
// ============================================================================

#[derive(Debug)]
struct PreparedCompaction {
    summary_message: ChatMessage,
    summary_block: MessageBlock,
    record: CompactionRecord,
    source_fingerprint_start_message_id: String,
    source_fingerprint: String,
    summary_tokens: u32,
    memory_flushes: Vec<PendingMemoryFlush>,
}

fn compaction_range_fingerprint(
    messages: &[ChatMessage],
    blocks_by_msg: &std::collections::HashMap<String, Vec<MessageBlock>>,
    start: usize,
    end: usize,
) -> String {
    let mut hasher = Sha256::new();
    for message in messages.iter().take(end).skip(start) {
        let encoded = serde_json::to_vec(message).unwrap_or_default();
        hasher.update((encoded.len() as u64).to_le_bytes());
        hasher.update(encoded);
        if let Some(blocks) = blocks_by_msg.get(&message.id) {
            for block in blocks {
                let encoded = serde_json::to_vec(block).unwrap_or_default();
                hasher.update((encoded.len() as u64).to_le_bytes());
                hasher.update(encoded);
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn load_compaction_range_fingerprint_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    start_id: &str,
    end_id: &str,
) -> ChatV2Result<Option<String>> {
    let all_messages = ChatV2Repo::get_session_messages_with_conn(conn, session_id)?;
    let mut messages = Vec::with_capacity(all_messages.len());
    let mut blocks_by_msg = std::collections::HashMap::new();
    for message in all_messages {
        let blocks = ChatV2Repo::get_message_blocks_with_conn(conn, &message.id)?;
        if blocks
            .iter()
            .any(|block| block.block_type == block_types::COMPACTION_SUMMARY)
        {
            continue;
        }
        blocks_by_msg.insert(message.id.clone(), blocks);
        messages.push(message);
    }
    let Some(start) = messages.iter().position(|message| message.id == start_id) else {
        return Ok(None);
    };
    let Some(end) = messages.iter().position(|message| message.id == end_id) else {
        return Ok(None);
    };
    if start >= end {
        return Ok(None);
    }
    Ok(Some(compaction_range_fingerprint(
        &messages,
        &blocks_by_msg,
        start,
        end,
    )))
}

fn validated_compaction_model_id(model_id: Option<&str>) -> Option<&str> {
    model_id.map(str::trim).filter(|id| !id.is_empty())
}

/// Enforce the only valid side-effect order: summary -> transaction -> memory flush.
async fn run_summary_commit_post<S, SummaryFuture, T, E, Persist, Post, PostFuture>(
    summarize: S,
    persist: Persist,
    post_commit: Post,
) -> Result<Option<T>, E>
where
    S: FnOnce() -> SummaryFuture,
    SummaryFuture: Future<Output = Result<Option<T>, E>>,
    Persist: FnOnce(&T) -> Result<bool, E>,
    Post: FnOnce(&T) -> PostFuture,
    PostFuture: Future<Output = ()>,
{
    let Some(prepared) = summarize().await? else {
        return Ok(None);
    };
    if !persist(&prepared)? {
        return Ok(None);
    }
    post_commit(&prepared).await;
    Ok(Some(prepared))
}

impl ChatV2Pipeline {
    /// 运行压缩：从 DB 加载全量历史，生成摘要并持久化，重置 ctx.needs_compaction
    ///
    /// LLM 摘要失败时仅记录日志并清零标志，不返回错误（退化为 FIFO 截断）
    ///
    /// 🔧 P1-4 / 结构化结果：返回 `CompactionOutcome::Compacted` 表示本次真的
    /// 落盘了一条 compaction 记录（调用方可据此重新加载历史以立即应用压缩视图）；
    /// 其它变体区分「无需 / 跳过 / 失败」及细分原因，供事件上报使用。
    pub(crate) async fn run_compaction(
        &self,
        ctx: &mut PipelineContext,
    ) -> ChatV2Result<CompactionOutcome> {
        if !ctx.needs_compaction {
            return Ok(CompactionOutcome::NotNeeded(
                CompactionSkipReason::NotTriggered,
            ));
        }
        let session_id = ctx.session_id.clone();
        let model_id = ctx
            .options
            .model2_override_id
            .clone()
            .or_else(|| ctx.options.model_id.clone());
        let context_limit = ctx.options.context_limit;
        let cancellation_token = ctx.cancellation_token.clone();
        let exclude_ids = vec![
            ctx.user_message_id.clone(),
            ctx.assistant_message_id.clone(),
        ];

        let outcome = self
            .run_compaction_for_session(
                &session_id,
                model_id.as_deref(),
                "auto",
                &exclude_ids,
                context_limit,
                ctx.options.memory_enabled,
                cancellation_token.as_ref(),
            )
            .await?;

        // 无论成功/跳过，都清除 ctx 的触发标志（防止外层循环反复重试）
        ctx.needs_compaction = false;
        if !outcome.did_compact() {
            debug!(
                "[compaction] session={} skipped: status={} reason={:?}",
                session_id,
                outcome.status_code(),
                outcome.reason_code()
            );
        }
        Ok(outcome)
    }

    /// 读取全局「压缩专用模型」配置（settings 表 model_assignments JSON 的
    /// `compaction_model_config_id` 字段）。设置了就用它做摘要 LLM 调用，
    /// 未设置回退调用方传入的模型（model2_override_id || 主模型）。
    pub(crate) fn compaction_model_override(&self) -> Option<String> {
        let db = self.main_db.as_ref()?;
        match db.get_model_assignments() {
            Ok(Some(assignments)) => assignments
                .compaction_model_config_id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty()),
            Ok(None) => None,
            Err(e) => {
                warn!(
                    "[compaction] failed to read model assignments for compaction model override: {}",
                    e
                );
                None
            }
        }
    }

    /// 🆕 R2-CR-R2-02 修复：context-agnostic 的 compaction 入口。
    ///
    /// 用于单变体（通过 `run_compaction`）和多变体（通过 `execute_multi_variant`
    /// 在 fan-out 前主动触发）共同复用。
    ///
    /// ## 并发控制
    /// 通过 `compaction_locks` HashSet 对 session_id 做互斥，防止两个请求
    /// 同时对同一会话压缩，避免重复 LLM 调用 + 孤儿记录（R2-MED 修复）。
    ///
    /// ## 参数
    /// - `session_id`: 目标会话
    /// - `model_id`: 主对话模型（用于摘要生成）；空字符串 / None 则跳过
    /// - `exclude_ids`: 当前正在处理的 user/assistant message IDs，防止把未完成
    ///   的消息纳入压缩范围
    /// - `session_memory_enabled`: 会话级记忆开关（`SendOptions.memory_enabled`）。
    ///   `Some(false)` 时不把被压缩内容入列 memory flush 账本（用户关闭记忆的
    ///   会话内容不得被冲刷提取入库）；`None` 表示调用方无会话选项（如手动压缩
    ///   命令），维持原行为，仅受全局 privacy/frequency 策略约束
    ///
    /// ## 返回
    /// `Ok(CompactionOutcome::Compacted)` — 执行了压缩并落盘一条记录
    /// `Ok(其它变体)` — 无需/跳过/失败（含细分原因，见 `CompactionOutcome`）
    /// `Err(_)` — DB / 事务硬错误
    pub(crate) async fn run_compaction_for_session(
        &self,
        session_id: &str,
        model_id: Option<&str>,
        reason: &str,
        exclude_ids: &[String],
        context_limit: Option<u32>,
        session_memory_enabled: Option<bool>,
        cancellation_token: Option<&tokio_util::sync::CancellationToken>,
    ) -> ChatV2Result<CompactionOutcome> {
        // 🆕 压缩专用模型：全局设置了就统一覆盖（所有触发路径共用此单点）
        let dedicated_model = self.compaction_model_override();
        let model_id = dedicated_model.as_deref().or(model_id);
        // A missing model must abort before any history work, summary call, ledger write,
        // or memory side effect. There is deliberately no Model2 fallback here.
        let effective_model_id = match validated_compaction_model_id(model_id) {
            Some(id) => id,
            None => {
                warn!("[compaction] no model_id; skip compaction (no fallback)");
                return Ok(CompactionOutcome::Skipped(CompactionSkipReason::NoModel));
            }
        };
        let reason = match reason {
            "manual" => "manual",
            "overflow" => "overflow",
            _ => "auto",
        };

        // --- 互斥锁：同一 session 同时只跑一个 compaction ---
        let lock_acquired = {
            let mut locks = self
                .compaction_locks
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            locks.insert(session_id.to_string())
        };
        if !lock_acquired {
            info!(
                "[compaction] session={} already running; skip this trigger",
                session_id
            );
            return Ok(CompactionOutcome::Skipped(CompactionSkipReason::LockBusy));
        }

        // RAII guard：无论函数从哪里 return，都把 session_id 从锁集合移除
        struct LockGuard<'a> {
            locks: &'a std::sync::Mutex<HashSet<String>>,
            key: String,
        }
        impl<'a> Drop for LockGuard<'a> {
            fn drop(&mut self) {
                if let Ok(mut l) = self.locks.lock() {
                    l.remove(&self.key);
                }
            }
        }
        let _guard = LockGuard {
            locks: &self.compaction_locks,
            key: session_id.to_string(),
        };

        info!("[compaction] running for session={}", session_id);

        // 1. 加载全量历史 + 所有块（用于签名保真扫描）
        let conn = self.db.get_conn_safe()?;

        // 🆕 按会话模式选择摘要模板：学习类模式用学习域模板，agent/通用模式用
        // 通用模板；读取失败保守回退通用模板。
        let session_mode = ChatV2Repo::get_session_with_conn(&conn, session_id)
            .ok()
            .flatten()
            .map(|session| session.mode);
        let profile = compaction_profile_for_mode(session_mode.as_deref());

        let all_messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)?;

        let exclude: std::collections::HashSet<&str> =
            exclude_ids.iter().map(|s| s.as_str()).collect();
        let candidate_messages: Vec<ChatMessage> = all_messages
            .into_iter()
            .filter(|m| !exclude.contains(m.id.as_str()))
            .collect();

        let mut blocks_by_msg: std::collections::HashMap<String, Vec<MessageBlock>> =
            std::collections::HashMap::new();
        for m in &candidate_messages {
            match ChatV2Repo::get_message_blocks_with_conn(&conn, &m.id) {
                Ok(bs) => {
                    blocks_by_msg.insert(m.id.clone(), bs);
                }
                Err(e) => warn!("[compaction] load blocks failed for {}: {}", m.id, e),
            }
        }
        let messages: Vec<ChatMessage> = candidate_messages
            .into_iter()
            .filter(|message| {
                !blocks_by_msg.get(&message.id).is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|block| block.block_type == block_types::COMPACTION_SUMMARY)
                })
            })
            .collect();
        if messages.len() < HEAD_USER_TURNS * 2 + 2 {
            info!(
                "[compaction] session too short ({} source msgs); skip",
                messages.len()
            );
            return Ok(CompactionOutcome::NotNeeded(
                CompactionSkipReason::SessionTooShort,
            ));
        }

        // 2. 构建 turn 列表
        let turns = split_into_turns(&messages);
        if turns.len() < HEAD_USER_TURNS + 2 {
            info!("[compaction] not enough turns ({}); skip", turns.len());
            return Ok(CompactionOutcome::NotNeeded(
                CompactionSkipReason::SessionTooShort,
            ));
        }

        // 3. 解析 ApiConfig（基于 model_id）
        let api_config = self
            .resolve_api_config_by_id(Some(effective_model_id))
            .await;
        let model_id_for_tokens = api_config
            .as_ref()
            .map(|c| c.model.as_str())
            .or(Some(effective_model_id));
        let usable = effective_usable_tokens(api_config.as_ref(), context_limit) as usize;
        if usable < 4_096 {
            warn!(
                "[compaction] input budget too small for safe summarization: session={} usable={}",
                session_id, usable
            );
            return Ok(CompactionOutcome::Skipped(
                CompactionSkipReason::UsableTooSmall,
            ));
        }
        let tail_budget_raw = (usable as f64 * TAIL_PRESERVE_RATIO) as usize;
        let tail_budget = tail_budget_raw.clamp(MIN_TAIL_TOKENS, MAX_TAIL_TOKENS);

        let tail = match select_tail(
            &messages,
            &turns,
            tail_budget,
            &blocks_by_msg,
            model_id_for_tokens,
        ) {
            Some(t) => t,
            None => {
                info!("[compaction] no suitable tail cut; skip");
                return Ok(CompactionOutcome::NotNeeded(
                    CompactionSkipReason::NoCompactibleRange,
                ));
            }
        };

        let tail_start_msg = &messages[tail.tail_start_idx];
        debug!(
            "[compaction] tail_start={} idx={} tail_tokens~{} budget={}",
            tail_start_msg.id, tail.tail_start_idx, tail.tail_tokens, tail_budget
        );

        // 4. 读取此前最近一次 compaction 记录（锚定链接续 + memory flush 增量起点）
        let previous_record = ChatV2Repo::get_active_compaction_with_conn(&conn, session_id)
            .map_err(|e| {
                warn!("[compaction] get_active_compaction failed: {}", e);
                e
            })?;
        let previous_summary: Option<String> = match previous_record.as_ref() {
            Some(previous) => {
                ChatV2Repo::get_message_blocks_with_conn(&conn, &previous.summary_message_id)?
                    .into_iter()
                    .find(|block| block.block_type == block_types::COMPACTION_SUMMARY)
                    .and_then(|block| block.content)
            }
            None => None,
        };

        // 5. 仅摘要上一条 active tail 到新 tail 的增量区间。
        let head_tokens_used = HEAD_USER_TURNS.min(turns.len());
        let head_end = if head_tokens_used > 0 {
            turns[head_tokens_used - 1].end
        } else {
            0
        };
        let middle_start = previous_record
            .as_ref()
            .and_then(|previous| {
                messages
                    .iter()
                    .position(|message| message.id == previous.tail_start_message_id)
            })
            .map(|index| index.max(head_end))
            .unwrap_or(head_end);
        let middle_end = tail.tail_start_idx;
        if middle_start >= middle_end {
            info!("[compaction] no incremental middle to summarize; skip");
            return Ok(CompactionOutcome::NotNeeded(
                CompactionSkipReason::NoCompactibleRange,
            ));
        }

        let summary_request_budget = ((usable as f64 * SUMMARY_INPUT_RATIO) as usize)
            .clamp(MIN_SUMMARY_INPUT_TOKENS, MAX_SUMMARY_INPUT_TOKENS)
            .min(usable.saturating_sub(512));
        let per_msg_cap = (summary_request_budget / 16).clamp(256, 8_000);
        let head_text_raw = render_messages_for_prompt(
            &messages,
            &blocks_by_msg,
            0,
            head_end,
            per_msg_cap,
            model_id_for_tokens,
        );
        let head_text = truncate_text_to_token_budget(
            &head_text_raw,
            (summary_request_budget / 5).clamp(256, 16_000),
            model_id_for_tokens,
        );
        let previous_summary_for_prompt = previous_summary.as_deref().map(|summary| {
            truncate_text_to_token_budget(
                summary,
                (summary_request_budget / 3).clamp(256, 12_000),
                model_id_for_tokens,
            )
        });
        let fixed_input_tokens = crate::utils::token_budget::estimate_tokens_with_model(
            &format!(
                "{}\n{}\n{}",
                profile.system,
                head_text,
                previous_summary_for_prompt.as_deref().unwrap_or_default()
            ),
            model_id_for_tokens,
        )
        .saturating_add(512);
        let summary_input_budget = summary_request_budget.saturating_sub(fixed_input_tokens);
        if summary_input_budget < 256 {
            warn!(
                "[compaction] fixed summary context exhausts request budget: session={} request={} fixed={}",
                session_id, summary_request_budget, fixed_input_tokens
            );
            return Ok(CompactionOutcome::Skipped(
                CompactionSkipReason::UsableTooSmall,
            ));
        }
        let summary_ranges = split_summary_ranges(
            &messages,
            &turns,
            &blocks_by_msg,
            middle_start,
            middle_end,
            summary_input_budget,
            per_msg_cap,
            model_id_for_tokens,
        );
        if summary_ranges.is_empty() {
            return Ok(CompactionOutcome::NotNeeded(
                CompactionSkipReason::NoCompactibleRange,
            ));
        }
        let summary_chunks = summary_ranges
            .iter()
            .map(|(start, end)| {
                truncate_text_to_token_budget(
                    &render_messages_for_prompt(
                        &messages,
                        &blocks_by_msg,
                        *start,
                        *end,
                        per_msg_cap,
                        model_id_for_tokens,
                    ),
                    summary_input_budget,
                    model_id_for_tokens,
                )
            })
            .collect::<Vec<_>>();

        // 🆕 标识符保真审计输入：从被摘要区间「最近 N 条消息」提取 opaque
        // 标识符（在与 prompt 相同的转义空间中提取，确保逐字比对语义一致）。
        // 这些标识符必须逐字出现在最终摘要里；缺失时借用现有修复重试补救。
        let audit_identifiers: Vec<String> = {
            let recent_start = middle_end
                .saturating_sub(IDENTIFIER_AUDIT_RECENT_MESSAGES)
                .max(middle_start);
            let recent_text = render_messages_for_prompt(
                &messages,
                &blocks_by_msg,
                recent_start,
                middle_end,
                per_msg_cap,
                model_id_for_tokens,
            );
            extract_opaque_identifiers(
                &escape_untrusted_prompt_data(&recent_text),
                IDENTIFIER_AUDIT_MAX,
            )
        };

        // 5.5 渲染 memory flush 输入段：只取"本次新被摘要掉"的增量区间。
        // 上一次 compaction 的 tail 起点之前的内容已在上一轮 flush 过，
        // 用 prev.tail_start 作为起点避免重复提取/重复写日志。
        // 会话级 memory_enabled=false 时直接不入列（对话文本不落入账本），
        // 与自动提取路径的会话开关语义一致。
        let flush_start = middle_start;
        let flush_segments = if session_memory_enabled == Some(false) {
            info!(
                "[compaction] session memory disabled; skip memory flush enqueue: session={}",
                session_id
            );
            Vec::new()
        } else if flush_start < middle_end {
            let flush_text = render_messages_for_prompt(
                &messages,
                &blocks_by_msg,
                flush_start,
                middle_end,
                per_msg_cap,
                model_id_for_tokens,
            );
            split_memory_flush_segment(&flush_text)
                .into_iter()
                .enumerate()
                .map(|(ordinal, segment_text)| {
                    (
                        ordinal,
                        build_memory_flush_segment_id(
                            session_id,
                            previous_record.as_ref().map(|record| record.id.as_str()),
                            &messages[flush_start].id,
                            &messages[middle_end].id,
                            ordinal,
                        ),
                        segment_text,
                    )
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let previous_visible_start = previous_record
            .as_ref()
            .and_then(|previous| {
                messages
                    .iter()
                    .position(|message| message.id == previous.tail_start_message_id)
            })
            .unwrap_or(0);
        let previous_summary_tokens = previous_summary
            .as_deref()
            .map(|summary| {
                crate::utils::token_budget::estimate_tokens_with_model(summary, model_id_for_tokens)
            })
            .unwrap_or(0);
        let tokens_before_estimate = messages[previous_visible_start..]
            .iter()
            .map(|message| estimate_message_tokens(message, &blocks_by_msg, model_id_for_tokens))
            .fold(previous_summary_tokens, usize::saturating_add)
            .min(u32::MAX as usize) as u32;
        let compacted_message_count = middle_end.saturating_sub(middle_start) as u32;
        let source_fingerprint_start_message_id = messages[0].id.clone();
        let source_fingerprint =
            compaction_range_fingerprint(&messages, &blocks_by_msg, 0, middle_end);

        // 6. 释放连接，执行 LLM 调用
        drop(conn);

        // 摘要/落盘闭包内的失败原因回传通道。默认 SummaryFailed；
        // 取消 / lineage 失效路径会覆写。用 Arc<Mutex> 而非 RefCell 以保持
        // future 的 Send 约束（tauri 命令要求）。
        let abort_reason: std::sync::Arc<std::sync::Mutex<CompactionSkipReason>> =
            std::sync::Arc::new(std::sync::Mutex::new(CompactionSkipReason::SummaryFailed));
        let abort_reason_summary = abort_reason.clone();
        let abort_reason_persist = abort_reason.clone();
        let set_abort_reason = |slot: &std::sync::Mutex<CompactionSkipReason>,
                                reason: CompactionSkipReason| {
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = reason;
        };

        let prepared = run_summary_commit_post(
            || async {
                let abort_reason = abort_reason_summary;
                let mut rolling_summary = previous_summary_for_prompt.clone();
                let mut actual_summary_model: Option<String> = None;
                let hard_cap_tokens = (tail_budget_raw / 2).clamp(512, 12_000);
                for (chunk_index, chunk_text) in summary_chunks.iter().enumerate() {
                    rolling_summary = rolling_summary.map(|summary| {
                        truncate_text_to_token_budget(
                            &summary,
                            (summary_request_budget / 3).clamp(256, 12_000),
                            model_id_for_tokens,
                        )
                    });
                    let prompt = build_compaction_prompt(
                        profile,
                        &head_text,
                        chunk_text,
                        rolling_summary.as_deref(),
                    );
                    let call = self
                        .llm_manager
                        .call_with_config_id_raw_prompt(effective_model_id, &prompt);
                    let result = if let Some(token) = cancellation_token {
                        tokio::select! {
                            result = call => Some(result),
                            _ = token.cancelled() => None,
                        }
                    } else {
                        Some(call.await)
                    };
                    let Some(result) = result else {
                        set_abort_reason(&abort_reason, CompactionSkipReason::Cancelled);
                        return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                    };
                    let out = match result {
                        Ok(out) => out,
                        Err(error) => {
                            log::error!(
                                "[compaction] summary failed session={} chunk={}/{}: {}",
                                session_id,
                                chunk_index + 1,
                                summary_chunks.len(),
                                error
                            );
                            set_abort_reason(&abort_reason, CompactionSkipReason::SummaryFailed);
                            return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                        }
                    };
                    if let Some(model) =
                        actual_model_from_raw_response(out.raw_response.as_deref())
                    {
                        actual_summary_model = Some(model);
                    }
                    let mut candidate = out.assistant_message.trim().to_string();
                    let mut candidate_tokens =
                        crate::utils::token_budget::estimate_tokens_with_model(
                            &candidate,
                            model_id_for_tokens,
                        );
                    // 🆕 标识符保真：只对最后一个 chunk（rolling summary 的最终形态）
                    // 强制审计「最近消息中的标识符」是否逐字保留。
                    let is_final_chunk = chunk_index + 1 == summary_chunks.len();
                    let mut missing = if is_final_chunk {
                        missing_identifiers(&candidate, &audit_identifiers)
                    } else {
                        Vec::new()
                    };
                    if !summary_is_structurally_valid(&candidate, profile)
                        || candidate_tokens > hard_cap_tokens
                        || !missing.is_empty()
                    {
                        let repair_input = truncate_text_to_token_budget(
                            &candidate,
                            (summary_request_budget / 2).clamp(256, 12_000),
                            model_id_for_tokens,
                        );
                        let missing_section = if missing.is_empty() {
                            String::new()
                        } else {
                            format!(
                                "\n\n以下关键标识符缺失，必须逐字出现在摘要中（不得改写、截断或省略）：\n{}",
                                missing
                                    .iter()
                                    .map(|id| format!("- {}", id))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            )
                        };
                        let repair_prompt = format!(
                            "{}\n\n上一次输出未通过结构、长度或标识符保真校验。请完整保留全部 {} 个规定标题，在不超过约 {} tokens 的前提下重新输出；不要解释。{}\n\n<invalid_summary_data>\n{}\n</invalid_summary_data>",
                            profile.system,
                            profile.required_headings.len(),
                            hard_cap_tokens,
                            missing_section,
                            escape_untrusted_prompt_data(&repair_input)
                        );
                        let repair_call = self
                            .llm_manager
                            .call_with_config_id_raw_prompt(effective_model_id, &repair_prompt);
                        let repair = if let Some(token) = cancellation_token {
                            tokio::select! {
                                result = repair_call => Some(result),
                                _ = token.cancelled() => None,
                            }
                        } else {
                            Some(repair_call.await)
                        };
                        let repaired = match repair {
                            None => {
                                set_abort_reason(&abort_reason, CompactionSkipReason::Cancelled);
                                return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                            }
                            Some(Err(error)) => {
                                log::error!(
                                    "[compaction] summary repair failed session={} chunk={}/{}: {}",
                                    session_id,
                                    chunk_index + 1,
                                    summary_chunks.len(),
                                    error
                                );
                                set_abort_reason(
                                    &abort_reason,
                                    CompactionSkipReason::SummaryFailed,
                                );
                                return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                            }
                            Some(Ok(repaired)) => repaired,
                        };
                        if let Some(model) =
                            actual_model_from_raw_response(repaired.raw_response.as_deref())
                        {
                            actual_summary_model = Some(model);
                        }
                        candidate = repaired.assistant_message.trim().to_string();
                        candidate_tokens =
                            crate::utils::token_budget::estimate_tokens_with_model(
                                &candidate,
                                model_id_for_tokens,
                            );
                        if is_final_chunk {
                            missing = missing_identifiers(&candidate, &audit_identifiers);
                        }
                    }
                    if !summary_is_structurally_valid(&candidate, profile)
                        || candidate_tokens > hard_cap_tokens
                    {
                        set_abort_reason(&abort_reason, CompactionSkipReason::SummaryFailed);
                        return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                    }
                    // 标识符审计是软要求：修复重试后仍缺失只告警，不再消耗额外重试轮数、
                    // 也不放弃本次压缩（放弃会退化成 FIFO 无声丢消息，损失更大）。
                    if !missing.is_empty() {
                        warn!(
                            "[compaction] identifier audit: {} identifier(s) still missing after repair (session={}): {:?}",
                            missing.len(),
                            session_id,
                            missing
                        );
                    }
                    rolling_summary = Some(candidate);
                }
                let Some(summary_text) =
                    rolling_summary.filter(|summary| !summary.trim().is_empty())
                else {
                    set_abort_reason(&abort_reason, CompactionSkipReason::SummaryFailed);
                    return Ok::<Option<PreparedCompaction>, ChatV2Error>(None);
                };
                let actual_model_id = actual_summary_model.unwrap_or_else(|| {
                    api_config
                        .as_ref()
                        .map(|config| config.model.clone())
                        .unwrap_or_else(|| effective_model_id.to_string())
                });

                let summary_tokens = crate::utils::token_budget::estimate_tokens_with_model(
                    &summary_text,
                    model_id_for_tokens,
                ) as u32;
                let tokens_after = Some(summary_tokens + tail.tail_tokens as u32);
                let now_ms = Utc::now().timestamp_millis();
                let summary_msg_id = format!("msg_{}", uuid::Uuid::new_v4());
                let summary_block_id = format!("blk_{}", uuid::Uuid::new_v4());
                let compaction_id = CompactionRecord::generate_id();

                let summary_message = ChatMessage {
                    id: summary_msg_id.clone(),
                    session_id: session_id.to_string(),
                    role: MessageRole::Assistant,
                    block_ids: vec![summary_block_id.clone()],
                    timestamp: now_ms,
                    persistent_stable_id: None,
                    parent_id: None,
                    supersedes: None,
                    meta: None,
                    attachments: None,
                    active_variant_id: None,
                    variants: None,
                    shared_context: None,
                };
                let summary_block = MessageBlock {
                    id: summary_block_id,
                    message_id: summary_msg_id.clone(),
                    block_type: block_types::COMPACTION_SUMMARY.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: Some(summary_text),
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(serde_json::json!({
                        "sessionId": session_id,
                        "compactionId": compaction_id,
                        "previousCompactionId": previous_record.as_ref().map(|record| record.id.as_str()),
                        "reason": reason,
                        "createdAt": now_ms,
                        "rangeStartMessageId": messages[middle_start].id,
                        "rangeEndMessageId": tail_start_msg.id,
                        "tailStartMessageId": tail_start_msg.id,
                        "compactedMessageCount": compacted_message_count,
                        "tailMessageCount": messages.len().saturating_sub(tail.tail_start_idx),
                        "tokensBefore": tokens_before_estimate,
                        "tokensAfter": tokens_after,
                        "summaryTokens": summary_tokens,
                        "summaryPasses": summary_chunks.len(),
                        "modelId": actual_model_id.clone(),
                        "modelConfigId": effective_model_id,
                    })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    first_chunk_at: Some(now_ms),
                    block_index: 0,
                };
                let record = CompactionRecord {
                    id: compaction_id.clone(),
                    session_id: session_id.to_string(),
                    summary_message_id: summary_msg_id,
                    tail_start_message_id: tail_start_msg.id.clone(),
                    tail_start_time_created: tail_start_msg.timestamp,
                    reason: reason.to_string(),
                    is_auto: reason == "auto",
                    is_overflow: reason == "overflow",
                    tokens_before: Some(tokens_before_estimate),
                    tokens_after,
                    model_id: Some(actual_model_id),
                    model_config_id: Some(effective_model_id.to_string()),
                    previous_compaction_id: previous_record
                        .as_ref()
                        .map(|record| record.id.clone()),
                    range_start_message_id: Some(messages[middle_start].id.clone()),
                    range_end_message_id: Some(tail_start_msg.id.clone()),
                    compacted_message_count: Some(compacted_message_count),
                    created_at: now_ms,
                };
                let memory_flushes = flush_segments
                    .iter()
                    .map(
                        |(segment_ordinal, segment_id, segment_text)| PendingMemoryFlush {
                            segment_id: segment_id.clone(),
                            compaction_id: compaction_id.clone(),
                            session_id: session_id.to_string(),
                            segment_ordinal: *segment_ordinal,
                            segment_text: segment_text.clone(),
                            extraction_json: None,
                            facts_completed: 0,
                            activities_completed: 0,
                        },
                    )
                    .collect();

                Ok(Some(PreparedCompaction {
                    summary_message,
                    summary_block,
                    record,
                    source_fingerprint_start_message_id,
                    source_fingerprint,
                    summary_tokens,
                    memory_flushes,
                }))
            },
            |prepared| {
                let persisted = self.persist_prepared_compaction(prepared)?;
                if !persisted {
                    set_abort_reason(&abort_reason_persist, CompactionSkipReason::StaleLineage);
                }
                Ok(persisted)
            },
            |_| async {
                // The ledger row was committed atomically with the compaction record. A crash or
                // item failure leaves it recoverable for a later successful compaction pass.
                self.flush_pending_memory_segments(Some(session_id)).await;
            },
        )
        .await?;

        let Some(prepared) = prepared else {
            let reason = *abort_reason.lock().unwrap_or_else(|p| p.into_inner());
            return Ok(match reason {
                CompactionSkipReason::Cancelled => {
                    CompactionOutcome::Skipped(CompactionSkipReason::Cancelled)
                }
                other => CompactionOutcome::Failed(other),
            });
        };
        info!(
            "[compaction] committed: id={} tail_start_msg={} summary_tokens={} tokens_after={:?}",
            prepared.record.id,
            prepared.record.tail_start_message_id,
            prepared.summary_tokens,
            prepared.record.tokens_after
        );

        Ok(CompactionOutcome::Compacted)
    }

    fn persist_prepared_compaction(&self, prepared: &PreparedCompaction) -> ChatV2Result<bool> {
        let mut conn = self.db.get_conn_safe()?;
        let tx = conn.transaction()?;
        let current: Option<String> = tx.query_row(
            "SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1",
            params![prepared.record.session_id],
            |row| row.get(0),
        )?;
        if current != prepared.record.previous_compaction_id {
            warn!(
                "[compaction] active lineage changed before commit for session={}; discarding stale summary",
                prepared.record.session_id
            );
            return Ok(false);
        }
        let current_fingerprint = load_compaction_range_fingerprint_with_conn(
            &tx,
            &prepared.record.session_id,
            &prepared.source_fingerprint_start_message_id,
            prepared
                .record
                .range_end_message_id
                .as_deref()
                .unwrap_or_default(),
        )?;
        if current_fingerprint.as_deref() != Some(prepared.source_fingerprint.as_str()) {
            warn!(
                "[compaction] source range changed before commit for session={}; discarding stale summary",
                prepared.record.session_id
            );
            return Ok(false);
        }
        ChatV2Repo::create_message_with_conn(&tx, &prepared.summary_message)?;
        ChatV2Repo::create_block_with_conn(&tx, &prepared.summary_block)?;
        ChatV2Repo::create_compaction_with_conn(&tx, &prepared.record)?;
        ChatV2Repo::set_session_last_compaction_with_conn(
            &tx,
            &prepared.record.session_id,
            &prepared.record.id,
        )?;
        // 🆕 R4-#6：同一事务内声明 available_skills 目录待换代。compaction
        // 摘要已打断 system+tools 之后的整段 prompt cache 前缀，是零成本的
        // 目录换代时机。后端拿不到 live registry 目录字符串（registry 与
        // XML 渲染在前端），故不在此重生成快照本体，只写显式换代标记
        // `availableSkillsSnapshotPendingGeneration`；前端下轮构建 system 时
        // 按 live registry 重新生成并经 freeze 原语作为新代 first write 冻结。
        // first-write-wins 不被静默破坏：freeze 只在见到有效标记时才覆盖。
        // 详见 docs/dev/wave2-A/r4-catalog-compaction.md。
        match ChatV2Repo::mark_session_available_skills_snapshot_stale_with_conn(
            &tx,
            &prepared.record.session_id,
        )? {
            Some(pending_generation) => info!(
                "[compaction] available_skills catalog marked stale in commit tx: session={} pending_generation={}",
                prepared.record.session_id, pending_generation
            ),
            None => debug!(
                "[compaction] available_skills snapshot never frozen; no catalog generation bump: session={}",
                prepared.record.session_id
            ),
        }
        for pending in &prepared.memory_flushes {
            let inserted =
                enqueue_memory_flush_with_conn(&tx, pending, prepared.record.created_at)?;
            if !inserted {
                debug!(
                    "[compaction] memory segment already queued: segment={} compaction={}",
                    pending.segment_id, pending.compaction_id
                );
            }
        }
        tx.commit()?;
        Ok(true)
    }

    /// 尝试从 `ctx.options.model_id` 解析活跃的 ApiConfig，用于 usable_tokens 估算
    pub(crate) async fn resolve_active_api_config(
        &self,
        ctx: &PipelineContext,
    ) -> Option<ApiConfig> {
        self.resolve_api_config_by_id(ctx.options.model_id.as_deref())
            .await
    }

    /// 按 model_id（config.id 或 config.model）解析 ApiConfig
    pub(crate) async fn resolve_api_config_by_id(&self, key: Option<&str>) -> Option<ApiConfig> {
        let key = key?.trim();
        if key.is_empty() {
            return None;
        }
        // 🔧 P1-8：配置加载失败不再静默 Err→None（会导致 compaction 阈值全部
        // 回退默认 200K 窗口、budget 判断失真），补 warn 带上下文
        let configs = match self.llm_manager.get_api_configs().await {
            Ok(configs) => configs,
            Err(e) => {
                warn!(
                    "[ChatV2::pipeline] resolve_api_config_by_id: failed to load API configs (key={}): {}; falling back to defaults",
                    key, e
                );
                return None;
            }
        };
        configs
            .iter()
            .find(|c| c.id == key)
            .or_else(|| configs.iter().find(|c| c.model == key))
            .cloned()
    }

    /// 🆕 R2-CR-R2-02：多变体 fan-out 前的压缩预检查
    ///
    /// 由于多变体路径不经过 `execute_internal`，没有 checkpoint A/B 去累加 usage，
    /// 这里直接估算"当前历史 + 共享上下文"的 token 数是否接近上限。
    pub(crate) async fn should_compact_before_multi_variant_fanout(
        &self,
        session_id: &str,
        api_config: Option<&ApiConfig>,
        context_limit: Option<u32>,
    ) -> bool {
        let usable = effective_usable_tokens(api_config, context_limit);
        if usable == 0 {
            return false;
        }
        let threshold = ((usable as f64) * TRIGGER_RATIO) as u32;

        // 估算历史 token（只看 message/block 的 content + tool_input/output，
        // 不加载其他开销；粗略但足以触发阈值判断）
        let Ok(conn) = self.db.get_conn_safe() else {
            return false;
        };
        let Ok(messages) = ChatV2Repo::get_session_messages_with_conn(&conn, session_id) else {
            return false;
        };
        if messages.is_empty() {
            return false;
        }
        let model_id_for_tokens = api_config.map(|c| c.model.as_str());

        let mut total: usize = 0;
        for m in &messages {
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &m.id).ok();
            let Some(blocks) = blocks else { continue };
            // 复用 estimate_message_tokens 的思路
            let mut blocks_by_msg: std::collections::HashMap<String, Vec<MessageBlock>> =
                std::collections::HashMap::new();
            blocks_by_msg.insert(m.id.clone(), blocks);
            total = total.saturating_add(estimate_message_tokens(
                m,
                &blocks_by_msg,
                model_id_for_tokens,
            ));
            if total >= threshold as usize {
                return true;
            }
        }
        let trigger = (total as u32) >= threshold;
        if trigger {
            info!(
                "[compaction] trigger@multi-variant-fanout: history_tokens~{} threshold={} usable={}",
                total, threshold, usable
            );
        }
        trigger
    }
}

// ============================================================================
// History 过滤（供 history.rs 和 multi_variant.rs 调用）
// ============================================================================

/// 按 compaction 视图过滤消息列表：隐藏 tail 起点之前的消息，插入 summary 系统消息
///
/// 返回 (summary_pseudo_user_message, kept_messages) —— 调用方应：
/// 1. 先 push summary_pseudo_user_message
/// 2. 再 push kept_messages
///
/// 🔧 P1-B6 修复：伪消息用 user 角色 + `<compacted_context>` 包裹，而非 system 角色。
pub fn apply_compaction_view(
    conn: &rusqlite::Connection,
    session_id: &str,
    messages: Vec<ChatMessage>,
) -> (Option<LegacyChatMessage>, Vec<ChatMessage>) {
    let summary_ids = (|| -> rusqlite::Result<HashSet<String>> {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT b.message_id
             FROM chat_v2_blocks b
             INNER JOIN chat_v2_messages m ON m.id = b.message_id
             WHERE b.block_type = ?1 AND m.session_id = ?2",
        )?;
        let rows = stmt.query_map(
            params![block_types::COMPACTION_SUMMARY, session_id],
            |row| row.get(0),
        )?;
        rows.collect()
    })();
    let messages = match summary_ids {
        Ok(ids) => messages
            .into_iter()
            .filter(|message| !ids.contains(&message.id))
            .collect(),
        Err(error) => {
            warn!(
                "[compaction] failed to identify summary artifacts for session={}: {}",
                session_id, error
            );
            messages
        }
    };
    // 🔧 R2-W2 修复：不要把 DB 错误当成"没有压缩"吞掉。
    // DB 错误时保持原始消息（保守行为），但显式告警，方便排查 sync 损坏之类的问题。
    let record = match ChatV2Repo::get_active_compaction_with_conn(conn, session_id) {
        Ok(Some(r)) => r,
        Ok(None) => return (None, messages),
        Err(e) => {
            log::warn!(
                "[compaction] apply_compaction_view: get_active_compaction failed for session={}: {}; \
                 falling back to raw history (may exceed context window)",
                session_id,
                e
            );
            return (None, messages);
        }
    };

    // 从 records 指向的 summary_message 读 summary 文本
    let summary_text = match ChatV2Repo::get_message_blocks_with_conn(
        conn,
        &record.summary_message_id,
    ) {
        Ok(blks) => blks
            .into_iter()
            .find(|b| b.block_type == block_types::COMPACTION_SUMMARY)
            .and_then(|b| b.content)
            .unwrap_or_default(),
        Err(e) => {
            log::warn!(
                "[compaction] apply_compaction_view: read summary blocks failed for session={} msg={}: {}",
                session_id,
                record.summary_message_id,
                e
            );
            String::new()
        }
    };

    // 🔧 新加防御：如果摘要文本被意外清空（迁移 / 手改 DB），避免产出
    // 空壳 `<compacted_context>` 框架把真历史都藏起来。此时保持原样不压缩。
    if summary_text.trim().is_empty() {
        log::warn!(
            "[compaction] apply_compaction_view: summary text is empty for session={}; \
             falling back to raw history",
            session_id
        );
        return (None, messages);
    }

    let Some(tail_index) = messages
        .iter()
        .position(|message| message.id == record.tail_start_message_id)
    else {
        warn!(
            "[compaction] tail boundary missing for session={} compaction={}; using raw history",
            session_id, record.id
        );
        return (None, messages);
    };
    let kept = messages.into_iter().skip(tail_index).collect();

    let summary_msg = make_summary_system_message(&summary_text, &record.id);
    (Some(summary_msg), kept)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn missing_model_is_rejected_before_compaction_effects() {
        assert_eq!(validated_compaction_model_id(None), None);
        assert_eq!(validated_compaction_model_id(Some("")), None);
        assert_eq!(validated_compaction_model_id(Some("   ")), None);
        assert_eq!(
            validated_compaction_model_id(Some("  cfg_1  ")),
            Some("cfg_1")
        );
    }

    #[tokio::test]
    async fn summary_failure_prevents_transaction_and_memory_flush() {
        let persist_calls = Arc::new(AtomicUsize::new(0));
        let post_calls = Arc::new(AtomicUsize::new(0));
        let persist_counter = persist_calls.clone();
        let post_counter = post_calls.clone();

        let result: Result<Option<&'static str>, &'static str> = run_summary_commit_post(
            || async { Ok(None) },
            move |_| {
                persist_counter.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            },
            move |_| {
                let post_counter = post_counter.clone();
                async move {
                    post_counter.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await;

        assert_eq!(result.unwrap(), None);
        assert_eq!(persist_calls.load(Ordering::SeqCst), 0);
        assert_eq!(post_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn transaction_failure_prevents_memory_flush() {
        let persist_calls = Arc::new(AtomicUsize::new(0));
        let post_calls = Arc::new(AtomicUsize::new(0));
        let persist_counter = persist_calls.clone();
        let post_counter = post_calls.clone();

        let result: Result<Option<&'static str>, &'static str> = run_summary_commit_post(
            || async { Ok(Some("summary")) },
            move |_| {
                persist_counter.fetch_add(1, Ordering::SeqCst);
                Err("transaction failed")
            },
            move |_| {
                let post_counter = post_counter.clone();
                async move {
                    post_counter.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await;

        assert_eq!(result, Err("transaction failed"));
        assert_eq!(persist_calls.load(Ordering::SeqCst), 1);
        assert_eq!(post_calls.load(Ordering::SeqCst), 0);
    }

    /// 🆕 结构化结果：status / reason 码是与前端约定死的契约，逐字校验
    #[test]
    fn compaction_outcome_status_and_reason_codes() {
        assert_eq!(CompactionOutcome::Compacted.status_code(), "compacted");
        assert_eq!(CompactionOutcome::Compacted.reason_code(), None);
        assert!(CompactionOutcome::Compacted.did_compact());

        let not_needed = CompactionOutcome::NotNeeded(CompactionSkipReason::SessionTooShort);
        assert_eq!(not_needed.status_code(), "notNeeded");
        assert_eq!(not_needed.reason_code(), Some("sessionTooShort"));
        assert!(!not_needed.did_compact());
        assert!(!not_needed.is_failed());

        let skipped = CompactionOutcome::Skipped(CompactionSkipReason::LockBusy);
        assert_eq!(skipped.status_code(), "skipped");
        assert_eq!(skipped.reason_code(), Some("lockBusy"));

        let failed = CompactionOutcome::Failed(CompactionSkipReason::SummaryFailed);
        assert_eq!(failed.status_code(), "failed");
        assert_eq!(failed.reason_code(), Some("summaryFailed"));
        assert!(failed.is_failed());

        assert_eq!(
            CompactionSkipReason::UsableTooSmall.as_code(),
            "usableTooSmall"
        );
        assert_eq!(CompactionSkipReason::Cancelled.as_code(), "cancelled");
        assert_eq!(CompactionSkipReason::StaleLineage.as_code(), "staleLineage");
        assert_eq!(CompactionSkipReason::NoModel.as_code(), "noModel");
        assert_eq!(
            CompactionSkipReason::NoCompactibleRange.as_code(),
            "noCompactibleRange"
        );
        assert_eq!(
            CompactionSkipReason::InternalError.as_code(),
            "internalError"
        );
    }
}
