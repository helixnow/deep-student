//! media 对 vfs 的回调实现：媒体转写 + 资源创建后的自动转写。
//!
//! vfs 只定义 trait；真正的 ASR 后端构建、进度转发和 auto-transcribe 逻辑在这里，
//! 由 `extensions::register_extensions()` 在启动时注册。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Once;

use crate::media::asr::{AsrBackend, HttpAsrBackend, UnavailableBackend};
use crate::media::pipeline::{transcribe_resource, MediaProgressUpdate, TranscriptionOutcome};
use crate::media::MediaError;
use crate::vfs::hooks::{
    MediaTranscriber, MediaTranscriptionFailure, MediaTranscriptionProgress,
    MediaTranscriptionRequest, MediaTranscriptionSummary, ResourceCreatedHook,
};

pub struct VfsMediaTranscriber;

impl MediaTranscriber for VfsMediaTranscriber {
    fn transcribe(
        &self,
        req: MediaTranscriptionRequest,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<MediaTranscriptionSummary, MediaTranscriptionFailure>>
                + Send,
        >,
    > {
        Box::pin(async move {
            let MediaTranscriptionRequest {
                vfs_db,
                llm_manager,
                settings_db,
                file_id,
                temp_dir,
                cancel,
                imported,
                progress,
            } = req;

            let backend: Result<Arc<dyn AsrBackend>, MediaError> = if imported {
                Ok(Arc::new(UnavailableBackend))
            } else {
                build_backend(&llm_manager, &settings_db).await
            };
            let backend = match backend {
                Ok(backend) => backend,
                Err(error) => return Err(failure(error)),
            };

            // 与旧顺序一致：后端构建成功后才清理 stale temp，再开始转写。
            sweep_stale_media_temp(&temp_dir);

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<MediaProgressUpdate>();
            let fut = transcribe_resource(
                Arc::clone(&vfs_db),
                &file_id,
                backend,
                Some(temp_dir),
                cancel.clone(),
                Some(tx),
            );
            tokio::pin!(fut);
            let result = loop {
                tokio::select! {
                    res = &mut fut => break res,
                    Some(update) = rx.recv() => {
                        let _ = progress.send(map_progress(update));
                    }
                }
            };
            while let Ok(update) = rx.try_recv() {
                let _ = progress.send(map_progress(update));
            }
            match result {
                Ok(outcome) => Ok(summary(outcome)),
                Err(error) => Err(failure(error)),
            }
        })
    }
}

/// 清理 24 小时前的 PCM spool 临时文件（原 vfs/pdf_processing_service 的实现）。
fn sweep_stale_media_temp(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    for entry in entries.flatten() {
        let path = entry.path();
        let is_spool = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("media-pcm-"))
            .unwrap_or(false);
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if is_spool && stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn map_progress(update: MediaProgressUpdate) -> MediaTranscriptionProgress {
    MediaTranscriptionProgress {
        stage: update.stage.as_str().to_string(),
        percent: update.percent,
        completed_segments: update.completed_segments,
        total_segments: update.total_segments,
    }
}

fn summary(outcome: TranscriptionOutcome) -> MediaTranscriptionSummary {
    MediaTranscriptionSummary {
        transcript_chars: outcome.transcript_chars,
        done_segments: outcome.done_segments,
        total_segments: outcome.total_segments,
        failed_segments: outcome.failed_segments,
    }
}

fn failure(error: MediaError) -> MediaTranscriptionFailure {
    if matches!(&error, MediaError::Cancelled) {
        return MediaTranscriptionFailure {
            cancelled: true,
            display: error.to_string(),
            payload: String::new(),
        };
    }
    let display = error.to_string();
    let payload = error.to_payload_string();
    MediaTranscriptionFailure {
        cancelled: false,
        display,
        payload,
    }
}

async fn build_backend(
    llm_manager: &Arc<crate::llm_manager::LLMManager>,
    settings_db: &Arc<crate::database::Database>,
) -> Result<Arc<dyn AsrBackend>, MediaError> {
    let endpoint = crate::voice_input::resolve_asr_endpoint(llm_manager, settings_db)
        .await
        .map_err(|error| MediaError::AsrFatal {
            code: error.code.to_string(),
            message: error.message,
        })?;
    let backend = HttpAsrBackend::new(endpoint, None)?;
    Ok(Arc::new(backend))
}

pub struct MediaResourceCreatedHook;

impl ResourceCreatedHook for MediaResourceCreatedHook {
    fn on_resource_created(&self, app: &tauri::AppHandle, resource_id: &str) {
        crate::media::commands::spawn_auto_transcribe_if_short_audio(app, resource_id.to_string());
    }
}

/// 由 `extensions::register_extensions()` 在启动时调用；幂等。
pub fn install_vfs_hooks() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        crate::vfs::hooks::register_media_transcriber(Arc::new(VfsMediaTranscriber));
        crate::vfs::hooks::register_resource_created_hook(Arc::new(MediaResourceCreatedHook));
    });
}
