//! 灵感召回工具执行器（Insight Recall v2 阶段二：升级级披露）
//!
//! 范式 A（对齐 BuiltinRetrievalExecutor）：自发 `insight_recall` 事件、
//! 不发通用 tool_call 事件——实时即是类型块，前端阶梯交互即时可用。
//!
//! 披露纪律（D2，本文件是唯一出口收口之一）：
//! - 两种模式：
//!   1. `query` 模式：混合召回 → 披露控制器（预算/置信/开关）→ 存在级内容；
//!   2. `insight_id` + `requested_level` 模式：阶梯升级（一次一级，direct_answer 旁路）；
//! - 出口内容一律经 `disclosure::filter_content` 过滤——emit_end payload 与
//!   ToolResultInfo.output 是同一份过滤后对象，块持久化只存当前披露级，
//!   历史回放/变体重建看到的内容与当时一致；
//! - 全部账本写入走 `InsightRecallService::record_event_idempotent`
//!   （确定性 id + INSERT OR IGNORE），重试/变体/回放不重复记账；
//! - 存在级只暴露标题（`exposes_method` 红线由 filter_content 保证）。

use std::time::Instant;

use serde_json::{json, Value};

use crate::chat_v2::context::citation_ledger_for_reply;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{SourceInfo, ToolCall, ToolResultInfo};
use crate::insight::disclosure::{self, DisclosureOutcome, DisclosurePolicy, SilenceReason};
use crate::insight::recall::InsightRecallService;
use crate::insight::types::{DisclosureLevel, InsightEventType};

use super::builtin_retrieval_executor::build_numbered_sources;
use super::executor::{ExecutionContext, ToolExecutor};
use super::strip_tool_namespace;

/// 灵感召回工具（`builtin-insight_recall`）。
///
/// 只读 + Low 敏感度：自动执行，无需审批。
pub struct InsightRecallExecutor;

