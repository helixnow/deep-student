//! 记忆自进化模块
//!
//! 对齐 memU 的 Self-Evolution 能力：
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

use super::service::{MemoryListItem, MemoryService};

const STALE_THRESHOLD_DAYS: i64 = 90;
const STALE_MIN_HITS: u32 = 2;
const HIGH_FREQ_HITS_THRESHOLD: u32 = 5;
const FOLDER_OVERFLOW_THRESHOLD: usize = 20;

pub struct MemoryEvolution {
    vfs_db: Arc<VfsDatabase>,
}

#[derive(Debug, Default)]
pub struct EvolutionReport {
    pub stale_demoted: usize,
    pub high_freq_promoted: usize,
    pub folders_reorganized: usize,
}

impl MemoryEvolution {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
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

        // Phase 3: 检查文件夹溢出
        report.folders_reorganized = self.check_folder_overflow(memory_service)?;

        info!(
            "[Evolution] Cycle complete: demoted={}, promoted={}, reorganized={}",
            report.stale_demoted, report.high_freq_promoted, report.folders_reorganized
        );

        Ok(report)
    }

    /// 低频记忆降级：给超过阈值天数未命中的记忆添加 `_stale` 标签
    fn demote_stale_memories(&self, memories: &[MemoryListItem]) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now = chrono::Utc::now();
        let mut demoted = 0usize;

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

        Ok(demoted)
    }

    /// 高频记忆升级：给频繁命中的记忆添加 `_important` 标签
    fn promote_high_freq_memories(&self, memories: &[MemoryListItem]) -> VfsResult<usize> {
        let conn = self.vfs_db.get_conn_safe()?;
        let mut promoted = 0usize;

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

        Ok(promoted)
    }

    /// 检查文件夹溢出（记录日志，后续可触发 LLM 重新分类）
    fn check_folder_overflow(&self, memory_service: &MemoryService) -> VfsResult<usize> {
        let folders = ["偏好", "经历", "经历/学科状态", "经历/时间节点", "偏好/个人背景"];
        let mut overflow_count = 0usize;

        for folder in &folders {
            let items = memory_service.list(Some(folder), 100, 0)?;
            let active_count = items.iter().filter(|m| !m.title.starts_with("__")).count();

            if active_count > FOLDER_OVERFLOW_THRESHOLD {
                overflow_count += 1;
                warn!(
                    "[Evolution] Folder '{}' has {} memories (threshold={}), consider reorganization",
                    folder, active_count, FOLDER_OVERFLOW_THRESHOLD
                );
            }
        }

        Ok(overflow_count)
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
