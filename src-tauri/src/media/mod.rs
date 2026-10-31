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
//! - [`bilibili`]：B 站链接 → 字幕（新建链接条目 / 给已有媒体挂字幕，`media_bilibili_*`）

pub mod asr;
pub mod bilibili;
pub mod bilibili_auth;
pub mod bilibili_lifecycle;
pub mod bilibili_stream;
pub mod bilibili_transport;
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
    /// 链接条目没有本地音视频，不能解码 / 转写
    #[error("{0}")]
    LinkOnly(String),
    /// B 站接口：链接无效 / 不支持 / 视频不可用 / 无字幕 / 请求失败（code 以 `bilibili-` 开头）
    #[error("{message}")]
    Bilibili { code: String, message: String },
    #[error("{0}")]
    Transport(Box<bilibili_transport::BiliError>),
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
            MediaError::LinkOnly(_) => "media-link-only",
            MediaError::Bilibili { code, .. } => code.as_str(),
            MediaError::Transport(error) => &error.code,
        }
    }

    /// 序列化为 `{"code":..,"message":..}`（与 voice_input 错误格式一致）
    pub fn to_payload_string(&self) -> String {
        if let Self::Transport(error) = self {
            return serde_json::to_string(error).unwrap_or_default();
        }
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

// 媒体种类判定、扩展名表、B 站链接条目常量与导入上限已下沉到
// `dstu_core::media_types`（存储层也要用），这里按原路径重导出。
// 链接条目内容见 [`bilibili::BiliLinkDescriptor`]。
pub use dstu_core::media_types::{
    is_link_item, media_kind, MediaKind, BILIBILI_LINK_EXTENSION, BILIBILI_LINK_MIME,
    MAX_MEDIA_IMPORT_BYTES,
};
pub(crate) use dstu_core::media_types::{AUDIO_EXTENSIONS, VIDEO_EXTENSIONS};

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
    fn bilibili_link_items_are_video_without_local_media() {
        assert!(is_link_item("video/x-bilibili", "课.bilibili"));
        assert!(is_link_item("application/octet-stream", "课.BILIBILI"));
        assert!(!is_link_item("video/mp4", "课.mp4"));
        assert_eq!(
            media_kind("application/octet-stream", "课.bilibili"),
            Some(MediaKind::Video)
        );
        assert_eq!(MediaError::LinkOnly("x".into()).code(), "media-link-only");
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
