//! 记忆自进化模块
//!
//! 受 memU Self-Evolution 启发：
//! - 低频记忆降级（双阈值分层）：搜索命中 90 天内视为活跃；无命中但注入在场
//!   180 天内视为在场保护；两者均超期且低命中才标记 `_stale`（阈值可配）
//! - 高频记忆升级：频繁命中的记忆在分类中突出标记
//! - 休眠归档：stale 后再过一个可配置周期仍无活跃信号 → 打 `_archived` 并移出
//!   检索索引（笔记本体保留，可从记忆界面恢复）；分类配额超限时按"最弱优先"归档
//! - 分类自动重组：当某文件夹记忆过多时触发精确合并去重
//! - 日志→画像晋升（参考成熟代理运行时的 dreaming，务实简化版）：扫描近 7 天
//!   每日学习日志，用 LLM 识别反复出现的错误模式/偏好变化，生成学习者
//!   画像增量更新并直接应用（带 audit_log + 画像版本号递增）
//!
//! 设计为后台定时任务，通过 `run_evolution_cycle` 一次性执行同步进化操作
//! （Phase 1-5，见其内注释）。语义级重复合并（措辞漂移的重复回收、
//! `_needs_dedup_review` 复核闭环）见独立模块 `semantic_dedup.rs`——涉及
//! LLM 判定与更复杂的护栏，由 `spawn_post_write_maintenance` 独立节流调用。

use std::sync::Arc;

use rusqlite::params;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::index_unit_repo;
use crate::vfs::repos::note_repo::VfsNoteRepo;

use super::audit_log::{MemoryAuditEntry, MemoryAuditLogger, MemoryOpSource, MemoryOpType};
use super::daily_log::{self, DailyLogRecord};
use super::learner_profile::{self, LearnerProfile, LearnerProfileUpdate};
use super::service::{MemoryListItem, MemoryService};

// stale/归档/配额/语义合并的天数阈值、命中数门槛与配额均已迁入 memory_config KV
// （见 config.rs 的 `EvolutionTuning`，每轮周期加载一次）
const HIGH_FREQ_HITS_THRESHOLD: u32 = 5;
/// `_used`（真实使用：LLM 读取全文）的晋升门槛。`_used` 是比 `_hits`
/// （top-N 检索曝光）强得多的信号，3 次真实使用即视为高价值记忆
const HIGH_FREQ_USED_THRESHOLD: u32 = 3;
const FOLDER_OVERFLOW_THRESHOLD: usize = 20;
const EVOLUTION_SCAN_BATCH_SIZE: u32 = 200;
/// 归档旗标标签（旗标非值前缀，同步 TagSetUnion 并集语义天然安全）
const TAG_ARCHIVED: &str = "_archived";
/// 晋升 pass 扫描的日志天数
const PROMOTION_SCAN_DAYS: u32 = 7;
/// 晋升输入指纹的配置键（日志无变化时跳过 LLM 调用）
const PROMOTION_LAST_FINGERPRINT_KEY: &str = "learner_promotion_last_fingerprint";

pub struct MemoryEvolution {
    vfs_db: Arc<VfsDatabase>,
    lance_store: Option<Arc<VfsLanceStore>>,
}

#[derive(Debug, Default)]
pub struct EvolutionReport {
    pub stale_demoted: usize,
    pub high_freq_promoted: usize,
    pub duplicates_merged: usize,
    /// 休眠归档数（stale 后长期无信号自动归档）
    pub archived_dormant: usize,
    /// 分类配额归档数（文件夹超预算时"最弱优先"归档）
    pub archived_quota: usize,
}

impl EvolutionReport {
    fn has_changes(&self) -> bool {
        self.stale_demoted > 0
            || self.high_freq_promoted > 0
            || self.duplicates_merged > 0
            || self.archived_dormant > 0
            || self.archived_quota > 0
    }
}

