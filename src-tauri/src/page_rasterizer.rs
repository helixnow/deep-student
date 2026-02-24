//! Stage 1: Page Rasterizer — 统一的文档→页面图片渲染器
//!
//! Visual-First 管线的第一阶段：将所有文档格式归一化为高清页面图片。
//!
//! 设计要点：
//! - 拆分 CPU 密集的渲染（可 spawn_blocking）与 DB 存储（需 async 上下文）
//! - 包含完整的安全检查（ZIP Bomb / 加密 / 文件大小限制）
//! - 渲染后立即释放原始文档字节，只保留页面图片

use base64::Engine;
use image::GenericImageView;
use pdfium_render::prelude::PdfRenderConfig;
use tracing::{debug, info, warn};

use crate::document_parser::DocumentParser;
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsBlobRepo;

const RENDER_DPI: f32 = 300.0;
const PAGE_WIDTH_INCHES: f32 = 8.5;
const PAGE_HEIGHT_INCHES: f32 = 14.0;
const MAX_DOCUMENT_SIZE: usize = 200 * 1024 * 1024;

/// 单个页面的渲染结果（不含原始图片字节以节省内存）
#[derive(Debug, Clone)]
pub struct PageSlice {
    pub page_index: usize,
    pub blob_hash: String,
    pub text_hint: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// 渲染器整体输出
#[derive(Debug, Clone)]
pub struct RasterizerResult {
    pub pages: Vec<PageSlice>,
    pub source_format: String,
}

/// 渲染阶段的中间产物（纯 CPU 计算，可在 spawn_blocking 中运行）
struct RenderedPage {
    page_index: usize,
    image_bytes: Vec<u8>,
    text_hint: Option<String>,
    width: u32,
    height: u32,
}

#[derive(Debug)]
enum DocxConversionResult {
    PdfBytes(Vec<u8>),
    NotAvailable(String),
}

pub struct PageRasterizer;

impl PageRasterizer {
    /// PDF base64 → 高清页面图片（300 DPI）+ text_hint
    ///
    /// 内部拆分为两步：
    /// 1. `render_pdf_pages`（纯 CPU，可 spawn_blocking）
    /// 2. 将渲染结果存入 VFS Blob
    pub fn rasterize_pdf(
        base64_content: &str,
        vfs_db: &VfsDatabase,
    ) -> Result<RasterizerResult, AppError> {
        let pdf_bytes = Self::decode_base64(base64_content)?;
        Self::check_file_size(pdf_bytes.len())?;

        // 安全检查：PDF 加密检测
        let parser = DocumentParser::new();
        parser
            .check_pdf_encryption_bytes(&pdf_bytes, "document.pdf")
            .map_err(|e| AppError::validation(format!("{}", e)))?;

        let rendered = Self::render_pdf_pages(&pdf_bytes)?;
        Self::store_rendered_pages(rendered, "pdf", vfs_db)
    }

