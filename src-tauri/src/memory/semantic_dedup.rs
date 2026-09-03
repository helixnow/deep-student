//! 语义去重 pass（存量重复回收）
//!
//! 现有回收路径的空白：
//! - 写入时刻去重（write_smart）只覆盖"新写入 vs 存量"，索引不可用时的显式写入
//!   只打 `_needs_dedup_review` 标签，此前没有任何消费者；
//! - evolution 的 check_folder_overflow 只按 (title, memory_type) 精确匹配，
//!   措辞漂移的语义重复（如"数学二次函数薄弱" vs "配方法掌握不牢"）永远不会合并。
//!
//! 本模块作为独立后台 pass 补上这块，由 `spawn_post_write_maintenance` 挂节流调用：
//! 1. 优先复核带 `_needs_dedup_review` 的积压记忆（复核过即摘标签，无论结果如何）；
//! 2. 无积压时对最近更新的 fact 类记忆做常规抽查；
//! 3. 逐条用内容做 InternalDedup 相似检索（不记命中），同类型高相似候选送 LLM
//!    判定 merge/keep（严格 JSON 输出）；
//! 4. 合并 = 更新保留者内容（超类型字数上限则拒绝合并）+ 走 `delete_with_source`
//!    删除冗余者（清向量、清反向 `_ref`）+ `_hits` 取较大值 + `_important` 有一即有
//!    + SEMANTIC_MERGE 审计。
//!
//! 成本护栏：进程内 atomic 节流（默认 6 小时，aggressive 档 2 小时）、每轮 LLM
//! 调用预算（`EvolutionTuning::semantic_merge_max_pairs`，0 表示关闭，另有进程内
//! 硬上限兜底）、连续 LLM 失败提前结束本轮、隐私模式下整个 pass 直接跳过。
//! 相似候选预筛门槛读 `EvolutionTuning::semantic_merge_min_score`。

use std::sync::Arc;

use rusqlite::params;
use serde::Deserialize;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::types::VfsNote;

use super::audit_log::{MemoryAuditEntry, MemoryOpSource, MemoryOpType};
use super::compaction_flush::extract_json_object;
use super::config::AutoExtractFrequency;
use super::service::{MemoryService, MemoryType, SearchPurpose, TAG_NEEDS_DEDUP_REVIEW};

/// aggressive 档节流间隔下限（毫秒）：30 分钟
/// （间隔本体由 memory_config 的 `evolution_semantic_dedup_interval_minutes`
/// 配置，默认 360 分钟;aggressive 档取其 1/3 并受此下限约束）
const DEDUP_INTERVAL_AGGRESSIVE_FLOOR_MS: i64 = 30 * 60 * 1000;
/// 每轮最多复核的 `_needs_dedup_review` 积压条数
const REVIEW_BATCH_LIMIT: usize = 10;
/// 无积压时常规抽查最近更新的 fact 类记忆条数
const ROUTINE_SAMPLE_LIMIT: usize = 10;
/// 每轮 LLM 判定调用硬上限（进程内兜底；实际预算取
/// `EvolutionTuning::semantic_merge_max_pairs` 与本值的较小者，防配置误设失控）
const MAX_LLM_CALLS_PER_ROUND: usize = 10;
/// 连续 LLM 失败达到该次数后提前结束本轮（失败条目不摘标签，下轮再试）
const MAX_CONSECUTIVE_LLM_FAILURES: usize = 2;
/// 单次 LLM 判定超时（秒）
const LLM_CALL_TIMEOUT_SECS: u64 = 60;
/// 标记搜索命中次数的 tag 前缀（与 service.rs 同口径，evolution 同样内联该字面量）
const TAG_HITS_PREFIX: &str = "_hits:";
/// 标记 LLM 主动读取全文（强使用信号）次数的 tag 前缀（与 service.rs 的
/// `record_used` 同口径），合并时同样取两者较大值，避免使用证据随删除丢失
const TAG_USED_PREFIX: &str = "_used:";
/// 归档旗标标签（evolution 休眠归档打上，索引已清空）：归档记忆不参与语义去重
const TAG_ARCHIVED: &str = "_archived";