impl MemoryEvolution {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        // 失败时保持原有降级行为（无向量清理的进化周期），但不再静默吞错。
        let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
            Ok(store) => Some(Arc::new(store)),
            Err(e) => {
                warn!(
                    "[MemoryEvolution] Failed to open lance store, evolution will run without vector cleanup: {}",
                    e
                );
                None
            }
        };
        Self {
            vfs_db,
            lance_store,
        }
    }

    /// 带全局节流的自进化执行入口
    ///
    /// `interval_ms` 由 `AutoExtractFrequency::evolution_interval_ms()` 提供。
    /// 使用进程级 static AtomicI64 确保标准 pipeline 和多变体 pipeline 共享同一计时器。
    pub fn run_throttled(
        &self,
        memory_service: &MemoryService,
        interval_ms: i64,
    ) -> Option<EvolutionReport> {
        use std::sync::atomic::{AtomicI64, Ordering};
        static LAST_EVOLUTION_MS: AtomicI64 = AtomicI64::new(0);

        let now_ms = chrono::Utc::now().timestamp_millis();
        let last = LAST_EVOLUTION_MS.load(Ordering::Relaxed);
        if now_ms - last < interval_ms {
            return None;
        }
        if LAST_EVOLUTION_MS
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }

        match self.run_evolution_cycle(memory_service) {
            Ok(report) => {
                if report.has_changes() {
                    info!(
                        "[Evolution] Throttled cycle: demoted={}, promoted={}, merged={}, archived={}+{}",
                        report.stale_demoted,
                        report.high_freq_promoted,
                        report.duplicates_merged,
                        report.archived_dormant,
                        report.archived_quota
                    );
                }
                Some(report)
            }
            Err(e) => {
                // 本轮执行失败时回滚节流时间，避免“失败也占用周期”导致长时间不重试。
                LAST_EVOLUTION_MS.store(last, Ordering::Relaxed);
                warn!("[Evolution] Throttled cycle failed (non-fatal): {}", e);
                None
            }
        }
    }

    /// 执行一轮完整的自进化周期
    pub fn run_evolution_cycle(
        &self,
        memory_service: &MemoryService,
    ) -> VfsResult<EvolutionReport> {
        let mut report = EvolutionReport::default();

        let mut all_memories = Vec::new();
        let mut offset = 0u32;
        loop {
            let page = memory_service.list(None, EVOLUTION_SCAN_BATCH_SIZE, offset)?;
            if page.is_empty() {
                break;
            }
            let page_len = page.len() as u32;
            all_memories.extend(page);
            if page_len < EVOLUTION_SCAN_BATCH_SIZE {
                break;
            }
            offset = offset.saturating_add(EVOLUTION_SCAN_BATCH_SIZE);
        }
        if all_memories.is_empty() {
            return Ok(report);
        }

        // 每轮周期加载一次生命周期调优参数（memory_config KV，缺失时取默认值）
        let tuning = super::config::MemoryConfig::new(self.vfs_db.clone()).get_evolution_tuning();

        // Phase 1: 低频记忆降级（双阈值：命中活跃窗口 / 注入在场保护窗口）
        report.stale_demoted = self.demote_stale_memories(&all_memories, &tuning)?;

        // Phase 2: 识别高频记忆并打标记
        report.high_freq_promoted = self.promote_high_freq_memories(&all_memories)?;

        // Phase 3: 检查文件夹溢出并按 (title, memory_type) 精确合并重复
        report.duplicates_merged = self.check_folder_overflow(memory_service)?;

        // Phase 4: 休眠归档——已 stale 且信号继续超期一个归档周期的记忆
        //（需在 Phase 1 之后：本轮新降级的记忆不会立即归档，信号计龄天然分层）
        report.archived_dormant = self.archive_dormant_memories(&all_memories, &tuning)?;

        // Phase 5: 分类配额——文件夹活跃记忆仍超预算时按"最弱优先"归档超出部分
        //（需在 Phase 3 合并与 Phase 4 归档之后重新按文件夹统计，先合并再裁员）
        report.archived_quota = self.enforce_category_quota(memory_service, &tuning)?;

        // Phase 6（异步，不在本周期内）：语义级重复合并与 `_needs_dedup_review`
        // 复核闭环见 `semantic_dedup.rs`，由 spawn_post_write_maintenance 独立
        // 节流调用（涉及 LLM 判定，隐私模式下跳过）。

        info!(
            "[Evolution] Cycle complete: demoted={}, promoted={}, merged={}, archived_dormant={}, archived_quota={}",
            report.stale_demoted,
            report.high_freq_promoted,
            report.duplicates_merged,
            report.archived_dormant,
            report.archived_quota
        );

        Ok(report)
    }

    /// 低频记忆降级（双阈值分层）：给无活跃信号的记忆添加 `_stale` 标签
    ///
    /// 分层判据（修复"在场≠有用"偏差——分类聚合成员每轮注入都会刷新
    /// `_last_injected`，若与搜索命中共用同一阈值取 max，则被注入分类里的
    /// 记忆永不衰老，衰减机制实际失效）：
    /// - 距 `_last_hit` ≤ `stale_hit_days`（默认 90 天）：搜索命中活跃，跳过；
    /// - 无有效命中但距 `_last_injected` ≤ `stale_injected_days`（默认 180 天）：
    ///   注入在场只提供有限期保护（更长窗口），窗口内跳过；
    /// - 两个信号均超期且 hits < `stale_min_hits`（默认 2）才降级；
    /// - 两个信号均缺失时回退到 updated_at 按命中窗口计龄（保持原行为）。
    fn demote_stale_memories(
        &self,
        memories: &[MemoryListItem],
        tuning: &super::config::EvolutionTuning,
    ) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now = chrono::Utc::now();
        let mut demoted = 0usize;
        // (note_id, title, 无信号天数, 命中数)，COMMIT 后写审计日志
        let mut demoted_entries: Vec<(String, String, i64, u32)> = Vec::new();

        conn.execute_batch("BEGIN IMMEDIATE")?;

        for mem in memories {
            if mem.title.starts_with("__") {
                continue;
            }
            // 用户主动保存的经验笔记/学习记忆不参与自动降级
            if mem.memory_type == "note" || mem.memory_type == "study" {
                continue;
            }

            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![&mem.id],
                    |row| row.get(0),
                )
                .ok();

            let Some(tags_json) = tags_json else {
                continue;
            };
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

            if tags.iter().any(|t| t == "_stale" || t == TAG_ARCHIVED) {
                continue;
            }

            let hits = Self::extract_hits(&tags);
            let last_hit_ms = Self::extract_last_hit_ms(&tags);
            let last_injected_ms = Self::extract_last_injected_ms(&tags);

            // 命中活跃窗口内：跳过
            if Self::signal_within_days(&now, last_hit_ms, tuning.stale_hit_days) {
                continue;
            }
            // 注入在场保护窗口内：跳过（保护窗口比命中窗口长，但有限期）
            if Self::signal_within_days(&now, last_injected_ms, tuning.stale_injected_days) {
                continue;
            }
            // 两个信号均缺失：回退到 updated_at 按命中窗口计龄
            if last_hit_ms.is_none() && last_injected_ms.is_none() {
                let age_days = Self::updated_at_age_days(&now, &mem.updated_at);
                if age_days <= tuning.stale_hit_days {
                    continue;
                }
            }

            // 审计展示用：距最近一次任意信号（或 updated_at 回退）的天数
            let days_since_signal =
                Self::days_since_best_signal(&now, last_hit_ms, last_injected_ms, &mem.updated_at);

            if hits < tuning.stale_min_hits {
                let mut new_tags = tags.clone();
                new_tags.push("_stale".to_string());
                let new_tags_json = serde_json::to_string(&new_tags).unwrap_or_default();
                if conn
                    .execute(
                        "UPDATE notes SET tags = ?1 WHERE id = ?2",
                        params![new_tags_json, &mem.id],
                    )
                    .is_ok()
                {
                    demoted += 1;
                    demoted_entries.push((
                        mem.id.clone(),
                        mem.title.clone(),
                        days_since_signal,
                        hits,
                    ));
                    debug!(
                        "[Evolution] Demoted stale memory: {} ({}d, {}hits)",
                        mem.title, days_since_signal, hits
                    );
                }
            }
        }

        conn.execute_batch("COMMIT")?;

        // stale 降级的可见性：写入 memory_audit_log（source=evolution），
        // 让"这条记忆为何从画像注入中消失"可在记忆审计界面追溯。
        // 放在 COMMIT 之后，避免审计写入与上面的事务争用写锁。
        if !demoted_entries.is_empty() {
            let audit = MemoryAuditLogger::new(self.vfs_db.clone());
            for (note_id, title, days, hits) in &demoted_entries {
                audit.log(&MemoryAuditEntry {
                    source: MemoryOpSource::Evolution,
                    operation: MemoryOpType::UpdateTags,
                    success: true,
                    note_id: Some(note_id.clone()),
                    title: Some(title.clone()),
                    content_preview: None,
                    folder: None,
                    event: Some("STALE_DEMOTE".to_string()),
                    confidence: None,
                    reason: Some(format!(
                        "距最近活跃信号 {} 天（命中 {} 次）：搜索命中与注入在场分别超出各自窗口，标记为 _stale",
                        days, hits
                    )),
                    session_id: None,
                    duration_ms: None,
                    extra_json: None,
                });
            }
        }

        Ok(demoted)
    }

    /// 高频记忆升级：给频繁命中的记忆添加 `_important` 标签
    fn promote_high_freq_memories(&self, memories: &[MemoryListItem]) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let mut promoted = 0usize;

        conn.execute_batch("BEGIN IMMEDIATE")?;

        for mem in memories {
            if mem.title.starts_with("__") {
                continue;
            }

            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![&mem.id],
                    |row| row.get(0),
                )
                .ok();

            let Some(tags_json) = tags_json else {
                continue;
            };
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

            if tags.iter().any(|t| t == "_important") {
                continue;
            }

            let hits = Self::extract_hits(&tags);
            let used = Self::extract_used(&tags);

            // 晋升判据：`_used`（真实使用）优先，`_hits`（检索曝光）保留为
            // 兼容口径——`_used` 是新信号，存量记忆只有 hits 可依据
            if used >= HIGH_FREQ_USED_THRESHOLD || hits >= HIGH_FREQ_HITS_THRESHOLD {
                let mut new_tags: Vec<String> =
                    tags.into_iter().filter(|t| t != "_stale").collect();
                new_tags.push("_important".to_string());
                let new_tags_json = serde_json::to_string(&new_tags).unwrap_or_default();
                if conn
                    .execute(
                        "UPDATE notes SET tags = ?1 WHERE id = ?2",
                        params![new_tags_json, &mem.id],
                    )
                    .is_ok()
                {
                    promoted += 1;
                    debug!(
                        "[Evolution] Promoted high-freq memory: {} (used={}, hits={})",
                        mem.title, used, hits
                    );
                }
            }
        }

        conn.execute_batch("COMMIT")?;
        Ok(promoted)
    }

    /// 检查文件夹溢出并执行合并：同一文件夹中标题完全相同的记忆合并内容后去重
    fn check_folder_overflow(&self, memory_service: &MemoryService) -> VfsResult<usize> {
        let mut folders: Vec<String> = vec![String::new()];
        if let Ok(Some(tree)) = memory_service.get_tree() {
            Self::collect_all_folder_paths(&tree.children, "", &mut folders);
        }
        if folders.is_empty() {
            return Ok(0);
        }
        let mut merged_count = 0usize;
        let conn = self.vfs_db.get_conn_safe()?;

        for folder in &folders {
            let folder_arg = if folder.is_empty() {
                None
            } else {
                Some(folder.as_str())
            };
            let mut items: Vec<MemoryListItem> = Vec::new();
            let mut offset = 0u32;
            loop {
                let page = memory_service.list_shallow(folder_arg, 200, offset)?;
                if page.is_empty() {
                    break;
                }
                let page_len = page.len() as u32;
                items.extend(page);
                if page_len < 200 {
                    break;
                }
                offset = offset.saturating_add(200);
            }
            // 已归档记忆不参与溢出统计与合并（其索引已清空，本体等待恢复或休眠）
            let active: Vec<&MemoryListItem> = items
                .iter()
                .filter(|m| !m.title.starts_with("__") && !m.is_archived)
                .collect();

            if active.len() <= FOLDER_OVERFLOW_THRESHOLD {
                continue;
            }

            let mut folder_merged = 0usize;
            // 按 (title, memory_type) 分组，避免跨类型误合并
            let mut title_groups: std::collections::HashMap<(&str, &str), Vec<&MemoryListItem>> =
                std::collections::HashMap::new();
            for mem in &active {
                title_groups
                    .entry((&mem.title, &mem.memory_type))
                    .or_default()
                    .push(mem);
            }

            for group in title_groups.values() {
                if group.len() < 2 {
                    continue;
                }
                let keep = group[0];
                let mut combined_content = String::new();
                let mut seen_fragments = std::collections::HashSet::new();
                let mut content_read_failed = false;
                for mem in group {
                    match crate::vfs::repos::note_repo::VfsNoteRepo::get_note_content(
                        &self.vfs_db,
                        &mem.id,
                    ) {
                        Ok(Some(content)) => {
                            for fragment in Self::split_merge_fragments(&content) {
                                if seen_fragments.insert(fragment.clone()) {
                                    if !combined_content.is_empty() {
                                        combined_content.push_str("\n\n");
                                    }
                                    combined_content.push_str(&fragment);
                                }
                            }
                        }
                        Ok(None) => {
                            warn!(
                                "[Evolution] Empty note content when merging group '{}': {}",
                                keep.title, mem.id
                            );
                            content_read_failed = true;
                            break;
                        }
                        Err(e) => {
                            warn!(
                                "[Evolution] Failed to read content for duplicate merge {}: {}",
                                mem.id, e
                            );
                            content_read_failed = true;
                            break;
                        }
                    }
                }
                if content_read_failed {
                    continue;
                }
                if combined_content.trim().is_empty() {
                    warn!(
                        "[Evolution] Skip empty merge output for title '{}', group_size={}",
                        keep.title,
                        group.len()
                    );
                    continue;
                }

                let updated_keep = match crate::vfs::repos::note_repo::VfsNoteRepo::update_note(
                    &self.vfs_db,
                    &keep.id,
                    crate::vfs::types::VfsUpdateNoteParams {
                        title: None,
                        content: Some(combined_content),
                        tags: None,
                        expected_updated_at: None,
                    },
                ) {
                    Ok(note) => note,
                    Err(e) => {
                        warn!(
                            "[Evolution] Failed to update merged memory {}: {}",
                            keep.id, e
                        );
                        continue;
                    }
                };

                if let Err(e) =
                    VfsIndexStateRepo::mark_pending(&self.vfs_db, &updated_keep.resource_id)
                {
                    warn!(
                        "[Evolution] Failed to mark pending after merge update {}: {}",
                        keep.id, e
                    );
                }

                for dup in &group[1..] {
                    let resource_id: Option<String> = VfsNoteRepo::get_note(&self.vfs_db, &dup.id)
                        .ok()
                        .flatten()
                        .map(|n| n.resource_id);

                    if let Err(e) =
                        crate::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item(
                            &self.vfs_db,
                            &dup.id,
                        )
                    {
                        warn!("[Evolution] Failed to delete duplicate {}: {}", dup.id, e);
                    } else {
                        if let Some(ref res_id) = resource_id {
                            self.remove_resource_from_index(&conn, res_id, "evolution merged duplicate");
                        }
                        folder_merged += 1;
                        debug!(
                            "[Evolution] Merged duplicate '{}' ({} → {})",
                            keep.title, dup.id, keep.id
                        );
                    }
                }
            }

            if folder_merged > 0 {
                info!(
                    "[Evolution] Folder '{}': merged {} duplicate memories (was {} active)",
                    folder,
                    folder_merged,
                    active.len()
                );
                merged_count += folder_merged;
            }
        }

        Ok(merged_count)
    }

    /// 将资源移出检索索引：Lance 向量即时删除（尽力而为）+ 入孤儿队列清 units
    /// （Lance 删除失败由后台 drain 兜底，模式同 vfs UI 删除路径）+ 索引状态置 disabled。
    /// 合并去重的被删方与归档记忆共用此路径。
    fn remove_resource_from_index(
        &self,
        conn: &rusqlite::Connection,
        resource_id: &str,
        reason: &str,
    ) {
        if let Some(ref lance) = self.lance_store {
            let lance_c = lance.clone();
            let res_id_c = resource_id.to_string();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                if let Err(e) = tokio::task::block_in_place(|| {
                    handle.block_on(async { lance_c.delete_by_resource("text", &res_id_c).await })
                }) {
                    warn!(
                        "[Evolution] Failed to delete vector chunks for {}: {}",
                        resource_id, e
                    );
                }
            }
        }
        // ★ A2-X1：入孤儿队列后再删 units，Lance 删除失败由后台 drain 兜底
        if let Err(e) = index_unit_repo::purge_index_artifacts_by_resource(conn, resource_id) {
            warn!(
                "[Evolution] Failed to purge index artifacts for {}: {}",
                resource_id, e
            );
        }
        if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(&self.vfs_db, resource_id, reason)
        {
            warn!(
                "[Evolution] Failed to mark index disabled for {}: {}",
                resource_id, e
            );
        }
    }

    /// 归档单条记忆：打 `_archived` 旗标（直接 SQL 重写 tags，不触发 updated_at
    /// 变更以免干扰计龄）+ 移出检索索引 + 写审计。笔记本体与内容保留，可从
    /// 记忆界面恢复（`MemoryService::restore_archived`）。
    /// 返回是否实际发生归档（已归档/笔记不存在时为 false）。
    fn archive_memory_note(
        &self,
        conn: &rusqlite::Connection,
        note_id: &str,
        title: &str,
        event_reason: &str,
    ) -> VfsResult<bool> {
        let note = match VfsNoteRepo::get_note(&self.vfs_db, note_id)? {
            Some(n) => n,
            None => return Ok(false),
        };
        if note.tags.iter().any(|t| t == TAG_ARCHIVED) {
            return Ok(false);
        }

        let mut new_tags = note.tags.clone();
        new_tags.push(TAG_ARCHIVED.to_string());
        let new_tags_json = serde_json::to_string(&new_tags).unwrap_or_default();
        conn.execute(
            "UPDATE notes SET tags = ?1 WHERE id = ?2",
            params![new_tags_json, note_id],
        )?;

        self.remove_resource_from_index(conn, &note.resource_id, "memory archived");

        let audit = MemoryAuditLogger::new(self.vfs_db.clone());
        audit.log(&MemoryAuditEntry {
            source: MemoryOpSource::Evolution,
            operation: MemoryOpType::UpdateTags,
            success: true,
            note_id: Some(note_id.to_string()),
            title: Some(title.to_string()),
            content_preview: None,
            folder: None,
            event: Some("ARCHIVE".to_string()),
            confidence: None,
            reason: Some(event_reason.to_string()),
            session_id: None,
            duration_ms: None,
            extra_json: None,
        });

        debug!("[Evolution] Archived memory: {} ({})", title, note_id);
        Ok(true)
    }

    /// Phase 4: 休眠归档——本轮之前已是 `_stale` 的记忆，若距最近活跃信号
    /// 超过"命中窗口 + 归档等待期"（默认 90+90 天）仍无任何信号，则自动归档。
    ///
    /// 使用周期开始时的快照 is_stale（而非重读后的 tags），保证记忆至少以
    /// stale 状态度过一个完整 evolution 周期后才可能归档，用户有机会在界面
    /// 看到"过时"标记并手动恢复。stale 记忆一旦被搜索命中会即时复活
    /// （record_search_hits 摘除 `_stale`），不会走到这里。
    fn archive_dormant_memories(
        &self,
        memories: &[MemoryListItem],
        tuning: &super::config::EvolutionTuning,
    ) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now = chrono::Utc::now();
        let mut archived = 0usize;
        let archive_horizon_days = tuning
            .stale_hit_days
            .saturating_add(tuning.archive_after_stale_days);

        for mem in memories {
            if mem.title.starts_with("__") || !mem.is_stale || mem.is_archived {
                continue;
            }
            // 与降级同口径：经验笔记/学习记忆/重要记忆不参与自动归档
            if mem.memory_type == "note" || mem.memory_type == "study" || mem.is_important {
                continue;
            }

            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![&mem.id],
                    |row| row.get(0),
                )
                .ok();
            let Some(tags_json) = tags_json else {
                continue;
            };
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            // 快照后被恢复/归档/命中复活的记忆：以最新 tags 为准跳过
            if tags.iter().any(|t| t == TAG_ARCHIVED) || !tags.iter().any(|t| t == "_stale") {
                continue;
            }

            let hits = Self::extract_hits(&tags);
            if hits >= tuning.stale_min_hits {
                continue;
            }
            let last_hit_ms = Self::extract_last_hit_ms(&tags);
            let last_injected_ms = Self::extract_last_injected_ms(&tags);
            let days_since_signal =
                Self::days_since_best_signal(&now, last_hit_ms, last_injected_ms, &mem.updated_at);
            // 注入在场信号窗口更长：其未超出"在场窗口 + 归档等待期"时同样受保护
            if Self::signal_within_days(
                &now,
                last_injected_ms,
                tuning
                    .stale_injected_days
                    .saturating_add(tuning.archive_after_stale_days),
            ) {
                continue;
            }
            if days_since_signal <= archive_horizon_days {
                continue;
            }

            if self.archive_memory_note(
                &conn,
                &mem.id,
                &mem.title,
                &format!(
                    "标记 _stale 后持续无活跃信号（距最近信号 {} 天，超过归档水位 {} 天），自动归档并移出检索索引",
                    days_since_signal, archive_horizon_days
                ),
            )? {
                archived += 1;
            }
        }

        Ok(archived)
    }

    /// Phase 5: 分类配额——单个文件夹的活跃（非 stale/非归档）记忆超过预算时，
    /// 按"最弱优先"（无 `_important`、hits 最低、最老）归档超出部分。
    /// 前置的 Phase 3 已做过精确合并；重要记忆与经验笔记/学习记忆不参与强制归档，
    /// 因此可归档候选不足时允许仍然超限（宁可超预算，不动用户手存内容）。
    fn enforce_category_quota(
        &self,
        memory_service: &MemoryService,
        tuning: &super::config::EvolutionTuning,
    ) -> VfsResult<usize> {
        let mut folders: Vec<String> = vec![String::new()];
        if let Ok(Some(tree)) = memory_service.get_tree() {
            Self::collect_all_folder_paths(&tree.children, "", &mut folders);
        }
        let conn = self.vfs_db.get_conn_safe()?;
        let mut archived_total = 0usize;

        for folder in &folders {
            let folder_arg = if folder.is_empty() {
                None
            } else {
                Some(folder.as_str())
            };
            let mut items: Vec<MemoryListItem> = Vec::new();
            let mut offset = 0u32;
            loop {
                let page = memory_service.list_shallow(folder_arg, 200, offset)?;
                if page.is_empty() {
                    break;
                }
                let page_len = page.len() as u32;
                items.extend(page);
                if page_len < 200 {
                    break;
                }
                offset = offset.saturating_add(200);
            }

            let active: Vec<&MemoryListItem> = items
                .iter()
                .filter(|m| !m.title.starts_with("__") && !m.is_stale && !m.is_archived)
                .collect();
            if active.len() <= tuning.category_quota {
                continue;
            }
            let excess = active.len() - tuning.category_quota;

            // 可归档候选：仅自动提取的原子事实（fact），排除重要记忆
            let mut candidates: Vec<&&MemoryListItem> = active
                .iter()
                .filter(|m| !m.is_important && m.memory_type == "fact")
                .collect();
            // 最弱优先：hits 升序，其次 updated_at 升序（最老在前）
            candidates.sort_by(|a, b| {
                a.hits
                    .cmp(&b.hits)
                    .then_with(|| a.updated_at.cmp(&b.updated_at))
            });

            let mut folder_archived = 0usize;
            for mem in candidates.into_iter().take(excess) {
                if self.archive_memory_note(
                    &conn,
                    &mem.id,
                    &mem.title,
                    &format!(
                        "分类 '{}' 活跃记忆 {} 条超出预算 {}，按最弱优先归档（命中 {} 次）",
                        if folder.is_empty() { "（根目录）" } else { folder },
                        active.len(),
                        tuning.category_quota,
                        mem.hits
                    ),
                )? {
                    folder_archived += 1;
                }
            }

            if folder_archived > 0 {
                info!(
                    "[Evolution] Folder '{}': archived {} memories over quota {} (was {} active)",
                    folder,
                    folder_archived,
                    tuning.category_quota,
                    active.len()
                );
                archived_total += folder_archived;
            }
        }

        Ok(archived_total)
    }

    fn collect_all_folder_paths(
        children: &[crate::vfs::types::FolderTreeNode],
        parent_path: &str,
        out: &mut Vec<String>,
    ) {
        for child in children {
            if child.folder.title.starts_with("__") {
                continue;
            }
            let path = if parent_path.is_empty() {
                child.folder.title.clone()
            } else {
                format!("{}/{}", parent_path, child.folder.title)
            };
            out.push(path.clone());
            if !child.children.is_empty() {
                Self::collect_all_folder_paths(&child.children, &path, out);
            }
        }
    }

    fn extract_hits(tags: &[String]) -> u32 {
        tags.iter()
            .find_map(|t| t.strip_prefix("_hits:").and_then(|v| v.parse().ok()))
            .unwrap_or(0)
    }

    /// 提取 `_used:N` 真实使用计数（LLM 读取全文的强信号，见 service::record_used）
    fn extract_used(tags: &[String]) -> u32 {
        tags.iter()
            .find_map(|t| t.strip_prefix("_used:").and_then(|v| v.parse().ok()))
            .unwrap_or(0)
    }

    fn extract_last_hit_ms(tags: &[String]) -> Option<i64> {
        tags.iter()
            .find_map(|t| t.strip_prefix("_last_hit:").and_then(|v| v.parse().ok()))
    }

    /// 最近一次随分类摘要注入 system prompt 的时间
    /// （由 `MemoryService::record_injection_presence` 回写）
    fn extract_last_injected_ms(tags: &[String]) -> Option<i64> {
        tags.iter().find_map(|t| {
            t.strip_prefix("_last_injected:")
                .and_then(|v| v.parse().ok())
        })
    }

    /// 信号是否落在指定天数窗口内（信号缺失或时间戳非法均视为窗口外）
    fn signal_within_days(
        now: &chrono::DateTime<chrono::Utc>,
        signal_ms: Option<i64>,
        window_days: i64,
    ) -> bool {
        signal_ms
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| (*now - t).num_days() <= window_days)
            .unwrap_or(false)
    }

    /// updated_at 计龄（解析失败视为极老，宁可降级也不让坏数据永生）
    fn updated_at_age_days(now: &chrono::DateTime<chrono::Utc>, updated_at: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(updated_at)
            .map(|dt| (*now - dt.with_timezone(&chrono::Utc)).num_days())
            .unwrap_or(i64::MAX)
    }

    /// 距最近一次任意活跃信号的天数（两信号均缺失时回退 updated_at 计龄），
    /// 供审计展示与归档判据使用
    fn days_since_best_signal(
        now: &chrono::DateTime<chrono::Utc>,
        last_hit_ms: Option<i64>,
        last_injected_ms: Option<i64>,
        updated_at: &str,
    ) -> i64 {
        let best_ms = match (last_hit_ms, last_injected_ms) {
            (Some(hit), Some(injected)) => Some(hit.max(injected)),
            (hit, injected) => hit.or(injected),
        };
        match best_ms.and_then(chrono::DateTime::from_timestamp_millis) {
            Some(t) => (*now - t).num_days(),
            None => Self::updated_at_age_days(now, updated_at),
        }
    }

    fn split_merge_fragments(content: &str) -> Vec<String> {
        content
            .split("\n\n")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    }
}