    /// 纯 CPU 渲染（不涉及 DB，可安全在 spawn_blocking 中调用）
    fn render_pdf_pages(pdf_bytes: &[u8]) -> Result<Vec<RenderedPage>, AppError> {
        let pdfium = crate::pdfium_utils::load_pdfium()
            .map_err(|e| AppError::internal(format!("加载 pdfium 失败: {}", e)))?;

        let document = pdfium
            .load_pdf_from_byte_slice(pdf_bytes, None)
            .map_err(|e| AppError::validation(format!("PDF 加载失败: {:?}", e)))?;

        let total_pages = document.pages().len() as usize;
        if total_pages == 0 {
            return Err(AppError::validation("PDF 中没有页面"));
        }

        info!(
            "[PageRasterizer] PDF 共 {} 页，开始 {}DPI 渲染",
            total_pages, RENDER_DPI as u32
        );

        let render_config = PdfRenderConfig::new()
            .set_target_width((RENDER_DPI * PAGE_WIDTH_INCHES) as i32)
            .set_maximum_height((RENDER_DPI * PAGE_HEIGHT_INCHES) as i32);

        let mut rendered = Vec::with_capacity(total_pages);

        for page_idx in 0..total_pages {
            let page = document
                .pages()
                .get(safe_page_index(page_idx)?)
                .map_err(|e| {
                    AppError::internal(format!("获取页面 {} 失败: {:?}", page_idx + 1, e))
                })?;

            let text_hint = match page.text() {
                Ok(tp) => {
                    let text = tp.all().trim().to_string();
                    if text.is_empty() {
                        None
                    } else {
                        Some(text)
                    }
                }
                Err(_) => None,
            };

            let bitmap = page.render_with_config(&render_config).map_err(|e| {
                AppError::internal(format!("渲染页面 {} 失败: {:?}", page_idx + 1, e))
            })?;

            let dynamic_image = bitmap.as_image();
            let rgb_image = dynamic_image.to_rgb8();
            let (width, height) = (rgb_image.width(), rgb_image.height());

            let mut jpeg_buffer = std::io::Cursor::new(Vec::new());
            rgb_image
                .write_to(&mut jpeg_buffer, image::ImageFormat::Jpeg)
                .map_err(|e| {
                    AppError::internal(format!("编码页面 {} JPEG 失败: {}", page_idx + 1, e))
                })?;

            rendered.push(RenderedPage {
                page_index: page_idx,
                image_bytes: jpeg_buffer.into_inner(),
                text_hint,
                width,
                height,
            });
        }

        Ok(rendered)
    }

    /// 将渲染结果存入 VFS Blob 并生成 PageSlice
    fn store_rendered_pages(
        rendered: Vec<RenderedPage>,
        source_format: &str,
        vfs_db: &VfsDatabase,
    ) -> Result<RasterizerResult, AppError> {
        let total = rendered.len();
        let mut pages = Vec::with_capacity(total);

        for rp in rendered {
            let blob =
                VfsBlobRepo::store_blob(vfs_db, &rp.image_bytes, Some("image/jpeg"), Some("jpg"))
                    .map_err(|e| {
                        AppError::database(format!(
                            "页面 {} Blob 存储失败: {}",
                            rp.page_index + 1,
                            e
                        ))
                    })?;

            debug!(
                "[PageRasterizer] 页面 {}/{}: {}x{}, text_hint={} chars, blob={}",
                rp.page_index + 1,
                total,
                rp.width,
                rp.height,
                rp.text_hint.as_ref().map(|t| t.len()).unwrap_or(0),
                &blob.hash[..blob.hash.len().min(12)]
            );

            pages.push(PageSlice {
                page_index: rp.page_index,
                blob_hash: blob.hash,
                text_hint: rp.text_hint,
                width: rp.width,
                height: rp.height,
            });
        }

        info!(
            "[PageRasterizer] 渲染完成: {} 页, {} 页有 text_hint",
            pages.len(),
            pages.iter().filter(|p| p.text_hint.is_some()).count()
        );

        Ok(RasterizerResult {
            pages,
            source_format: source_format.to_string(),
        })
    }

