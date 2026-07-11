// PDF 文件流式加载协议
// 提供 pdfstream:// 自定义协议，支持 HTTP Range Request，用于高效加载大型 PDF 文件

use log::{info, warn};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const DEFAULT_CORS_ORIGIN: &str = "tauri://localhost";

/// `tauri::http::Response<Vec<u8>>` 必须在返回前完整持有响应体，无法真正流式发送。
/// 因此对完整 GET 和单次 Range 都设置与应用文档导入一致的 200MB 硬上限，
/// 避免恶意或异常超大本地文件触发无界分配。
const PDF_PROTOCOL_MAX_RESPONSE_BYTES: u64 = 200 * 1024 * 1024;
const PDF_PROTOCOL_MAX_IN_FLIGHT_BYTES: u64 = 400 * 1024 * 1024;

static PDF_PROTOCOL_IN_FLIGHT_BYTES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
struct PdfResponseBudget {
    bytes: u64,
}

impl Drop for PdfResponseBudget {
    fn drop(&mut self) {
        PDF_PROTOCOL_IN_FLIGHT_BYTES.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

fn reserve_response_budget(bytes: u64) -> Option<Arc<PdfResponseBudget>> {
    loop {
        let current = PDF_PROTOCOL_IN_FLIGHT_BYTES.load(Ordering::Acquire);
        let next = current.checked_add(bytes)?;
        if next > PDF_PROTOCOL_MAX_IN_FLIGHT_BYTES {
            return None;
        }
        if PDF_PROTOCOL_IN_FLIGHT_BYTES
            .compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return Some(Arc::new(PdfResponseBudget { bytes }));
        }
    }
}

// ★ 2026-07-08（PDF 链路审计 H1/H2）：移除 4MB 无 Range 截断与 8MB Range 截断。
//
// 此前的截断策略与 pdf.js 实际行为不兼容，导致 >4MB 的 PDF 必然解析失败或挂起：
// - H1：pdf.js 的初始完整请求（PDFFetchStreamFullReader / validateRangeRequestCapabilities）
//   只读取 Content-Length，从不解析 Content-Range。返回 206 + Content-Length=4MB 时，
//   pdf.js 认为文件总长就是 4MB，xref/trailer 不可达 → "Invalid PDF"。
//   macOS/Linux 上 pdfstream:// 为非 http scheme，pdf.js 直接禁用 Range 模式，无任何恢复路径。
// - H2：pdf.js 的 ChunkedStreamManager 会把连续缺失的 64KB 块合并为单个 Range 请求；
//   服务端静默截断到 8MB 后，剩余块保持 requested 状态且永远不会重发 → 加载永久挂起。
//
// 现在：允许范围内的无 Range 请求返回 200 + 完整内容；Range 请求严格按请求范围返回
// （parse_range_header 已把 end clamp 到 file_size-1）。超过硬上限时明确拒绝，
// 不通过静默截断破坏 pdf.js 的分块状态机。

fn checked_response_len(len: u64) -> Option<usize> {
    if len > PDF_PROTOCOL_MAX_RESPONSE_BYTES || len > usize::MAX as u64 {
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
    expected_path: &std::path::Path,
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
        // 强句柄路径校验由各平台 API 后续补齐。
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

/// 兼容桌面与移动端 WebView 来源：
/// - tauri://localhost（桌面自定义协议）
/// - http(s)://tauri.localhost（Windows / Android）
/// - http(s)://localhost（开发态，可带端口）
///
/// ★ 2026-06-12（代理 3 审阅 A2）：localhost 改为精确匹配 host（允许带端口），
/// 避免 `http://localhost.evil.com` 这类前缀域名通过校验。
fn is_allowed_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin == "http://localhost"
        || origin == "https://localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
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

/// 从 Tauri AppHandle 解析允许的 PDF 访问目录白名单。
/// 仅包含用户数据和文档相关目录，排除系统敏感路径。
pub fn resolve_allowed_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;

    let mut resolvers: Vec<Box<dyn Fn() -> Result<PathBuf, tauri::Error>>> = vec![
        Box::new(|| app.path().app_data_dir()),
        Box::new(|| app.path().app_local_data_dir()),
        Box::new(|| app.path().app_cache_dir()),
        Box::new(|| app.path().document_dir()),
        Box::new(|| app.path().download_dir()),
        Box::new(|| app.path().temp_dir()),
        Box::new(|| app.path().resource_dir()),
    ];

    // desktop_dir / picture_dir 仅桌面端可用
    #[cfg(desktop)]
    {
        resolvers.push(Box::new(|| app.path().desktop_dir()));
        resolvers.push(Box::new(|| app.path().picture_dir()));
    }

    let mut dirs: Vec<PathBuf> = resolvers
        .into_iter()
        .filter_map(|f| f().ok().and_then(|p| std::fs::canonicalize(&p).ok()))
        .collect();

    // ★ 2026-06-12（审阅问题 R1 配套）：VFS blobs 目录加入白名单。
    // 数据槽可由用户迁移到任意位置（可能在 app_data 之外），
    // 教材 PDF 复制进 blob 后需要可被 pdfstream:// 流式读取。
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if let Some(vfs_db) = state.vfs_db.as_ref() {
            if let Ok(blobs_dir) = std::fs::canonicalize(vfs_db.blobs_dir()) {
                if !dirs.contains(&blobs_dir) {
                    dirs.push(blobs_dir);
                }
            }
        }
    }

    dirs
}

/// 处理 pdfstream:// 协议请求
///
/// 支持功能：
/// - HTTP Range Request (用于 PDF.js 流式加载)
/// - Content-Type 自动识别
/// - 跨域支持（CORS）
/// - 目录白名单安全检查（仅允许访问特定目录下的 PDF）
pub fn handle_asset_protocol(
    request: &tauri::http::Request<Vec<u8>>,
    allowed_dirs: &[PathBuf],
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
        "[pdfstream] raw_uri={}, decoded_path={}",
        raw_uri, decoded_path
    );