// ============================================================================
// 日志→画像晋升 pass（三层记忆的晋升管道）
// ============================================================================

/// 晋升 pass 执行报告
#[derive(Debug, Default)]
pub struct PromotionReport {
    /// 扫描到的日志天数
    pub logs_scanned: usize,
    /// 是否实际应用了画像更新
    pub applied: bool,
    /// 应用后的画像版本号
    pub new_version: Option<u32>,
}

impl MemoryEvolution {
    /// 带全局节流的晋升 pass 入口（频率跟随现有 evolution 周期）
    ///
    /// 与 `run_throttled` 使用独立计时器：晋升涉及一次 LLM 调用，
    /// 失败时回滚节流时间以便下轮重试。
    pub async fn run_promotion_throttled(
        &self,
        memory_service: &MemoryService,
        llm_manager: Arc<LLMManager>,
        interval_ms: i64,
    ) -> Option<PromotionReport> {
        use std::sync::atomic::{AtomicI64, Ordering};
        static LAST_PROMOTION_MS: AtomicI64 = AtomicI64::new(0);

        let now_ms = chrono::Utc::now().timestamp_millis();
        let last = LAST_PROMOTION_MS.load(Ordering::Relaxed);
        if now_ms - last < interval_ms {
            return None;
        }
        if LAST_PROMOTION_MS
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }

