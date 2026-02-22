//! PDF 预渲染模块
//!
//! 提供 PDF 上传时的预渲染功能：
//! - 使用 pdfium 将 PDF 按页渲染成图片
//! - 使用 pdfium 提取文本内容（替代原 pdf-extract，中文支持更好）
//! - 将图片存储到 blobs 表
//!
//! 参考题目集识别 (exam_sheets) 的 preview_json 模式设计。

use rusqlite::Connection;
use std::path::Path;
use tracing::{debug, info, warn};

use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::VfsBlobRepo;
use crate::vfs::types::{PdfPagePreview, PdfPreviewJson};

/// PDF 预渲染配置
pub struct PdfPreviewConfig {
    /// 渲染 DPI（默认 150）
    pub render_dpi: u32,
    /// 最大渲染页数（默认 50）
    pub max_pages: usize,
    /// 目标宽度（像素）
    pub target_width: u32,
    /// 最大高度（像素）
    pub max_height: u32,
    /// JPEG 压缩质量（1-100，默认 75）
    /// v2.0 新增：使用 JPEG 格式替代 PNG，减少存储空间
    pub jpeg_quality: u8,
    /// 是否启用压缩（默认 true）
    pub compression_enabled: bool,
}

impl Default for PdfPreviewConfig {
    fn default() -> Self {
        Self {
            render_dpi: 150,
            max_pages: 50,
            target_width: 1200,
            max_height: 1600,
            jpeg_quality: 75, // 平衡质量与大小
            compression_enabled: true,
        }
    }
}

/// PDF 预渲染结果
pub struct PdfPreviewResult {
    /// 预渲染数据（JSON 格式）
    /// ★ P1-52 修复：渲染失败时为 None，避免空 preview_json 导致误判
    pub preview_json: Option<PdfPreviewJson>,
    /// 提取的文本内容
    pub extracted_text: Option<String>,
    /// 总页数
    pub page_count: usize,
}

/// 渲染 PDF 并提取文本
pub fn render_pdf_preview(
    conn: &Connection,
    blobs_dir: &Path,
    pdf_bytes: &[u8],
    config: &PdfPreviewConfig,
) -> VfsResult<PdfPreviewResult> {
    // 无进度回调版本
    render_pdf_preview_with_progress(conn, blobs_dir, pdf_bytes, config, |_, _| {})
}

/// 渲染 PDF 并提取文本（带进度回调）
///
/// ## 参数
/// - `conn`: 数据库连接
/// - `blobs_dir`: Blob 存储目录
/// - `pdf_bytes`: PDF 文件字节
/// - `config`: 渲染配置
/// - `progress_callback`: 进度回调 (current_page, total_pages)
///
/// ## 返回
/// - `Ok(PdfPreviewResult)`: 预渲染结果
/// - `Err(VfsError)`: 渲染失败
pub fn render_pdf_preview_with_progress<F>(
    conn: &Connection,
    blobs_dir: &Path,
    pdf_bytes: &[u8],
    config: &PdfPreviewConfig,
    progress_callback: F,
) -> VfsResult<PdfPreviewResult>
where
    F: Fn(usize, usize),
{
    // 1. 提取文本（使用 pdfium，即使渲染失败也尝试提取）
    let extracted_text = extract_pdf_text(pdf_bytes);

    // 2. 尝试使用 pdfium 渲染
    let (preview_json, page_count) =
        match render_pdf_pages_with_progress(conn, blobs_dir, pdf_bytes, config, progress_callback)
        {
            Ok(result) => (Some(result.0), result.1),
            Err(e) => {
                // ★ P1-52 修复：渲染失败时不写入 preview_json，避免误判“有预渲染”
                warn!("[PDF-Preview] Pdfium render failed, text-only mode: {}", e);
                (None, 0)
            }
        };

    Ok(PdfPreviewResult {
        preview_json,
        extracted_text,
        page_count,
    })
}

/// 使用 pdfium 提取 PDF 文本
///
/// 替代原 pdf-extract 实现：
/// - 中文/CJK 字体支持更好（pdf-extract 遇到非 Identity-H 编码会 panic）
/// - 与渲染使用同一引擎，行为一致
/// - 不会因为 assert 导致进程崩溃
fn extract_pdf_text(pdf_bytes: &[u8]) -> Option<String> {
    // 使用公共 pdfium 工具模块
    let pdfium = match crate::pdfium_utils::load_pdfium() {
        Ok(p) => p,
        Err(e) => {
            warn!(
                "[PDF-Preview] Failed to load pdfium for text extraction: {}",
                e
            );
            return None;
        }
    };

    match crate::pdfium_utils::extract_text_from_pdf_bytes(&pdfium, pdf_bytes) {
        Ok(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                debug!("[PDF-Preview] Extracted empty text from PDF");
                None
            } else {
                debug!("[PDF-Preview] Extracted {} chars from PDF", trimmed.len());
                Some(trimmed)
            }
        }
        Err(e) => {
            warn!("[PDF-Preview] Failed to extract text: {}", e);
            None
        }
    }
}

/// 使用 pdfium 渲染 PDF 每页为图片
fn render_pdf_pages(
    conn: &Connection,
    blobs_dir: &Path,
    pdf_bytes: &[u8],
    config: &PdfPreviewConfig,
) -> VfsResult<(PdfPreviewJson, usize)> {
    render_pdf_pages_with_progress(conn, blobs_dir, pdf_bytes, config, |_, _| {})
}