/// 单条候选的处理结果
enum CandidateOutcome {
    /// 合并完成（冗余者已删除，保留者标签已归并）
    Merged,
    /// 复核完成，保留（无相似候选 / LLM 判 keep / 护栏拒绝合并），已摘标签
    Kept,
    /// 本条跳过（读取失败/已删除/合并执行失败），不摘标签，下轮再试
    Skipped,
    /// LLM 调用失败或超时，不摘标签，计入连续失败
    LlmFailed,
}

/// LLM 判定响应（严格 JSON：{"action": "merge"|"keep", "keep_note_id": ..., "merged_content": ...}）
#[derive(Debug, Deserialize)]
struct DedupDecision {
    #[serde(default)]
    action: String,
    #[serde(default)]
    keep_note_id: Option<String>,
    #[serde(default)]
    merged_content: Option<String>,
}

#[derive(Debug, Default)]
pub struct SemanticDedupReport {
    /// 完成复核的条数（含合并与保留）
    pub reviewed: usize,
    /// 实际合并（删除冗余者）的条数
    pub merged: usize,
    /// 本轮消耗的 LLM 判定调用次数
    pub llm_calls: usize,
}

pub struct SemanticDedup {
    vfs_db: Arc<VfsDatabase>,
}

impl SemanticDedup {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    /// 带全局节流的语义去重入口（供 `spawn_post_write_maintenance` 调用）
    ///
    /// 与 evolution 的 `run_throttled` 同款进程级 static AtomicI64 计时器，
    /// 确保标准 pipeline 和多变体 pipeline 共享同一节流窗口。
    pub async fn run_throttled(
        &self,
        memory_service: &MemoryService,
        llm_manager: Arc<LLMManager>,
        frequency: AutoExtractFrequency,
    ) -> Option<SemanticDedupReport> {
        use std::sync::atomic::{AtomicI64, Ordering};
        static LAST_SEMANTIC_DEDUP_MS: AtomicI64 = AtomicI64::new(0);

        // 间隔可配（memory_config KV，主键查询亚毫秒级）：常规档取配置值，
        // aggressive 档取 1/3（下限 30 分钟）——默认 360 分钟时与原 6h/2h 常量行为一致
        let base_interval_ms = super::config::MemoryConfig::new(self.vfs_db.clone())
            .get_evolution_tuning()
            .semantic_dedup_interval_minutes
            .saturating_mul(60_000);
        let interval_ms = match frequency {
            AutoExtractFrequency::Aggressive => {
                (base_interval_ms / 3).max(DEDUP_INTERVAL_AGGRESSIVE_FLOOR_MS)
            }
            _ => base_interval_ms,
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        let last = LAST_SEMANTIC_DEDUP_MS.load(Ordering::Relaxed);
        if now_ms - last < interval_ms {
            return None;
        }
        if LAST_SEMANTIC_DEDUP_MS
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }

        match self.run_dedup_pass(memory_service, llm_manager).await {
            Ok(report) => {
                if report.reviewed > 0 || report.merged > 0 {
                    info!(
                        "[SemanticDedup] Throttled pass: reviewed={}, merged={}, llm_calls={}",
                        report.reviewed, report.merged, report.llm_calls
                    );
                }
                Some(report)
            }
            Err(e) => {
                // 本轮执行失败时回滚节流时间，避免"失败也占用周期"导致长时间不重试
                LAST_SEMANTIC_DEDUP_MS.store(last, Ordering::Relaxed);
                warn!("[SemanticDedup] Throttled pass failed (non-fatal): {}", e);
                None
            }
        }
    }

