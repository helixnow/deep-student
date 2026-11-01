//! app 向 chat_v2 pipeline 注入的域能力实现（step 10 §3.1 #3 / #4）。
//!
//! - [`NotesCanvasSource`]：Canvas 模式 prompt 注入的笔记读取（原 pipeline 直接调用
//!   `NotesManager::get_note`）。由 `lib.rs` 作为 `ChatV2Pipeline::new` 的
//!   `canvas_note_source` 参数注入。
//! - [`ResearchInsightHints`] / [`InsightHintPlugin`]：Insight Recall v2 被动提示（原
//!   `pipeline/prompt.rs::load_insight_existence_hints` 函数体，逐字搬来）。经
//!   `chat_v2::pipeline::register_insight_hint_provider` 槽位注入，**必须**由
//!   `extensions.rs` 的插件列表注册（`Arc::new(crate::agent_wiring::plugins::InsightHintPlugin)`），
//!   否则被动提示静默为空。

use std::sync::Arc;

use dstu_kernel::{Plugin, PluginError, Scope};

use crate::chat_v2::pipeline::{CanvasNoteSource, InsightHintProvider, InsightHintRequest};
use crate::notes_manager::NotesManager;

/// `NotesManager` 的 Canvas 笔记读取口。
pub struct NotesCanvasSource(pub Arc<NotesManager>);

impl CanvasNoteSource for NotesCanvasSource {
    fn note(&self, note_id: &str) -> Result<(String, String), String> {
        self.0
            .get_note(note_id)
            .map(|note| (note.title, note.content_md))
            .map_err(|error| error.to_string())
    }
}

/// research 域的 Insight Recall 被动提示实现。
pub struct ResearchInsightHints;

impl InsightHintProvider for ResearchInsightHints {
    /// 🆕 Insight Recall v2 阶段二：被动注入（存在级最小披露）。
    ///
    /// 纪律（D2 / 规格 §4 阶段二验收）：
    /// - 只走 FTS（同步、微秒级）——被动注入在每轮热路径上，LLM 级联升级
    ///   （改写/唱反调）属于 insight_recall 工具路径，不在此发生；
    /// - 披露控制器门控（开关/置信/预算），存在级只给标题，方法零泄露；
    /// - 沉默四态幂等记账（确定性事件 id，重试/变体重建不重复）；
    /// - 任何失败降级为 None，绝不阻塞主流程。
    fn existence_hints(&self, request: InsightHintRequest<'_>) -> Option<String> {
        use crate::insight::disclosure::{self, DisclosureOutcome};
        use crate::insight::recall::InsightRecallService;
        use crate::insight::types::{DisclosureLevel, InsightEventType};

        let vfs_db = request.vfs_db;
        let policy = disclosure::load_policy(request.main_db);
        // 阶段四：三本账校准（效用门控路由器）
        let policy = match vfs_db.get_conn_safe() {
            Ok(conn) => disclosure::calibrate_policy_from_ledger(&conn, policy),
            Err(_) => policy,
        };

        // 用户禁用：每轮至多一条沉默账本（幂等键），然后静默退出
        if !policy.enabled {
            if let Ok(conn) = vfs_db.get_conn_safe() {
                let _ = InsightRecallService::record_event_idempotent(
                    &conn,
                    Some(request.session_id),
                    Some(request.user_message_id),
                    None,
                    InsightEventType::SilenceUserDisabled,
                    DisclosureLevel::Hidden,
                    None,
                );
            }
            return None;
        }

        let query = request.user_content.trim();
        // 太短没有召回价值（trigram 下限 3 字符；多留一点防噪音注入）
        if query.chars().count() < 4 {
            return None;
        }

        let recall = InsightRecallService::new(std::sync::Arc::clone(vfs_db));
        let candidates = match recall.recall_fts(query, policy.max_per_turn * 2) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] insight passive recall failed: {e}");
                return None;
            }
        };

        let conn = vfs_db.get_conn_safe().ok()?;

        // 无候选：沉默记账（验收：无匹配完整走沉默分支）
        if candidates.is_empty() {
            let _ = InsightRecallService::record_event_idempotent(
                &conn,
                Some(request.session_id),
                Some(request.user_message_id),
                None,
                InsightEventType::SilenceNoMatch,
                DisclosureLevel::Hidden,
                None,
            );
            return None;
        }

        let scored: Vec<disclosure::ScoredRef> = candidates
            .iter()
            .map(|c| disclosure::ScoredRef {
                confidence: c.confidence,
            })
            .collect();
        let outcomes = disclosure::decide_passive(&policy, &scored);

        let mut lines: Vec<String> = Vec::new();
        for (cand, outcome) in candidates.iter().zip(outcomes.iter()) {
            match outcome {
                DisclosureOutcome::Disclose(level) => {
                    // 存在级只暴露标题（filter_content 是红线收口）
                    let (title, _, _) =
                        disclosure::filter_content(*level, &cand.card.title, "", "");
                    let inserted = InsightRecallService::record_event_idempotent(
                        &conn,
                        Some(request.session_id),
                        Some(request.user_message_id),
                        Some(&cand.card.id),
                        InsightEventType::ShownExistence,
                        *level,
                        None,
                    );
                    // 计数器只在事件真正插入时累加（重试/变体幂等一致）
                    if inserted.unwrap_or(false) {
                        let _ =
                            crate::insight::repo::bump_stat(&conn, &cand.card.id, "shown_count");
                    }
                    lines.push(format!("- [灵感] {title}"));
                }
                DisclosureOutcome::Silence(reason) => {
                    let event_type = match reason {
                        disclosure::SilenceReason::NoMatch => InsightEventType::SilenceNoMatch,
                        disclosure::SilenceReason::LowConfidence => {
                            InsightEventType::SilenceLowConfidence
                        }
                        disclosure::SilenceReason::Budget => InsightEventType::SilenceBudget,
                        disclosure::SilenceReason::UserDisabled => {
                            InsightEventType::SilenceUserDisabled
                        }
                    };
                    let _ = InsightRecallService::record_event_idempotent(
                        &conn,
                        Some(request.session_id),
                        Some(request.user_message_id),
                        Some(&cand.card.id),
                        event_type,
                        DisclosureLevel::Hidden,
                        None,
                    );
                }
            }
        }

        if lines.is_empty() {
            return None;
        }
        Some(lines.join("\n"))
    }
}

/// 把 [`ResearchInsightHints`] 装入 pipeline 槽位；槽位已被占用时视为已就位。
pub fn install_insight_hints(scope: &mut Scope) {
    if let Ok(disposer) =
        crate::chat_v2::pipeline::register_insight_hint_provider(Arc::new(ResearchInsightHints))
    {
        scope.add(disposer);
    }
}

/// `extensions.rs` 组合根插件：Insight Recall 被动提示（chat_v2 pipeline → research 域）。
pub struct InsightHintPlugin;

impl Plugin for InsightHintPlugin {
    fn name(&self) -> &'static str {
        "agent_insight_hints"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        install_insight_hints(scope);
        Ok(())
    }
}
