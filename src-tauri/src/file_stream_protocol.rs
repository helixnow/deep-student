// 通用文件流式加载协议
// 提供 filestream:// 自定义协议，支持 HTTP Range Request，
// 用于媒体（音频/视频/图片）与通用 VFS blob 的流式加载。
//
// 安全模型与 pdf_protocol.rs 完全对齐：
// - 目录白名单（复用 pdf_protocol::resolve_allowed_dirs：应用数据目录 + VFS blobs 目录）
// - 扩展名白名单（媒体扩展名 + pdf 兜底 + bin；VFS blobs 目录内放宽为任意扩展名，目录本身即授权边界）
// - canonicalize + 打开后句柄复核防 TOCTOU
// - 拒绝白名单根目录之下的隐藏路径段
// - Range/206/HEAD/CORS/大小预算与 pdfstream 同值
//
// pdf_protocol 中仅 resolve_allowed_dirs / handle_asset_protocol / cors_origin_for_request
// 为 pub，其余辅助函数（Range 解析、CORS 构造、预算、句柄复核）为私有，
// 按任务约定在本文件内复制实现，不修改 pdf_protocol.rs。

use log::{info, warn};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const DEFAULT_CORS_ORIGIN: &str = "tauri://localhost";

/// `tauri::http::Response<Vec<u8>>` 必须在返回前完整持有响应体，无法真正流式发送。
/// 与 pdfstream 同值：单响应 200MB 硬上限 + 全局在途 400MB 预算，
/// 避免恶意或异常超大本地文件触发无界分配。
const FILE_STREAM_MAX_RESPONSE_BYTES: u64 = 200 * 1024 * 1024;
const FILE_STREAM_MAX_IN_FLIGHT_BYTES: u64 = 400 * 1024 * 1024;

static FILE_STREAM_IN_FLIGHT_BYTES: AtomicU64 = AtomicU64::new(0);

/// 允许的媒体扩展名白名单（小写；bin 为通用 blob 兜底）。
/// VFS blobs 目录内不受此白名单约束（见 `extension_permitted`）。
const ALLOWED_EXTENSIONS: &[&str] = &[
    // 音频
    "mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus", "weba", "aiff", "aif", "caf",
    // 视频
    "mp4", "webm", "mov", "m4v", "ogv", "mpg", "mpeg", "3gp", "mkv", "avi",
    // 图片
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic",
    // 文档兜底
    "pdf",
    // 通用 blob
    "bin",
];

#[derive(Debug)]
struct FileStreamResponseBudget {
    bytes: u64,
}

impl Drop for FileStreamResponseBudget {
    fn drop(&mut self) {
        FILE_STREAM_IN_FLIGHT_BYTES.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

fn reserve_response_budget(bytes: u64) -> Option<Arc<FileStreamResponseBudget>> {
    loop {
        let current = FILE_STREAM_IN_FLIGHT_BYTES.load(Ordering::Acquire);
        let next = current.checked_add(bytes)?;
        if next > FILE_STREAM_MAX_IN_FLIGHT_BYTES {
            return None;
        }
        if FILE_STREAM_IN_FLIGHT_BYTES
            .compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return Some(Arc::new(FileStreamResponseBudget { bytes }));
        }
    }
}

fn checked_response_len(len: u64) -> Option<usize> {
    if len > FILE_STREAM_MAX_RESPONSE_BYTES || len > usize::MAX as u64 {
        None
    } else {
        Some(len as usize)
    }
}

#[cfg(target_os = "linux")]
fn opened_file_path(file: &File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(target_os = "macos")]
fn opened_file_path(file: &File) -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;

    let mut buffer = [0i8; libc::PATH_MAX as usize];
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        return None;
    }
    let path = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Some(PathBuf::from(path.to_string_lossy().into_owned()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn opened_file_path(_file: &File) -> Option<PathBuf> {
    None
}

fn opened_file_matches_authorized_path(
    file: &File,
    expected_path: &Path,
    allowed_dirs: &[PathBuf],
) -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let Some(actual_path) =
            opened_file_path(file).and_then(|path| std::fs::canonicalize(path).ok())
        else {
            return false;
        };
        actual_path == expected_path && allowed_dirs.iter().any(|dir| actual_path.starts_with(dir))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // 其他平台至少在 open 后重新解析一次路径并拒绝最终组件 symlink。
        let Ok(post_open_path) = std::fs::canonicalize(expected_path) else {
            return false;
        };
        let final_component_is_symlink = std::fs::symlink_metadata(expected_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true);
        !final_component_is_symlink
            && post_open_path == expected_path
            && allowed_dirs
                .iter()
                .any(|dir| post_open_path.starts_with(dir))
    }
}