        match self.run_promotion_pass(memory_service, llm_manager).await {
            Ok(report) => {
                if report.applied {
                    info!(
                        "[Evolution] Promotion pass applied: logs={}, new_version={:?}",
                        report.logs_scanned, report.new_version
                    );
                }
                Some(report)
            }
            Err(e) => {
                LAST_PROMOTION_MS.store(last, Ordering::Relaxed);
                warn!("[Evolution] Promotion pass failed (non-fatal): {}", e);
                None
            }
        }
    }

    /// 执行一轮"日志→画像"晋升：
    /// 1. 扫描近 7 天 daily log
    /// 2. 日志指纹未变化时直接跳过（省一次 LLM 调用）
    /// 3. LLM（memory decision task 模型）识别反复错误模式/偏好变化，生成增量提案
    /// 4. 结构化 merge 进画像并直接应用（版本号递增 + audit_log + 历史版本保留）
    pub async fn run_promotion_pass(
        &self,
        memory_service: &MemoryService,
        llm_manager: Arc<LLMManager>,
    ) -> VfsResult<PromotionReport> {
        let mut report = PromotionReport::default();

        let logs = daily_log::list_recent(memory_service, PROMOTION_SCAN_DAYS)?;
        report.logs_scanned = logs.len();
        if logs.is_empty() {
            debug!("[Evolution] Promotion: no recent daily logs; skip");
            return Ok(report);
        }

        // 指纹守卫：近 7 天日志内容无变化时不再重复调用 LLM
        let fingerprint = Self::promotion_fingerprint(&logs);
        let mem_cfg = super::config::MemoryConfig::new(self.vfs_db.clone());
        let cached_fingerprint = mem_cfg.get(PROMOTION_LAST_FINGERPRINT_KEY)?;
        let current_profile = learner_profile::load_profile(memory_service)?.unwrap_or_default();
        if current_profile.has_promotion_fingerprint(&fingerprint)
            || cached_fingerprint.as_deref() == Some(fingerprint.as_str())
        {
            // The profile marker is authoritative because it commits with the profile CAS.
            // Replaying a legacy config-only marker upgrades it in place; a marker replay also
            // repairs history that may have been interrupted after the profile commit.
            learner_profile::apply_profile_promotion_update(
                memory_service,
                &LearnerProfileUpdate::default(),
                MemoryOpSource::Evolution,
                None,
                "日志→画像晋升指纹恢复",
                learner_profile::ProfileLimitPolicy::Enforce,
                &fingerprint,
                || false,
            )?;
            if cached_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                if let Err(error) = mem_cfg.set(PROMOTION_LAST_FINGERPRINT_KEY, &fingerprint) {
                    warn!(
                        "[Evolution] Failed to repair promotion fingerprint cache: {}",
                        error
                    );
                }
            }
            debug!("[Evolution] Promotion: logs unchanged since last pass; skip");
            return Ok(report);
        }

        let prompt = build_promotion_prompt(&logs, &current_profile);

        let output = llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| VfsError::Other(format!("Promotion LLM call failed: {}", e)))?;

        let update = parse_promotion_response(&output.assistant_message);

        if update.is_empty() {
            debug!("[Evolution] Promotion: LLM proposed no profile update");
        }

        // Apply the proposal to the latest profile, not the snapshot used to
        // build the LLM prompt. The CAS loop replays this merge if another
        // writer commits while the LLM call is in flight.
        let outcome = learner_profile::apply_profile_promotion_update(
            memory_service,
            &update,
            MemoryOpSource::Evolution,
            None,
            &format!(
                "日志→画像晋升：扫描近 {} 天共 {} 条日志",
                PROMOTION_SCAN_DAYS, report.logs_scanned
            ),
            learner_profile::ProfileLimitPolicy::Enforce,
            &fingerprint,
            || false,
        )?;

        // Persist the fingerprint only after the profile commit (or a
        // confirmed no-op). If the profile write fails, the same logs remain
        // eligible for a later retry.
        if let Err(e) = mem_cfg.set(PROMOTION_LAST_FINGERPRINT_KEY, &fingerprint) {
            warn!("[Evolution] Failed to persist promotion fingerprint: {}", e);
        }

        report.applied = outcome.changed;
        report.new_version = outcome.changed.then_some(outcome.profile.version);
        Ok(report)
    }

    /// 日志集合的轻量指纹（date + 内容长度 + 内容哈希）
    fn promotion_fingerprint(logs: &[DailyLogRecord]) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        for log in logs {
            log.date.hash(&mut hasher);
            log.content.hash(&mut hasher);
        }
        format!("{}:{:x}", logs.len(), hasher.finish())
    }
}

