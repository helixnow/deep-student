//! 「音视频」子应用的资源库视图（资源库的一个镜头，媒体仍是 VFS File 资源）
//!
//! | 命令 | 说明 |
//! |---|---|
//! | `media_library_list(limit?)` | 全部未删除的音视频文件 + 转写状态 + 播放进度 + 讲义数，按最近活动倒序 |
//! | `media_related_notes(resourceId)` | 由该媒体生成的笔记（`notes.props._origin.resourceId` 精确匹配），新的在前 |
//!
//! - 列表一次查询 `files`（LEFT JOIN `media_progress` 与按 resource_id 聚合的段计数），
//!   不做 N+1；"运行中"由调用方传入的判定闭包给出（生产 = 媒体任务承载方的内存表）。
//! - 转写状态词表与推导规则与 `media_transcript_get` 完全一致（[`derive_status`]）。
//! - 时间戳统一为 Unix 毫秒（与 DstuNode.createdAt/updatedAt 相同）。

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use super::commands::derive_status;
use super::{
    is_link_item, media_kind, MediaError, MediaKind, AUDIO_EXTENSIONS, BILIBILI_LINK_EXTENSION,
    VIDEO_EXTENSIONS,
};
use crate::dstu::handler_utils::node_converters::{
    parse_timestamp, sanitize_textbook_display_name,
};
use crate::vfs::database::VfsDatabase;
use crate::vfs::pdf_processing_service::PdfProcessingService;
use crate::vfs::repos::media_transcript_repo::SegmentCounts;

