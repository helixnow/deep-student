//! 记忆自进化模块
//!
//! 受 memU Self-Evolution 启发：
//! - 低频记忆降级：超过 N 天未命中的记忆从分类摘要中排除
//! - 高频记忆升级：频繁命中的记忆在分类中突出标记
//! - 分类自动重组：当某文件夹记忆过多时触发 LLM 重新分类
//! - 日志→画像晋升（参考成熟代理运行时的 dreaming，务实简化版）：扫描近 7 天
//!   每日学习日志，用 LLM 识别反复出现的错误模式/偏好变化，生成学习者
//!   画像增量更新并直接应用（带 audit_log + 画像版本号递增）
//!
//! 设计为后台定时任务，通过 `run_evolution_cycle` 一次性执行全部进化操作。

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

use super::audit_log::MemoryOpSource;
use super::daily_log::{self, DailyLogRecord};
use super::learner_profile::{self, LearnerProfile, LearnerProfileUpdate};
use super::service::{MemoryListItem, MemoryService};

const STALE_THRESHOLD_DAYS: i64 = 90;
const STALE_MIN_HITS: u32 = 2;
const HIGH_FREQ_HITS_THRESHOLD: u32 = 5;
const FOLDER_OVERFLOW_THRESHOLD: usize = 20;
const EVOLUTION_SCAN_BATCH_SIZE: u32 = 200;
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
}

impl MemoryEvolution {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        let lance_store = VfsLanceStore::new(vfs_db.clone()).ok().map(Arc::new);
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
                if report.stale_demoted > 0
                    || report.high_freq_promoted > 0
                    || report.duplicates_merged > 0
                {
                    info!(
                        "[Evolution] Throttled cycle: demoted={}, promoted={}, merged={}",
                        report.stale_demoted, report.high_freq_promoted, report.duplicates_merged
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

        // Phase 1: 识别低频记忆并打标记
        report.stale_demoted = self.demote_stale_memories(&all_memories)?;

        // Phase 2: 识别高频记忆并打标记
        report.high_freq_promoted = self.promote_high_freq_memories(&all_memories)?;

        // Phase 3: 检查文件夹溢出并合并重复
        report.duplicates_merged = self.check_folder_overflow(memory_service)?;

        info!(
            "[Evolution] Cycle complete: demoted={}, promoted={}, merged={}",
            report.stale_demoted, report.high_freq_promoted, report.duplicates_merged
        );

        Ok(report)
    }

    /// 低频记忆降级：给超过阈值天数未命中的记忆添加 `_stale` 标签
    fn demote_stale_memories(&self, memories: &[MemoryListItem]) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now = chrono::Utc::now();
        let mut demoted = 0usize;

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

            if tags.iter().any(|t| t == "_stale") {
                continue;
            }

            let hits = Self::extract_hits(&tags);
            let last_hit_ms = Self::extract_last_hit_ms(&tags);

            let days_since_hit = if let Some(ms) = last_hit_ms {
                let hit_time = chrono::DateTime::from_timestamp_millis(ms);
                hit_time
                    .map(|t| (now - t).num_days())
                    .unwrap_or(STALE_THRESHOLD_DAYS + 1)
            } else {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&mem.updated_at) {
                    (now - dt.with_timezone(&chrono::Utc)).num_days()
                } else {
                    STALE_THRESHOLD_DAYS + 1
                }
            };

            if days_since_hit > STALE_THRESHOLD_DAYS && hits < STALE_MIN_HITS {
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
                    debug!(
                        "[Evolution] Demoted stale memory: {} ({}d, {}hits)",
                        mem.title, days_since_hit, hits
                    );
                }
            }
        }

        conn.execute_batch("COMMIT")?;
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

            if hits >= HIGH_FREQ_HITS_THRESHOLD {
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
                        "[Evolution] Promoted high-freq memory: {} ({}hits)",
                        mem.title, hits
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
            let active: Vec<&MemoryListItem> = items
                .iter()
                .filter(|m| !m.title.starts_with("__"))
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
                            if let Some(ref lance) = self.lance_store {
                                let lance_c = lance.clone();
                                let res_id_c = res_id.clone();
                                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                                    if let Err(e) = tokio::task::block_in_place(|| {
                                        handle.block_on(async {
                                            lance_c.delete_by_resource("text", &res_id_c).await
                                        })
                                    }) {
                                        warn!(
                                            "[Evolution] Failed to delete vector chunks for {}: {}",
                                            res_id, e
                                        );
                                    }
                                }
                            }
                            // ★ A2-X1：入孤儿队列后再删 units，Lance 删除失败由后台 drain 兜底
                            if let Err(e) =
                                index_unit_repo::purge_index_artifacts_by_resource(&conn, res_id)
                            {
                                warn!(
                                    "[Evolution] Failed to purge index artifacts for {}: {}",
                                    res_id, e
                                );
                            }
                            if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                                &self.vfs_db,
                                res_id,
                                "evolution merged duplicate",
                            ) {
                                warn!(
                                    "[Evolution] Failed to mark index disabled for {}: {}",
                                    res_id, e
                                );
                            }
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

    fn extract_last_hit_ms(tags: &[String]) -> Option<i64> {
        tags.iter()
            .find_map(|t| t.strip_prefix("_last_hit:").and_then(|v| v.parse().ok()))
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
