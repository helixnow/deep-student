//! 音视频字幕段与播放进度 Repo（`media_transcript_segments` / `media_progress`）
//!
//! 设计契约：`docs/dev/media-learning/README.md` §1.1–1.2。
//!
//! - `resource_id` 是 VFS File 资源 ID（`files.id`，`file_*` / `att_*`）。
//! - 段 `status`：0 待转写 / 1 完成 / 2 失败；`source`：`asr` | `import`。
//! - **续做与重建**：`apply_plan_with_conn` 对比新 VAD 计划与已有计划的段数，
//!   偏差 ≤ 20% 时沿用已有计划（已完成段保留，续做只跑未完成段）；
//!   偏差 > 20% 时整表重建，`plan_version + 1`。
//! - 所有写入都带 `plan_version` 守卫：重建后迟到的 ASR 结果不会写进新计划。
//!
//! 判断"计划变没变"只用段数与 plan_version（AGENTS.md：禁止对 HashMap 序列化哈希比对）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::error::{VfsError, VfsResult};

pub const SEGMENT_STATUS_PENDING: i64 = 0;
pub const SEGMENT_STATUS_DONE: i64 = 1;
pub const SEGMENT_STATUS_FAILED: i64 = 2;

pub const SEGMENT_SOURCE_ASR: &str = "asr";
pub const SEGMENT_SOURCE_IMPORT: &str = "import";

/// 新旧计划段数相对偏差超过该比例时重建计划。
pub const PLAN_REBUILD_DEVIATION: f64 = 0.20;

/// 单次 `media_progress_set` 接受的最大观看时长增量（防止前端时钟跳变刷时长）。
pub const MAX_WATCHED_DELTA_MS: i64 = 120_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 一条字幕段
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSegmentRow {
    pub idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub status: i64,
    pub source: String,
    pub plan_version: i64,
}

/// 计划中的一段（VAD 输出或字幕导入）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSpan {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 计划应用结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanOutcome {
    /// 此前无计划，新建
    Created { plan_version: i64 },
    /// 沿用已有计划（续做）
    Reused { plan_version: i64 },
    /// 段数偏差过大，重建
    Rebuilt { plan_version: i64 },
}

impl PlanOutcome {
    pub fn plan_version(&self) -> i64 {
        match self {
            PlanOutcome::Created { plan_version }
            | PlanOutcome::Reused { plan_version }
            | PlanOutcome::Rebuilt { plan_version } => *plan_version,
        }
    }
}

/// 段计数
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentCounts {
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub pending: i64,
}

/// 播放进度
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProgressRow {
    pub resource_id: String,
    pub last_position_ms: i64,
    pub duration_ms: Option<i64>,
    pub watched_ms: i64,
    pub finished: bool,
    pub updated_at: i64,
}

/// 播放进度更新参数
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProgressUpdate {
    /// 当前播放位置（毫秒）
    pub position_ms: Option<i64>,
    /// 媒体总时长（毫秒）
    pub duration_ms: Option<i64>,
    /// 自上次上报以来新增的观看时长（毫秒，单次 ≤ 120 s）
    pub watched_delta_ms: Option<i64>,
    /// 显式设置是否看完
    pub finished: Option<bool>,
}

/// 判断新计划是否需要重建（段数相对偏差 > 20%）
pub fn plan_needs_rebuild(existing_count: usize, new_count: usize) -> bool {
    if existing_count == 0 {
        return true;
    }
    let diff = (existing_count as f64 - new_count as f64).abs();
    diff / existing_count as f64 > PLAN_REBUILD_DEVIATION
}

fn validate_spans(spans: &[PlannedSpan]) -> VfsResult<()> {
    for (i, span) in spans.iter().enumerate() {
        if span.start_ms < 0 || span.end_ms < span.start_ms {
            return Err(VfsError::InvalidArgument {
                param: "spans".to_string(),
                reason: format!(
                    "segment {} has invalid range {}..{}",
                    i, span.start_ms, span.end_ms
                ),
            });
        }
    }
    Ok(())
}

