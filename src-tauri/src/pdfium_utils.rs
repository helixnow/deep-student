//! Pdfium 公共工具模块
//!
//! 提供跨模块的 pdfium 库加载和 PDF 文本提取功能。
//! 统一加载策略：优先应用捆绑库 → 回退系统库。
//!
//! ## 使用者
//! - `vfs/repos/pdf_preview.rs`：PDF 预渲染与文本提取
//! - `document_parser.rs`：文档解析器
//! - `pdf_ocr_service.rs`：PDF OCR 服务

use pdfium_render::prelude::*;
use std::path::Path;
use std::sync::OnceLock;
use tracing::{debug, error, info};

/// 线程安全的 Pdfium 包装
///
/// pdfium-render 0.8.37 移除了 `PdfiumLibraryBindings` 的 `Send + Sync` trait bound，
/// 但 `thread_safe` feature 已启用，底层 pdfium 库保证线程安全。
/// 此包装让 Pdfium 实例可存入 `OnceLock` 等要求 `Send + Sync` 的容器。
struct SyncPdfium(Pdfium);

// SAFETY: pdfium-render 的 `thread_safe` feature 通过互斥锁保证了线程安全
unsafe impl Send for SyncPdfium {}
unsafe impl Sync for SyncPdfium {}

/// 全局 Pdfium 实例缓存
///
/// 使用 OnceLock 确保只初始化一次，避免重复加载动态库的开销。
/// pdfium-render 的 `thread_safe` feature 已启用，Pdfium 实例可安全跨线程共享。
static PDFIUM_INSTANCE: OnceLock<Result<SyncPdfium, String>> = OnceLock::new();

/// 获取全局 Pdfium 实例（惰性初始化，首次调用时加载库）
///
/// 加载策略：
/// 1. 优先从应用资源目录加载（移动端/沙盒环境）
/// 2. 回退到系统库（桌面端）
///
/// ## 性能
/// 首次调用会加载动态库（约几十毫秒），后续调用直接返回缓存的实例引用。
///
/// ## 错误
/// 如果所有加载方式都失败，返回错误描述（也会被缓存，避免重复尝试加载）
pub fn load_pdfium() -> Result<&'static Pdfium, String> {
    PDFIUM_INSTANCE
        .get_or_init(|| init_pdfium())
        .as_ref()
        .map(|sp| &sp.0)
        .map_err(|e| e.clone())
}

/// 内部初始化函数（只调用一次）
fn init_pdfium() -> Result<SyncPdfium, String> {
    // 1. 尝试从应用资源目录加载（移动端/沙盒环境）
    if let Some(lib_path) = get_bundled_pdfium_path() {
        if lib_path.exists() {
            match Pdfium::bind_to_library(&lib_path) {
                Ok(bindings) => {
                    info!("[Pdfium] Using app-bundled library: {:?}", lib_path);
                    return Ok(SyncPdfium(Pdfium::new(bindings)));
                }
                Err(e) => {
                    debug!("[Pdfium] App-bundled library failed: {:?}", e);
                }
            }
        }
    }

    // 2. 回退到系统库（桌面端）
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => {
            info!("[Pdfium] Using system library");
            Ok(SyncPdfium(Pdfium::new(bindings)))
        }
        Err(e) => {
            error!("[Pdfium] No pdfium library available: {:?}", e);
            Err(format!(
                "PDF 功能不可用：未找到 pdfium 库。\
                 桌面端请确保 libpdfium 在系统路径中。\
                 移动端需在应用包中内嵌 pdfium 库。错误: {:?}",
                e
            ))
        }
    }
}

/// 使用 pdfium 从文件路径提取全部文本（避免将大文件全部读入内存）
///
/// ## 参数
/// - `pdfium`: Pdfium 实例引用
/// - `file_path`: PDF 文件路径
///
/// ## 返回
/// - `Ok(String)`: 提取的文本
/// - `Err(String)`: 加载失败
pub fn extract_text_from_pdf_file(pdfium: &Pdfium, file_path: &Path) -> Result<String, String> {
    let document = pdfium
        .load_pdf_from_file(file_path, None)
        .map_err(|e| format!("PDF文档加载失败: {:?}", e))?;

    extract_text_from_document(&document)
}

/// 使用 pdfium 从 PDF 字节流中提取全部文本
///
/// 逐页提取文本，页间以换行符分隔。
/// 对于无法提取文本的页面，静默跳过。
///
/// ## 参数
/// - `pdfium`: 已加载的 Pdfium 实例
/// - `pdf_bytes`: PDF 文件字节
///
/// ## 返回
/// - `Ok(String)`: 提取的文本（可能为空字符串）
/// - `Err(String)`: 加载 PDF 失败
pub fn extract_text_from_pdf_bytes(pdfium: &Pdfium, pdf_bytes: &[u8]) -> Result<String, String> {
    let document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .map_err(|e| format!("PDF文档加载失败: {:?}", e))?;

    extract_text_from_document(&document)
}

/// 从已加载的 PdfDocument 中提取全部文本（内部共享逻辑）
fn extract_text_from_document(document: &PdfDocument) -> Result<String, String> {
    let mut all_text = String::new();
    let total_pages = document.pages().len();

    for i in 0..total_pages {
        match document.pages().get(i) {
            Ok(page) => match page.text() {
                Ok(text_page) => {
                    let page_text = text_page.all();
                    if !page_text.trim().is_empty() {
                        if !all_text.is_empty() {
                            all_text.push('\n');
                        }
                        all_text.push_str(&page_text);
                    }
                }
                Err(e) => {
                    debug!("[Pdfium] Failed to extract text from page {}: {:?}", i, e);
                }
            },
            Err(e) => {
                debug!("[Pdfium] Failed to get page {}: {:?}", i, e);
            }
        }
    }

    Ok(all_text)
}

/// 获取应用捆绑的 pdfium 库路径
///
/// 各平台路径约定：
/// - macOS: App.app/Contents/Frameworks/libpdfium.dylib
/// - Windows: App/pdfium.dll
/// - Linux: App/lib/libpdfium.so
/// - Android: 由系统 JNI 加载，返回 None
/// - iOS: 由框架内嵌加载，返回 None
fn get_bundled_pdfium_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.join("../Frameworks/libpdfium.dylib"));
    }

    #[cfg(target_os = "windows")]
    {
        return std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.join("pdfium.dll"));
    }

    #[cfg(target_os = "linux")]
    {
        return std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.join("lib/libpdfium.so"));
    }

    #[cfg(target_os = "android")]
    {
        // Android 通过 System.loadLibrary 加载，由 pdfium-render 的 Android 支持处理
        return None;
    }

    #[cfg(target_os = "ios")]
    {
        // iOS 通过 framework 加载，路径需要根据实际打包方式调整
        return None;
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux",
        target_os = "android",
        target_os = "ios"
    )))]
    {
        None
    }
}