/// 兼容桌面与移动端 WebView 来源（与 pdf_protocol::is_allowed_origin 同规则）：
/// localhost 精确匹配 host（允许带端口），避免 `http://localhost.evil.com` 前缀域名绕过。
fn is_allowed_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin == "http://localhost"
        || origin == "https://localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
}

fn resolve_cors_origin(request: &tauri::http::Request<Vec<u8>>) -> String {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(DEFAULT_CORS_ORIGIN);

    if is_allowed_origin(origin) {
        origin.to_string()
    } else {
        DEFAULT_CORS_ORIGIN.to_string()
    }
}

fn with_cors_headers(
    mut builder: tauri::http::response::Builder,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::response::Builder {
    let origin = resolve_cors_origin(request);
    builder = builder
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range",
        )
        .header("Vary", "Origin");
    builder
}

pub fn cors_origin_for_request(request: &tauri::http::Request<Vec<u8>>) -> String {
    resolve_cors_origin(request)
}

/// 解析 VFS blobs 目录（扩展名放宽的授权边界）。
/// 目录白名单本身复用 `crate::pdf_protocol::resolve_allowed_dirs`（已含 blobs 目录）。
pub fn resolve_blob_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;

    let mut dirs = Vec::new();
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if let Some(vfs_db) = state.vfs_db.as_ref() {
            if let Ok(blobs_dir) = std::fs::canonicalize(vfs_db.blobs_dir()) {
                dirs.push(blobs_dir);
            }
        }
    }
    dirs
}

fn is_allowed_media_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&lower.as_str())
}

/// 扩展名判定：
/// - blobs 目录内：任意扩展名（含无扩展名），目录本身即授权边界；
/// - 其余白名单目录：必须命中媒体扩展名白名单（大小写不敏感）。
fn extension_permitted(canonical_path: &Path, blob_dirs: &[PathBuf]) -> bool {
    if blob_dirs.iter().any(|dir| canonical_path.starts_with(dir)) {
        return true;
    }
    canonical_path
        .extension()
        .and_then(|s| s.to_str())
        .map(is_allowed_media_extension)
        .unwrap_or(false)
}

/// 拒绝白名单根目录之下的隐藏路径段（点号开头的组件）。
/// 只检查相对于最长匹配白名单目录的相对部分——白名单根本身可能位于
/// 隐藏目录内（如 Linux 下 ~/.local/share），不应因此误伤。
fn has_hidden_segment_within(canonical_path: &Path, allowed_dirs: &[PathBuf]) -> bool {
    let Some(base) = allowed_dirs
        .iter()
        .filter(|dir| canonical_path.starts_with(dir))
        .max_by_key(|dir| dir.components().count())
    else {
        // 不在白名单内：调用方应已拒绝，此处保守视为隐藏
        return true;
    };
    let Ok(relative) = canonical_path.strip_prefix(base) else {
        return true;
    };
    relative.components().any(|c| {
        matches!(
            c,
            std::path::Component::Normal(name)
                if name.to_string_lossy().starts_with('.')
        )
    })
}

/// 根据文件扩展名返回 MIME 类型（大小写不敏感）。
/// 无扩展名或未知扩展名（含 bin）返回 application/octet-stream，
/// 前端可通过 `?mime=` 查询参数覆盖（见 `mime_override_from_query`）。
fn get_mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        // 音频
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("aac") => "audio/aac",
        Some("weba") => "audio/webm",
        Some("aiff") | Some("aif") => "audio/aiff",
        Some("caf") => "audio/x-caf",
        // 视频
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("ogv") => "video/ogg",
        Some("mpg") | Some("mpeg") => "video/mpeg",
        Some("3gp") => "video/3gpp",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        // 图片
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("heic") => "image/heic",
        // 文档兜底
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 校验并规范化 `?mime=` 覆盖值：
/// - 百分号解码后仅允许 audio/*、video/*、image/* 前缀（防任意 Content-Type 注入）；
/// - 子类型仅允许 ASCII 字母数字与 `.+-`（阻断 CR/LF/分号等头注入字符）。
fn sanitize_mime_override(raw: &str) -> Option<String> {
    let decoded = urlencoding::decode(raw).ok()?;
    let mime = decoded.trim().to_ascii_lowercase();
    let subtype = mime
        .strip_prefix("audio/")
        .or_else(|| mime.strip_prefix("video/"))
        .or_else(|| mime.strip_prefix("image/"))?;
    if subtype.is_empty() || subtype.len() > 64 {
        return None;
    }
    if !subtype
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
    {
        return None;
    }
    Some(mime)
}