    /// 执行一轮语义去重 pass
    async fn run_dedup_pass(
        &self,
        memory_service: &MemoryService,
        llm_manager: Arc<LLMManager>,
    ) -> VfsResult<SemanticDedupReport> {
        let mut report = SemanticDedupReport::default();

        // 双保险：调用方（spawn_post_write_maintenance）已按隐私模式跳过，
        // 这里再防御一次——本 pass 会把记忆内容送入外部 LLM。
        if memory_service.get_config()?.privacy_mode {
            debug!("[SemanticDedup] Privacy mode enabled, skipping pass");
            return Ok(report);
        }

        // 调优参数与 evolution 共用 EvolutionTuning：LLM 判定预算（0 表示关闭）
        // 与相似候选预筛门槛均可配（memory_config KV），预算另受进程内硬上限兜底
        let tuning = super::config::MemoryConfig::new(self.vfs_db.clone()).get_evolution_tuning();
        if tuning.semantic_merge_max_pairs == 0 {
            debug!("[SemanticDedup] semantic_merge_max_pairs=0, pass disabled");
            return Ok(report);
        }
        let llm_budget = tuning.semantic_merge_max_pairs.min(MAX_LLM_CALLS_PER_ROUND);
        let min_score = tuning.semantic_merge_min_score;

        // 候选：优先消化 `_needs_dedup_review` 积压；无积压时常规抽查
        let mut candidates = self.list_review_backlog(REVIEW_BATCH_LIMIT)?;
        let from_backlog = !candidates.is_empty();
        if candidates.is_empty() {
            candidates = Self::sample_recent_facts(memory_service, ROUTINE_SAMPLE_LIMIT)?;
        }
        if candidates.is_empty() {
            return Ok(report);
        }
        debug!(
            "[SemanticDedup] Pass start: {} candidates ({})",
            candidates.len(),
            if from_backlog {
                "review backlog"
            } else {
                "routine sample"
            }
        );

        let mut consecutive_llm_failures = 0usize;
        for note_id in &candidates {
            if report.llm_calls >= llm_budget {
                debug!("[SemanticDedup] LLM call budget exhausted, ending round");
                break;
            }
            let (outcome, llm_called) = self
                .process_candidate(memory_service, &llm_manager, note_id, min_score)
                .await;
            if llm_called {
                report.llm_calls += 1;
            }
            match outcome {
                CandidateOutcome::Merged => {
                    report.reviewed += 1;
                    report.merged += 1;
                    consecutive_llm_failures = 0;
                }
                CandidateOutcome::Kept => {
                    report.reviewed += 1;
                    consecutive_llm_failures = 0;
                }
                CandidateOutcome::Skipped => {}
                CandidateOutcome::LlmFailed => {
                    consecutive_llm_failures += 1;
                    if consecutive_llm_failures >= MAX_CONSECUTIVE_LLM_FAILURES {
                        warn!(
                            "[SemanticDedup] {} consecutive LLM failures, ending round early",
                            consecutive_llm_failures
                        );
                        break;
                    }
                }
            }
        }

        Ok(report)
    }

