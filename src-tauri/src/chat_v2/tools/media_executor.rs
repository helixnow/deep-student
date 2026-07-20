//! Managed attachment media transcription tools.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::Instant;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    artifact_root, normalize_runtime_relative_path, revalidate_runtime_root, runtime_root_by_id,
};
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::voice_input::{
    voice_input_asr_capability, voice_input_transcribe_with_state, VoiceInputAsrCapability,
    VoiceInputTranscribeRequest,
};

const MAX_AUDIO_BYTES: u64 = 25 * 1024 * 1024;

pub struct MediaToolExecutor;

impl MediaToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn source_locator(args: &Value) -> Result<(&str, &str, Option<&str>), String> {
        let source = args.get("source").unwrap_or(args);
        let locator = source
            .get("object_handle")
            .or_else(|| source.get("objectHandle"))
            .and_then(|handle| handle.get("locator"))
            .unwrap_or(source);
        let root_id = locator
            .get("root_id")
            .or_else(|| locator.get("rootId"))
            .and_then(Value::as_str)
            .ok_or("source must include an object handle locator rootId")?;
        let relative_path = locator
            .get("relative_path")
            .or_else(|| locator.get("relativePath"))
            .and_then(Value::as_str)
            .ok_or("source must include an object handle locator relativePath")?;
        let derived_from = source
            .get("object_handle")
            .or_else(|| source.get("objectHandle"))
            .and_then(|handle| handle.get("handleId"))
            .and_then(Value::as_str);
        Ok((root_id, relative_path, derived_from))
    }

    /// ★ VFS 附件寻址：source（或顶层参数）中的 resourceId / resource_id
    ///（会话附件与资源库文件的 files.id，如 file_xxx / att_xxx）
    fn vfs_resource_locator(args: &Value) -> Option<String> {
        let source = args.get("source").unwrap_or(args);
        source
            .get("resource_id")
            .or_else(|| source.get("resourceId"))
            .or_else(|| args.get("resource_id"))
            .or_else(|| args.get("resourceId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// 从 VFS 读取附件原始字节（inline resources.data / external blob 兜底），
    /// 并保持与 runtime 路径一致的大小限额。
    fn read_vfs_attachment_bytes(
        ctx: &ExecutionContext,
        resource_id: &str,
    ) -> Result<Vec<u8>, String> {
        use crate::vfs::repos::attachment_repo::VfsAttachmentContentSource;
        use crate::vfs::repos::VfsAttachmentRepo;

        let vfs_db = ctx
            .vfs_db
            .clone()
            .ok_or("MEDIA_SOURCE_NOT_FOUND: VFS database unavailable")?;
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?;
        let source =
            VfsAttachmentRepo::get_content_source_with_conn(&conn, vfs_db.blobs_dir(), resource_id)
                .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?
                .ok_or_else(|| {
                    format!("MEDIA_SOURCE_NOT_FOUND: attachment {resource_id} not found in VFS")
                })?;

        let bytes = match source {
            VfsAttachmentContentSource::File(path) => {
                let metadata = fs::metadata(&path)
                    .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?;
                if metadata.len() > MAX_AUDIO_BYTES {
                    return Err(format!(
                        "MEDIA_TOO_LARGE: {} bytes exceeds {} byte managed ASR limit",
                        metadata.len(),
                        MAX_AUDIO_BYTES
                    ));
                }
                fs::read(&path).map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?
            }
            VfsAttachmentContentSource::Base64(base64_content) => {
                let payload = if base64_content.starts_with("data:") {
                    base64_content
                        .split_once(',')
                        .map(|(_, right)| right.to_string())
                        .ok_or("MEDIA_SOURCE_READ_FAILED: invalid data URL")?
                } else {
                    base64_content
                };
                // 解码前按编码长度估算限额，避免超限内容先占用峰值内存
                if payload.len() as u64 / 4 * 3 > MAX_AUDIO_BYTES {
                    return Err(format!(
                        "MEDIA_TOO_LARGE: decoded audio may exceed {} byte managed ASR limit",
                        MAX_AUDIO_BYTES
                    ));
                }
                STANDARD
                    .decode(payload.trim())
                    .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?
            }
        };
        if bytes.len() as u64 > MAX_AUDIO_BYTES {
            return Err(format!(
                "MEDIA_TOO_LARGE: {} bytes exceeds {} byte managed ASR limit",
                bytes.len(),
                MAX_AUDIO_BYTES
            ));
        }
        Ok(bytes)
    }

    fn media_signature(bytes: &[u8]) -> Result<&'static str, String> {
        if bytes.starts_with(b"ID3")
            || bytes.starts_with(b"\xff\xfb")
            || bytes.starts_with(b"\xff\xf3")
            || bytes.starts_with(b"\xff\xf2")
        {
            Ok("audio/mpeg")
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
            Ok("audio/wav")
        } else if bytes.starts_with(b"OggS") {
            Ok("audio/ogg")
        } else if bytes.starts_with(b"fLaC") {
            Ok("audio/flac")
        } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
            // ★ ISO BMFF：仅接受签名确认为纯音频的 M4A/M4B/M4P 品牌容器；
            // 其余 ftyp 品牌（mp42/isom/qt 等）仍按视频容器 fail-closed
            let brand = &bytes[8..12];
            if brand.starts_with(b"M4A") || brand.starts_with(b"M4B") || brand.starts_with(b"M4P")
            {
                Ok("audio/mp4")
            } else {
                Err(
                    "MEDIA_VIDEO_EXTRACTION_UNSUPPORTED: ISO BMFF containers other than M4A/M4B/M4P are rejected because no application-managed parser has proven they are audio-only"
                        .into(),
                )
            }
        } else if bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xf6) == 0xf0 {
            // ★ ADTS AAC 帧头（0xFFF1 / 0xFFF9 等）
            Ok("audio/aac")
        } else if bytes.starts_with(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11") {
            // ★ WMA（ASF 容器）：明确不支持而非笼统 unsupported
            Err(
                "MEDIA_UNSUPPORTED_FORMAT: WMA (ASF container) is not supported by the managed ASR runtime; convert to MP3/WAV/M4A first"
                    .into(),
            )
        } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
            Err(
                "MEDIA_VIDEO_EXTRACTION_UNSUPPORTED: EBML (WebM/MKV) containers are rejected because no application-managed parser has proven they are audio-only"
                    .into(),
            )
        } else {
            Err(
                "MEDIA_UNSUPPORTED_FORMAT: supported audio signatures are MP3, WAV, OGG, FLAC, M4A and ADTS AAC"
                    .into(),
            )
        }
    }

    fn capability(asr: Option<VoiceInputAsrCapability>) -> Value {
        let available = asr.is_some_and(|value| value.configured);
        let unavailable_reason_code = if available {
            Value::Null
        } else if asr.is_some() {
            Value::String("ASR_NOT_CONFIGURED".into())
        } else {
            Value::String("APP_STATE_UNAVAILABLE".into())
        };
        let provider_id = asr.map(|value| value.provider_id);
        let provider_name = asr.map(|value| value.provider_name);
        let model = asr.map(|value| value.model);
        json!({
            "ok": true,
            "capability": "managed_audio_transcription",
            "available": available,
            "runtime": "existing_voice_input_asr",
            "provider": {
                "id": provider_id,
                "name": provider_name,
                "model": model,
                "externalProcessing": true,
            },
            "supportedAudio": [
                "audio/mpeg",
                "audio/wav",
                "audio/ogg",
                "audio/flac",
                "audio/mp4",
                "audio/aac"
            ],
            "unavailableReasonCode": unavailable_reason_code,
            "videoAudioExtraction": {
                "available": false,
                "reasonCode": "SAFE_DEPENDENCY_UNAVAILABLE",
                "reason": "未发现应用管理的安全视频音轨提取依赖；不会安装 ffmpeg 或修改系统环境"
            },
            "configuration": {
                "configured": available,
                "requirement": "ASR execution requires the existing SiliconFlow voice-input API key"
            },
        })
    }

    async fn execute_transcribe(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let app = ctx.window_ref().app_handle();
        let state = app
            .try_state::<AppState>()
            .ok_or("MEDIA_CAPABILITY_UNAVAILABLE: AppState is not registered")?;
        let asr = voice_input_asr_capability(&state);
        if !asr.configured {
            return Err(
                "MEDIA_ASR_UNAVAILABLE: configure the existing SiliconFlow voice-input API key in Settings"
                    .into(),
            );
        }
        // ★ 双寻址：优先 VFS resourceId（会话附件/资源库文件），否则走 runtime root 定位
        let (bytes, source_uri, derived_from_ids): (Vec<u8>, String, Vec<String>) =
            if let Some(resource_id) = Self::vfs_resource_locator(args) {
                let bytes = Self::read_vfs_attachment_bytes(ctx, &resource_id)?;
                let source_uri = format!("vfs://files/{resource_id}");
                (bytes, source_uri, vec![resource_id])
            } else {
                let (root_id, relative_raw, derived_from) = Self::source_locator(args)?;
                let relative = normalize_runtime_relative_path(Some(relative_raw))?;
                if relative.as_os_str().is_empty() {
                    return Err("MEDIA_INVALID_SOURCE: locator must point to a file".into());
                }
                let root = runtime_root_by_id(
                    app,
                    &state.database,
                    &ctx.session_id,
                    None,
                    Some(root_id),
                    false,
                )?;
                let root_canon = revalidate_runtime_root(&state.database, &root)?;
                let target = root_canon.join(relative);
                let target_canon = target
                    .canonicalize()
                    .map_err(|error| format!("MEDIA_SOURCE_NOT_FOUND: {error}"))?;
                if !target_canon.starts_with(&root_canon) || !target_canon.is_file() {
                    return Err(
                        "MEDIA_SOURCE_UNAUTHORIZED: source escaped its runtime root".into()
                    );
                }
                let metadata = target_canon
                    .metadata()
                    .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?;
                if metadata.len() > MAX_AUDIO_BYTES {
                    return Err(format!(
                        "MEDIA_TOO_LARGE: {} bytes exceeds {} byte managed ASR limit",
                        metadata.len(),
                        MAX_AUDIO_BYTES
                    ));
                }
                let bytes = fs::read(&target_canon)
                    .map_err(|error| format!("MEDIA_SOURCE_READ_FAILED: {error}"))?;
                let source_uri = format!("runtime://{root_id}/{relative_raw}");
                (
                    bytes,
                    source_uri,
                    derived_from.map(str::to_string).into_iter().collect(),
                )
            };
        let mime_type = Self::media_signature(&bytes)?;
        let request = VoiceInputTranscribeRequest {
            audio_base64: STANDARD.encode(&bytes),
            mime_type: mime_type.into(),
            provider_id: None,
            model: None,
            config_id: None,
            language: args
                .get("language")
                .and_then(Value::as_str)
                .map(str::to_string),
            prompt: args
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            duration_ms: None,
        };
        let transcript = voice_input_transcribe_with_state(request, &state)
            .await
            .map_err(|error| {
                format!(
                    "MEDIA_ASR_UNAVAILABLE: {}; configure the existing voice-input ASR capability in Settings. No dependency installation or environment mutation was attempted",
                    error.message
                )
            })?;

        let source_hash = hex::encode(Sha256::digest(&bytes));
        let body = format!(
            "# Transcript\n\n{}\n\n---\nSource SHA-256: `{}`\nProvider: `{}`\nModel: `{}`\n",
            transcript.text, source_hash, transcript.provider_id, transcript.model
        );
        let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
        let artifact = artifact_root(app, &ctx.session_id, true)?;
        let directory = artifact.path.join("media-transcripts");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("MEDIA_ARTIFACT_WRITE_FAILED: {error}"))?;
        let display_name = format!("transcript-{}.md", &body_hash[..12]);
        let target = directory.join(&display_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => file
                .write_all(body.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("MEDIA_ARTIFACT_WRITE_FAILED: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("MEDIA_ARTIFACT_WRITE_FAILED: {error}")),
        }
        let relative_path = format!("media-transcripts/{display_name}");
        let mut handle = TaskObjectHandle::new(
            format!("media-transcript:{body_hash}"),
            TaskObjectKind::Artifact,
            display_name,
            ObjectProvenance {
                source: "managed_asr".into(),
                source_uri: Some(source_uri),
                server: None,
                tool: Some("media_transcribe".into()),
                derived_from: derived_from_ids,
                observed_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        handle.media_type = Some("text/markdown".into());
        handle.size_bytes = Some(body.len() as u64);
        handle.sha256 = Some(body_hash);
        handle.locator = Some(ManagedLocator::new("artifacts", &relative_path)?);
        handle.capabilities = ObjectCapabilities {
            readable: true,
            materializable: true,
            writable: false,
            shareable: false,
            sendable: true,
            deletable: true,
        };
        handle.validate()?;
        Ok(json!({
            "ok": true,
            "transcript": transcript.text,
            "language": transcript.language,
            "provider": transcript.provider_id,
            "model": transcript.model,
            "sourceSha256": source_hash,
            "rootId": "artifacts",
            "relativePath": relative_path,
            "objectHandle": handle,
        }))
    }
}

impl Default for MediaToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for MediaToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            "media_capabilities" | "media_transcribe"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match strip_tool_namespace(&call.name) {
            "media_capabilities" => {
                let asr = ctx
                    .window_ref()
                    .try_state::<AppState>()
                    .map(|state| voice_input_asr_capability(&state));
                Ok(Self::capability(asr))
            }
            "media_transcribe" => self.execute_transcribe(&call.arguments, ctx).await,
            _ => Err("Unknown media tool".into()),
        };
        let duration = started.elapsed().as_millis() as u64;
        let info = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&info) {
            log::warn!("[MediaToolExecutor] Failed to save tool block: {error}");
        }
        Ok(info)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        if strip_tool_namespace(tool_name) == "media_transcribe" {
            ToolSensitivity::Medium
        } else {
            ToolSensitivity::Low
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if strip_tool_namespace(tool_name) == "media_capabilities" {
            ToolConcurrency::ReadOnly
        } else {
            ToolConcurrency::SafeParallel
        }
    }

    fn name(&self) -> &'static str {
        "MediaToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_media_contract_tools() {
        let executor = MediaToolExecutor::new();
        assert!(executor.can_handle("builtin-media_capabilities"));
        assert!(executor.can_handle("builtin-media_transcribe"));
    }

    #[test]
    fn video_capability_fails_closed_without_extractor() {
        let capability = MediaToolExecutor::capability(None);
        assert_eq!(capability["videoAudioExtraction"]["available"], false);
        assert_eq!(
            capability["videoAudioExtraction"]["reasonCode"],
            "SAFE_DEPENDENCY_UNAVAILABLE"
        );
    }

    #[test]
    fn transcription_is_medium_sensitivity() {
        let executor = MediaToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-media_transcribe"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-media_capabilities"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn only_proven_audio_signatures_are_accepted() {
        assert_eq!(
            MediaToolExecutor::media_signature(b"ID3audio"),
            Ok("audio/mpeg")
        );
        assert_eq!(
            MediaToolExecutor::media_signature(b"OggSaudio"),
            Ok("audio/ogg")
        );
        assert!(MediaToolExecutor::media_signature(b"\x1a\x45\xdf\xa3webm")
            .unwrap_err()
            .contains("MEDIA_VIDEO_EXTRACTION_UNSUPPORTED"));
        // ★ M4A（MP4 audio 品牌）与 ADTS AAC 现在被接受
        assert_eq!(
            MediaToolExecutor::media_signature(b"\0\0\0\x18ftypM4A "),
            Ok("audio/mp4")
        );
        assert_eq!(
            MediaToolExecutor::media_signature(b"\xff\xf1\x50\x80aac-frame"),
            Ok("audio/aac")
        );
        // 非音频品牌的 MP4 容器仍 fail-closed
        assert!(MediaToolExecutor::media_signature(b"\0\0\0\x18ftypmp42")
            .unwrap_err()
            .contains("MEDIA_VIDEO_EXTRACTION_UNSUPPORTED"));
        // WMA 返回明确的不支持原因
        assert!(MediaToolExecutor::media_signature(
            b"\x30\x26\xb2\x75\x8e\x66\xcf\x11wma"
        )
        .unwrap_err()
        .contains("WMA"));
    }

    #[test]
    fn unavailable_capability_is_not_advertised_as_ready() {
        let capability = MediaToolExecutor::capability(None);
        assert_eq!(capability["available"], false);
        assert_eq!(capability["unavailableReasonCode"], "APP_STATE_UNAVAILABLE");
        assert_eq!(capability["supportedAudio"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn capability_reflects_resolved_asr_configuration() {
        let asr = VoiceInputAsrCapability {
            provider_id: "siliconflow",
            provider_name: "SiliconFlow",
            model: "TeleAI/TeleSpeechASR",
            configured: false,
        };
        let unavailable = MediaToolExecutor::capability(Some(asr));
        assert_eq!(unavailable["available"], false);
        assert_eq!(unavailable["unavailableReasonCode"], "ASR_NOT_CONFIGURED");
        assert_eq!(unavailable["provider"]["name"], "SiliconFlow");

        let available = MediaToolExecutor::capability(Some(VoiceInputAsrCapability {
            configured: true,
            ..asr
        }));
        assert_eq!(available["available"], true);
        assert_eq!(available["configuration"]["configured"], true);
        assert!(available["unavailableReasonCode"].is_null());
    }
}
