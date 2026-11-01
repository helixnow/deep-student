//! 媒体与附件的纯数据定义：音视频种类判定、扩展名表与大小上限。
//!
//! 由 app 的 `media` 与 `vfs::repos::attachment_repo` 按原路径重导出；存储层
//! （staged_upload / file_manager）直接引用这里，不依赖上层业务模块。

/// 媒体种类（音频 / 视频）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Audio,
    Video,
}

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "ogg", "oga", "m4a", "m4b", "flac", "aac", "opus", "wma", "aiff", "aif", "caf",
    "weba",
];
pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "3gp", "ts", "mts", "m2ts",
];

fn extension_of(name: &str) -> Option<String> {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

/// B 站链接条目的 MIME：内容是一小段描述 JSON（见 app `media::bilibili::BiliLinkDescriptor`），
/// 按视频归类进音视频库，但没有本地音视频可解码
pub const BILIBILI_LINK_MIME: &str = "video/x-bilibili";
pub const BILIBILI_LINK_EXTENSION: &str = "bilibili";

/// 是否为链接条目（MIME 或扩展名任一命中）
pub fn is_link_item(mime_type: &str, file_name: &str) -> bool {
    mime_type.trim().eq_ignore_ascii_case(BILIBILI_LINK_MIME)
        || extension_of(file_name).as_deref() == Some(BILIBILI_LINK_EXTENSION)
}

/// 依据 MIME 或文件名判断是否为音视频（`application/octet-stream` 等走扩展名兜底）
pub fn media_kind(mime_type: &str, file_name: &str) -> Option<MediaKind> {
    if is_link_item(mime_type, file_name) {
        return Some(MediaKind::Video);
    }
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

/// 附件图片上传大小上限
/// ★ 2026-06-12（审阅问题 M8）：图片上限 10MB→50MB。现代手机原图/HEIC 转
/// JPEG 普遍超过 10MB，旧限制导致常见照片无法导入。
/// ★ #62/ATT-09：全局附件上限的唯一权威来源（app 中以
/// `vfs::repos::attachment_repo::MAX_IMAGE_BYTES` 重导出），其他模块的
/// 校验与错误提示应引用这里，禁止再散落硬编码。
pub const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
