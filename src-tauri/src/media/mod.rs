//! 音视频学习：媒体转写流水线（解码 → VAD → ASR → 字幕段）
//!
//! 设计契约：`docs/dev/media-learning/README.md`（§1.1–1.3、§4）。
//!
//! - [`decoder`]：symphonia 流式解码 → 单声道 16 kHz i16（全局时间网格对齐、坏包补静音）
//! - [`resample`]：无累计漂移的有理数网格重采样
//! - [`vad`]：能量 + 过零率 VAD 与段合并
//! - [`asr`]：每段 WAV → 受管 ASR（与语音输入同一配置/槽位），AIMD 自适应并发
//! - [`pipeline`]：续做 / 重建规则、全局单飞队列、转写文本落库
//! - [`subtitle`]：`.srt` / `.vtt` / B 站 BCC JSON 导入与 srt / vtt / txt 导出
//! - [`transcript`]：`[mm:ss] 文本` 行格式（extracted_text 与 resource_read 共用）
//! - [`commands`]：Tauri 命令（`media_transcribe_*` / `media_transcript_*` / `media_progress_*`）
//! - [`library`]：「音视频」子应用的资源库视图（`media_library_list` / `media_related_notes`）

pub mod asr;
pub mod commands;
pub mod decoder;
pub mod ledger;
pub mod library;
pub mod pipeline;
pub mod resample;
pub mod subtitle;
pub mod transcript;
pub mod vad;
pub mod wav;

/// 媒体流水线错误（`code()` 是前端可依赖的稳定错误码）
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    /// 容器 / 编码不受支持
    #[error("{0}")]
    Unsupported(String),
    /// 媒体中没有可解码的音轨
    #[error("{0}")]
    NoAudioTrack(String),
    /// 解码失败（文件损坏等）
    #[error("{0}")]
    Decode(String),
    /// 用户取消
    #[error("已取消")]
    Cancelled,
    /// 文件 / 临时文件 IO
    #[error("{0}")]
    Io(String),
    /// 数据库
    #[error("{0}")]
    Database(String),
    /// 资源不存在
    #[error("{0}")]
    NotFound(String),
    /// 参数不合法
    #[error("{0}")]
    InvalidInput(String),
    /// ASR 不可用 / 未配置 / 鉴权失败（整任务终止）
    #[error("{message}")]
    AsrFatal { code: String, message: String },
}

impl MediaError {
    pub fn code(&self) -> &str {
        match self {
            MediaError::Unsupported(_) => "media-unsupported",
            MediaError::NoAudioTrack(_) => "media-no-audio-track",
            MediaError::Decode(_) => "media-decode-failed",
            MediaError::Cancelled => "cancelled",
            MediaError::Io(_) => "io-failed",
            MediaError::Database(_) => "database-failed",
            MediaError::NotFound(_) => "not-found",
            MediaError::InvalidInput(_) => "invalid-input",
            MediaError::AsrFatal { code, .. } => code.as_str(),
        }
    }

    /// 序列化为 `{"code":..,"message":..}`（与 voice_input 错误格式一致）
    pub fn to_payload_string(&self) -> String {
        serde_json::json!({ "code": self.code(), "message": self.to_string() }).to_string()
    }
}

impl From<std::io::Error> for MediaError {
    fn from(e: std::io::Error) -> Self {
        MediaError::Io(e.to_string())
    }
}

impl From<crate::vfs::error::VfsError> for MediaError {
    fn from(e: crate::vfs::error::VfsError) -> Self {
        MediaError::Database(e.to_string())
    }
}

impl From<rusqlite::Error> for MediaError {
    fn from(e: rusqlite::Error) -> Self {
        MediaError::Database(e.to_string())
    }
}

/// 媒体种类（音频 / 视频）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Audio,
    Video,
}

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "ogg", "oga", "m4a", "m4b", "flac", "aac", "opus", "wma", "aiff", "aif", "caf",
    "weba",
];
pub(crate) const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "3gp", "ts", "mts", "m2ts",
];

fn extension_of(name: &str) -> Option<String> {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

/// 依据 MIME 或文件名判断是否为音视频（`application/octet-stream` 等走扩展名兜底）
pub fn media_kind(mime_type: &str, file_name: &str) -> Option<MediaKind> {
    let mime = mime_type.trim().to_ascii_lowercase();
    if mime.starts_with("audio/") {
        return Some(MediaKind::Audio);
    }
    if mime.starts_with("video/") {
        return Some(MediaKind::Video);
    }
    let ext = extension_of(file_name)?;
    if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Audio)
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// 音视频导入的大小上限（流式写入 blob，不整文件进内存）
pub const MAX_MEDIA_IMPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 导入后自动开始转写的时长上限（短音频保持原"导入即转写"体验）
pub const AUTO_TRANSCRIBE_MAX_DURATION_MS: i64 = 10 * 60 * 1000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_kind_by_mime_and_extension() {
        assert_eq!(media_kind("audio/mpeg", "x"), Some(MediaKind::Audio));
        assert_eq!(media_kind("video/mp4", "x"), Some(MediaKind::Video));
        assert_eq!(
            media_kind("application/octet-stream", "lecture.MKV"),
            Some(MediaKind::Video)
        );
        assert_eq!(media_kind("", "talk.m4a"), Some(MediaKind::Audio));
        assert_eq!(media_kind("application/pdf", "a.pdf"), None);
    }

    #[test]
    fn error_payload_has_stable_code() {
        let e = MediaError::Unsupported("x".into());
        let v: serde_json::Value = serde_json::from_str(&e.to_payload_string()).unwrap();
        assert_eq!(v["code"], "media-unsupported");
        let e = MediaError::AsrFatal {
            code: "auth-failed".into(),
            message: "bad key".into(),
        };
        assert_eq!(e.code(), "auth-failed");
    }
}