/// 使用 pdfium 渲染 PDF 每页为图片（带进度回调）
fn render_pdf_pages_with_progress<F>(
    conn: &Connection,
    blobs_dir: &Path,
    pdf_bytes: &[u8],
    config: &PdfPreviewConfig,
    progress_callback: F,
) -> VfsResult<(PdfPreviewJson, usize)>
where
    F: Fn(usize, usize),
{
    use pdfium_render::prelude::*;

    // 1. 加载 pdfium 库（使用统一加载策略）
    let pdfium = load_pdfium()?;

    // 2. 加载 PDF 文档
    let document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .map_err(|e| VfsError::Other(format!("加载 PDF 文档失败: {:?}", e)))?;

    let total_pages = document.pages().len() as usize;
    let render_pages = total_pages.min(config.max_pages);

    info!(
        "[PDF-Preview] Rendering PDF: {} pages (max: {})",
        total_pages, config.max_pages
    );

    // 3. 配置渲染参数
    let pdfium_render_config = PdfRenderConfig::new()
        .set_target_width(config.target_width as i32)
        .set_maximum_height(config.max_height as i32);

    let mut pages = Vec::with_capacity(render_pages);

    // 4. 逐页渲染
    for page_index in 0..render_pages {
        // 🆕 调用进度回调
        progress_callback(page_index + 1, render_pages);

        match render_single_page(
            conn,
            blobs_dir,
            &document,
            page_index,
            &pdfium_render_config,
            config,
        ) {
            Ok(page_preview) => {
                pages.push(page_preview);
            }
            Err(e) => {
                warn!("[PDF-Preview] Failed to render page {}: {}", page_index, e);
                // 继续渲染其他页面
            }
        }
    }

    // S-028 修复：记录截断信息，前端可据此显示 "仅渲染前 N 页" 提示
    let is_truncated = total_pages > config.max_pages;
    if is_truncated {
        warn!(
            "[PDF-Preview] PDF truncated: total {} pages, only rendered first {} pages",
            total_pages, config.max_pages
        );
    }

    let preview = PdfPreviewJson {
        pages,
        render_dpi: config.render_dpi,
        total_pages,
        rendered_at: chrono::Utc::now().to_rfc3339(),
        is_truncated,
        max_rendered_pages: config.max_pages,
    };

    info!(
        "[PDF-Preview] Rendered {} pages successfully (truncated: {})",
        preview.pages.len(),
        is_truncated,
    );

    Ok((preview, total_pages))
}

/// 渲染单页并存储到 blobs
///
/// v2.0 更新：支持 JPEG 压缩，使用快速编码减少存储空间
fn render_single_page(
    conn: &Connection,
    blobs_dir: &Path,
    document: &pdfium_render::prelude::PdfDocument,
    page_index: usize,
    render_config: &pdfium_render::prelude::PdfRenderConfig,
    preview_config: &PdfPreviewConfig,
) -> VfsResult<PdfPagePreview> {
    use image::codecs::jpeg::JpegEncoder;

    // 1. 获取页面
    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| VfsError::Other(format!("获取页面 {} 失败: {:?}", page_index, e)))?;

    // 2. 渲染为位图
    let bitmap = page
        .render_with_config(render_config)
        .map_err(|e| VfsError::Other(format!("渲染页面 {} 失败: {:?}", page_index, e)))?;

    // 3. 转换为 RGB 图像
    let image = bitmap.as_image();
    let rgb_image = image.to_rgb8();
    let (width, height) = rgb_image.dimensions();

    // 4. 编码为 JPEG（v2.0：使用 JPEG 替代 PNG，减少存储空间）
    let (image_bytes, mime_type, extension) = if preview_config.compression_enabled {
        // 使用 JPEG 编码（快速模式）
        let mut jpeg_bytes = Vec::new();
        let mut encoder =
            JpegEncoder::new_with_quality(&mut jpeg_bytes, preview_config.jpeg_quality);
        encoder
            .encode(rgb_image.as_raw(), width, height, image::ColorType::Rgb8)
            .map_err(|e| VfsError::Other(format!("编码 JPEG 失败: {:?}", e)))?;

        (jpeg_bytes, "image/jpeg", "jpg")
    } else {
        // 保持 PNG 格式（无损）
        use image::ImageFormat;
        let mut png_bytes = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        rgb_image
            .write_to(&mut cursor, ImageFormat::Png)
            .map_err(|e| VfsError::Other(format!("编码 PNG 失败: {:?}", e)))?;

        (png_bytes, "image/png", "png")
    };

    // 5. 存储到 blobs 并获取 hash
    let blob = VfsBlobRepo::store_blob_with_conn(
        conn,
        blobs_dir,
        &image_bytes,
        Some(mime_type),
        Some(extension),
    )?;
    let blob_hash = blob.hash;

    debug!(
        "[PDF-Preview] Page {} rendered: {}x{}, size={} bytes, format={}, hash={}",
        page_index,
        width,
        height,
        image_bytes.len(),
        mime_type,
        &blob_hash[..16]
    );

    Ok(PdfPagePreview {
        page_index,
        blob_hash,
        width,
        height,
        mime_type: mime_type.to_string(),
        compressed_blob_hash: None,
    })
}

/// 统一 Pdfium 库加载策略（委托给公共模块，使用全局单例）
///
/// ★ P0 修复：优先尝试应用捆绑库，然后回退到系统库
/// 确保移动端和桌面端使用一致的渲染引擎
fn load_pdfium() -> VfsResult<&'static pdfium_render::prelude::Pdfium> {
    crate::pdfium_utils::load_pdfium().map_err(|e| VfsError::Other(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pdf_preview_config_default() {
        let config = PdfPreviewConfig::default();
        assert_eq!(config.render_dpi, 150);
        assert_eq!(config.max_pages, 50);
        assert_eq!(config.target_width, 1200);
        assert_eq!(config.max_height, 1600);
        assert_eq!(config.jpeg_quality, 75);
        assert!(config.compression_enabled);
    }
}