    let requested_path = PathBuf::from(decoded_path.as_ref());

    let canonical_path = match std::fs::canonicalize(&requested_path) {
        Ok(path) => path,
        Err(e) => {
            warn!(
                "[pdfstream] canonicalize 失败: path={}, error={}",
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
            "[pdfstream] 拒绝访问白名单外路径: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(403)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 安全检查 2：只允许访问 .pdf 文件（大小写不敏感，兼容 Windows 上的 .PDF）
    let is_pdf = canonical_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        warn!(
            "[pdfstream] 拒绝访问非 PDF 文件: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(403)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 安全检查 3：确保路径存在且可读
    if !canonical_path.exists() || !canonical_path.is_file() {
        warn!(
            "[pdfstream] 文件不存在或非文件: {}",
            canonical_path.display()
        );
        return Ok(tauri::http::Response::builder()
            .status(404)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Origin", resolve_cors_origin(request))
            .body(Vec::new())?);
    }

    // 打开文件（★ 2026-07-08 审计 M4：先 open 再取已打开句柄的 metadata，
    // 避免 stat 与 open 之间文件被替换/收缩产生 read_exact 竞态 500）
    let mut file = File::open(&canonical_path)?;
    if !opened_file_matches_authorized_path(&file, &canonical_path, allowed_dirs) {
        warn!(
            "[pdfstream] 打开句柄与已授权路径不一致，拒绝潜在竞态访问: {}",
            canonical_path.display()
        );
        return Ok(
            with_cors_headers(tauri::http::Response::builder().status(403), request)
                .body(Vec::new())?,
        );
    }
    let metadata = file.metadata()?;
    let file_size = metadata.len();

    // ★ 2026-07-08（审计 L1）：HEAD 请求只返回响应头，不读文件体
    let is_head = request.method() == tauri::http::Method::HEAD;
    if is_head {
        return Ok(with_cors_headers(
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", get_mime_type(&canonical_path))
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
                // ★ 2026-07-08（审计 H2）：不再截断 Range 响应。
                // pdf.js 对被截断的 206 不会重发剩余部分（ChunkedStreamManager 挂起）。
                // end 已在 parse_range_header 中 clamp 到 file_size-1。

                // 计算实际读取范围
                let content_length = end - start + 1;
                let Some(buffer_len) = checked_response_len(content_length) else {
                    warn!(
                        "[pdfstream] 拒绝超大 Range 响应: {}..{} ({} bytes, limit={} bytes)",
                        start, end, content_length, PDF_PROTOCOL_MAX_RESPONSE_BYTES
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
                        "[pdfstream] PDF 响应总内存预算已满，拒绝 {} bytes Range",
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

                // Seek 到起始位置
                file.seek(SeekFrom::Start(start))?;

                // 读取指定范围的数据（★ 审计 M4：文件在读取中收缩时返回 416 而非 500）
                let mut buffer = vec![0u8; buffer_len];
                if let Err(e) = file.read_exact(&mut buffer) {
                    warn!(
                        "[pdfstream] Range 读取失败（文件可能已被修改）: {}..{}, err={}",
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
                        .header("Content-Type", get_mime_type(&canonical_path))
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
            // ★ 2026-07-08（审计 H1）：无 Range 请求一律返回 200 + 完整内容。
            // pdf.js 的初始完整请求不解析 Content-Range，任何截断都会被当作文件总长，
            // 导致 >截断值 的 PDF 解析失败。Tauri 自定义协议无法流式响应，
            // 只能整体缓冲；Accept-Ranges: bytes 让 pdf.js（Windows http scheme）
            // 尽早切换到 Range 模式以减少后续全量请求。
            let Some(buffer_len) = checked_response_len(file_size) else {
                warn!(
                    "[pdfstream] 拒绝超大完整响应: {} bytes (limit={} bytes)",
                    file_size, PDF_PROTOCOL_MAX_RESPONSE_BYTES
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
                    "[pdfstream] PDF 响应总内存预算已满，拒绝 {} bytes 完整响应",
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
                    .header("Content-Type", get_mime_type(&canonical_path))
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
    // 移除 "bytes=" 前缀
    let range_str = range_str.strip_prefix("bytes=")?;

    // 分割 start-end
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
            // Clamp end to file_size - 1 (PDF.js may request beyond file size)
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

/// 根据文件扩展名返回 MIME 类型
fn get_mime_type(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("txt") => "text/plain",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
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
    fn test_is_allowed_origin() {
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(is_allowed_origin("http://tauri.localhost"));
        assert!(is_allowed_origin("https://tauri.localhost"));
        assert!(is_allowed_origin("http://localhost"));
        assert!(is_allowed_origin("http://localhost:1420"));
        assert!(is_allowed_origin("https://localhost:8080"));
        // 前缀域名攻击：不能匹配
        assert!(!is_allowed_origin("http://localhost.evil.com"));
        assert!(!is_allowed_origin("https://localhost.evil.com:443"));
        assert!(!is_allowed_origin("http://evil.com"));
    }

    #[test]
    fn test_checked_response_len_enforces_platform_and_protocol_limits() {
        assert_eq!(
            checked_response_len(PDF_PROTOCOL_MAX_RESPONSE_BYTES),
            usize::try_from(PDF_PROTOCOL_MAX_RESPONSE_BYTES).ok()
        );
        assert_eq!(
            checked_response_len(PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1),
            None
        );
        assert_eq!(checked_response_len(u64::MAX), None);
    }

    #[test]
    fn test_oversized_get_and_open_range_are_rejected_without_reading_body() {
        use std::fs::OpenOptions;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let pdf_path = temp_dir.path().join("oversized.pdf");
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&pdf_path)
            .expect("create sparse pdf");
        file.set_len(PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1)
            .expect("set sparse length");

        let pdf_path_text = pdf_path.to_string_lossy();
        let encoded = urlencoding::encode(pdf_path_text.as_ref());
        let uri = format!("pdfstream://localhost/{}", encoded);
        let allowed_dirs = vec![temp_dir.path().canonicalize().expect("canonical tempdir")];

        let get = tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(&uri)
            .body(Vec::new())
            .expect("GET request");
        let response = handle_asset_protocol(&get, &allowed_dirs).expect("GET response");
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
        let response = handle_asset_protocol(&range, &allowed_dirs).expect("Range response");
        assert_eq!(
            response.status(),
            tauri::http::StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert!(response.body().is_empty());

        let head = tauri::http::Request::builder()
            .method(tauri::http::Method::HEAD)
            .uri(&uri)
            .body(Vec::new())
            .expect("HEAD request");
        let response = handle_asset_protocol(&head, &allowed_dirs).expect("HEAD response");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Length").unwrap(),
            &(PDF_PROTOCOL_MAX_RESPONSE_BYTES + 1).to_string()
        );
        assert!(response
            .headers()
            .contains_key("Access-Control-Expose-Headers"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn test_opened_handle_rejects_path_replaced_after_open() {
        use std::os::unix::fs::symlink;

        let allowed = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let requested = allowed.path().join("requested.pdf");
        let moved = allowed.path().join("moved.pdf");
        let secret = external.path().join("secret.pdf");
        std::fs::write(&requested, b"%PDF-allowed").unwrap();
        std::fs::write(&secret, b"%PDF-secret").unwrap();

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

    #[test]
    fn test_get_mime_type() {
        assert_eq!(get_mime_type(&PathBuf::from("test.pdf")), "application/pdf");
        assert_eq!(get_mime_type(&PathBuf::from("test.png")), "image/png");
        assert_eq!(
            get_mime_type(&PathBuf::from("test.unknown")),
            "application/octet-stream"
        );
    }
}
