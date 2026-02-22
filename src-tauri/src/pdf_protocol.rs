// PDF 文件流式加载协议
// 提供 pdfstream:// 自定义协议，支持 HTTP Range Request，用于高效加载大型 PDF 文件

use log::{info, warn};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// 从 Tauri AppHandle 解析允许的 PDF 访问目录白名单。
/// 仅包含用户数据和文档相关目录，排除系统敏感路径。
pub fn resolve_allowed_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;

    let resolvers: Vec<Box<dyn Fn() -> Result<PathBuf, tauri::Error>>> = vec![
        Box::new(|| app.path().app_data_dir()),
        Box::new(|| app.path().app_local_data_dir()),
        Box::new(|| app.path().app_cache_dir()),
        Box::new(|| app.path().document_dir()),
        Box::new(|| app.path().download_dir()),
        Box::new(|| app.path().desktop_dir()),
        Box::new(|| app.path().picture_dir()),
        Box::new(|| app.path().temp_dir()),
        Box::new(|| app.path().resource_dir()),
    ];

    resolvers
        .into_iter()
        .filter_map(|f| {
            f().ok().and_then(|p| std::fs::canonicalize(&p).ok())
        })
        .collect()
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
                .header("Access-Control-Allow-Origin", "tauri://localhost")
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
            .header("Access-Control-Allow-Origin", "tauri://localhost")
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
            .header("Access-Control-Allow-Origin", "tauri://localhost")
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
            .header("Access-Control-Allow-Origin", "tauri://localhost")
            .body(Vec::new())?);
    }

    // 获取文件元数据
    let metadata = std::fs::metadata(&canonical_path)?;
    let file_size = metadata.len();

    // 打开文件
    let mut file = File::open(&canonical_path)?;

    // 解析 Range 请求头
    let range_header = request.headers().get("range");

    match range_header {
        Some(range_value) => {
            // 处理 Range Request (e.g., "bytes=0-1023")
            let range_str = range_value.to_str()?;

            if let Some((start, end)) = parse_range_header(range_str, file_size) {
                // 计算实际读取范围
                let content_length = end - start + 1;

                // Seek 到起始位置
                file.seek(SeekFrom::Start(start))?;

                // 读取指定范围的数据
                let mut buffer = vec![0u8; content_length as usize];
                file.read_exact(&mut buffer)?;

                // 返回 206 Partial Content
                Ok(tauri::http::Response::builder()
                    .status(206)
                    .header("Content-Type", get_mime_type(&canonical_path))
                    .header("Content-Length", content_length.to_string())
                    .header(
                        "Content-Range",
                        format!("bytes {}-{}/{}", start, end, file_size),
                    )
                    .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "tauri://localhost")
                .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                .header("Access-Control-Allow-Headers", "Range")
                .body(buffer)?)
            } else {
                // Range 格式错误
                Ok(tauri::http::Response::builder()
                    .status(416)
                    .header("Content-Range", format!("bytes */{}", file_size))
                    .header("Access-Control-Allow-Origin", "tauri://localhost")
                    .body(Vec::new())?)
            }
        }
        None => {
            // 无 Range 请求，返回整个文件
            let mut buffer = Vec::with_capacity(file_size as usize);
            file.read_to_end(&mut buffer)?;

            Ok(tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", get_mime_type(&canonical_path))
                .header("Content-Length", file_size.to_string())
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "tauri://localhost")
                .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                .header("Access-Control-Allow-Headers", "Range")
                .body(buffer)?)
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
    fn test_get_mime_type() {
        assert_eq!(get_mime_type(&PathBuf::from("test.pdf")), "application/pdf");
        assert_eq!(get_mime_type(&PathBuf::from("test.png")), "image/png");
        assert_eq!(
            get_mime_type(&PathBuf::from("test.unknown")),
            "application/octet-stream"
        );
    }
}
