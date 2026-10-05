//! 媒体转写流水线编排：queued → decode → vad → asr（→ indexing 由任务承载方执行）
//!
//! - **全局单飞**：同一时刻只跑一个媒体转写（[`MEDIA_TRANSCRIPTION_LOCK`]），排队期间可取消。
//! - **续做**：已完成段跳过；新 VAD 计划段数偏差 > 20% 时重建（`plan_version + 1`），
//!   见 [`MediaTranscriptRepo::apply_plan_with_conn`]。
//! - **落库**：每段完成即写库（取消 / 崩溃不丢已完成段）；结束时把 `[mm:ss] 文本`
//!   行写入 `files.extracted_text`，供 chatanki / qbank 等既有消费方直接读取。
//!
//! 任务状态、事件与启动恢复由 `vfs::pdf_processing_service`（MediaType::Audio/Video）承载。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use super::asr::{run_asr_jobs, AsrBackend, AsrJob, AsrSink};
use super::decoder::decode_to_mono_16k;
use super::transcript::build_transcript_text;
use super::vad::{plan_segments, VadAnalyzer, VadParams};
use super::wav::{PcmSpool, PcmSpoolWriter};
use super::{MediaError, MediaKind};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::media_transcript_repo::{
    MediaTranscriptRepo, PlanOutcome, PlannedSpan, SEGMENT_SOURCE_IMPORT,
};

/// 全局串行：一次只跑一个媒体转写任务（解码 CPU + ASR 配额）
pub static MEDIA_TRANSCRIPTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 流水线阶段（与 `files.processing_status` / 事件 `stage` 字符串一致）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaStage {
    Queued,
    Decode,
    Vad,
    Asr,
    Indexing,
}

impl MediaStage {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaStage::Queued => "queued",
            MediaStage::Decode => "decode",
            MediaStage::Vad => "vad",
            MediaStage::Asr => "asr",
            MediaStage::Indexing => "indexing",
        }
    }
}

/// 进度更新（由承载方转成 `media-processing-progress` 事件）
#[derive(Debug, Clone, PartialEq)]
pub struct MediaProgressUpdate {
    pub stage: MediaStage,
    /// 0..100
    pub percent: f32,
    pub completed_segments: Option<i64>,
    pub total_segments: Option<i64>,
}

/// 一次转写的结果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptionOutcome {
    pub duration_ms: i64,
    pub total_segments: i64,
    pub done_segments: i64,
    pub failed_segments: i64,
    pub plan_version: i64,
    /// 计划是否因段数偏差被重建
    pub rebuilt: bool,
    /// 字幕导入的段，未跑 ASR
    pub imported: bool,
    pub transcript_chars: usize,
}

/// 媒体文件信息
#[derive(Debug, Clone)]
pub struct MediaFileInfo {
    pub file_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub size: i64,
    pub resource_id: Option<String>,
}

impl MediaFileInfo {
    pub fn kind(&self) -> Option<MediaKind> {
        super::media_kind(&self.mime_type, &self.file_name)
    }