pub struct MediaTranscriptRepo;

impl MediaTranscriptRepo {
    fn row_to_segment(row: &rusqlite::Row) -> rusqlite::Result<MediaSegmentRow> {
        Ok(MediaSegmentRow {
            idx: row.get(0)?,
            start_ms: row.get(1)?,
            end_ms: row.get(2)?,
            text: row.get(3)?,
            status: row.get(4)?,
            source: row.get(5)?,
            plan_version: row.get(6)?,
        })
    }

    /// 按 idx 升序列出全部段
    pub fn list_segments_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Vec<MediaSegmentRow>> {
        let mut stmt = conn.prepare_cached(
            "SELECT idx, start_ms, end_ms, text, status, source, plan_version
             FROM media_transcript_segments WHERE resource_id = ?1 ORDER BY idx ASC",
        )?;
        let rows = stmt
            .query_map(params![resource_id], Self::row_to_segment)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 列出时间窗内（与 [start_ms, end_ms) 相交）的段
    pub fn list_segments_in_range_with_conn(
        conn: &Connection,
        resource_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> VfsResult<Vec<MediaSegmentRow>> {
        let mut stmt = conn.prepare_cached(
            "SELECT idx, start_ms, end_ms, text, status, source, plan_version
             FROM media_transcript_segments
             WHERE resource_id = ?1 AND end_ms > ?2 AND start_ms < ?3
             ORDER BY idx ASC",
        )?;
        let rows = stmt
            .query_map(params![resource_id, start_ms, end_ms], Self::row_to_segment)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 待转写（status != 1）的段，按 idx 升序
    pub fn list_unfinished_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Vec<MediaSegmentRow>> {
        let mut stmt = conn.prepare_cached(
            "SELECT idx, start_ms, end_ms, text, status, source, plan_version
             FROM media_transcript_segments
             WHERE resource_id = ?1 AND status != 1 ORDER BY idx ASC",
        )?;
        let rows = stmt
            .query_map(params![resource_id], Self::row_to_segment)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn counts_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<SegmentCounts> {
        let (total, done, failed): (i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END), 0)
             FROM media_transcript_segments WHERE resource_id = ?1",
            params![resource_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(SegmentCounts {
            total,
            done,
            failed,
            pending: total - done - failed,
        })
    }

    /// 当前计划版本与来源（无段时 None）
    pub fn plan_info_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<(i64, String)>> {
        Ok(conn
            .query_row(
                "SELECT MAX(plan_version), MIN(source) FROM media_transcript_segments
                 WHERE resource_id = ?1 HAVING COUNT(*) > 0",
                params![resource_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?)
    }

    fn insert_spans(
        conn: &Connection,
        resource_id: &str,
        spans: &[PlannedSpan],
        texts: Option<&[String]>,
        status: i64,
        source: &str,
        plan_version: i64,
        now: i64,
    ) -> VfsResult<()> {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO media_transcript_segments
                 (resource_id, idx, start_ms, end_ms, text, status, source, plan_version, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for (i, span) in spans.iter().enumerate() {
            let text = texts
                .and_then(|t| t.get(i))
                .map(String::as_str)
                .unwrap_or("");
            stmt.execute(params![
                resource_id,
                i as i64,
                span.start_ms,
                span.end_ms,
                text,
                status,
                source,
                plan_version,
                now
            ])?;
        }
        Ok(())
    }

    /// 应用一个新的 ASR 计划（续做 / 重建规则见模块文档）。
    ///
    /// 已有计划来源为 `import`（字幕导入）时不覆盖，视为沿用。
    pub fn apply_plan_with_conn(
        conn: &Connection,
        resource_id: &str,
        spans: &[PlannedSpan],
    ) -> VfsResult<PlanOutcome> {
        validate_spans(spans)?;
        let tx = conn.unchecked_transaction()?;
        let existing_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM media_transcript_segments WHERE resource_id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;
        let info = Self::plan_info_with_conn(&tx, resource_id)?;
        let now = now_ms();

        let outcome = match info {
            None => {
                Self::insert_spans(
                    &tx,
                    resource_id,
                    spans,
                    None,
                    SEGMENT_STATUS_PENDING,
                    SEGMENT_SOURCE_ASR,
                    1,
                    now,
                )?;
                PlanOutcome::Created { plan_version: 1 }
            }
            Some((version, source)) => {
                if source == SEGMENT_SOURCE_IMPORT
                    || !plan_needs_rebuild(existing_count as usize, spans.len())
                {
                    PlanOutcome::Reused {
                        plan_version: version,
                    }
                } else {
                    let next = version + 1;
                    tx.execute(
                        "DELETE FROM media_transcript_segments WHERE resource_id = ?1",
                        params![resource_id],
                    )?;
                    Self::insert_spans(
                        &tx,
                        resource_id,
                        spans,
                        None,
                        SEGMENT_STATUS_PENDING,
                        SEGMENT_SOURCE_ASR,
                        next,
                        now,
                    )?;
                    PlanOutcome::Rebuilt { plan_version: next }
                }
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// 标记一段转写完成（plan_version 不符时不写，返回 false）
    pub fn mark_done_with_conn(
        conn: &Connection,
        resource_id: &str,
        idx: i64,
        plan_version: i64,
        text: &str,
    ) -> VfsResult<bool> {
        Self::mark_done_with_bounds_with_conn(conn, resource_id, idx, plan_version, text, None)
    }

    /// 标记完成并可选收紧段边界（ASR 返回词/句级时间戳时，把段起止收紧到实际语音）。
    ///
    /// 收紧后的边界必须落在原段内，否则忽略（保持段间不重叠、idx 顺序不变）。
    pub fn mark_done_with_bounds_with_conn(
        conn: &Connection,
        resource_id: &str,
        idx: i64,
        plan_version: i64,
        text: &str,
        bounds: Option<(i64, i64)>,
    ) -> VfsResult<bool> {
        let changed = match bounds {
            Some((start, end)) if start <= end => conn.execute(
                "UPDATE media_transcript_segments
                 SET text = ?1, status = 1, updated_at = ?2,
                     start_ms = CASE WHEN ?6 >= start_ms AND ?7 <= end_ms THEN ?6 ELSE start_ms END,
                     end_ms   = CASE WHEN ?6 >= start_ms AND ?7 <= end_ms THEN ?7 ELSE end_ms END
                 WHERE resource_id = ?3 AND idx = ?4 AND plan_version = ?5",
                params![text, now_ms(), resource_id, idx, plan_version, start, end],
            )?,
            _ => conn.execute(
                "UPDATE media_transcript_segments
                 SET text = ?1, status = 1, updated_at = ?2
                 WHERE resource_id = ?3 AND idx = ?4 AND plan_version = ?5",
                params![text, now_ms(), resource_id, idx, plan_version],
            )?,
        };
        Ok(changed > 0)
    }

    /// 标记一段转写失败（已完成段不会被降级）
    pub fn mark_failed_with_conn(
        conn: &Connection,
        resource_id: &str,
        idx: i64,
        plan_version: i64,
    ) -> VfsResult<bool> {
        let changed = conn.execute(
            "UPDATE media_transcript_segments
             SET status = 2, updated_at = ?1
             WHERE resource_id = ?2 AND idx = ?3 AND plan_version = ?4 AND status != 1",
            params![now_ms(), resource_id, idx, plan_version],
        )?;
        Ok(changed > 0)
    }

    /// 失败段重置为待转写（重新开始转写前调用）
    pub fn reset_failed_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<usize> {
        Ok(conn.execute(
            "UPDATE media_transcript_segments SET status = 0, updated_at = ?1
             WHERE resource_id = ?2 AND status = 2",
            params![now_ms(), resource_id],
        )?)
    }

    /// 用导入的字幕整体替换段（`source='import'`，全部 status=1），返回新 plan_version。
    pub fn set_imported_segments_with_conn(
        conn: &Connection,
        resource_id: &str,
        segments: &[(PlannedSpan, String)],
    ) -> VfsResult<i64> {
        let spans: Vec<PlannedSpan> = segments.iter().map(|(span, _)| *span).collect();
        validate_spans(&spans)?;
        let texts: Vec<String> = segments.iter().map(|(_, text)| text.clone()).collect();
        let tx = conn.unchecked_transaction()?;
        let version = Self::plan_info_with_conn(&tx, resource_id)?
            .map(|(v, _)| v + 1)
            .unwrap_or(1);
        tx.execute(
            "DELETE FROM media_transcript_segments WHERE resource_id = ?1",
            params![resource_id],
        )?;
        Self::insert_spans(
            &tx,
            resource_id,
            &spans,
            Some(&texts),
            SEGMENT_STATUS_DONE,
            SEGMENT_SOURCE_IMPORT,
            version,
            now_ms(),
        )?;
        tx.commit()?;
        Ok(version)
    }

    pub fn delete_segments_with_conn(conn: &Connection, resource_id: &str) -> VfsResult<usize> {
        Ok(conn.execute(
            "DELETE FROM media_transcript_segments WHERE resource_id = ?1",
            params![resource_id],
        )?)
    }

    // ------------------------------------------------------------------
    // 播放进度
    // ------------------------------------------------------------------

    pub fn get_progress_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<Option<MediaProgressRow>> {
        Ok(conn
            .query_row(
                "SELECT resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at
                 FROM media_progress WHERE resource_id = ?1",
                params![resource_id],
                |row| {
                    Ok(MediaProgressRow {
                        resource_id: row.get(0)?,
                        last_position_ms: row.get(1)?,
                        duration_ms: row.get(2)?,
                        watched_ms: row.get(3)?,
                        finished: row.get::<_, i64>(4)? != 0,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// 合并写入播放进度。
    ///
    /// - `position_ms` 缺省时保留原值；`duration_ms` 缺省时保留原值；
    /// - `watched_delta_ms` 截断到 [0, 120 s] 后累加；
    /// - `finished` 缺省时：已看完保持；时长已知且位置 ≥ 95% 自动置为看完。
    pub fn set_progress_with_conn(
        conn: &Connection,
        resource_id: &str,
        update: &MediaProgressUpdate,
    ) -> VfsResult<MediaProgressRow> {
        let existing = Self::get_progress_with_conn(conn, resource_id)?.unwrap_or_default();
        let position = update
            .position_ms
            .map(|p| p.max(0))
            .unwrap_or(existing.last_position_ms);
        let duration = update
            .duration_ms
            .filter(|d| *d > 0)
            .or(existing.duration_ms);
        let delta = update
            .watched_delta_ms
            .unwrap_or(0)
            .clamp(0, MAX_WATCHED_DELTA_MS);
        let watched = existing.watched_ms.saturating_add(delta);
        let auto_finished = duration
            .map(|d| d > 0 && position as f64 >= d as f64 * 0.95)
            .unwrap_or(false);
        let finished = update
            .finished
            .unwrap_or(existing.finished || auto_finished);
        let now = now_ms();
        conn.execute(
            "INSERT INTO media_progress
                 (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(resource_id) DO UPDATE SET
                 last_position_ms = excluded.last_position_ms,
                 duration_ms = excluded.duration_ms,
                 watched_ms = excluded.watched_ms,
                 finished = excluded.finished,
                 updated_at = excluded.updated_at",
            params![
                resource_id,
                position,
                duration,
                watched,
                finished as i64,
                now
            ],
        )?;
        Ok(MediaProgressRow {
            resource_id: resource_id.to_string(),
            last_position_ms: position,
            duration_ms: duration,
            watched_ms: watched,
            finished,
            updated_at: now,
        })
    }

    /// 仅记录媒体时长（解码阶段得到），不触碰播放位置与观看时长
    pub fn record_duration_with_conn(
        conn: &Connection,
        resource_id: &str,
        duration_ms: i64,
    ) -> VfsResult<()> {
        conn.execute(
            "INSERT INTO media_progress (resource_id, duration_ms, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(resource_id) DO UPDATE SET duration_ms = excluded.duration_ms",
            params![resource_id, duration_ms, now_ms()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::database::setup_migrated_test_db;

    fn spans(n: usize) -> Vec<PlannedSpan> {
        (0..n)
            .map(|i| PlannedSpan {
                start_ms: i as i64 * 1000,
                end_ms: i as i64 * 1000 + 900,
            })
            .collect()
    }

    #[test]
    fn rebuild_threshold_is_twenty_percent() {
        assert!(!plan_needs_rebuild(10, 10));
        assert!(!plan_needs_rebuild(10, 12));
        assert!(!plan_needs_rebuild(10, 8));
        assert!(plan_needs_rebuild(10, 13));
        assert!(plan_needs_rebuild(10, 7));
        assert!(plan_needs_rebuild(0, 3));
    }

    #[test]
    fn plan_create_resume_and_rebuild() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let rid = "file_media_1";

        let outcome = MediaTranscriptRepo::apply_plan_with_conn(&conn, rid, &spans(10)).unwrap();
        assert_eq!(outcome, PlanOutcome::Created { plan_version: 1 });
        assert!(MediaTranscriptRepo::mark_done_with_conn(&conn, rid, 0, 1, "你好").unwrap());
        assert!(MediaTranscriptRepo::mark_done_with_conn(&conn, rid, 3, 1, "world").unwrap());
        assert!(MediaTranscriptRepo::mark_failed_with_conn(&conn, rid, 4, 1).unwrap());
        // 已完成段不会被降级
        assert!(!MediaTranscriptRepo::mark_failed_with_conn(&conn, rid, 0, 1).unwrap());

        // 段数偏差 ≤ 20%：沿用，已完成段保留
        let outcome = MediaTranscriptRepo::apply_plan_with_conn(&conn, rid, &spans(11)).unwrap();
        assert_eq!(outcome, PlanOutcome::Reused { plan_version: 1 });
        let counts = MediaTranscriptRepo::counts_with_conn(&conn, rid).unwrap();
        assert_eq!(
            counts,
            SegmentCounts {
                total: 10,
                done: 2,
                failed: 1,
                pending: 7
            }
        );
        let unfinished = MediaTranscriptRepo::list_unfinished_with_conn(&conn, rid).unwrap();
        assert_eq!(unfinished.len(), 8);
        assert!(unfinished.iter().all(|s| s.idx != 0 && s.idx != 3));

        // 偏差 > 20%：重建，plan_version+1，旧结果丢弃
        let outcome = MediaTranscriptRepo::apply_plan_with_conn(&conn, rid, &spans(20)).unwrap();
        assert_eq!(outcome, PlanOutcome::Rebuilt { plan_version: 2 });
        let counts = MediaTranscriptRepo::counts_with_conn(&conn, rid).unwrap();
        assert_eq!(counts.total, 20);
        assert_eq!(counts.done, 0);
        // 旧版本迟到的结果被 plan_version 守卫拒绝
        assert!(!MediaTranscriptRepo::mark_done_with_conn(&conn, rid, 1, 1, "late").unwrap());
        assert!(MediaTranscriptRepo::mark_done_with_conn(&conn, rid, 1, 2, "fresh").unwrap());

        // 边界收紧：落在原段内才生效
        assert!(MediaTranscriptRepo::mark_done_with_bounds_with_conn(
            &conn,
            rid,
            2,
            2,
            "tight",
            Some((2100, 2800))
        )
        .unwrap());
        assert!(MediaTranscriptRepo::mark_done_with_bounds_with_conn(
            &conn,
            rid,
            5,
            2,
            "loose",
            Some((0, 99_999))
        )
        .unwrap());
        let rows = MediaTranscriptRepo::list_segments_with_conn(&conn, rid).unwrap();
        assert_eq!((rows[2].start_ms, rows[2].end_ms), (2100, 2800));
        assert_eq!((rows[5].start_ms, rows[5].end_ms), (5000, 5900));
    }

    #[test]
    fn imported_segments_replace_plan_and_are_not_overwritten_by_asr_plan() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let rid = "file_media_2";
        MediaTranscriptRepo::apply_plan_with_conn(&conn, rid, &spans(3)).unwrap();
        let imported = vec![
            (
                PlannedSpan {
                    start_ms: 0,
                    end_ms: 1500,
                },
                "第一句".to_string(),
            ),
            (
                PlannedSpan {
                    start_ms: 1500,
                    end_ms: 4000,
                },
                "第二句".to_string(),
            ),
        ];
        let version =
            MediaTranscriptRepo::set_imported_segments_with_conn(&conn, rid, &imported).unwrap();
        assert_eq!(version, 2);
        let rows = MediaTranscriptRepo::list_segments_with_conn(&conn, rid).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|r| r.status == SEGMENT_STATUS_DONE && r.source == SEGMENT_SOURCE_IMPORT));

        let outcome = MediaTranscriptRepo::apply_plan_with_conn(&conn, rid, &spans(30)).unwrap();
        assert_eq!(outcome, PlanOutcome::Reused { plan_version: 2 });
        assert_eq!(
            MediaTranscriptRepo::list_segments_with_conn(&conn, rid)
                .unwrap()
                .len(),
            2
        );
        let ranged =
            MediaTranscriptRepo::list_segments_in_range_with_conn(&conn, rid, 2000, 3000).unwrap();
        assert_eq!(ranged.len(), 1);
        assert_eq!(ranged[0].text, "第二句");
    }

    #[test]
    fn invalid_spans_are_rejected() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let bad = vec![PlannedSpan {
            start_ms: 500,
            end_ms: 100,
        }];
        assert!(MediaTranscriptRepo::apply_plan_with_conn(&conn, "file_x", &bad).is_err());
    }

    #[test]
    fn progress_merge_semantics() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let rid = "file_media_3";
        assert!(MediaTranscriptRepo::get_progress_with_conn(&conn, rid)
            .unwrap()
            .is_none());

        MediaTranscriptRepo::record_duration_with_conn(&conn, rid, 600_000).unwrap();
        let p = MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            rid,
            &MediaProgressUpdate {
                position_ms: Some(10_000),
                watched_delta_ms: Some(10_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.duration_ms, Some(600_000));
        assert_eq!(p.watched_ms, 10_000);
        assert!(!p.finished);

        // 增量截断到 120 s；负数忽略
        let p = MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            rid,
            &MediaProgressUpdate {
                watched_delta_ms: Some(10_000_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.watched_ms, 130_000);
        assert_eq!(p.last_position_ms, 10_000);
        let p = MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            rid,
            &MediaProgressUpdate {
                watched_delta_ms: Some(-5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p.watched_ms, 130_000);

        // 位置 ≥ 95% 自动看完，之后保持
        let p = MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            rid,
            &MediaProgressUpdate {
                position_ms: Some(590_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(p.finished);
        let p = MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            rid,
            &MediaProgressUpdate {
                position_ms: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(p.finished);
        let stored = MediaTranscriptRepo::get_progress_with_conn(&conn, rid)
            .unwrap()
            .unwrap();
        assert_eq!(stored.last_position_ms, 0);
        assert!(stored.finished);
    }
}