    /// 处理单条候选。返回 (处理结果, 是否消耗了一次 LLM 调用)。
    /// `min_score`：相似候选预筛门槛（`EvolutionTuning::semantic_merge_min_score`）。
    async fn process_candidate(
        &self,
        memory_service: &MemoryService,
        llm_manager: &Arc<LLMManager>,
        note_id: &str,
        min_score: f32,
    ) -> (CandidateOutcome, bool) {
        // 读取复核对象（read 已限制在记忆根内，已删除/根外返回 None）
        let (note, content) = match memory_service.read(note_id) {
            Ok(Some(pair)) => pair,
            Ok(None) => return (CandidateOutcome::Skipped, false),
            Err(e) => {
                warn!(
                    "[SemanticDedup] Failed to read candidate {}: {}",
                    note_id, e
                );
                return (CandidateOutcome::Skipped, false);
            }
        };
        if note.title.starts_with("__") {
            // 系统笔记不参与去重（tags LIKE 预筛可能误召回，这里精确兜底）
            return (CandidateOutcome::Skipped, false);
        }
        if note.tags.iter().any(|t| t == TAG_ARCHIVED) {
            // 已归档记忆索引已清空、不参与检索，去重合并只会把它意外复活；
            // 视为复核完成摘标签即可
            self.remove_review_tag(&note.id);
            return (CandidateOutcome::Kept, false);
        }
        if content.trim().is_empty() {
            // 空内容无法做语义比对，视为复核完成
            self.remove_review_tag(&note.id);
            return (CandidateOutcome::Kept, false);
        }
        let memory_type = MemoryType::from_tags(&note.tags);

        // 用内容做相似检索（InternalDedup 不记命中），找同类型的最相似候选
        let similar = match memory_service
            .search_for_purpose(&content, 5, SearchPurpose::InternalDedup)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(
                    "[SemanticDedup] Similar search failed for {}: {}",
                    note.id, e
                );
                return (CandidateOutcome::Skipped, false);
            }
        };

        let mut pair: Option<(VfsNote, String)> = None;
        for hit in &similar {
            if hit.note_id == note.id || hit.score < min_score {
                continue;
            }
            match memory_service.read(&hit.note_id) {
                Ok(Some((other, other_content))) => {
                    // 跨类型不合并（与 evolution 的溢出合并同口径）；归档记忆不作为合并对象
                    if other.title.starts_with("__")
                        || other.tags.iter().any(|t| t == TAG_ARCHIVED)
                        || MemoryType::from_tags(&other.tags) != memory_type
                        || other_content.trim().is_empty()
                    {
                        continue;
                    }
                    pair = Some((other, other_content));
                    break;
                }
                Ok(None) => continue,
                Err(e) => {
                    warn!(
                        "[SemanticDedup] Failed to read similar note {}: {}",
                        hit.note_id, e
                    );
                    continue;
                }
            }
        }

        let Some((other, other_content)) = pair else {
            // 无高相似候选：复核完成，摘标签
            self.remove_review_tag(&note.id);
            return (CandidateOutcome::Kept, false);
        };

        // LLM 判定 merge/keep（严格 JSON 输出，超时/失败不摘标签、下轮再试）
        let max_chars = memory_type.max_content_chars();
        let prompt = build_dedup_prompt(&note, &content, &other, &other_content, max_chars);
        let llm_result = tokio::time::timeout(
            std::time::Duration::from_secs(LLM_CALL_TIMEOUT_SECS),
            llm_manager.call_memory_decision_raw_prompt(&prompt),
        )
        .await;
        let response = match llm_result {
            Ok(Ok(output)) => output.assistant_message,
            Ok(Err(e)) => {
                warn!("[SemanticDedup] LLM call failed for {}: {}", note.id, e);
                return (CandidateOutcome::LlmFailed, true);
            }
            Err(_) => {
                warn!(
                    "[SemanticDedup] LLM call timed out ({}s) for {}",
                    LLM_CALL_TIMEOUT_SECS, note.id
                );
                return (CandidateOutcome::LlmFailed, true);
            }
        };
        let Some(decision) = parse_dedup_response(&response) else {
            warn!(
                "[SemanticDedup] Failed to parse LLM response for {}",
                note.id
            );
            return (CandidateOutcome::LlmFailed, true);
        };

        // keep，或 merge 参数不满足安全护栏（keep_note_id 非两者之一 /
        // 合并内容为空 / 超类型字数上限）→ 拒绝合并，两条都保留，复核完成
        let Some((keep_id, merged_content)) =
            validate_merge_decision(&decision, &note, &other, max_chars)
        else {
            self.remove_review_tag(&note.id);
            return (CandidateOutcome::Kept, true);
        };

        let (keeper, loser) = if keep_id == note.id {
            (&note, &other)
        } else {
            (&other, &note)
        };

        // 合并前先取两条的 _hits/_used 较大值与 _important 归并结果
        let merged_hits = extract_tag_count(&keeper.tags, TAG_HITS_PREFIX)
            .max(extract_tag_count(&loser.tags, TAG_HITS_PREFIX));
        let merged_used = extract_tag_count(&keeper.tags, TAG_USED_PREFIX)
            .max(extract_tag_count(&loser.tags, TAG_USED_PREFIX));
        let merged_important = keeper.tags.iter().any(|t| t == "_important")
            || loser.tags.iter().any(|t| t == "_important");

        // 1) 更新保留者内容（内部校验长度/敏感信息；OCC 冲突等失败则本轮跳过、不摘标签）
        if let Err(e) = memory_service.update_by_id_with_source(
            &keeper.id,
            None,
            Some(merged_content.as_str()),
            MemoryOpSource::SemanticDedup,
            None,
        ) {
            warn!(
                "[SemanticDedup] Failed to update keeper {} with merged content: {}",
                keeper.id, e
            );
            return (CandidateOutcome::Skipped, true);
        }

        // 2) 删除冗余者（delete_with_source 会清向量索引与反向 _ref）
        if let Err(e) = memory_service
            .delete_with_source(&loser.id, MemoryOpSource::SemanticDedup, None)
            .await
        {
            warn!(
                "[SemanticDedup] Merged content written but failed to delete duplicate {}: {}",
                loser.id, e
            );
            self.log_merge_audit(
                memory_service,
                keeper,
                loser,
                &merged_content,
                false,
                Some(&e.to_string()),
            );
            // 不摘标签：下轮重试可收尾删除侧（内容已合并，重复检索会再次命中该对）
            return (CandidateOutcome::Skipped, true);
        }

        // 3) 保留者标签归并：_hits/_used 取较大值、_important 有一即有、摘除待复核标签
        self.merge_keeper_tags(&keeper.id, merged_hits, merged_used, merged_important);

        self.log_merge_audit(memory_service, keeper, loser, &merged_content, true, None);
        info!(
            "[SemanticDedup] Merged duplicate: kept '{}' ({}), deleted '{}' ({})",
            keeper.title, keeper.id, loser.title, loser.id
        );
        (CandidateOutcome::Merged, true)
    }

    /// 找出带 `_needs_dedup_review` 标签的积压记忆（最老的优先复核）。
    ///
    /// tags 为 JSON 数组文本；LIKE 的 `_` 是单字符通配，可能少量误召回，
    /// `process_candidate` 读取后有系统笔记/根外兜底，误召回只会退化为
    /// 一次常规复核，无副作用。
    fn list_review_backlog(&self, limit: usize) -> VfsResult<Vec<String>> {
        let conn = self.vfs_db.get_conn_safe()?;
        let pattern = format!("%\"{}\"%", TAG_NEEDS_DEDUP_REVIEW);
        let mut stmt = conn.prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL AND tags LIKE ?1
             ORDER BY updated_at ASC LIMIT ?2",
        )?;
        let ids = stmt
            .query_map(params![pattern, limit as i64], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// 常规抽查：取最近更新的 N 条 fact 类记忆
    /// （list 已按 updated_at DESC 排序、排除 `__*__` 系统笔记；归档记忆不抽查）
    fn sample_recent_facts(memory_service: &MemoryService, limit: usize) -> VfsResult<Vec<String>> {
        let page = memory_service.list(None, (limit * 3) as u32, 0)?;
        Ok(page
            .into_iter()
            .filter(|m| m.memory_type == "fact" && !m.is_archived)
            .take(limit)
            .map(|m| m.id)
            .collect())
    }

    /// 摘除待复核标签（直接改写 tags、不推进 updated_at，与 record_search_hits 同口径）
    fn remove_review_tag(&self, note_id: &str) {
        let result: VfsResult<()> = (|| {
            let conn = self.vfs_db.get_conn_safe()?;
            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![note_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(tags_json) = tags_json else {
                return Ok(());
            };
            let mut tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let before = tags.len();
            tags.retain(|t| t != TAG_NEEDS_DEDUP_REVIEW);
            if tags.len() == before {
                return Ok(());
            }
            let new_tags_json = serde_json::to_string(&tags).unwrap_or_default();
            conn.execute(
                "UPDATE notes SET tags = ?1 WHERE id = ?2",
                params![new_tags_json, note_id],
            )?;
            Ok(())
        })();
        if let Err(e) = result {
            warn!(
                "[SemanticDedup] Failed to remove review tag from {}: {}",
                note_id, e
            );
        }
    }

    /// 合并后归并保留者标签：`_hits`/`_used` 取两者较大值、`_important` 有一即有、
    /// 同时摘除待复核标签（直接改写 tags、不推进 updated_at）
    fn merge_keeper_tags(
        &self,
        note_id: &str,
        merged_hits: u32,
        merged_used: u32,
        merged_important: bool,
    ) {
        let result: VfsResult<()> = (|| {
            let conn = self.vfs_db.get_conn_safe()?;
            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![note_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(tags_json) = tags_json else {
                return Ok(());
            };
            let mut tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            tags.retain(|t| {
                !t.starts_with(TAG_HITS_PREFIX)
                    && !t.starts_with(TAG_USED_PREFIX)
                    && t != TAG_NEEDS_DEDUP_REVIEW
                    && t != "_important"
            });
            if merged_hits > 0 {
                tags.push(format!("{}{}", TAG_HITS_PREFIX, merged_hits));
            }
            if merged_used > 0 {
                tags.push(format!("{}{}", TAG_USED_PREFIX, merged_used));
            }
            if merged_important {
                tags.push("_important".to_string());
            }
            let new_tags_json = serde_json::to_string(&tags).unwrap_or_default();
            conn.execute(
                "UPDATE notes SET tags = ?1 WHERE id = ?2",
                params![new_tags_json, note_id],
            )?;
            Ok(())
        })();
        if let Err(e) = result {
            warn!(
                "[SemanticDedup] Failed to merge keeper tags for {}: {}",
                note_id, e
            );
        }
    }

    /// 写 SEMANTIC_MERGE 审计（reason 含两条标题；删除侧失败时 success=false）
    fn log_merge_audit(
        &self,
        memory_service: &MemoryService,
        keeper: &VfsNote,
        loser: &VfsNote,
        merged_content: &str,
        success: bool,
        error: Option<&str>,
    ) {
        let reason = if let Some(err) = error {
            format!(
                "语义合并未完成：保留「{}」内容已更新，但删除「{}」失败：{}",
                keeper.title, loser.title, err
            )
        } else {
            format!(
                "语义合并：保留「{}」，删除重复记忆「{}」",
                keeper.title, loser.title
            )
        };
        memory_service.audit_logger().log(&MemoryAuditEntry {
            source: MemoryOpSource::SemanticDedup,
            operation: MemoryOpType::SemanticMerge,
            success,
            note_id: Some(keeper.id.clone()),
            title: Some(keeper.title.clone()),
            content_preview: Some(merged_content.to_string()),
            folder: None,
            event: Some("SEMANTIC_MERGE".to_string()),
            confidence: None,
            reason: Some(reason),
            session_id: None,
            duration_ms: None,
            extra_json: Some(
                serde_json::json!({
                    "deletedNoteId": loser.id,
                    "deletedTitle": loser.title,
                })
                .to_string(),
            ),
        });
    }
}

/// 从 tags 中提取形如 `<prefix>N` 的计数值（缺失时为 0）
fn extract_tag_count(tags: &[String], prefix: &str) -> u32 {
    tags.iter()
        .find_map(|t| t.strip_prefix(prefix).and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

/// 构建去重判定 prompt（纯函数，可单元测试）
fn build_dedup_prompt(
    note: &VfsNote,
    content: &str,
    other: &VfsNote,
    other_content: &str,
    max_chars: usize,
) -> String {
    format!(
        r#"你是记忆库的去重审查员。下面两条记忆可能是同一信息的措辞漂移（语义重复），请判断是否应合并。

## 记忆 A（本轮复核对象）
[ID: {a_id}] 标题: {a_title}
内容: {a_content}

## 记忆 B（相似候选）
[ID: {b_id}] 标题: {b_title}
内容: {b_content}

## 判定规则
1. 两条记忆表达同一事实/同一薄弱点/同一偏好（即使措辞不同）→ merge
2. 一条的信息完全被另一条涵盖 → merge（keep_note_id 填信息更全的那条）
3. 两条各有独立价值（不同事实、不同侧面、互补信息）→ keep
4. merge 时给出合并后内容：保留两条中的全部有效信息、去除冗余，不要编造新信息；合并内容不超过 {max_chars} 字
5. keep_note_id 必须是上面两条记忆之一的 ID

## 输出格式（严格 JSON，不要其他内容）
{{"action": "merge" | "keep", "keep_note_id": "merge 时填保留记忆的 ID", "merged_content": "merge 时填合并后内容"}}"#,
        a_id = note.id,
        a_title = note.title,
        a_content = content,
        b_id = other.id,
        b_title = other.title,
        b_content = other_content,
        max_chars = max_chars,
    )
}

/// 解析 LLM 判定响应（容错：代码块/前后杂讯；action 非法时返回 None 视为失败）
fn parse_dedup_response(response: &str) -> Option<DedupDecision> {
    let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);
    serde_json::from_str::<DedupDecision>(&cleaned)
        .ok()
        .or_else(|| extract_json_object(&cleaned).and_then(|s| serde_json::from_str(&s).ok()))
        .or_else(|| extract_json_object(response).and_then(|s| serde_json::from_str(&s).ok()))
        .filter(|d: &DedupDecision| {
            d.action.eq_ignore_ascii_case("merge") || d.action.eq_ignore_ascii_case("keep")
        })
}

/// 合并决策的安全护栏（纯函数）：
/// - action 必须为 merge；
/// - keep_note_id 必须是两条记忆之一；
/// - 合并内容非空且不超过类型字数上限（超限拒绝合并，退回 keep）。
///
/// 返回 Some((保留者 note_id, 合并后内容))，不满足则 None（按 keep 处理）。
fn validate_merge_decision(
    decision: &DedupDecision,
    a: &VfsNote,
    b: &VfsNote,
    max_chars: usize,
) -> Option<(String, String)> {
    if !decision.action.eq_ignore_ascii_case("merge") {
        return None;
    }
    let keep_id = decision.keep_note_id.as_deref()?.trim();
    if keep_id != a.id && keep_id != b.id {
        return None;
    }
    let merged = decision.merged_content.as_deref()?.trim();
    if merged.is_empty() || merged.chars().count() > max_chars {
        return None;
    }
    Some((keep_id.to_string(), merged.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_note(id: &str, title: &str, tags: Vec<String>) -> VfsNote {
        VfsNote {
            id: id.to_string(),
            resource_id: format!("res_{}", id),
            title: title.to_string(),
            tags,
            is_favorite: false,
            created_at: "2026-07-01T00:00:00Z".to_string(),
            updated_at: "2026-07-01T00:00:00Z".to_string(),
            deleted_at: None,
            props: None,
        }
    }

    #[test]
    fn test_parse_dedup_response_merge() {
        let raw = r#"```json
{"action": "merge", "keep_note_id": "n1", "merged_content": "数学二次函数配方法掌握不牢，符号处理常出错"}
```"#;
        let decision = parse_dedup_response(raw).unwrap();
        assert_eq!(decision.action, "merge");
        assert_eq!(decision.keep_note_id.as_deref(), Some("n1"));
    }

    #[test]
    fn test_parse_dedup_response_keep_with_noise() {
        let raw = "分析：两条各有价值。\n{\"action\": \"keep\"}";
        let decision = parse_dedup_response(raw).unwrap();
        assert_eq!(decision.action, "keep");
        assert!(decision.keep_note_id.is_none());
    }

    #[test]
    fn test_parse_dedup_response_invalid_action() {
        assert!(parse_dedup_response(r#"{"action": "delete"}"#).is_none());
        assert!(parse_dedup_response("没有 JSON").is_none());
    }

    #[test]
    fn test_validate_merge_decision_guards() {
        let a = test_note("n1", "A", vec![]);
        let b = test_note("n2", "B", vec![]);

        let ok = DedupDecision {
            action: "merge".to_string(),
            keep_note_id: Some("n1".to_string()),
            merged_content: Some("合并后内容".to_string()),
        };
        assert_eq!(
            validate_merge_decision(&ok, &a, &b, 200),
            Some(("n1".to_string(), "合并后内容".to_string()))
        );

        // keep_note_id 不是两者之一 → 拒绝
        let bad_id = DedupDecision {
            action: "merge".to_string(),
            keep_note_id: Some("n999".to_string()),
            merged_content: Some("内容".to_string()),
        };
        assert!(validate_merge_decision(&bad_id, &a, &b, 200).is_none());

        // 合并内容超过类型上限 → 拒绝合并（退回 keep）
        let too_long = DedupDecision {
            action: "merge".to_string(),
            keep_note_id: Some("n2".to_string()),
            merged_content: Some("长".repeat(201)),
        };
        assert!(validate_merge_decision(&too_long, &a, &b, 200).is_none());

        // 空内容 → 拒绝
        let empty = DedupDecision {
            action: "merge".to_string(),
            keep_note_id: Some("n1".to_string()),
            merged_content: Some("   ".to_string()),
        };
        assert!(validate_merge_decision(&empty, &a, &b, 200).is_none());

        // keep 不产出合并参数
        let keep = DedupDecision {
            action: "keep".to_string(),
            keep_note_id: None,
            merged_content: None,
        };
        assert!(validate_merge_decision(&keep, &a, &b, 200).is_none());
    }

    #[test]
    fn test_extract_tag_count_max_merge() {
        let a_tags = vec![
            "_hits:3".to_string(),
            "_used:2".to_string(),
            "_type:fact".to_string(),
        ];
        let b_tags = vec!["_hits:7".to_string()];
        assert_eq!(
            extract_tag_count(&a_tags, TAG_HITS_PREFIX)
                .max(extract_tag_count(&b_tags, TAG_HITS_PREFIX)),
            7
        );
        assert_eq!(
            extract_tag_count(&a_tags, TAG_USED_PREFIX)
                .max(extract_tag_count(&b_tags, TAG_USED_PREFIX)),
            2
        );
        assert_eq!(extract_tag_count(&[], TAG_HITS_PREFIX), 0);
    }

    #[test]
    fn test_build_dedup_prompt_contains_both_notes() {
        let a = test_note("n1", "数学二次函数薄弱", vec![]);
        let b = test_note("n2", "配方法掌握不牢", vec![]);
        let prompt = build_dedup_prompt(&a, "内容A", &b, "内容B", 200);
        assert!(prompt.contains("[ID: n1]"));
        assert!(prompt.contains("[ID: n2]"));
        assert!(prompt.contains("内容A"));
        assert!(prompt.contains("内容B"));
        assert!(prompt.contains("不超过 200 字"));
        assert!(prompt.contains(r#""action": "merge" | "keep""#));
    }
}
