//! Media transcript retrieval glue (design contract `docs/dev/media-learning/README.md` §1.4).
//!
//! Audio/video stay ordinary VFS `File` resources. Once transcript segments exist in
//! `media_transcript_segments` (keyed by `files.id`), the index units of that resource are
//! **time windows** (~90 s or ~800 chars of finished segments) instead of the file's
//! extracted text, so both the SQLite lexical ledger and (when compiled) the vector index
//! can answer "where in the lecture was X said".
//!
//! - Window boundaries are a pure function of the ordered finished segments, so retrieval
//!   can map any hit on unit `N` back to its `[startMs, endMs)` range — including on
//!   lance-less builds where no `vfs_index_segments` rows exist.
//! - Vector segments additionally carry `metadata_json = {"startMs":…,"endMs":…}`, built from
//!   two integers only (deterministic; AGENTS.md bans hashing HashMap serialisations).
//! - Citations use `[媒体@{files.id}:{mm:ss}]` (`h:mm:ss` from one hour on).

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::index_unit_repo::CreateUnitInput;
use crate::vfs::repos::media_transcript_repo::{MediaTranscriptRepo, SEGMENT_STATUS_DONE};
use crate::vfs::retrieval_planner::FusedRetrievalHit;

/// `vfs_index_units.text_source` of transcript time-window units.
pub const TRANSCRIPT_TEXT_SOURCE: &str = "transcript";
/// Target window length.
pub const WINDOW_TARGET_MS: i64 = 90_000;
/// Target window text size (characters of segment text, timestamps excluded).
pub const WINDOW_TARGET_CHARS: usize = 800;
/// `resource_read` returns at most this much transcript per call.
pub const MAX_READ_SPAN_MS: i64 = 600_000;

/// A media time range in milliseconds (`end_ms` exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTimeRange {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// One finished transcript line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptLine {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// One retrieval window (= one index unit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaWindow {
    pub range: MediaTimeRange,
    /// `[mm:ss] text` lines joined by `\n`.
    pub text: String,
}

/// `mm:ss`, or `h:mm:ss` from one hour on.
pub fn format_timestamp(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

/// Ready-to-cite marker, e.g. `[媒体@file_abc:01:30]`.
pub fn media_citation(file_id: &str, start_ms: i64) -> String {
    format!("[媒体@{}:{}]", file_id, format_timestamp(start_ms))
}

/// Deterministic segment metadata (`{"startMs":…,"endMs":…}`).
pub fn segment_metadata_json(range: MediaTimeRange) -> String {
    format!(
        r#"{{"startMs":{},"endMs":{}}}"#,
        range.start_ms, range.end_ms
    )
}

/// Reads `startMs`/`endMs` back from segment metadata.
pub fn time_range_from_metadata(metadata: &serde_json::Value) -> Option<MediaTimeRange> {
    let start_ms = metadata.get("startMs")?.as_i64()?;
    let end_ms = metadata.get("endMs")?.as_i64()?;
    (end_ms >= start_ms).then_some(MediaTimeRange { start_ms, end_ms })
}

fn stamped_line(line: &TranscriptLine) -> String {
    format!("[{}] {}", format_timestamp(line.start_ms), line.text.trim())
}

/// Groups ordered finished lines into ~90 s / ~800 char windows. A window is closed before
/// a line would push it past either target; a single oversized line forms its own window.
pub fn build_windows(lines: &[TranscriptLine]) -> Vec<MediaWindow> {
    let mut windows = Vec::new();
    let mut current: Vec<&TranscriptLine> = Vec::new();
    let mut current_chars = 0usize;
    let flush = |current: &mut Vec<&TranscriptLine>, windows: &mut Vec<MediaWindow>| {
        let (Some(first), Some(last)) = (current.first(), current.last()) else {
            return;
        };
        windows.push(MediaWindow {
            range: MediaTimeRange {
                start_ms: first.start_ms,
                end_ms: current
                    .iter()
                    .map(|line| line.end_ms)
                    .max()
                    .unwrap_or(last.end_ms),
            },
            text: current
                .iter()
                .map(|line| stamped_line(line))
                .collect::<Vec<_>>()
                .join("\n"),
        });
        current.clear();
    };
    for line in lines {
        let line_chars = line.text.trim().chars().count();
        if line_chars == 0 {
            continue;
        }
        if let Some(first) = current.first() {
            if line.end_ms - first.start_ms > WINDOW_TARGET_MS
                || current_chars + line_chars > WINDOW_TARGET_CHARS
            {
                flush(&mut current, &mut windows);
                current_chars = 0;
            }
        }
        current.push(line);
        current_chars += line_chars;
    }
    flush(&mut current, &mut windows);
    windows
}

/// Finished, non-empty transcript lines of a media file (`files.id`), ordered by idx.
pub fn load_finished_lines(conn: &Connection, file_id: &str) -> VfsResult<Vec<TranscriptLine>> {
    Ok(MediaTranscriptRepo::list_segments_with_conn(conn, file_id)?
        .into_iter()
        .filter(|segment| segment.status == SEGMENT_STATUS_DONE && !segment.text.trim().is_empty())
        .map(|segment| TranscriptLine {
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: segment.text,
        })
        .collect())
}

/// `files.id` of a VFS resource (`res_*`), if it is a file.
pub fn file_id_for_resource(conn: &Connection, resource_id: &str) -> VfsResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM files WHERE resource_id = ?1 LIMIT 1",
            rusqlite::params![resource_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

/// Transcript window units for `resource_id`, or `None` when the resource is not a file
/// or has no finished transcript yet (callers then fall back to the regular builders).
pub fn transcript_units_for_resource(
    conn: &Connection,
    resource_id: &str,
) -> VfsResult<Option<Vec<CreateUnitInput>>> {
    let Some(file_id) = file_id_for_resource(conn, resource_id)? else {
        return Ok(None);
    };
    let windows = build_windows(&load_finished_lines(conn, &file_id)?);
    if windows.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        windows
            .into_iter()
            .enumerate()
            .map(|(index, window)| CreateUnitInput {
                resource_id: resource_id.to_string(),
                unit_index: index as i32,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some(window.text),
                text_source: Some(TRANSCRIPT_TEXT_SOURCE.to_string()),
            })
            .collect(),
    ))
}

