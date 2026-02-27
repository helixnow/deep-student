//! 记忆自进化模块
//!
//! 受 memU Self-Evolution 启发：
//! - 低频记忆降级：超过 N 天未命中的记忆从分类摘要中排除
//! - 高频记忆升级：频繁命中的记忆在分类中突出标记
//! - 分类自动重组：当某文件夹记忆过多时触发 LLM 重新分类
//!
//! 设计为后台定时任务，通过 `run_evolution_cycle` 一次性执行全部进化操作。

use std::sync::Arc;

use rusqlite::params;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::index_unit_repo;
use crate::vfs::repos::note_repo::VfsNoteRepo;

use super::service::{MemoryListItem, MemoryService};

const STALE_THRESHOLD_DAYS: i64 = 90;
const STALE_MIN_HITS: u32 = 2;
const HIGH_FREQ_HITS_THRESHOLD: u32 = 5;
const FOLDER_OVERFLOW_THRESHOLD: usize = 20;

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
        Self { vfs_db, lance_store }
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
        LAST_EVOLUTION_MS.store(now_ms, Ordering::Relaxed);

        match self.run_evolution_cycle(memory_service) {
            Ok(report) => {
                if report.stale_demoted > 0 || report.high_freq_promoted > 0 || report.duplicates_merged > 0 {
                    info!(
                        "[Evolution] Throttled cycle: demoted={}, promoted={}, merged={}",
                        report.stale_demoted, report.high_freq_promoted, report.duplicates_merged
                    );
                }
                Some(report)
            }
            Err(e) => {
                debug!("[Evolution] Throttled cycle failed (non-fatal): {}", e);
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

        let all_memories = memory_service.list(None, 500, 0)?;
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

        let _ = conn.execute_batch("BEGIN IMMEDIATE");

        for mem in memories {
            if mem.title.starts_with("__") {
                continue;
            }
            // note 类型记忆是用户主动保存的经验笔记，不参与自动降级
            if mem.memory_type == "note" {
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
                    debug!("[Evolution] Demoted stale memory: {} ({}d, {}hits)", mem.title, days_since_hit, hits);
                }
            }
        }

        let _ = conn.execute_batch("COMMIT");
        Ok(demoted)
    }

    /// 高频记忆升级：给频繁命中的记忆添加 `_important` 标签
    fn promote_high_freq_memories(&self, memories: &[MemoryListItem]) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let mut promoted = 0usize;

        let _ = conn.execute_batch("BEGIN IMMEDIATE");

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
                let mut new_tags: Vec<String> = tags
                    .into_iter()
                    .filter(|t| t != "_stale")
                    .collect();
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
                    debug!("[Evolution] Promoted high-freq memory: {} ({}hits)", mem.title, hits);
                }
            }
        }

        let _ = conn.execute_batch("COMMIT");
        Ok(promoted)
    }

    /// 检查文件夹溢出并执行合并：同一文件夹中标题完全相同的记忆合并内容后去重
    fn check_folder_overflow(&self, memory_service: &MemoryService) -> VfsResult<usize> {
        let mut folders: Vec<String> = Vec::new();
        if let Ok(Some(tree)) = memory_service.get_tree() {
            Self::collect_all_folder_paths(&tree.children, "", &mut folders);
        }
        if folders.is_empty() {
            return Ok(0);
        }
        let mut merged_count = 0usize;
        let conn = self.vfs_db.get_conn_safe()?;

        for folder in &folders {
            let items = memory_service.list(Some(folder), 200, 0)?;
            let active: Vec<&MemoryListItem> = items.iter().filter(|m| !m.title.starts_with("__")).collect();

            if active.len() <= FOLDER_OVERFLOW_THRESHOLD {
                continue;
            }

            let mut folder_merged = 0usize;
            // 按 (title, memory_type) 分组，避免跨类型误合并
            let mut title_groups: std::collections::HashMap<(&str, &str), Vec<&MemoryListItem>> =
                std::collections::HashMap::new();
            for mem in &active {
                title_groups.entry((&mem.title, &mem.memory_type)).or_default().push(mem);
            }

            for (_key, group) in &title_groups {
                if group.len() < 2 {
                    continue;
                }
                let keep = group[0];
                let mut combined_content = String::new();
                for mem in group {
                    if let Ok(Some(content)) =
                        crate::vfs::repos::note_repo::VfsNoteRepo::get_note_content(
                            &self.vfs_db,
                            &mem.id,
                        )
                    {
                        if !content.is_empty() {
                            if !combined_content.is_empty() {
                                combined_content.push_str("\n\n");
                            }
                            combined_content.push_str(&content);
                        }
                    }
                }

                if let Err(e) = crate::vfs::repos::note_repo::VfsNoteRepo::update_note(
                    &self.vfs_db,
                    &keep.id,
                    crate::vfs::types::VfsUpdateNoteParams {
                        title: None,
                        content: Some(combined_content),
                        tags: None,
                        expected_updated_at: None,
                    },
                ) {
                    warn!("[Evolution] Failed to update merged memory {}: {}", keep.id, e);
                    continue;
                }

                for dup in &group[1..] {
                    let resource_id: Option<String> = VfsNoteRepo::get_note(&self.vfs_db, &dup.id)
                        .ok()
                        .flatten()
                        .map(|n| n.resource_id);

                    if let Some(ref res_id) = resource_id {
                        if let Some(ref lance) = self.lance_store {
                            let lance_c = lance.clone();
                            let res_id_c = res_id.clone();
                            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                                let _ = tokio::task::block_in_place(|| {
                                    handle.block_on(async {
                                        lance_c.delete_by_resource("text", &res_id_c).await
                                    })
                                });
                            }
                        }
                        let _ = index_unit_repo::delete_by_resource(&conn, res_id);
                        let _ = VfsIndexStateRepo::mark_disabled_with_reason(
                            &self.vfs_db,
                            res_id,
                            "evolution merged duplicate",
                        );
                    }

                    if let Err(e) = crate::vfs::repos::note_repo::VfsNoteRepo::delete_note_with_folder_item(
                        &self.vfs_db,
                        &dup.id,
                    ) {
                        warn!("[Evolution] Failed to delete duplicate {}: {}", dup.id, e);
                    } else {
                        folder_merged += 1;
                        debug!("[Evolution] Merged duplicate '{}' ({} → {})", keep.title, dup.id, keep.id);
                    }
                }
            }

            if folder_merged > 0 {
                info!(
                    "[Evolution] Folder '{}': merged {} duplicate memories (was {} active)",
                    folder, folder_merged, active.len()
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_hits() {
        let tags = vec!["_hits:5".to_string(), "_last_hit:1234567890".to_string()];
        assert_eq!(MemoryEvolution::extract_hits(&tags), 5);
        assert_eq!(MemoryEvolution::extract_last_hit_ms(&tags), Some(1234567890));
    }

    #[test]
    fn test_extract_hits_missing() {
        let tags: Vec<String> = vec![];
        assert_eq!(MemoryEvolution::extract_hits(&tags), 0);
        assert_eq!(MemoryEvolution::extract_last_hit_ms(&tags), None);
    }
}