/// 构建晋升提案 prompt（纯函数，可单元测试）
fn build_promotion_prompt(logs: &[DailyLogRecord], profile: &LearnerProfile) -> String {
    let mut logs_section = String::new();
    for log in logs {
        logs_section.push_str(&format!("### {}\n{}\n\n", log.date, log.content));
    }

    let profile_section = if profile.is_content_empty() {
        "（当前画像为空）".to_string()
    } else {
        profile.render_markdown()
    };

    format!(
        r#"你是学习者画像的策展人。请对比"近期学习日志"与"当前画像"，识别**反复出现**的错误模式和偏好/状态变化，输出画像的增量更新提案。

## 当前学习者画像
{profile_section}

## 近 7 天学习日志
{logs_section}
## 提案规则
1. 只提炼**跨多天反复出现**或**证据充分**的模式，单次偶发错误不要写入画像
2. weak_points_add：科目 + 知识点 + 错误模式一句话概括，evidence_count 填日志中观察到的次数
3. 日志显示某薄弱点已连续多天正确、明显克服时，放入 weak_points_remove
4. 偏好只在日志中有明确信号时更新（如反复要求某种讲解方式）
5. recent_status：用 1-2 句话概括近期学习状态（可选）
6. 没有值得更新的内容时，所有字段返回空

## 输出格式（严格 JSON，不要其他内容）
{{
  "weak_points_add": [
    {{"subject": "数学", "knowledge_point": "二次函数", "error_pattern": "配方时符号处理错误", "evidence_count": 3, "last_seen": "2026-07-08"}}
  ],
  "weak_points_remove": [
    {{"subject": "科目", "knowledge_point": "已克服的知识点"}}
  ],
  "preferences": {{"explanation_style": null, "language": null, "pace": null, "others_add": [], "others_remove": []}},
  "goals_add": [],
  "goals_remove": [],
  "recent_status": null
}}"#,
        profile_section = profile_section,
        logs_section = logs_section,
    )
}