/// 文件夹路径解析的最大深度（防御环形 parent_id）
const MAX_FOLDER_DEPTH: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibraryTranscript {
    /// none | queued | running | completed | partial | error | cancelled
    pub status: String,
    pub completed_segments: i64,
    pub total_segments: i64,
    pub failed_segments: i64,
    /// asr | import（无段时 null）
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibraryProgress {
    pub last_position_ms: i64,
    pub watched_ms: i64,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibraryItem {
    /// `files.id`（`file_*` / `att_*`），DSTU 路径为 `/{id}`
    pub id: String,
    /// `files.resource_id`（`res_*`，可空）
    pub resource_id: Option<String>,
    pub name: String,
    pub folder_id: Option<String>,
    pub folder_name: Option<String>,
    /// 根 → 所在文件夹的标题链（根级文件为空数组）
    pub folder_path: Vec<String>,
    pub size: i64,
    pub mime_type: String,
    /// audio | video
    pub kind: String,
    /// B 站链接条目（没有本地音视频，播放走内嵌播放器）
    pub is_link: bool,
    /// 链接条目的封面（来自条目描述，已限定 B 站图床域名）；本地文件为 null
    pub cover_url: Option<String>,
    /// Unix 毫秒
    pub created_at: i64,
    /// Unix 毫秒
    pub updated_at: i64,
    pub duration_ms: Option<i64>,
    pub transcript: MediaLibraryTranscript,
    pub progress: MediaLibraryProgress,
    /// 最近一次播放上报（Unix 毫秒）；仅记录过时长、从未播放时为 null
    pub last_watched_at: Option<i64>,
    /// 来源指向本媒体的未删除笔记数（讲义 / 笔记）
    pub handout_count: i64,
    /// 排序键：max(lastWatchedAt, updatedAt)（Unix 毫秒）
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRelatedNote {
    /// `note_*`，DSTU 路径为 `/{id}`
    pub id: String,
    pub title: String,
    /// Unix 毫秒
    pub created_at: i64,
    /// Unix 毫秒
    pub updated_at: i64,
}

fn kind_label(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

/// SQL 预筛：type / MIME / 扩展名任一命中（最终以 [`media_kind`] 判定，与转写命令一致）
fn media_candidate_clause() -> String {
    let mut parts = vec![
        "f.\"type\" IN ('audio', 'video')".to_string(),
        "lower(COALESCE(f.mime_type, '')) LIKE 'audio/%'".to_string(),
        "lower(COALESCE(f.mime_type, '')) LIKE 'video/%'".to_string(),
    ];
    for ext in AUDIO_EXTENSIONS
        .iter()
        .chain(VIDEO_EXTENSIONS.iter())
        .chain(std::iter::once(&BILIBILI_LINK_EXTENSION))
    {
        parts.push(format!("lower(f.file_name) LIKE '%.{}'", ext));
    }
    format!("({})", parts.join(" OR "))
}

/// `notes.props._origin`（JSON 字符串）中 `kind='resource'` 的 resourceId 子查询列。
/// 嵌套 CASE + json_valid：畸形 props / _origin 不会让 json_extract 报错中断整条查询。
const NOTE_ORIGIN_SUBQUERY: &str = "
    SELECT id, title, created_at, updated_at,
           CASE WHEN json_valid(o) THEN json_extract(o, '$.kind') END AS origin_kind,
           CASE WHEN json_valid(o) THEN json_extract(o, '$.resourceId') END AS origin_rid
    FROM (
        SELECT id, title, created_at, updated_at,
               CASE WHEN json_valid(props) THEN json_extract(props, '$._origin') END AS o
        FROM notes
        WHERE deleted_at IS NULL AND props IS NOT NULL AND instr(props, '_origin') > 0
    )";

/// 每个来源 resourceId → 未删除笔记数（一次聚合查询）
fn handout_counts_with_conn(conn: &Connection) -> Result<HashMap<String, i64>, MediaError> {
    let sql = format!(
        "SELECT origin_rid, COUNT(*) FROM ({NOTE_ORIGIN_SUBQUERY})
         WHERE origin_kind = 'resource' AND typeof(origin_rid) = 'text'
         GROUP BY origin_rid"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

/// 未删除文件夹的 (id → (parent_id, title))
fn load_folders(
    conn: &Connection,
) -> Result<HashMap<String, (Option<String>, String)>, MediaError> {
    let mut stmt =
        conn.prepare("SELECT id, parent_id, title FROM folders WHERE deleted_at IS NULL")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?),
            ))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

fn folder_path(
    folders: &HashMap<String, (Option<String>, String)>,
    folder_id: &str,
) -> Vec<String> {
    let mut path = Vec::new();
    let mut current = Some(folder_id.to_string());
    while let Some(id) = current {
        if path.len() >= MAX_FOLDER_DEPTH {
            break;
        }
        match folders.get(&id) {
            Some((parent, title)) => {
                path.push(title.clone());
                current = parent.clone();
            }
            None => break,
        }
    }
    path.reverse();
    path
}

struct LibraryRow {
    id: String,
    resource_id: Option<String>,
    file_name: String,
    mime_type: String,
    size: i64,
    created_at: String,
    updated_at: String,
    processing_status: Option<String>,
    progress_position: Option<i64>,
    progress_duration: Option<i64>,
    progress_watched: Option<i64>,
    progress_finished: Option<i64>,
    progress_updated_at: Option<i64>,
    seg_total: i64,
    seg_done: i64,
    seg_failed: i64,
    seg_source: Option<String>,
    folder_id: Option<String>,
}

/// 列出资源库中的全部音视频（纯函数；`is_running` 判定转写任务是否在跑）
pub fn list_media_library_with_conn(
    conn: &Connection,
    is_running: &dyn Fn(&str) -> bool,
    limit: Option<usize>,
) -> Result<Vec<MediaLibraryItem>, MediaError> {
    let sql = format!(
        "SELECT f.id, f.resource_id, f.file_name, COALESCE(f.mime_type, ''), COALESCE(f.size, 0),
                f.created_at, f.updated_at, f.processing_status,
                mp.last_position_ms, mp.duration_ms, mp.watched_ms, mp.finished, mp.updated_at,
                COALESCE(seg.total, 0), COALESCE(seg.done, 0), COALESCE(seg.failed, 0), seg.source,
                (SELECT fi.folder_id FROM folder_items fi
                  WHERE fi.item_type IN ('file', 'image') AND fi.item_id = f.id
                    AND fi.deleted_at IS NULL
                  ORDER BY COALESCE(fi.updated_at, fi.created_at) DESC LIMIT 1)
         FROM files f
         LEFT JOIN media_progress mp ON mp.resource_id = f.id
         LEFT JOIN (
             SELECT resource_id,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS done,
                    SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS failed,
                    MIN(source) AS source
             FROM media_transcript_segments GROUP BY resource_id
         ) seg ON seg.resource_id = f.id
         WHERE f.status = 'active' AND f.deleted_at IS NULL AND {}",
        media_candidate_clause()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LibraryRow {
                id: r.get(0)?,
                resource_id: r.get(1)?,
                file_name: r.get(2)?,
                mime_type: r.get(3)?,
                size: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                processing_status: r.get(7)?,
                progress_position: r.get(8)?,
                progress_duration: r.get(9)?,
                progress_watched: r.get(10)?,
                progress_finished: r.get(11)?,
                progress_updated_at: r.get(12)?,
                seg_total: r.get(13)?,
                seg_done: r.get(14)?,
                seg_failed: r.get(15)?,
                seg_source: r.get(16)?,
                folder_id: r.get(17)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let needs_folders = rows.iter().any(|r| r.folder_id.is_some());
    let folders = if needs_folders {
        load_folders(conn)?
    } else {
        HashMap::new()
    };
    let handouts = handout_counts_with_conn(conn)?;

    let mut items: Vec<MediaLibraryItem> = rows
        .into_iter()
        .filter_map(|row| {
            // 与 load_media_file 同口径：媒体判定失败的文件转写命令也打不开，不进列表
            let kind = media_kind(&row.mime_type, &row.file_name)?;
            let counts = SegmentCounts {
                total: row.seg_total,
                done: row.seg_done,
                failed: row.seg_failed,
                pending: row.seg_total - row.seg_done - row.seg_failed,
            };
            let status = derive_status(
                is_running(&row.id),
                row.processing_status.as_deref(),
                &counts,
            );
            let progress = MediaLibraryProgress {
                last_position_ms: row.progress_position.unwrap_or(0),
                watched_ms: row.progress_watched.unwrap_or(0),
                finished: row.progress_finished.unwrap_or(0) != 0,
            };
            // record_duration 会在解码时建行（updated_at=解码时刻），未播放过不算"看过"
            let watched_any =
                progress.last_position_ms > 0 || progress.watched_ms > 0 || progress.finished;
            let last_watched_at = row.progress_updated_at.filter(|_| watched_any);
            let created_at = parse_timestamp(&row.created_at);
            let updated_at = parse_timestamp(&row.updated_at);
            let (folder_id, folder_name, folder_path) = match row.folder_id {
                Some(fid) if folders.contains_key(&fid) => {
                    let path = folder_path(&folders, &fid);
                    let name = path.last().cloned();
                    (Some(fid), name, path)
                }
                _ => (None, None, Vec::new()),
            };
            let handout_count = handouts.get(&row.id).copied().unwrap_or(0)
                + row
                    .resource_id
                    .as_ref()
                    .filter(|rid| **rid != row.id)
                    .and_then(|rid| handouts.get(rid))
                    .copied()
                    .unwrap_or(0);
            Some(MediaLibraryItem {
                name: sanitize_textbook_display_name(&row.file_name, &row.created_at),
                is_link: is_link_item(&row.mime_type, &row.file_name),
                cover_url: None,
                id: row.id,
                resource_id: row.resource_id,
                folder_id,
                folder_name,
                folder_path,
                size: row.size,
                mime_type: row.mime_type,
                kind: kind_label(kind).to_string(),
                created_at,
                updated_at,
                duration_ms: row.progress_duration.filter(|d| *d > 0),
                transcript: MediaLibraryTranscript {
                    status: status.to_string(),
                    completed_segments: counts.done,
                    total_segments: counts.total,
                    failed_segments: counts.failed,
                    source: row.seg_source.filter(|_| counts.total > 0),
                },
                progress,
                last_watched_at,
                handout_count,
                last_activity_at: last_watched_at.unwrap_or(i64::MIN).max(updated_at),
            })
        })
        .collect();

    items.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    if let Some(limit) = limit {
        items.truncate(limit);
    }
    Ok(items)
}

/// 由某媒体生成的笔记（`_origin.kind='resource'` 且 resourceId 精确等于 `files.id` 或其 `res_*`）
pub fn list_related_notes_with_conn(
    conn: &Connection,
    resource_id: &str,
) -> Result<Vec<MediaRelatedNote>, MediaError> {
    let resource_id = resource_id.trim();
    if resource_id.is_empty() {
        return Err(MediaError::InvalidInput("resourceId 不能为空".into()));
    }
    // file_* 与 res_* 两种 ID 互通（来源可能记录任一种）
    let ids: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, resource_id FROM files WHERE id = ?1 OR resource_id = ?1
             ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1",
            params![resource_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (file_id, res_id) = match ids {
        Some((file_id, res_id)) => (file_id, res_id.unwrap_or_default()),
        None => (resource_id.to_string(), String::new()),
    };
    let sql = format!(
        "SELECT id, title, created_at, updated_at FROM ({NOTE_ORIGIN_SUBQUERY})
         WHERE origin_kind = 'resource' AND typeof(origin_rid) = 'text'
           AND (origin_rid = ?1 OR (?2 <> '' AND origin_rid = ?2))"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut notes = stmt
        .query_map(params![file_id, res_id], |r| {
            Ok(MediaRelatedNote {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: parse_timestamp(&r.get::<_, String>(2)?),
                updated_at: parse_timestamp(&r.get::<_, String>(3)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    notes.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(notes)
}

fn err(e: MediaError) -> String {
    e.to_payload_string()
}

#[tauri::command]
pub async fn media_library_list(
    limit: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> Result<Vec<MediaLibraryItem>, String> {
    let db = Arc::clone(vfs_db.inner());
    let service = Arc::clone(pdf_processing_service.inner());
    tokio::task::spawn_blocking(move || {
        let mut items = {
            let conn = db.get_conn_safe()?;
            list_media_library_with_conn(
                &conn,
                &|id| service.is_running(id),
                limit.map(|l| l as usize),
            )?
        };
        // 链接条目的描述只有几百字节，逐条读出封面；读不到（文件缺失 / 旧格式）就不显示封面
        for item in items.iter_mut().filter(|item| item.is_link) {
            item.cover_url = crate::media::bilibili::read_link_descriptor(&db, &item.id)
                .ok()
                .and_then(|descriptor| descriptor.cover);
        }
        Ok(items)
    })
    .await
    .map_err(|e| err(MediaError::Io(e.to_string())))?
    .map_err(err)
}

#[tauri::command]
pub async fn media_related_notes(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<MediaRelatedNote>, String> {
    let db = Arc::clone(vfs_db.inner());
    tokio::task::spawn_blocking(move || {
        let conn = db.get_conn_safe()?;
        list_related_notes_with_conn(&conn, &resource_id)
    })
    .await
    .map_err(|e| err(MediaError::Io(e.to_string())))?
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::database::setup_migrated_test_db;
    use crate::vfs::repos::media_transcript_repo::{
        MediaProgressUpdate, MediaTranscriptRepo, PlannedSpan,
    };
    use crate::vfs::repos::note_repo::{VfsNoteMetadataUpdate, VfsNoteRepo};
    use crate::vfs::types::VfsCreateNoteParams;

    fn insert_file(
        conn: &Connection,
        id: &str,
        name: &str,
        mime: Option<&str>,
        file_type: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1000, ?4, ?5, 'active', ?6, ?6)",
            params![id, format!("sha_{id}"), name, mime, file_type, updated_at],
        )
        .unwrap();
    }

    fn spans(n: usize) -> Vec<PlannedSpan> {
        (0..n)
            .map(|i| PlannedSpan {
                start_ms: i as i64 * 1000,
                end_ms: i as i64 * 1000 + 900,
            })
            .collect()
    }

    fn not_running(_: &str) -> bool {
        false
    }

    fn by_id<'a>(items: &'a [MediaLibraryItem], id: &str) -> &'a MediaLibraryItem {
        items.iter().find(|i| i.id == id).unwrap()
    }

    #[test]
    fn lists_only_live_audio_video_files() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let t = "2026-10-01T00:00:00Z";
        insert_file(&conn, "file_a", "talk.mp3", Some("audio/mpeg"), "audio", t);
        insert_file(
            &conn,
            "file_v",
            "lecture.mkv",
            Some("application/octet-stream"),
            "document",
            t,
        );
        insert_file(
            &conn,
            "file_pdf",
            "book.pdf",
            Some("application/pdf"),
            "document",
            t,
        );
        insert_file(&conn, "file_img", "a.png", Some("image/png"), "image", t);
        insert_file(&conn, "file_gone", "old.mp4", Some("video/mp4"), "video", t);
        conn.execute(
            "UPDATE files SET status = 'deleted', deleted_at = ?1 WHERE id = 'file_gone'",
            params![t],
        )
        .unwrap();

        let items = list_media_library_with_conn(&conn, &not_running, None).unwrap();
        let mut ids: Vec<_> = items.iter().map(|i| i.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["file_a", "file_v"]);
        assert_eq!(by_id(&items, "file_a").kind, "audio");
        assert_eq!(by_id(&items, "file_v").kind, "video");
        let a = by_id(&items, "file_a");
        assert_eq!(a.transcript.status, "none");
        assert_eq!(a.duration_ms, None);
        assert_eq!(a.progress, MediaLibraryProgress::default());
        assert_eq!(a.last_watched_at, None);
        assert_eq!(a.handout_count, 0);
        assert_eq!(a.created_at, parse_timestamp(t));
        assert!(a.folder_path.is_empty());

        let json = serde_json::to_value(a).unwrap();
        assert_eq!(json["transcript"]["completedSegments"], 0);
        assert_eq!(json["progress"]["lastPositionMs"], 0);
        assert!(json["lastWatchedAt"].is_null());
        assert_eq!(json["mimeType"], "audio/mpeg");

        let limited = list_media_library_with_conn(&conn, &not_running, Some(1)).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn transcript_status_matches_transcript_get_vocabulary() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let t = "2026-10-01T00:00:00Z";
        for id in [
            "file_none",
            "file_partial",
            "file_done",
            "file_run",
            "file_err",
        ] {
            insert_file(&conn, id, "x.wav", Some("audio/wav"), "audio", t);
        }
        // partial：2/4 完成，processing_status 为崩溃遗留中间态
        MediaTranscriptRepo::apply_plan_with_conn(&conn, "file_partial", &spans(4)).unwrap();
        MediaTranscriptRepo::mark_done_with_conn(&conn, "file_partial", 0, 1, "a").unwrap();
        MediaTranscriptRepo::mark_done_with_conn(&conn, "file_partial", 1, 1, "b").unwrap();
        conn.execute(
            "UPDATE files SET processing_status = 'asr' WHERE id = 'file_partial'",
            [],
        )
        .unwrap();
        // completed：字幕导入
        MediaTranscriptRepo::set_imported_segments_with_conn(
            &conn,
            "file_done",
            &[(
                PlannedSpan {
                    start_ms: 0,
                    end_ms: 1000,
                },
                "hi".to_string(),
            )],
        )
        .unwrap();
        // running：内存表里有任务
        conn.execute(
            "UPDATE files SET processing_status = 'asr' WHERE id = 'file_run'",
            [],
        )
        .unwrap();
        // error：无段且任务报错
        conn.execute(
            "UPDATE files SET processing_status = 'error' WHERE id = 'file_err'",
            [],
        )
        .unwrap();

        let running = |id: &str| id == "file_run";
        let items = list_media_library_with_conn(&conn, &running, None).unwrap();
        assert_eq!(by_id(&items, "file_none").transcript.status, "none");
        let partial = &by_id(&items, "file_partial").transcript;
        assert_eq!(partial.status, "partial");
        assert_eq!(
            (
                partial.completed_segments,
                partial.total_segments,
                partial.failed_segments
            ),
            (2, 4, 0)
        );
        assert_eq!(partial.source.as_deref(), Some("asr"));
        let done = &by_id(&items, "file_done").transcript;
        assert_eq!(done.status, "completed");
        assert_eq!(done.source.as_deref(), Some("import"));
        assert_eq!(by_id(&items, "file_run").transcript.status, "running");
        assert_eq!(by_id(&items, "file_err").transcript.status, "error");
        assert_eq!(by_id(&items, "file_none").transcript.source, None);
    }

    #[test]
    fn progress_duration_and_sort_by_recent_activity() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        // 更新时间：old < mid < new；old 最近被播放过 → 排第一
        insert_file(
            &conn,
            "file_old",
            "o.mp3",
            Some("audio/mpeg"),
            "audio",
            "2020-01-01T00:00:00Z",
        );
        insert_file(
            &conn,
            "file_mid",
            "m.mp3",
            Some("audio/mpeg"),
            "audio",
            "2021-01-01T00:00:00Z",
        );
        insert_file(
            &conn,
            "file_new",
            "n.mp4",
            Some("video/mp4"),
            "video",
            "2022-01-01T00:00:00Z",
        );
        MediaTranscriptRepo::set_progress_with_conn(
            &conn,
            "file_old",
            &MediaProgressUpdate {
                position_ms: Some(30_000),
                duration_ms: Some(100_000),
                watched_delta_ms: Some(20_000),
                finished: None,
            },
        )
        .unwrap();
        // 仅解码记录了时长（从未播放）：有 duration，但不算 lastWatchedAt
        MediaTranscriptRepo::record_duration_with_conn(&conn, "file_mid", 42_000).unwrap();

        let items = list_media_library_with_conn(&conn, &not_running, None).unwrap();
        let order: Vec<_> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(order, vec!["file_old", "file_new", "file_mid"]);

        let old = by_id(&items, "file_old");
        assert_eq!(old.duration_ms, Some(100_000));
        assert_eq!(
            old.progress,
            MediaLibraryProgress {
                last_position_ms: 30_000,
                watched_ms: 20_000,
                finished: false,
            }
        );
        assert!(old.last_watched_at.is_some());
        assert_eq!(old.last_activity_at, old.last_watched_at.unwrap());

        let mid = by_id(&items, "file_mid");
        assert_eq!(mid.duration_ms, Some(42_000));
        assert_eq!(mid.last_watched_at, None);
        assert_eq!(mid.last_activity_at, mid.updated_at);
    }

    #[test]
    fn folder_path_is_resolved() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        insert_file(
            &conn,
            "file_a",
            "a.mp3",
            Some("audio/mpeg"),
            "audio",
            "2026-01-01T00:00:00Z",
        );
        conn.execute_batch(
            "INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES ('fld_root', NULL, '课程', 1, 1);
             INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES ('fld_sub', 'fld_root', '第一周', 1, 1);
             INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at) VALUES ('fi_1', 'fld_sub', 'file', 'file_a', 1);",
        )
        .unwrap();
        let items = list_media_library_with_conn(&conn, &not_running, None).unwrap();
        assert_eq!(items[0].folder_id.as_deref(), Some("fld_sub"));
        assert_eq!(items[0].folder_name.as_deref(), Some("第一周"));
        assert_eq!(items[0].folder_path, vec!["课程", "第一周"]);
    }

    fn note_with_origin(
        db: &VfsDatabase,
        title: &str,
        origin: Option<serde_json::Value>,
    ) -> String {
        let note = VfsNoteRepo::create_note(
            db,
            VfsCreateNoteParams {
                title: title.to_string(),
                content: "body".to_string(),
                tags: vec![],
            },
        )
        .unwrap();
        if let Some(origin) = origin {
            VfsNoteRepo::update_note_metadata(
                db,
                &note.id,
                VfsNoteMetadataUpdate {
                    title: None,
                    tags: None,
                    is_favorite: None,
                    props: Some(serde_json::json!({ "_origin": origin.to_string(), "课程": "ML" })),
                    expected_updated_at: None,
                },
            )
            .unwrap();
        }
        note.id
    }

    fn resource_origin(id: &str) -> serde_json::Value {
        serde_json::json!({ "kind": "resource", "resourceId": id, "title": "讲座" })
    }

    #[test]
    fn related_notes_match_exactly_and_skip_deleted() {
        let (_tmp, db) = setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().unwrap();
            insert_file(
                &conn,
                "file_abc",
                "a.mp3",
                Some("audio/mpeg"),
                "audio",
                "2026-01-01T00:00:00Z",
            );
            insert_file(
                &conn,
                "file_abcd",
                "b.mp3",
                Some("audio/mpeg"),
                "audio",
                "2026-01-01T00:00:00Z",
            );
            conn.execute("UPDATE files SET resource_id = NULL", [])
                .unwrap();
        }
        let n1 = note_with_origin(&db, "讲义一", Some(resource_origin("file_abc")));
        let n2 = note_with_origin(&db, "讲义二", Some(resource_origin("file_abc")));
        // 前缀相同的另一个资源、对话来源、无来源、已删除 —— 都不应命中
        let other = note_with_origin(&db, "别的", Some(resource_origin("file_abcd")));
        note_with_origin(
            &db,
            "对话",
            Some(serde_json::json!({ "kind": "chat", "sessionId": "file_abc" })),
        );
        note_with_origin(&db, "无来源", None);
        let deleted = note_with_origin(&db, "已删", Some(resource_origin("file_abc")));
        VfsNoteRepo::delete_note(&db, &deleted).unwrap();
        // 畸形 _origin 不应让查询报错
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE notes SET props = '{\"_origin\":\"not json\"}' WHERE id = ?1",
                params![other],
            )
            .unwrap();
        }
        let conn = db.get_conn_safe().unwrap();
        // n2 更新得更晚 → 排前面
        conn.execute(
            "UPDATE notes SET updated_at = '2030-01-01T00:00:00Z' WHERE id = ?1",
            params![n2],
        )
        .unwrap();

        let notes = list_related_notes_with_conn(&conn, "file_abc").unwrap();
        let ids: Vec<_> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec![n2.as_str(), n1.as_str()]);
        assert_eq!(notes[1].title, "讲义一");
        assert!(list_related_notes_with_conn(&conn, "file_abcd")
            .unwrap()
            .is_empty());
        assert!(list_related_notes_with_conn(&conn, "file_ab")
            .unwrap()
            .is_empty());

        let items = list_media_library_with_conn(&conn, &not_running, None).unwrap();
        assert_eq!(by_id(&items, "file_abc").handout_count, 2);
        assert_eq!(by_id(&items, "file_abcd").handout_count, 0);
    }

    #[test]
    fn related_notes_accept_res_id_alias() {
        let (_tmp, db) = setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().unwrap();
            insert_file(
                &conn,
                "file_x",
                "x.mp4",
                Some("video/mp4"),
                "video",
                "2026-01-01T00:00:00Z",
            );
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF; UPDATE files SET resource_id = 'res_x' WHERE id = 'file_x'; PRAGMA foreign_keys = ON;",
            )
            .unwrap();
        }
        let by_res = note_with_origin(&db, "按 res 记录", Some(resource_origin("res_x")));
        let by_file = note_with_origin(&db, "按 file 记录", Some(resource_origin("file_x")));
        let conn = db.get_conn_safe().unwrap();
        let mut ids: Vec<_> = list_related_notes_with_conn(&conn, "file_x")
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        ids.sort();
        let mut expected = vec![by_res, by_file];
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(
            list_related_notes_with_conn(&conn, "res_x").unwrap().len(),
            2
        );
        let items = list_media_library_with_conn(&conn, &not_running, None).unwrap();
        assert_eq!(items[0].handout_count, 2);
        assert!(list_related_notes_with_conn(&conn, "  ").is_err());
    }
}