/// Call after a media file's transcript changed (segments finished, imported, rebuilt or
/// deleted). Lexical units are rebuilt right away (searchable even on lance-less builds);
/// the resource is marked pending so the background indexer refreshes vectors. Returns the
/// number of transcript window units now indexed for the file.
pub fn refresh_transcript_index(
    db: &std::sync::Arc<VfsDatabase>,
    file_id: &str,
) -> VfsResult<usize> {
    let resource_id: Option<String> = {
        let conn = db.get_conn_safe()?;
        conn.query_row(
            "SELECT resource_id FROM files WHERE id = ?1",
            rusqlite::params![file_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    };
    let Some(resource_id) = resource_id else {
        return Ok(0);
    };
    let has_transcript = {
        let conn = db.get_conn_safe()?;
        transcript_units_for_resource(&conn, &resource_id)?.is_some()
    };
    if !has_transcript {
        // Transcript gone: the indexer re-syncs (stale transcript units force a rebuild).
        crate::vfs::repos::VfsIndexStateRepo::mark_pending(db, &resource_id)?;
        return Ok(0);
    }
    let units = crate::vfs::index_service::VfsIndexService::new(db.clone()).sync_resource_units(
        crate::vfs::unit_builder::UnitBuildInput {
            resource_id: resource_id.clone(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: None,
            page_count: None,
            extracted_text: None,
            preview_json: None,
        },
    )?;
    Ok(units.len())
}

/// Time ranges of the transcript units of `resource_id`, indexed by `unit_index`
/// (empty when the resource has no finished transcript).
pub fn unit_time_ranges(conn: &Connection, resource_id: &str) -> VfsResult<Vec<MediaTimeRange>> {
    let Some(file_id) = file_id_for_resource(conn, resource_id)? else {
        return Ok(Vec::new());
    };
    Ok(build_windows(&load_finished_lines(conn, &file_id)?)
        .into_iter()
        .map(|window| window.range)
        .collect())
}

/// Range of one unit from [`unit_time_ranges`].
pub fn range_for_unit(ranges: &[MediaTimeRange], unit_index: i32) -> Option<MediaTimeRange> {
    usize::try_from(unit_index)
        .ok()
        .and_then(|index| ranges.get(index))
        .copied()
}

/// Fills `identity.time_range` (and a `file_*` source id) on media hits. Best-effort: a
/// missing transcript table or row never fails retrieval.
pub fn attach_media_time_ranges(db: &VfsDatabase, hits: &mut [FusedRetrievalHit]) {
    if hits.is_empty() {
        return;
    }
    if let Err(error) = attach_media_time_ranges_inner(db, hits) {
        log::debug!("[MediaIndex] time range enrichment skipped: {error}");
    }
}

fn attach_media_time_ranges_inner(
    db: &VfsDatabase,
    hits: &mut [FusedRetrievalHit],
) -> VfsResult<()> {
    let conn = db.get_conn_safe()?;
    // resource_id -> (file_id, windows); BTreeMap keeps lookups deterministic.
    let mut media: BTreeMap<String, Option<(String, Vec<MediaWindow>)>> = BTreeMap::new();
    for fused in hits.iter_mut() {
        let hit = &mut fused.hit;
        if hit
            .resource_type
            .as_deref()
            .is_some_and(|kind| kind != "file")
        {
            continue;
        }
        let resource_id = hit.identity.resource_id.clone();
        if !media.contains_key(&resource_id) {
            let entry = match file_id_for_resource(&conn, &resource_id)? {
                Some(file_id) => {
                    let windows = build_windows(&load_finished_lines(&conn, &file_id)?);
                    (!windows.is_empty()).then_some((file_id, windows))
                }
                None => None,
            };
            media.insert(resource_id.clone(), entry);
        }
        let Some(Some((file_id, windows))) = media.get(&resource_id) else {
            continue;
        };
        let range = time_range_from_metadata(&hit.metadata).or_else(|| {
            hit.identity
                .page_index
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| windows.get(index))
                .map(|window| window.range)
        });
        if let Some(range) = range {
            hit.identity.time_range = Some(range);
            hit.source_id = Some(file_id.clone());
        }
    }
    Ok(())
}

/// Result of a time-window transcript read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptRead {
    /// `[mm:ss] text` lines.
    pub content: String,
    pub range: MediaTimeRange,
    /// End of the last finished line of the whole transcript.
    pub total_ms: i64,
    /// Requested span exceeded [`MAX_READ_SPAN_MS`] and was cut.
    pub truncated: bool,
    pub line_count: usize,
}

/// Reads the transcript of `file_id` between `start_s` and `end_s` (seconds; `end_s`
/// defaults to `start_s + 10 min`, and is capped at that span). Returns `None` when the
/// file has no finished transcript.
pub fn read_transcript_range(
    conn: &Connection,
    file_id: &str,
    start_s: Option<f64>,
    end_s: Option<f64>,
) -> VfsResult<Option<TranscriptRead>> {
    let lines = load_finished_lines(conn, file_id)?;
    let Some(total_ms) = lines.iter().map(|line| line.end_ms).max() else {
        return Ok(None);
    };
    let to_ms = |seconds: f64| (seconds.max(0.0) * 1000.0).round() as i64;
    let start_ms = start_s.map(to_ms).unwrap_or(0);
    let requested_end = end_s.map(to_ms).filter(|end| *end > start_ms);
    let cap = start_ms.saturating_add(MAX_READ_SPAN_MS);
    let end_ms = requested_end.unwrap_or(cap).min(cap);
    let truncated = requested_end.is_some_and(|end| end > cap);
    let selected: Vec<&TranscriptLine> = lines
        .iter()
        .filter(|line| line.end_ms > start_ms && line.start_ms < end_ms)
        .collect();
    Ok(Some(TranscriptRead {
        content: selected
            .iter()
            .map(|line| stamped_line(line))
            .collect::<Vec<_>>()
            .join("\n"),
        range: MediaTimeRange { start_ms, end_ms },
        total_ms,
        truncated,
        line_count: selected.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_s: i64, end_s: i64, text: &str) -> TranscriptLine {
        TranscriptLine {
            start_ms: start_s * 1000,
            end_ms: end_s * 1000,
            text: text.to_string(),
        }
    }

    #[test]
    fn timestamps_switch_to_hours_after_one_hour() {
        assert_eq!(format_timestamp(0), "00:00");
        assert_eq!(format_timestamp(90_500), "01:30");
        assert_eq!(format_timestamp(3_725_000), "1:02:05");
        assert_eq!(media_citation("file_a", 75_000), "[媒体@file_a:01:15]");
    }

    #[test]
    fn windows_close_at_ninety_seconds() {
        let lines: Vec<_> = (0..10)
            .map(|i| line(i * 20, i * 20 + 15, &format!("第{i}段")))
            .collect();
        let windows = build_windows(&lines);
        // 0..75 s fits (line 4 ends at 95 s > 90 s budget from 0) → 4 lines per window.
        assert_eq!(windows.len(), 3);
        assert_eq!(
            windows[0].range,
            MediaTimeRange {
                start_ms: 0,
                end_ms: 75_000
            }
        );
        assert_eq!(windows[1].range.start_ms, 80_000);
        assert!(windows[0].text.starts_with("[00:00] 第0段\n[00:20] 第1段"));
        // Deterministic: same input, same windows.
        assert_eq!(windows, build_windows(&lines));
    }

    #[test]
    fn windows_close_at_char_budget_and_skip_empty_lines() {
        let long = "字".repeat(500);
        let lines = vec![
            line(0, 5, &long),
            line(5, 6, "   "),
            line(6, 10, &long),
            line(10, 12, "尾巴"),
        ];
        let windows = build_windows(&lines);
        assert_eq!(windows.len(), 2);
        assert_eq!(
            windows[1].range,
            MediaTimeRange {
                start_ms: 6_000,
                end_ms: 12_000
            }
        );
    }

    /// A `File` resource (res_media) backed by files.id = file_media with an imported
    /// transcript of 8 lines × 30 s.
    fn media_fixture() -> (tempfile::TempDir, std::sync::Arc<VfsDatabase>) {
        use crate::vfs::repos::media_transcript_repo::PlannedSpan;
        let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().expect("conn");
        conn.execute(
            "INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode,
                                    metadata_json, created_at, updated_at)
             VALUES ('res_media', 'hash_media', 'file', 'file_media', 'files', 'external',
                     '{\"title\":\"信号与系统 第3讲\"}', 0, 0)",
            [],
        )
        .expect("insert resource");
        conn.execute(
            "INSERT INTO files (id, resource_id, sha256, file_name, size, type, mime_type,
                                created_at, updated_at)
             VALUES ('file_media', 'res_media', 'sha_media', 'lecture.mp4', 1, 'video',
                     'video/mp4', '0', '0')",
            [],
        )
        .expect("insert file");
        let topics = [
            "今天讲傅里叶级数",
            "周期信号可以展开",
            "正交基的概念",
            "系数的计算方法",
            "接下来介绍卷积定理",
            "时域卷积对应频域乘积",
            "例题一",
            "下课",
        ];
        let segments: Vec<(PlannedSpan, String)> = topics
            .iter()
            .enumerate()
            .map(|(i, text)| {
                let start_ms = i as i64 * 30_000;
                (
                    PlannedSpan {
                        start_ms,
                        end_ms: start_ms + 28_000,
                    },
                    text.to_string(),
                )
            })
            .collect();
        MediaTranscriptRepo::set_imported_segments_with_conn(&conn, "file_media", &segments)
            .expect("import transcript");
        drop(conn);
        (temp_dir, std::sync::Arc::new(db))
    }

    #[test]
    fn transcript_files_index_as_time_window_units() {
        use crate::vfs::index_service::VfsIndexService;
        use crate::vfs::unit_builder::UnitBuildInput;

        let (_temp_dir, db) = media_fixture();
        let input = UnitBuildInput {
            resource_id: "res_media".to_string(),
            resource_type: "file".to_string(),
            data: None,
            ocr_text: None,
            ocr_pages_json: None,
            blob_hash: None,
            page_count: None,
            // Legacy whole-file transcription text must be superseded by the windows.
            extracted_text: Some("旧的整段转写".to_string()),
            preview_json: None,
        };
        let service = VfsIndexService::new(db.clone());
        let units = service.sync_resource_units(input.clone()).expect("sync");
        // 8 lines of 30 s: lines 0-2 (0..88 s), 3-5, 6-7.
        assert_eq!(units.len(), 3);
        assert!(units
            .iter()
            .all(|unit| unit.text_source.as_deref() == Some(TRANSCRIPT_TEXT_SOURCE)));
        assert!(units[1]
            .text_content
            .as_deref()
            .unwrap()
            .contains("[02:00] 接下来介绍卷积定理"));
        // Re-sync is a content-hash no-op (deterministic windows).
        let again = service.sync_resource_units(input).expect("resync");
        assert_eq!(
            again.iter().map(|u| u.id.clone()).collect::<Vec<_>>(),
            units.iter().map(|u| u.id.clone()).collect::<Vec<_>>()
        );
        assert_eq!(
            again
                .iter()
                .map(|u| u.content_hash.clone())
                .collect::<Vec<_>>(),
            units
                .iter()
                .map(|u| u.content_hash.clone())
                .collect::<Vec<_>>()
        );

        let conn = db.get_conn_safe().unwrap();
        let ranges = unit_time_ranges(&conn, "res_media").unwrap();
        assert_eq!(
            range_for_unit(&ranges, 1),
            Some(MediaTimeRange {
                start_ms: 90_000,
                end_ms: 178_000
            })
        );
    }

    #[test]
    fn refresh_after_transcript_change_rebuilds_lexical_units() {
        let (_temp_dir, db) = media_fixture();
        assert_eq!(refresh_transcript_index(&db, "file_media").unwrap(), 3);
        assert_eq!(refresh_transcript_index(&db, "file_unknown").unwrap(), 0);
        let conn = db.get_conn_safe().unwrap();
        MediaTranscriptRepo::delete_segments_with_conn(&conn, "file_media").unwrap();
        drop(conn);
        assert_eq!(refresh_transcript_index(&db, "file_media").unwrap(), 0);
    }

    #[test]
    fn media_hits_get_time_range_and_file_source_id() {
        use crate::vfs::retrieval_planner::{RetrievalHit, RetrievalIdentity};

        let (_temp_dir, db) = media_fixture();
        let fused = |page_index: Option<i32>, metadata: serde_json::Value| FusedRetrievalHit {
            hit: RetrievalHit {
                identity: RetrievalIdentity {
                    resource_id: "res_media".to_string(),
                    chunk_index: 0,
                    page_index,
                    time_range: None,
                },
                embedding_id: "unit:x".to_string(),
                text: "卷积".to_string(),
                title: None,
                resource_type: Some("file".to_string()),
                source_id: None,
                folder_id: None,
                blob_hash: None,
                image_url: None,
                raw_score: None,
                metadata,
            },
            rrf_score: 1.0,
            normalized_score: None,
            rerank_score: None,
            provenance: Vec::new(),
        };
        let mut hits = vec![
            fused(Some(1), serde_json::Value::Null),
            fused(
                None,
                serde_json::json!({"startMs": 150_000, "endMs": 178_000}),
            ),
            fused(None, serde_json::Value::Null),
        ];
        attach_media_time_ranges(&db, &mut hits);
        assert_eq!(
            hits[0].hit.identity.time_range,
            Some(MediaTimeRange {
                start_ms: 90_000,
                end_ms: 178_000
            })
        );
        assert_eq!(hits[0].hit.source_id.as_deref(), Some("file_media"));
        assert_eq!(hits[1].hit.identity.time_range.unwrap().start_ms, 150_000);
        assert_eq!(hits[2].hit.identity.time_range, None);
        assert_eq!(
            media_citation(
                "file_media",
                hits[0].hit.identity.time_range.unwrap().start_ms
            ),
            "[媒体@file_media:01:30]"
        );
    }

    #[test]
    fn transcript_reads_are_capped_at_ten_minutes() {
        let (_temp_dir, db) = media_fixture();
        let conn = db.get_conn_safe().unwrap();
        let read = read_transcript_range(&conn, "file_media", Some(60.0), Some(125.0))
            .unwrap()
            .unwrap();
        assert_eq!(
            read.content,
            "[01:00] 正交基的概念\n[01:30] 系数的计算方法\n[02:00] 接下来介绍卷积定理"
        );
        assert!(!read.truncated);
        let long = read_transcript_range(&conn, "file_media", Some(0.0), Some(3600.0))
            .unwrap()
            .unwrap();
        assert!(long.truncated);
        assert_eq!(long.range.end_ms, MAX_READ_SPAN_MS);
        assert_eq!(long.line_count, 8);
        assert!(read_transcript_range(&conn, "file_none", None, None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn metadata_round_trips_deterministically() {
        let range = MediaTimeRange {
            start_ms: 90_000,
            end_ms: 180_000,
        };
        let json = segment_metadata_json(range);
        assert_eq!(json, r#"{"startMs":90000,"endMs":180000}"#);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(time_range_from_metadata(&value), Some(range));
        assert_eq!(time_range_from_metadata(&serde_json::Value::Null), None);
    }
}