/// 解析晋升提案响应（容错：代码块/杂讯/缺字段；解析失败兜底为空提案）
pub(crate) fn parse_promotion_response(response: &str) -> LearnerProfileUpdate {
    let cleaned = crate::llm_manager::parser::enhanced_clean_json_response(response);

    let parsed = serde_json::from_str::<LearnerProfileUpdate>(&cleaned)
        .ok()
        .or_else(|| {
            super::compaction_flush::extract_json_object(&cleaned)
                .and_then(|s| serde_json::from_str::<LearnerProfileUpdate>(&s).ok())
        })
        .or_else(|| {
            super::compaction_flush::extract_json_object(response)
                .and_then(|s| serde_json::from_str::<LearnerProfileUpdate>(&s).ok())
        });

    match parsed {
        Some(update) => update,
        None => {
            debug!("[Evolution] Promotion: no valid JSON proposal in response; treating as empty");
            LearnerProfileUpdate::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_hits() {
        let tags = vec!["_hits:5".to_string(), "_last_hit:1234567890".to_string()];
        assert_eq!(MemoryEvolution::extract_hits(&tags), 5);
        assert_eq!(
            MemoryEvolution::extract_last_hit_ms(&tags),
            Some(1234567890)
        );
    }

    #[test]
    fn test_extract_hits_missing() {
        let tags: Vec<String> = vec![];
        assert_eq!(MemoryEvolution::extract_hits(&tags), 0);
        assert_eq!(MemoryEvolution::extract_last_hit_ms(&tags), None);
        assert_eq!(MemoryEvolution::extract_last_injected_ms(&tags), None);
    }

    #[test]
    fn test_extract_last_injected() {
        let tags = vec![
            "_hits:1".to_string(),
            "_last_injected:9876543210".to_string(),
        ];
        assert_eq!(
            MemoryEvolution::extract_last_injected_ms(&tags),
            Some(9876543210)
        );
    }

    // ---- 双阈值分层判据的纯函数 ----

    #[test]
    fn test_signal_within_days_dual_threshold() {
        let now = chrono::Utc::now();
        let days_ago = |d: i64| (now - chrono::Duration::days(d)).timestamp_millis();

        // 命中 100 天前：超出 90 天命中窗口，但在 180 天在场窗口内
        assert!(!MemoryEvolution::signal_within_days(
            &now,
            Some(days_ago(100)),
            90
        ));
        assert!(MemoryEvolution::signal_within_days(
            &now,
            Some(days_ago(100)),
            180
        ));
        // 200 天前：两个窗口均超出
        assert!(!MemoryEvolution::signal_within_days(
            &now,
            Some(days_ago(200)),
            180
        ));
        // 信号缺失/时间戳非法均视为窗口外
        assert!(!MemoryEvolution::signal_within_days(&now, None, 90));
        assert!(!MemoryEvolution::signal_within_days(
            &now,
            Some(i64::MAX),
            90
        ));
    }

    #[test]
    fn test_days_since_best_signal_prefers_latest_and_falls_back() {
        let now = chrono::Utc::now();
        let days_ago = |d: i64| (now - chrono::Duration::days(d)).timestamp_millis();

        // 两个信号取较近者计龄
        let days = MemoryEvolution::days_since_best_signal(
            &now,
            Some(days_ago(120)),
            Some(days_ago(30)),
            "invalid",
        );
        assert!((29..=31).contains(&days));

        // 两个信号均缺失时回退 updated_at
        let updated_at = (now - chrono::Duration::days(10)).to_rfc3339();
        let days = MemoryEvolution::days_since_best_signal(&now, None, None, &updated_at);
        assert!((9..=11).contains(&days));

        // updated_at 也非法：视为极老（宁可降级也不让坏数据永生）
        assert_eq!(
            MemoryEvolution::days_since_best_signal(&now, None, None, "not-a-date"),
            i64::MAX
        );
    }

    // ---- 晋升 pass：提案生成与解析（LLM 输出打桩） ----

    fn sample_logs() -> Vec<DailyLogRecord> {
        vec![
            DailyLogRecord {
                date: "2026-07-07".to_string(),
                note_id: "n1".to_string(),
                content: "- [10:00] 做了 5 道二次函数题，错 2 道，均为符号错误".to_string(),
            },
            DailyLogRecord {
                date: "2026-07-08".to_string(),
                note_id: "n2".to_string(),
                content: "- [21:30] 又做 3 道二次函数题，错 1 道，仍是符号错误".to_string(),
            },
        ]
    }

    #[test]
    fn test_build_promotion_prompt_includes_logs_and_profile() {
        let logs = sample_logs();
        let mut profile = LearnerProfile::default();
        profile.weak_points.push(learner_profile::WeakPoint {
            subject: "英语".to_string(),
            knowledge_point: "虚拟语气".to_string(),
            error_pattern: "时态搭配错误".to_string(),
            evidence_count: 2,
            last_seen: None,
            source: None,
        });

        let prompt = build_promotion_prompt(&logs, &profile);
        assert!(prompt.contains("### 2026-07-07"));
        assert!(prompt.contains("符号错误"));
        assert!(prompt.contains("虚拟语气"));
        assert!(prompt.contains("weak_points_add"));
    }

    #[test]
    fn test_build_promotion_prompt_empty_profile_placeholder() {
        let prompt = build_promotion_prompt(&sample_logs(), &LearnerProfile::default());
        assert!(prompt.contains("（当前画像为空）"));
    }

    #[test]
    fn test_parse_promotion_response_full_proposal() {
        // 打桩的 LLM 输出：带代码块包裹与前缀杂讯
        let raw = r#"分析完成：
```json
{
  "weak_points_add": [
    {"subject": "数学", "knowledge_point": "二次函数", "error_pattern": "配方时符号处理错误", "evidence_count": 3, "last_seen": "2026-07-08"}
  ],
  "weak_points_remove": [],
  "goals_add": [],
  "goals_remove": [],
  "recent_status": "近两天集中练习二次函数"
}
```"#;
        let update = parse_promotion_response(raw);
        assert!(!update.is_empty());
        assert_eq!(update.weak_points_add.len(), 1);
        assert_eq!(update.weak_points_add[0].evidence_count, 3);
        assert_eq!(
            update.recent_status.as_deref(),
            Some("近两天集中练习二次函数")
        );

        // 提案可直接 merge 进画像
        let mut profile = LearnerProfile::default();
        assert!(profile.merge_update(&update));
        assert_eq!(profile.weak_points.len(), 1);
        assert_eq!(profile.weak_points[0].knowledge_point, "二次函数");
    }

    #[test]
    fn test_parse_promotion_response_empty_and_garbage() {
        assert!(parse_promotion_response(r#"{}"#).is_empty());
        assert!(parse_promotion_response("模型拒绝回答").is_empty());
        assert!(parse_promotion_response("").is_empty());
    }

    #[test]
    fn test_promotion_fingerprint_stable_and_sensitive() {
        let logs = sample_logs();
        let fp1 = MemoryEvolution::promotion_fingerprint(&logs);
        let fp2 = MemoryEvolution::promotion_fingerprint(&logs);
        assert_eq!(fp1, fp2);

        let mut changed = logs.clone();
        changed[1].content.push_str("\n- [22:00] 新增一条");
        assert_ne!(fp1, MemoryEvolution::promotion_fingerprint(&changed));
    }
}