    /// 图片 base64（单张或 JSON 数组）→ PageSlice 列表
    pub fn rasterize_images(
        content: &str,
        vfs_db: &VfsDatabase,
    ) -> Result<RasterizerResult, AppError> {
        let base64_images: Vec<String> = if content.trim_start().starts_with('[') {
            serde_json::from_str(content)
                .map_err(|e| AppError::validation(format!("解析图片列表失败: {}", e)))?
        } else {
            vec![content.to_string()]
        };

        if base64_images.is_empty() {
            return Err(AppError::validation("图片列表为空"));
        }

        info!("[PageRasterizer] 处理 {} 张图片", base64_images.len());

        let mut pages = Vec::with_capacity(base64_images.len());

        for (idx, b64) in base64_images.iter().enumerate() {
            let raw_b64 = if let Some(pos) = b64.find(',') {
                &b64[pos + 1..]
            } else {
                b64.as_str()
            };

            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw_b64)
                .map_err(|e| {
                    AppError::validation(format!("图片 {} base64 解码失败: {}", idx + 1, e))
                })?;

            Self::check_file_size(bytes.len())?;

            let (width, height) = match image::load_from_memory(&bytes) {
                Ok(img) => img.dimensions(),
                Err(_) => (0, 0),
            };

            let (mime, ext) = detect_image_format(&bytes);

            let blob = VfsBlobRepo::store_blob(vfs_db, &bytes, Some(mime), Some(ext))
                .map_err(|e| {
                    AppError::database(format!("图片 {} Blob 存储失败: {}", idx + 1, e))
                })?;

            pages.push(PageSlice {
                page_index: idx,
                blob_hash: blob.hash,
                text_hint: None,
                width,
                height,
            });
        }

        info!("[PageRasterizer] 图片处理完成: {} 页", pages.len());

        Ok(RasterizerResult {
            pages,
            source_format: "image".to_string(),
        })
    }