/// 从 URI query 中提取合法的 mime 覆盖值（非法值静默忽略，回退扩展名推断）。
fn mime_override_from_query(query: Option<&str>) -> Option<String> {
    for pair in query?.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next().unwrap_or("") != "mime" {
            continue;
        }
        return sanitize_mime_override(parts.next().unwrap_or(""));
    }
    None
}

/// 处理 filestream:// 协议请求
///
/// 支持功能：
/// - HTTP Range Request（音视频 seek / 分段加载）
/// - Content-Type 按扩展名识别，支持 `?mime=` 覆盖（仅 audio/video/image 前缀）
/// - 跨域支持（CORS）与 HEAD 探测
/// - 目录白名单 + 扩展名白名单（blobs 目录内放宽）+ TOCTOU 句柄复核
pub fn handle_asset_protocol(
    request: &tauri::http::Request<Vec<u8>>,
    allowed_dirs: &[PathBuf],
    blob_dirs: &[PathBuf],
) -> Result<tauri::http::Response<Vec<u8>>, Box<dyn std::error::Error>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return Ok(
            with_cors_headers(tauri::http::Response::builder().status(204), request)
                .body(Vec::new())?,
        );
    }

    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return Ok(with_cors_headers(
            tauri::http::Response::builder()
                .status(405)
                .header("Allow", "GET, HEAD, OPTIONS"),
            request,
        )
        .body(Vec::new())?);
    }

    let raw_uri = request.uri().to_string();
    let path = request.uri().path();
    let path = path.strip_prefix('/').unwrap_or(path);

    let decoded_path = urlencoding::decode(path)?;

    info!(
        "[filestream] raw_uri={}, decoded_path={}",
        raw_uri, decoded_path
    );

    let requested_path = PathBuf::from(decoded_path.as_ref());

    let canonical_path = match std::fs::canonicalize(&requested_path) {
        Ok(path) => path,
        Err(e) => {
            warn!(
                "[filestream] canonicalize 失败: path={}, error={}",
                requested_path.display(),
                e
            );
            return Ok(tauri::http::Response::builder()
                .status(404)
                .header("Vary", "Origin")
                .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
                .body(Vec::new())?);
        }
    };

    // 安全检查 1：目录白名单 — 规范路径必须位于已授权目录下
    let is_in_allowed_dir = allowed_dirs
        .iter()
        .any(|dir| canonical_path.starts_with(dir));
    if !is_in_allowed_dir {
        warn!(
            "[filestream] 拒绝访问白名单外路径: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(403)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 安全检查 2：拒绝白名单根目录之下的隐藏路径段
    if has_hidden_segment_within(&canonical_path, allowed_dirs) {
        warn!(
            "[filestream] 拒绝访问隐藏路径段: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(403)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 安全检查 3：扩展名白名单（blobs 目录内放宽为任意扩展名）
    if !extension_permitted(&canonical_path, blob_dirs) {
        warn!(
            "[filestream] 拒绝访问非白名单扩展名文件: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(403)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 安全检查 4：确保路径存在且可读
    if !canonical_path.exists() || !canonical_path.is_file() {
        warn!(
            "[filestream] 文件不存在或非文件: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(404)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 打开文件后取已打开句柄的 metadata，并复核句柄真实路径，防 TOCTOU 竞态
    let mut file = File::open(&canonical_path)?;
    if !opened_file_matches_authorized_path(&file, &canonical_path, allowed_dirs) {
        warn!(
            "[filestream] 打开句柄与已授权路径不一致，拒绝潜在竞态访问: {}",
            canonical_path.display()
        );
        return Ok(
            with_cors_headers(tauri::http::Response::builder().status(403), request)
                .body(Vec::new())?,
        );
    }
    let metadata = file.metadata()?;
    let file_size = metadata.len();

    // Content-Type：合法的 ?mime= 覆盖优先，否则按扩展名推断
    let content_type = mime_override_from_query(request.uri().query())
        .unwrap_or_else(|| get_mime_type(&canonical_path).to_string());

    // HEAD 请求只返回响应头，不读文件体
    let is_head = request.method() == tauri::http::Method::HEAD;
    if is_head {
        return Ok(with_cors_headers(
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", content_type)
                .header("Content-Length", file_size.to_string())
                .header("Accept-Ranges", "bytes"),
            request,
        )
        .body(Vec::new())?);
    }

    // 解析 Range 请求头
    let range_header = request.headers().get("range");

    match range_header {
        Some(range_value) => {
            // 处理 Range Request (e.g., "bytes=0-1023")
            let range_str = range_value.to_str()?;

            if let Some((start, end)) = parse_range_header(range_str, file_size) {
                // end 已在 parse_range_header 中 clamp 到 file_size-1，
                // 不做静默截断（与 pdfstream 审计结论一致，避免破坏客户端分块状态机）。
                let content_length = end - start + 1;
                let Some(buffer_len) = checked_response_len(content_length) else {
                    warn!(
                        "[filestream] 拒绝超大 Range 响应: {}..{} ({} bytes, limit={} bytes)",
                        start, end, content_length, FILE_STREAM_MAX_RESPONSE_BYTES
                    );
                    return Ok(with_cors_headers(
                        tauri::http::Response::builder()
                            .status(416)
                            .header("Content-Range", format!("bytes */{}", file_size)),
                        request,
                    )
                    .body(Vec::new())?);
                };
                let Some(response_budget) = reserve_response_budget(content_length) else {
                    warn!(
                        "[filestream] 响应总内存预算已满，拒绝 {} bytes Range",
                        content_length
                    );
                    return Ok(with_cors_headers(
                        tauri::http::Response::builder()
                            .status(503)
                            .header("Retry-After", "1"),
                        request,
                    )
                    .body(Vec::new())?);
                };

                file.seek(SeekFrom::Start(start))?;

                // 文件在读取中收缩时返回 416 而非 500
                let mut buffer = vec![0u8; buffer_len];
                if let Err(e) = file.read_exact(&mut buffer) {
                    warn!(
                        "[filestream] Range 读取失败（文件可能已被修改）: {}..{}, err={}",
                        start, end, e
                    );
                    return Ok(with_cors_headers(
                        tauri::http::Response::builder()
                            .status(416)
                            .header("Content-Range", format!("bytes */{}", file_size)),
                        request,
                    )
                    .body(Vec::new())?);
                }

                // 返回 206 Partial Content
                let mut response = with_cors_headers(
                    tauri::http::Response::builder()
                        .status(206)
                        .header("Content-Type", content_type)
                        .header("Content-Length", content_length.to_string())
                        .header(
                            "Content-Range",
                            format!("bytes {}-{}/{}", start, end, file_size),
                        )
                        .header("Accept-Ranges", "bytes"),
                    request,
                )
                .body(buffer)?;
                response.extensions_mut().insert(response_budget);
                Ok(response)
            } else {
                // Range 格式错误
                Ok(with_cors_headers(
                    tauri::http::Response::builder()
                        .status(416)
                        .header("Content-Range", format!("bytes */{}", file_size)),
                    request,
                )
                .body(Vec::new())?)
            }
        }
        None => {
            // 无 Range 请求返回 200 + 完整内容；超过硬上限时明确拒绝（413），
            // 不通过静默截断破坏客户端状态。
            let Some(buffer_len) = checked_response_len(file_size) else {
                warn!(
                    "[filestream] 拒绝超大完整响应: {} bytes (limit={} bytes)",
                    file_size, FILE_STREAM_MAX_RESPONSE_BYTES
                );
                return Ok(with_cors_headers(
                    tauri::http::Response::builder()
                        .status(413)
                        .header("Accept-Ranges", "bytes"),
                    request,
                )
                .body(Vec::new())?);
            };
            let Some(response_budget) = reserve_response_budget(file_size) else {
                warn!(
                    "[filestream] 响应总内存预算已满，拒绝 {} bytes 完整响应",
                    file_size
                );
                return Ok(with_cors_headers(
                    tauri::http::Response::builder()
                        .status(503)
                        .header("Retry-After", "1"),
                    request,
                )
                .body(Vec::new())?);
            };

            let mut buffer = Vec::with_capacity(buffer_len);
            file.take(file_size).read_to_end(&mut buffer)?;

            let mut response = with_cors_headers(
                tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", content_type)
                    .header("Content-Length", buffer.len().to_string())
                    .header("Accept-Ranges", "bytes"),
                request,
            )
            .body(buffer)?;
            response.extensions_mut().insert(response_budget);
            Ok(response)
        }
    }
}

/// 解析 Range 请求头，返回 (start, end) 字节范围
///
/// 支持格式：
/// - bytes=0-1023 (完整范围)
/// - bytes=0- (从0到文件末尾)
/// - bytes=-1024 (最后1024字节)
fn parse_range_header(range_str: &str, file_size: u64) -> Option<(u64, u64)> {
    let range_str = range_str.strip_prefix("bytes=")?;

    let parts: Vec<&str> = range_str.split('-').collect();
    if parts.len() != 2 {
        return None;
    }

    let start_str = parts[0].trim();
    let end_str = parts[1].trim();

    match (start_str.is_empty(), end_str.is_empty()) {
        (false, false) => {
            // bytes=0-1023
            let start: u64 = start_str.parse().ok()?;
            let end: u64 = end_str.parse().ok()?;
            if start > end || start >= file_size {
                return None;
            }
            // end 超出文件大小时 clamp 到 file_size - 1
            let end = end.min(file_size - 1);
            Some((start, end))
        }
        (false, true) => {
            // bytes=1024- (从1024到文件末尾)
            let start: u64 = start_str.parse().ok()?;
            if start >= file_size {
                return None;
            }
            Some((start, file_size - 1))
        }
        (true, false) => {
            // bytes=-1024 (最后1024字节)
            if file_size == 0 {
                return None;
            }
            let suffix_len: u64 = end_str.parse().ok()?;
            if suffix_len == 0 {
                return None;
            }
            let start = file_size.saturating_sub(suffix_len);
            Some((start, file_size - 1))
        }
        (true, true) => None, // 无效格式
    }
}

/// filestream 协议可达性探测（对齐 pdfstream_check_access 的校验规则）
///
/// 与 `handle_asset_protocol` 使用完全相同的判定链
/// （canonicalize → 目录白名单 → 隐藏路径段 → 扩展名白名单（blobs 放宽）→ 常规文件），
/// 避免前端探测成功、实际加载却 403 的不一致。
///
/// 校验失败一律返回 `Ok(false)`（不可达是常态而非异常）；
/// `Result<bool, String>` 签名与前端契约保持一致。
#[tauri::command]
pub async fn filestream_check_access(
    app: tauri::AppHandle,
    path: String,
) -> Result<bool, String> {
    let Ok(canonical) = std::fs::canonicalize(Path::new(&path)) else {
        return Ok(false);
    };

    let allowed_dirs = crate::pdf_protocol::resolve_allowed_dirs(&app);
    if !allowed_dirs.iter().any(|dir| canonical.starts_with(dir)) {
        return Ok(false);
    }

    if has_hidden_segment_within(&canonical, &allowed_dirs) {
        return Ok(false);
    }

    let blob_dirs = resolve_blob_dirs(&app);
    if !extension_permitted(&canonical, &blob_dirs) {
        return Ok(false);
    }

    Ok(canonical.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_range_header() {
        // 完整范围
        assert_eq!(parse_range_header("bytes=0-1023", 10000), Some((0, 1023)));
        // 从某位置到末尾
        assert_eq!(parse_range_header("bytes=1024-", 10000), Some((1024, 9999)));
        // 最后N字节
        assert_eq!(parse_range_header("bytes=-1024", 10000), Some((8976, 9999)));
        // RFC 9110: suffix-length 必须大于 0
        assert_eq!(parse_range_header("bytes=-0", 10000), None);
        // end 超出文件大小 → clamp 到 file_size-1
        assert_eq!(parse_range_header("bytes=0-20000", 10000), Some((0, 9999)));
        // start 超出文件大小 → None
        assert_eq!(parse_range_header("bytes=20000-30000", 10000), None);
        // 无效格式
        assert_eq!(parse_range_header("bytes=abc-def", 10000), None);
        // file_size==0 时所有 Range 都应返回 None
        assert_eq!(parse_range_header("bytes=0-1023", 0), None);
        assert_eq!(parse_range_header("bytes=0-", 0), None);
        assert_eq!(parse_range_header("bytes=-1024", 0), None);
    }

    #[test]
    fn test_is_allowed_media_extension() {
        // 音频
        assert!(is_allowed_media_extension("mp3"));
        assert!(is_allowed_media_extension("flac"));
        assert!(is_allowed_media_extension("opus"));
        assert!(is_allowed_media_extension("aif"));
        assert!(is_allowed_media_extension("caf"));
        // 视频
        assert!(is_allowed_media_extension("mp4"));
        assert!(is_allowed_media_extension("mkv"));
        assert!(is_allowed_media_extension("3gp"));
        // 图片
        assert!(is_allowed_media_extension("png"));
        assert!(is_allowed_media_extension("heic"));
        // 文档兜底
        assert!(is_allowed_media_extension("pdf"));
        // 通用 blob
        assert!(is_allowed_media_extension("bin"));
        // 大小写不敏感
        assert!(is_allowed_media_extension("MP4"));
        assert!(is_allowed_media_extension("Png"));
        // 拒绝
        assert!(!is_allowed_media_extension("exe"));
        assert!(!is_allowed_media_extension("html"));
        assert!(!is_allowed_media_extension(""));
    }

    #[test]
    fn test_extension_permitted_relaxed_inside_blob_dirs() {
        let blob_dirs = vec![PathBuf::from("/data/blobs")];
        // blobs 目录内：任意扩展名/无扩展名均放行
        assert!(extension_permitted(
            &PathBuf::from("/data/blobs/abcdef0123456789"),
            &blob_dirs
        ));
        assert!(extension_permitted(
            &PathBuf::from("/data/blobs/file.weird"),
            &blob_dirs
        ));
        // blobs 目录外：无扩展名 / 非白名单扩展名拒绝
        assert!(!extension_permitted(
            &PathBuf::from("/data/other/noext"),
            &blob_dirs
        ));
        assert!(!extension_permitted(
            &PathBuf::from("/data/other/file.exe"),
            &blob_dirs
        ));
        // blobs 目录外：白名单扩展名放行
        assert!(extension_permitted(
            &PathBuf::from("/data/other/video.mp4"),
            &blob_dirs
        ));
    }

    #[test]
    fn test_get_mime_type() {
        assert_eq!(get_mime_type(&PathBuf::from("a.mp3")), "audio/mpeg");
        assert_eq!(get_mime_type(&PathBuf::from("a.m4a")), "audio/mp4");
        assert_eq!(get_mime_type(&PathBuf::from("a.opus")), "audio/ogg");
        assert_eq!(get_mime_type(&PathBuf::from("a.caf")), "audio/x-caf");
        assert_eq!(get_mime_type(&PathBuf::from("a.mp4")), "video/mp4");
        assert_eq!(get_mime_type(&PathBuf::from("a.mov")), "video/quicktime");
        assert_eq!(get_mime_type(&PathBuf::from("a.mkv")), "video/x-matroska");
        assert_eq!(get_mime_type(&PathBuf::from("a.png")), "image/png");
        assert_eq!(get_mime_type(&PathBuf::from("a.avif")), "image/avif");
        assert_eq!(get_mime_type(&PathBuf::from("a.pdf")), "application/pdf");
        // 大小写不敏感
        assert_eq!(get_mime_type(&PathBuf::from("a.MP4")), "video/mp4");
        // 无扩展名 / bin / 未知 → octet-stream
        assert_eq!(
            get_mime_type(&PathBuf::from("noext")),
            "application/octet-stream"
        );
        assert_eq!(
            get_mime_type(&PathBuf::from("a.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            get_mime_type(&PathBuf::from("a.unknown")),
            "application/octet-stream"
        );
    }

    #[test]
    fn test_sanitize_mime_override() {
        // 合法媒体前缀
        assert_eq!(
            sanitize_mime_override("video/mp4"),
            Some("video/mp4".to_string())
        );
        assert_eq!(
            sanitize_mime_override("audio/mpeg"),
            Some("audio/mpeg".to_string())
        );
        assert_eq!(
            sanitize_mime_override("image/svg+xml"),
            Some("image/svg+xml".to_string())
        );
        // 百分号编码
        assert_eq!(
            sanitize_mime_override("video%2Fmp4"),
            Some("video/mp4".to_string())
        );
        // 大小写规范化
        assert_eq!(
            sanitize_mime_override("Video/MP4"),
            Some("video/mp4".to_string())
        );
        // 非媒体前缀拒绝
        assert_eq!(sanitize_mime_override("text/html"), None);
        assert_eq!(sanitize_mime_override("application/octet-stream"), None);
        // 头注入字符拒绝
        assert_eq!(sanitize_mime_override("video/mp4\r\nSet-Cookie: x"), None);
        assert_eq!(sanitize_mime_override("video/mp4; charset=utf-8"), None);
        // 空子类型拒绝
        assert_eq!(sanitize_mime_override("video/"), None);
        assert_eq!(sanitize_mime_override(""), None);
    }

    #[test]
    fn test_mime_override_from_query() {
        assert_eq!(
            mime_override_from_query(Some("mime=video%2Fmp4")),
            Some("video/mp4".to_string())
        );
        assert_eq!(
            mime_override_from_query(Some("foo=bar&mime=audio/ogg&baz=1")),
            Some("audio/ogg".to_string())
        );
        // 非法覆盖值静默忽略
        assert_eq!(mime_override_from_query(Some("mime=text%2Fhtml")), None);
        assert_eq!(mime_override_from_query(Some("foo=bar")), None);
        assert_eq!(mime_override_from_query(None), None);
    }

    #[test]
    fn test_has_hidden_segment_within() {
        let allowed = vec![PathBuf::from("/home/u/.local/share/app")];
        // 白名单根本身在隐藏目录内（Linux）不误伤
        assert!(!has_hidden_segment_within(
            &PathBuf::from("/home/u/.local/share/app/media/a.mp4"),
            &allowed
        ));
        // 根之下的隐藏段拒绝
        assert!(has_hidden_segment_within(
            &PathBuf::from("/home/u/.local/share/app/.secret/a.mp4"),
            &allowed
        ));
        assert!(has_hidden_segment_within(
            &PathBuf::from("/home/u/.local/share/app/media/.hidden.mp4"),
            &allowed
        ));
        // 白名单外保守视为拒绝
        assert!(has_hidden_segment_within(
            &PathBuf::from("/etc/passwd"),
            &allowed
        ));
    }

    fn make_get_request(uri: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(uri)
            .body(Vec::new())
            .expect("GET request")
    }

    #[test]
    fn test_protocol_rejects_disallowed_paths() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let allowed_dirs = vec![temp_dir.path().canonicalize().expect("canonical tempdir")];
        let blob_dirs: Vec<PathBuf> = Vec::new();

        // 非白名单扩展名 → 403
        let exe_path = temp_dir.path().join("evil.exe");
        std::fs::write(&exe_path, b"MZ").expect("write exe");
        let encoded = urlencoding::encode(&exe_path.to_string_lossy()).into_owned();
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::FORBIDDEN);

        // 隐藏路径段 → 403
        let hidden_dir = temp_dir.path().join(".secret");
        std::fs::create_dir_all(&hidden_dir).expect("mkdir hidden");
        let hidden_path = hidden_dir.join("a.mp4");
        std::fs::write(&hidden_path, b"data").expect("write hidden");
        let encoded = urlencoding::encode(&hidden_path.to_string_lossy()).into_owned();
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::FORBIDDEN);

        // 白名单目录外 → 403（用另一个 tempdir 里的合法扩展名文件）
        let outside_dir = tempfile::tempdir().expect("outside tempdir");
        let outside_path = outside_dir.path().join("a.mp4");
        std::fs::write(&outside_path, b"data").expect("write outside");
        let canonical_outside = outside_path.canonicalize().expect("canonical outside");
        let encoded = urlencoding::encode(&canonical_outside.to_string_lossy()).into_owned();
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::FORBIDDEN);

        // 不存在的文件 → 404
        let missing = temp_dir.path().join("missing.mp4");
        let encoded = urlencoding::encode(&missing.to_string_lossy()).into_owned();
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn test_protocol_serves_media_with_range_and_mime_override() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let allowed_dirs = vec![temp_dir.path().canonicalize().expect("canonical tempdir")];
        let blob_dirs: Vec<PathBuf> = Vec::new();

        let media_path = temp_dir.path().join("clip.mp4");
        std::fs::write(&media_path, vec![0u8; 4096]).expect("write media");
        let encoded = urlencoding::encode(&media_path.to_string_lossy()).into_owned();

        // 完整 GET → 200 + video/mp4
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "video/mp4"
        );
        assert_eq!(response.body().len(), 4096);

        // Range GET → 206 + Content-Range
        let request = tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(format!("filestream://localhost/{}", encoded))
            .header("Range", "bytes=0-1023")
            .body(Vec::new())
            .expect("Range request");
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(
            response.status(),
            tauri::http::StatusCode::PARTIAL_CONTENT
        );
        assert_eq!(
            response.headers().get("Content-Range").unwrap(),
            "bytes 0-1023/4096"
        );
        assert_eq!(response.body().len(), 1024);

        // HEAD → 200 空体
        let request = tauri::http::Request::builder()
            .method(tauri::http::Method::HEAD)
            .uri(format!("filestream://localhost/{}", encoded))
            .body(Vec::new())
            .expect("HEAD request");
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(
            response.headers().get("Content-Length").unwrap(),
            &4096.to_string()
        );
    }

    #[test]
    fn test_protocol_allows_extensionless_blob_with_mime_override() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let canonical_root = temp_dir.path().canonicalize().expect("canonical tempdir");
        let allowed_dirs = vec![canonical_root.clone()];
        // 整个 tempdir 视为 blobs 目录：扩展名放宽
        let blob_dirs = vec![canonical_root];

        let blob_path = temp_dir.path().join("0123456789abcdef");
        std::fs::write(&blob_path, vec![7u8; 128]).expect("write blob");
        let encoded = urlencoding::encode(&blob_path.to_string_lossy()).into_owned();

        // 无 mime 覆盖 → application/octet-stream
        let request = make_get_request(&format!("filestream://localhost/{}", encoded));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "application/octet-stream"
        );

        // ?mime=video%2Fmp4 覆盖 → video/mp4
        let request = make_get_request(&format!(
            "filestream://localhost/{}?mime=video%2Fmp4",
            encoded
        ));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "video/mp4"
        );

        // 非法 mime 覆盖被忽略，回退 octet-stream
        let request = make_get_request(&format!(
            "filestream://localhost/{}?mime=text%2Fhtml",
            encoded
        ));
        let response =
            handle_asset_protocol(&request, &allowed_dirs, &blob_dirs).expect("response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "application/octet-stream"
        );
    }

    #[test]
    fn test_oversized_get_and_open_range_are_rejected_without_reading_body() {
        use std::fs::OpenOptions;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let media_path = temp_dir.path().join("oversized.mp4");
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&media_path)
            .expect("create sparse media");
        file.set_len(FILE_STREAM_MAX_RESPONSE_BYTES + 1)
            .expect("set sparse length");

        let media_path_text = media_path.to_string_lossy();
        let encoded = urlencoding::encode(media_path_text.as_ref());
        let uri = format!("filestream://localhost/{}", encoded);
        let allowed_dirs = vec![temp_dir.path().canonicalize().expect("canonical tempdir")];
        let blob_dirs: Vec<PathBuf> = Vec::new();

        let get = make_get_request(&uri);
        let response = handle_asset_protocol(&get, &allowed_dirs, &blob_dirs).expect("GET response");
        assert_eq!(
            response.status(),
            tauri::http::StatusCode::PAYLOAD_TOO_LARGE
        );
        assert!(response.body().is_empty());

        let range = tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(&uri)
            .header("Range", "bytes=0-")
            .body(Vec::new())
            .expect("Range request");
        let response =
            handle_asset_protocol(&range, &allowed_dirs, &blob_dirs).expect("Range response");
        assert_eq!(
            response.status(),
            tauri::http::StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert!(response.body().is_empty());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn test_opened_handle_rejects_path_replaced_after_open() {
        use std::os::unix::fs::symlink;

        let allowed = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let requested = allowed.path().join("requested.mp4");
        let moved = allowed.path().join("moved.mp4");
        let secret = external.path().join("secret.mp4");
        std::fs::write(&requested, b"allowed").unwrap();
        std::fs::write(&secret, b"secret").unwrap();

        let expected = requested.canonicalize().unwrap();
        let opened = File::open(&requested).unwrap();
        std::fs::rename(&requested, &moved).unwrap();
        symlink(&secret, &requested).unwrap();

        let allowed_dirs = vec![allowed.path().canonicalize().unwrap()];
        assert!(!opened_file_matches_authorized_path(
            &opened,
            &expected,
            &allowed_dirs,
        ));
    }
}