impl InsightRecallExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 从设置读取披露策略（与被动注入共用 `disclosure::load_policy` 收口）。
    fn load_policy(ctx: &ExecutionContext) -> DisclosurePolicy {
        disclosure::load_policy(ctx.main_db.as_deref())
    }

    fn silence_event_type(reason: SilenceReason) -> InsightEventType {
        match reason {
            SilenceReason::NoMatch => InsightEventType::SilenceNoMatch,
            SilenceReason::LowConfidence => InsightEventType::SilenceLowConfidence,
            SilenceReason::Budget => InsightEventType::SilenceBudget,
            SilenceReason::UserDisabled => InsightEventType::SilenceUserDisabled,
        }
    }

    /// query 模式：召回 → 披露门控 → 存在级源列表
    async fn execute_recall(
        &self,
        query: &str,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let policy = Self::load_policy(ctx);
        let recall = InsightRecallService::new(std::sync::Arc::clone(vfs_db));

        let candidates = recall
            .recall(query, ctx.llm_manager.as_deref(), policy.max_per_turn * 2)
            .await
            .map_err(|e| e.to_string())?;

        // 披露门控
        let scored: Vec<disclosure::ScoredRef> = candidates
            .iter()
            .map(|c| disclosure::ScoredRef { confidence: c.confidence })
            .collect();
        let outcomes = disclosure::decide_passive(&policy, &scored);

        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| format!("获取 VFS 连接失败: {e}"))?;

        // 无候选 → 沉默记账（insight_id 为 NULL）
        if candidates.is_empty() {
            InsightRecallService::record_event_idempotent(
                &conn,
                Some(&ctx.session_id),
                Some(&ctx.message_id),
                None,
                InsightEventType::SilenceNoMatch,
                DisclosureLevel::Hidden,
                Some(&json!({ "query": query }).to_string()),
            )
            .map_err(|e| e.to_string())?;
            return Ok(json!({
                "sources": [],
                "count": 0,
                "silence": "no_match",
            }));
        }

        // 逐卡应用决策：披露 → 过滤内容 + 记账；沉默 → 分原因记账
        let mut sources: Vec<SourceInfo> = Vec::new();
        for (cand, outcome) in candidates.into_iter().zip(outcomes.iter()) {
            match outcome {
                DisclosureOutcome::Disclose(level) => {
                    let rev = cand.card.current_revision.as_ref();
                    let (title, situation, rule) = disclosure::filter_content(
                        *level,
                        &cand.card.title,
                        rev.map(|r| r.situation.as_str()).unwrap_or(""),
                        rev.map(|r| r.rule.as_str()).unwrap_or(""),
                    );
                    InsightRecallService::record_event_idempotent(
                        &conn,
                        Some(&ctx.session_id),
                        Some(&ctx.message_id),
                        Some(&cand.card.id),
                        InsightEventType::ShownExistence,
                        *level,
                        None,
                    )
                    .map_err(|e| e.to_string())?;
                    let _ = crate::insight::repo::bump_stat(&conn, &cand.card.id, "shown_count");
                    sources.push(SourceInfo {
                        title: Some(format!("[灵感] {title}")),
                        url: None,
                        snippet: situation.map(|s| s.to_string()),
                        score: Some(cand.confidence as f32),
                        metadata: Some(json!({
                            "sourceType": "insight",
                            "insightId": cand.card.id,
                            "disclosureLevel": level.as_str(),
                            "matchedVia": cand.matched_via,
                            "rule": rule,
                            "verificationState": cand.card.verification_state.as_str(),
                        })),
                    });
                }
                DisclosureOutcome::Silence(reason) => {
                    InsightRecallService::record_event_idempotent(
                        &conn,
                        Some(&ctx.session_id),
                        Some(&ctx.message_id),
                        Some(&cand.card.id),
                        Self::silence_event_type(*reason),
                        DisclosureLevel::Hidden,
                        Some(&json!({ "confidence": cand.confidence }).to_string()),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        // 引用编号（[灵感-N]，CitationLedger 进程级注册表按回复键控）
        let ledger = citation_ledger_for_reply(&ctx.session_id, &ctx.message_id, ctx.variant_id.as_deref());
        let numbered = {
            let mut guard = ledger.lock().map_err(|e| e.to_string())?;
            build_numbered_sources(&sources, &mut guard)
        };

        Ok(json!({
            "sources": numbered,
            "count": numbered.len(),
        }))
    }

    /// insight_id 模式：阶梯升级（存在 → 回忆提示 → 提示 → 全文）
    async fn execute_escalate(
        &self,
        insight_id: &str,
        requested_level: DisclosureLevel,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let policy = Self::load_policy(ctx);
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| format!("获取 VFS 连接失败: {e}"))?;

        let card = crate::insight::repo::get_card(&conn, insight_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("灵感卡不存在: {insight_id}"))?;

        // 当前披露级 = 本会话该卡已记录的最高 help_level
        let current_str: Option<String> = conn
            .query_row(
                "SELECT help_level FROM insight_events
                 WHERE insight_id = ?1 AND session_id = ?2
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                rusqlite::params![insight_id, ctx.session_id],
                |row| row.get(0),
            )
            .ok();
        let current = current_str
            .as_deref()
            .map(DisclosureLevel::parse)
            .unwrap_or(DisclosureLevel::Hidden);

        match disclosure::decide_escalation(&policy, current, requested_level) {
            DisclosureOutcome::Disclose(level) => {
                let rev = card.current_revision.as_ref();
                let (title, situation, rule) = disclosure::filter_content(
                    level,
                    &card.title,
                    rev.map(|r| r.situation.as_str()).unwrap_or(""),
                    rev.map(|r| r.rule.as_str()).unwrap_or(""),
                );
                let event_type = match level {
                    DisclosureLevel::Existence => InsightEventType::ShownExistence,
                    DisclosureLevel::RecallPrompt => InsightEventType::RecallAttempt,
                    DisclosureLevel::Hint => InsightEventType::ShownHint,
                    DisclosureLevel::Full => InsightEventType::ShownFull,
                    DisclosureLevel::DirectAnswer => InsightEventType::DirectAnswer,
                    DisclosureLevel::Hidden => InsightEventType::ShownExistence,
                };
                InsightRecallService::record_event_idempotent(
                    &conn,
                    Some(&ctx.session_id),
                    Some(&ctx.message_id),
                    Some(insight_id),
                    event_type,
                    level,
                    None,
                )
                .map_err(|e| e.to_string())?;
                if level >= DisclosureLevel::Hint {
                    let _ = crate::insight::repo::bump_stat(&conn, insight_id, "recall_count");
                    let _ = crate::insight::repo::touch_last_recalled(&conn, insight_id);
                }

                let source = SourceInfo {
                    title: Some(format!("[灵感] {title}")),
                    url: None,
                    snippet: situation.map(|s| s.to_string()),
                    score: None,
                    metadata: Some(json!({
                        "sourceType": "insight",
                        "insightId": insight_id,
                        "disclosureLevel": level.as_str(),
                        "rule": rule,
                        "turningPoint": if level.exposes_method() {
                            rev.map(|r| r.turning_point.clone())
                        } else {
                            None
                        },
                        "validityConditions": if level.exposes_method() {
                            rev.map(|r| r.validity_conditions.clone())
                        } else {
                            None
                        },
                    })),
                };
                let ledger = citation_ledger_for_reply(
                    &ctx.session_id,
                    &ctx.message_id,
                    ctx.variant_id.as_deref(),
                );
                let numbered = {
                    let mut guard = ledger.lock().map_err(|e| e.to_string())?;
                    build_numbered_sources(&[source], &mut guard)
                };
                Ok(json!({
                    "sources": numbered,
                    "count": 1,
                    "escalatedTo": level.as_str(),
                }))
            }
            DisclosureOutcome::Silence(reason) => {
                InsightRecallService::record_event_idempotent(
                    &conn,
                    Some(&ctx.session_id),
                    Some(&ctx.message_id),
                    Some(insight_id),
                    Self::silence_event_type(reason),
                    DisclosureLevel::Hidden,
                    None,
                )
                .map_err(|e| e.to_string())?;
                Ok(json!({
                    "sources": [],
                    "count": 0,
                    "silence": format!("{:?}", reason),
                }))
            }
        }
    }
}

#[async_trait::async_trait]
impl ToolExecutor for InsightRecallExecutor {
    fn name(&self) -> &'static str {
        "InsightRecallExecutor"
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == "insight_recall"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        // 范式 A：不发 tool_call 事件（避免双块），自发 insight_recall 事件
        let query = call
            .arguments
            .get("query")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let insight_id = call
            .arguments
            .get("insight_id")
            .or_else(|| call.arguments.get("insightId"))
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let requested_level = call
            .arguments
            .get("requested_level")
            .or_else(|| call.arguments.get("requestedLevel"))
            .and_then(Value::as_str)
            .map(DisclosureLevel::parse);

        ctx.emitter.emit_start(
            event_types::INSIGHT_RECALL,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "query": query,
                "insightId": insight_id,
                "source": call.name,
            })),
            None,
        );

        let result = if let Some(id) = insight_id.as_deref() {
            self.execute_escalate(
                id,
                requested_level.unwrap_or(DisclosureLevel::RecallPrompt),
                ctx,
            )
            .await
        } else if let Some(q) = query.as_deref() {
            self.execute_recall(q, ctx).await
        } else {
            Err("insight_recall 需要 query 或 insight_id 参数".to_string())
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emitter.emit_end(
                    event_types::INSIGHT_RECALL,
                    &ctx.block_id,
                    Some(output.clone()),
                    None,
                );
                // 注意：不调用 save_tool_block——检索块已由 emit_start/end 建块，
                // 持久化经 add_tool_block（tool_loop 无条件调用），
                // 块类型经 get_block_type_for_tool_static("insight_recall") 映射。
                Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                ))
            }
            Err(e) => {
                ctx.emitter.emit_error(
                    event_types::INSIGHT_RECALL,
                    &ctx.block_id,
                    &e,
                    None,
                );
                Ok(ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                ))
            }
        }
    }
}