    /// DOCX base64 → 尝试系统级转 PDF → 渲染为页面图片
    pub fn rasterize_docx(
        base64_content: &str,
        vfs_db: &VfsDatabase,
    ) -> Result<RasterizerResult, AppError> {
        let docx_bytes = Self::decode_base64(base64_content)?;
        Self::check_file_size(docx_bytes.len())?;

        // 安全检查
        let parser = DocumentParser::new();
        parser
            .check_office_encryption_bytes(&docx_bytes, "document.docx")
            .map_err(|e| AppError::validation(format!("{}", e)))?;
        parser
            .check_zip_bomb_bytes(&docx_bytes, "document.docx")
            .map_err(|e| AppError::validation(format!("{}", e)))?;

        let temp_dir = std::env::temp_dir().join(format!("ds_docx2pdf_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

        let docx_path = temp_dir.join("input.docx");
        let pdf_path = temp_dir.join("input.pdf");

        std::fs::write(&docx_path, &docx_bytes)
            .map_err(|e| AppError::file_system(format!("写入临时 DOCX 失败: {}", e)))?;

        let conversion = Self::convert_docx_to_pdf(&docx_path, &pdf_path);

        let result = match conversion {
            DocxConversionResult::PdfBytes(pdf_bytes) => {
                info!("[PageRasterizer] DOCX → PDF 转换成功，开始渲染");
                let rendered = Self::render_pdf_pages(&pdf_bytes)?;
                Self::store_rendered_pages(rendered, "docx", vfs_db)
            }
            DocxConversionResult::NotAvailable(reason) => Err(AppError::validation(format!(
                "DOCX → PDF 转换不可用 ({})",
                reason
            ))),
        };

        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    }

    fn convert_docx_to_pdf(
        docx_path: &std::path::Path,
        pdf_path: &std::path::Path,
    ) -> DocxConversionResult {
        #[cfg(target_os = "windows")]
        {
            if let Ok(bytes) = Self::convert_docx_to_pdf_windows(docx_path, pdf_path) {
                return DocxConversionResult::PdfBytes(bytes);
            }
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            if let Ok(bytes) = Self::convert_docx_to_pdf_soffice(docx_path, pdf_path) {
                return DocxConversionResult::PdfBytes(bytes);
            }
        }

        DocxConversionResult::NotAvailable("无可用的 DOCX→PDF 转换工具".to_string())
    }

    #[cfg(target_os = "windows")]
    fn convert_docx_to_pdf_windows(
        docx_path: &std::path::Path,
        pdf_path: &std::path::Path,
    ) -> Result<Vec<u8>, String> {
        let docx_str = docx_path.to_string_lossy().replace('\\', "\\\\");
        let pdf_str = pdf_path.to_string_lossy().replace('\\', "\\\\");

        let script = format!(
            r#"$word = New-Object -ComObject Word.Application; $word.Visible = $false; try {{ $doc = $word.Documents.Open("{}"); $doc.SaveAs([ref]"{}", [ref]17); $doc.Close(); }} finally {{ $word.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }}"#,
            docx_str, pdf_str
        );

        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("启动 PowerShell 失败: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Word COM 转换失败: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        std::fs::read(pdf_path).map_err(|e| format!("读取转换后 PDF 失败: {}", e))
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn convert_docx_to_pdf_soffice(
        docx_path: &std::path::Path,
        pdf_path: &std::path::Path,
    ) -> Result<Vec<u8>, String> {
        let out_dir = pdf_path.parent().unwrap_or(std::path::Path::new("."));

        let candidates = if cfg!(target_os = "macos") {
            vec![
                "/Applications/LibreOffice.app/Contents/MacOS/soffice",
                "soffice",
            ]
        } else {
            vec!["soffice", "/usr/bin/soffice", "/usr/bin/libreoffice"]
        };

        for bin in &candidates {
            match std::process::Command::new(bin)
                .args([
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    &out_dir.to_string_lossy(),
                    &docx_path.to_string_lossy(),
                ])
                .output()
            {
                Ok(output) if output.status.success() => {
                    return std::fs::read(pdf_path)
                        .map_err(|e| format!("读取转换后 PDF 失败: {}", e));
                }
                _ => continue,
            }
        }

        Err("LibreOffice (soffice) 未安装或不可用".to_string())
    }

    // ====== 安全 & 工具函数 ======

    fn check_file_size(size: usize) -> Result<(), AppError> {
        if size > MAX_DOCUMENT_SIZE {
            return Err(AppError::validation(format!(
                "文件大小 {}MB 超过限制 {}MB",
                size / (1024 * 1024),
                MAX_DOCUMENT_SIZE / (1024 * 1024)
            )));
        }
        Ok(())
    }

    fn decode_base64(content: &str) -> Result<Vec<u8>, AppError> {
        let raw_b64 = if content.starts_with("data:") {
            content
                .split(',')
                .nth(1)
                .ok_or_else(|| AppError::validation("Data URL 格式错误：缺少 base64 内容"))?
        } else {
            content
        };

        base64::engine::general_purpose::STANDARD
            .decode(raw_b64)
            .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))
    }
}

/// 按 blob_hash 从 VFS 读取页面图片字节（Stage 4 配图裁切时使用）
pub fn load_page_image_bytes(
    vfs_db: &VfsDatabase,
    blob_hash: &str,
) -> Result<Vec<u8>, AppError> {
    let blob_path = VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
        .map_err(|e| AppError::database(format!("查询 blob 路径失败: {}", e)))?
        .ok_or_else(|| AppError::not_found(format!("页面图片 blob 不存在: {}", blob_hash)))?;

    std::fs::read(&blob_path)
        .map_err(|e| AppError::file_system(format!("读取页面图片失败: {}", e)))
}

pub fn detect_image_format(data: &[u8]) -> (&'static str, &'static str) {
    if data.starts_with(b"\x89PNG") {
        ("image/png", "png")
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        ("image/jpeg", "jpg")
    } else if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
        ("image/webp", "webp")
    } else if data.starts_with(b"GIF8") {
        ("image/gif", "gif")
    } else if data.starts_with(b"BM") {
        ("image/bmp", "bmp")
    } else if data.len() >= 12 && &data[4..8] == b"ftyp" {
        ("image/heic", "heic")
    } else {
        ("image/png", "png")
    }
}

/// 安全的页面索引转换（避免 u16 溢出）
fn safe_page_index(idx: usize) -> Result<u16, AppError> {
    u16::try_from(idx).map_err(|_| {
        AppError::validation(format!(
            "页面索引 {} 超出 pdfium 支持的最大值 65535",
            idx
        ))
    })
}