    pub fn extension(&self) -> Option<String> {
        Path::new(&self.file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
    }
}

/// 解析 `files.id`（也接受 `res_*` 资源 ID）
pub fn load_media_file(vfs_db: &VfsDatabase, id: &str) -> Result<MediaFileInfo, MediaError> {
    let conn = vfs_db.get_conn_safe()?;
    let row = conn
        .query_row(
            "SELECT id, file_name, COALESCE(mime_type, ''), COALESCE(size, 0), resource_id
             FROM files WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NULL
             ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1",
            params![id],
            |row| {
                Ok(MediaFileInfo {
                    file_id: row.get(0)?,
                    file_name: row.get(1)?,
                    mime_type: row.get(2)?,
                    size: row.get(3)?,
                    resource_id: row.get(4)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                MediaError::NotFound(format!("媒体文件不存在: {}", id))
            }
            other => MediaError::Database(other.to_string()),
        })?;
    if row.kind().is_none() {
        return Err(MediaError::InvalidInput(format!(
            "不是音视频文件: {} ({})",
            row.file_name, row.mime_type
        )));
    }
    Ok(row)
}

/// 媒体文件在磁盘上的位置（内联小文件落临时文件）
pub struct MediaSource {
    pub path: PathBuf,
    _temp: Option<tempfile::NamedTempFile>,
}

pub fn resolve_media_source(
    vfs_db: &VfsDatabase,
    file_id: &str,
) -> Result<MediaSource, MediaError> {
    use crate::vfs::repos::attachment_repo::VfsAttachmentContentSource;
    use crate::vfs::repos::VfsAttachmentRepo;
    let conn = vfs_db.get_conn_safe()?;
    let source =
        VfsAttachmentRepo::get_content_source_with_conn(&conn, vfs_db.blobs_dir(), file_id)?
            .ok_or_else(|| MediaError::NotFound(format!("媒体文件内容缺失: {}", file_id)))?;
    match source {
        VfsAttachmentContentSource::File(path) => Ok(MediaSource { path, _temp: None }),
        VfsAttachmentContentSource::Base64(content) => {
            use base64::Engine as _;
            let payload = match content.split_once(',') {
                Some((head, rest)) if head.starts_with("data:") => rest.to_string(),
                _ => content,
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .map_err(|e| MediaError::Decode(format!("媒体内容解码失败: {}", e)))?;
            let mut temp = tempfile::NamedTempFile::new()?;
            std::io::Write::write_all(&mut temp, &bytes)?;
            Ok(MediaSource {
                path: temp.path().to_path_buf(),
                _temp: Some(temp),
            })
        }
    }
}

/// 解码 + VAD 的产物
pub struct DecodedMedia {
    pub spool: Arc<PcmSpool>,
    pub spans: Vec<PlannedSpan>,
    pub duration_ms: i64,
    pub corrupt_packets: u64,
}

/// 解码到临时 PCM 并跑 VAD（阻塞，调用方放进 spawn_blocking）
pub fn decode_and_plan(
    path: &Path,
    ext_hint: Option<&str>,
    temp_dir: Option<&Path>,
    cancel: &CancellationToken,
    on_progress: &mut dyn FnMut(f32),
) -> Result<DecodedMedia, MediaError> {
    let mut spool = PcmSpoolWriter::new_in(temp_dir)?;
    let mut vad = VadAnalyzer::new();
    let report = decode_to_mono_16k(
        path,
        ext_hint,
        &|| cancel.is_cancelled(),
        on_progress,
        &mut |pcm| {
            vad.push(pcm);
            spool.write(pcm)
        },
    )?;
    let spool = spool.finish()?;
    let frames = vad.finish();
    let spans = plan_segments(&frames, &VadParams::default())
        .into_iter()
        .map(|(start_ms, end_ms)| PlannedSpan { start_ms, end_ms })
        .collect();
    Ok(DecodedMedia {
        spool: Arc::new(spool),
        spans,
        duration_ms: report.duration_ms,
        corrupt_packets: report.corrupt_packets,
    })
}

/// 只解码 + VAD 估算段数（不写库）
pub fn estimate_segments(
    path: &Path,
    ext_hint: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(i64, usize), MediaError> {
    let mut vad = VadAnalyzer::new();
    let report = decode_to_mono_16k(
        path,
        ext_hint,
        &|| cancel.is_cancelled(),
        &mut |_| {},
        &mut |pcm| {
            vad.push(pcm);
            Ok(())
        },
    )?;
    let frames = vad.finish();
    Ok((
        report.duration_ms,
        plan_segments(&frames, &VadParams::default()).len(),
    ))
}

fn send(tx: &Option<UnboundedSender<MediaProgressUpdate>>, update: MediaProgressUpdate) {
    if let Some(tx) = tx {
        let _ = tx.send(update);
    }
}

struct DbSink {
    vfs_db: Arc<VfsDatabase>,
    file_id: String,
    plan_version: i64,
    done: i64,
    total: i64,
    since_refresh: i64,
    tx: Option<UnboundedSender<MediaProgressUpdate>>,
}

impl DbSink {
    fn report(&self) {
        let ratio = if self.total > 0 {
            self.done as f32 / self.total as f32
        } else {
            1.0
        };
        send(
            &self.tx,
            MediaProgressUpdate {
                stage: MediaStage::Asr,
                percent: 35.0 + 55.0 * ratio,
                completed_segments: Some(self.done),
                total_segments: Some(self.total),
            },
        );
    }
}

impl AsrSink for DbSink {
    fn on_done(
        &mut self,
        job: &AsrJob,
        text: &str,
        bounds: Option<(i64, i64)>,
    ) -> Result<(), MediaError> {
        let conn = self.vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::mark_done_with_bounds_with_conn(
            &conn,
            &self.file_id,
            job.idx,
            self.plan_version,
            text,
            bounds,
        )?;
        self.done += 1;
        self.since_refresh += 1;
        if self.since_refresh >= PARTIAL_REFRESH_EVERY {
            self.since_refresh = 0;
            write_transcript_text(&self.vfs_db, &self.file_id)?;
            refresh_index(&self.vfs_db, &self.file_id);
        }
        self.report();
        Ok(())
    }

    fn on_failed(&mut self, job: &AsrJob, message: &str) -> Result<(), MediaError> {
        log::warn!(
            "[media::pipeline] segment {} of {} failed: {}",
            job.idx,
            self.file_id,
            message
        );
        let conn = self.vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::mark_failed_with_conn(
            &conn,
            &self.file_id,
            job.idx,
            self.plan_version,
        )?;
        Ok(())
    }
}

/// 把完成段写成 `files.extracted_text`（`[mm:ss] 文本` 行），返回字符数
pub fn write_transcript_text(vfs_db: &VfsDatabase, file_id: &str) -> Result<usize, MediaError> {
    let conn = vfs_db.get_conn_safe()?;
    let segments = MediaTranscriptRepo::list_segments_with_conn(&conn, file_id)?;
    let text = build_transcript_text(&segments);
    let value: Option<&str> = if text.is_empty() { None } else { Some(&text) };
    conn.execute(
        "UPDATE files SET extracted_text = ?1 WHERE id = ?2",
        params![value, file_id],
    )?;
    Ok(text.chars().count())
}

/// 转写变化后刷新检索：时间窗词法单元立即重建、向量标记待刷新（best-effort）
pub fn refresh_index(vfs_db: &Arc<VfsDatabase>, file_id: &str) {
    if let Err(e) = crate::vfs::media_index::refresh_transcript_index(vfs_db, file_id) {
        log::warn!(
            "[media::pipeline] refresh transcript index failed for {}: {}",
            file_id,
            e
        );
    }
}

/// 长转写过程中每完成多少段刷新一次转写文本与检索（部分转写即可搜索）
const PARTIAL_REFRESH_EVERY: i64 = 20;

/// 运行一次转写（排队 → 解码 → VAD → ASR → 写转写文本）。
///
/// 不负责索引与任务状态（由 `PdfProcessingService` 承载）。
pub async fn transcribe_resource(
    vfs_db: Arc<VfsDatabase>,
    file_id: &str,
    backend: Arc<dyn AsrBackend>,
    temp_dir: Option<PathBuf>,
    cancel: CancellationToken,
    tx: Option<UnboundedSender<MediaProgressUpdate>>,
) -> Result<TranscriptionOutcome, MediaError> {
    send(
        &tx,
        MediaProgressUpdate {
            stage: MediaStage::Queued,
            percent: 0.0,
            completed_segments: None,
            total_segments: None,
        },
    );
    let info = load_media_file(&vfs_db, file_id)?;
    let file_id = info.file_id.clone();

    // 字幕导入的转写不跑 ASR、不占全局转写槽位
    {
        let conn = vfs_db.get_conn_safe()?;
        if let Some((version, source)) = MediaTranscriptRepo::plan_info_with_conn(&conn, &file_id)?
        {
            if source == SEGMENT_SOURCE_IMPORT {
                drop(conn);
                let chars = write_transcript_text(&vfs_db, &file_id)?;
                refresh_index(&vfs_db, &file_id);
                let conn = vfs_db.get_conn_safe()?;
                let counts = MediaTranscriptRepo::counts_with_conn(&conn, &file_id)?;
                return Ok(TranscriptionOutcome {
                    total_segments: counts.total,
                    done_segments: counts.done,
                    plan_version: version,
                    imported: true,
                    transcript_chars: chars,
                    ..Default::default()
                });
            }
        }
    }

    let _guard = tokio::select! {
        guard = MEDIA_TRANSCRIPTION_LOCK.lock() => guard,
        _ = cancel.cancelled() => return Err(MediaError::Cancelled),
    };

    send(
        &tx,
        MediaProgressUpdate {
            stage: MediaStage::Decode,
            percent: 1.0,
            completed_segments: None,
            total_segments: None,
        },
    );

    let source = resolve_media_source(&vfs_db, &file_id)?;
    let ext = info.extension();
    let decode_cancel = cancel.clone();
    let decode_tx = tx.clone();
    let decoded = tokio::task::spawn_blocking(move || {
        let mut last = -1i32;
        let result = decode_and_plan(
            &source.path,
            ext.as_deref(),
            temp_dir.as_deref(),
            &decode_cancel,
            &mut |fraction| {
                let pct = (fraction * 30.0) as i32;
                if pct != last {
                    last = pct;
                    send(
                        &decode_tx,
                        MediaProgressUpdate {
                            stage: MediaStage::Decode,
                            percent: 1.0 + pct as f32,
                            completed_segments: None,
                            total_segments: None,
                        },
                    );
                }
            },
        );
        drop(source);
        result
    })
    .await
    .map_err(|e| MediaError::Io(format!("decode task failed: {}", e)))??;

    if decoded.corrupt_packets > 0 {
        log::warn!(
            "[media::pipeline] {} corrupt packets skipped (filled with silence) in {}",
            decoded.corrupt_packets,
            file_id
        );
    }

    send(
        &tx,
        MediaProgressUpdate {
            stage: MediaStage::Vad,
            percent: 32.0,
            completed_segments: None,
            total_segments: Some(decoded.spans.len() as i64),
        },
    );

    let (outcome, jobs) = {
        let conn = vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::record_duration_with_conn(&conn, &file_id, decoded.duration_ms)?;
        let outcome = MediaTranscriptRepo::apply_plan_with_conn(&conn, &file_id, &decoded.spans)?;
        MediaTranscriptRepo::reset_failed_with_conn(&conn, &file_id)?;
        let jobs: Vec<AsrJob> = MediaTranscriptRepo::list_unfinished_with_conn(&conn, &file_id)?
            .into_iter()
            .map(|s| AsrJob {
                idx: s.idx,
                start_ms: s.start_ms,
                end_ms: s.end_ms,
            })
            .collect();
        (outcome, jobs)
    };
    if let PlanOutcome::Rebuilt { plan_version } = outcome {
        // 旧计划的段已删除：转写文本与检索同步清掉
        write_transcript_text(&vfs_db, &file_id)?;
        refresh_index(&vfs_db, &file_id);
        log::info!(
            "[media::pipeline] plan rebuilt for {} (plan_version={})",
            file_id,
            plan_version
        );
    }

    let counts = {
        let conn = vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::counts_with_conn(&conn, &file_id)?
    };
    let mut sink = DbSink {
        vfs_db: Arc::clone(&vfs_db),
        file_id: file_id.clone(),
        plan_version: outcome.plan_version(),
        done: counts.done,
        total: counts.total,
        since_refresh: 0,
        tx: tx.clone(),
    };
    sink.report();

    let asr_result = if jobs.is_empty() {
        Ok(Default::default())
    } else {
        run_asr_jobs(
            backend,
            Arc::clone(&decoded.spool),
            jobs,
            cancel.clone(),
            &mut sink,
        )
        .await
    };

    // 无论 ASR 是否中途失败，已完成段都写进转写文本（续做时追加）
    let chars = write_transcript_text(&vfs_db, &file_id)?;
    refresh_index(&vfs_db, &file_id);
    asr_result?;

    let counts = {
        let conn = vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::counts_with_conn(&conn, &file_id)?
    };
    Ok(TranscriptionOutcome {
        duration_ms: decoded.duration_ms,
        total_segments: counts.total,
        done_segments: counts.done,
        failed_segments: counts.failed,
        plan_version: outcome.plan_version(),
        rebuilt: matches!(outcome, PlanOutcome::Rebuilt { .. }),
        imported: false,
        transcript_chars: chars,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::media::asr::{AsrClipResult, HttpAsrBackend};
    use crate::media::decoder::tests::write_wav;
    use crate::vfs::database::setup_migrated_test_db;
    use crate::voice_input::AsrEndpoint;

    /// 合成"讲课"：语音块（200 Hz + 谐波）与静音交替
    pub(crate) fn lecture_wav(path: &Path, blocks: &[(f64, bool)], rate: u32) {
        let mut pcm = Vec::new();
        let mut t = 0usize;
        for &(secs, voiced) in blocks {
            for _ in 0..(secs * rate as f64) as usize {
                let x = t as f64 / rate as f64;
                let v = if voiced {
                    0.3 * (2.0 * std::f64::consts::PI * 200.0 * x).sin()
                        + 0.1 * (2.0 * std::f64::consts::PI * 650.0 * x).sin()
                } else {
                    0.0
                };
                pcm.push((v * 32767.0) as i16);
                t += 1;
            }
        }
        write_wav(path, rate, 1, &pcm);
    }

    /// 在 VFS 测试库插入一条指向外部文件的 files 行
    pub(crate) fn insert_media_file(db: &VfsDatabase, file_id: &str, path: &Path) {
        let conn = db.get_conn_safe().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO files (id, sha256, file_name, original_path, size, mime_type, type, status, created_at, updated_at)
             VALUES (?1, ?2, 'lecture.wav', ?3, 1000, 'audio/wav', 'audio', 'active', ?4, ?4)",
            params![file_id, format!("sha_{}", file_id), path.to_string_lossy(), now],
        )
        .unwrap();
    }

    #[test]
    fn decode_and_plan_produces_spans() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.wav");
        lecture_wav(
            &path,
            &[
                (0.5, false),
                (2.0, true),
                (1.5, false),
                (3.0, true),
                (0.5, false),
            ],
            44_100,
        );
        let d = decode_and_plan(
            &path,
            Some("wav"),
            None,
            &CancellationToken::new(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(d.duration_ms, 7_500);
        assert_eq!(d.spans.len(), 2, "{:?}", d.spans);
        assert_eq!(d.spool.duration_ms(), 7_500);
    }

    #[tokio::test]
    async fn transcribe_resource_end_to_end_with_mock_asr_and_resume() {
        let (tmp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let path = tmp.path().join("lecture.wav");
        lecture_wav(
            &path,
            &[
                (0.5, false),
                (2.0, true),
                (1.5, false),
                (2.0, true),
                (1.5, false),
                (2.0, true),
                (0.5, false),
            ],
            16_000,
        );
        insert_media_file(&db, "file_lecture", &path);

        // 第一次：第 2 段（idx 1）ASR 400 → 段失败；其余成功
        let mut server = mockito::Server::new_async().await;
        let ok = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(200)
            .with_body(r#"{"text":"讲到这里"}"#)
            .expect(2)
            .create_async()
            .await;
        let bad = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(400)
            .with_body("bad audio")
            .expect(1)
            .create_async()
            .await;
        let _ = (&ok, &bad);
        let backend: Arc<dyn AsrBackend> = Arc::new(
            HttpAsrBackend::new(
                AsrEndpoint::new(
                    "siliconflow",
                    "SiliconFlow",
                    &format!("{}/v1", server.url()),
                    "sk-test",
                    "Qwen/Qwen3-ASR-1.7B",
                    None,
                )
                .unwrap(),
                None,
            )
            .unwrap(),
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = transcribe_resource(
            Arc::clone(&db),
            "file_lecture",
            Arc::clone(&backend),
            None,
            CancellationToken::new(),
            Some(tx),
        )
        .await
        .unwrap();
        assert_eq!(outcome.total_segments, 3);
        assert_eq!(outcome.done_segments + outcome.failed_segments, 3);
        assert_eq!(outcome.failed_segments, 1);
        let mut stages = Vec::new();
        while let Ok(u) = rx.try_recv() {
            stages.push(u.stage);
        }
        assert_eq!(stages.first(), Some(&MediaStage::Queued));
        assert!(stages.contains(&MediaStage::Decode));
        assert!(stages.contains(&MediaStage::Asr));

        let extracted: Option<String> = db
            .get_conn_safe()
            .unwrap()
            .query_row(
                "SELECT extracted_text FROM files WHERE id = 'file_lecture'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let extracted = extracted.unwrap();
        assert_eq!(extracted.lines().count(), 2, "{}", extracted);
        assert!(extracted.starts_with("[00:00] 讲到这里"), "{}", extracted);

        // 第二次（续做）：只重试失败的那一段
        let retry = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(200)
            .with_body(r#"{"text":"补上"}"#)
            .expect(1)
            .create_async()
            .await;
        let outcome = transcribe_resource(
            Arc::clone(&db),
            "file_lecture",
            backend,
            None,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(outcome.done_segments, 3);
        assert_eq!(outcome.failed_segments, 0);
        assert!(!outcome.rebuilt);
        retry.assert_async().await;
        let duration: i64 = db
            .get_conn_safe()
            .unwrap()
            .query_row(
                "SELECT duration_ms FROM media_progress WHERE resource_id = 'file_lecture'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(duration, 10_000);
    }

    #[tokio::test]
    async fn transcription_is_single_flight_and_cancellable_while_queued() {
        let guard = MEDIA_TRANSCRIPTION_LOCK.lock().await;
        let (tmp, db) = setup_migrated_test_db();
        let path = tmp.path().join("queued.wav");
        lecture_wav(&path, &[(1.0, true)], 16_000);
        insert_media_file(&db, "file_queued", &path);
        struct Never;
        #[async_trait::async_trait]
        impl AsrBackend for Never {
            async fn transcribe(
                &self,
                _wav: Vec<u8>,
            ) -> Result<AsrClipResult, crate::voice_input::AsrHttpError> {
                unreachable!()
            }
            fn model_label(&self) -> String {
                "never".into()
            }
        }
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let task = tokio::spawn(transcribe_resource(
            Arc::new(db),
            "file_queued",
            Arc::new(Never),
            None,
            cancel,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!task.is_finished(), "must wait for the global lock");
        c2.cancel();
        let err = task.await.unwrap().unwrap_err();
        assert!(matches!(err, MediaError::Cancelled));
        drop(guard);
    }
}
