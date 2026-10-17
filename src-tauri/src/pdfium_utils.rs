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
        .get_or_init(init_pdfium)
        .as_ref()
        .map(|sp| &sp.0)
        .map_err(|e| e.clone())
}

/// 内部初始化函数（只调用一次）
fn init_pdfium() -> Result<SyncPdfium, String> {
    // 收集所有候选路径，逐一尝试
    let candidates = get_pdfium_candidate_paths();
    let mut bind_failures: Vec<String> = Vec::new();

    for path in &candidates {
        if path.exists() {
            match Pdfium::bind_to_library(path) {
                Ok(bindings) => {
                    info!("[Pdfium] Loaded library from: {:?}", path);
                    return Ok(SyncPdfium(Pdfium::new(bindings)));
                }
                Err(e) => {
                    bind_failures.push(format!("{:?} => {:?}", path, e));
                    debug!("[Pdfium] Failed to bind {:?}: {:?}", path, e);
                }
            }
        } else {
            debug!("[Pdfium] Candidate not found: {:?}", path);
        }
    }

    // Android: 尝试直接 dlopen 库名（jniLibs 中的 .so 在 linker 搜索路径上）
    #[cfg(target_os = "android")]
    {
        match Pdfium::bind_to_library("libpdfium.so") {
            Ok(bindings) => {
                info!("[Pdfium] Loaded via dlopen(\"libpdfium.so\") on Android");
                return Ok(SyncPdfium(Pdfium::new(bindings)));
            }
            Err(e) => {
                debug!("[Pdfium] Android dlopen(\"libpdfium.so\") failed: {:?}", e);
            }
        }
    }

    // 最后回退到系统库（dlopen 搜索）
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => {
            info!("[Pdfium] Using system library");
            Ok(SyncPdfium(Pdfium::new(bindings)))
        }
        Err(e) => {
            let bind_failure_summary = if bind_failures.is_empty() {
                "none".to_string()
            } else {
                bind_failures.join(" | ")
            };
            error!(
                "[Pdfium] No pdfium library available. Tried {} paths: {:?}. Bind failures: {}. System fallback error: {:?}",
                candidates.len(), candidates, bind_failure_summary, e
            );
            Err(format!(
                "PDF 功能不可用：未找到 pdfium 库。\
                 搜索了 {} 个路径均未找到。\
                 候选库绑定失败：{}。\
                 桌面端请确保 libpdfium 在系统路径或应用目录中。错误: {:?}",
                candidates.len(),
                bind_failure_summary,
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

/// PDF 页间分隔符（与 pdftotext 约定一致的换页符）：索引按页拆分单元时据此对齐页码
pub const PDF_PAGE_SEPARATOR: char = '\u{000C}';

/// 从已加载的 PdfDocument 中提取全部文本（内部共享逻辑）
///
/// 每页之间（含空页）插入 [`PDF_PAGE_SEPARATOR`]，第 i 段即第 i 页，
/// 知识库据此按页建索引、引用精确到页。
fn extract_text_from_document(document: &PdfDocument) -> Result<String, String> {
    let mut all_text = String::new();
    let total_pages = document.pages().len();

    for i in 0..total_pages {
        if i > 0 {
            all_text.push(PDF_PAGE_SEPARATOR);
        }
        match document.pages().get(i) {
            Ok(page) => match page.text() {
                Ok(text_page) => {
                    let page_text = text_page.all();
                    if !page_text.trim().is_empty() {
                        all_text.push_str(page_text.replace(PDF_PAGE_SEPARATOR, "\n").trim());
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

/// Tauri 命令：测试 pdfium 加载状态，返回诊断信息
#[tauri::command]
pub fn test_pdfium_status() -> Result<std::collections::HashMap<String, String>, String> {
    let mut info = std::collections::HashMap::new();

    // 1. 报告 exe 路径
    if let Ok(exe) = std::env::current_exe() {
        info.insert("exe_path".into(), format!("{:?}", exe));
        if let Some(dir) = exe.parent() {
            info.insert("exe_dir".into(), format!("{:?}", dir));
        }
    }

    // 2. 报告候选路径
    let candidates = get_pdfium_candidate_paths();
    for (i, p) in candidates.iter().enumerate() {
        let exists = p.exists();
        info.insert(
            format!("candidate_{}", i),
            format!("{:?} (exists={})", p, exists),
        );
    }

    // 3. 尝试加载
    match load_pdfium() {
        Ok(pdfium) => {
            info.insert("load_result".into(), "OK".into());
            // 4. 尝试解析一个最小 PDF
            let minimal_pdf = b"%PDF-1.0\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000043 00000 n \n0000000098 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n167\n%%EOF";
            match pdfium.load_pdf_from_byte_slice(minimal_pdf, None) {
                Ok(doc) => {
                    info.insert(
                        "parse_test".into(),
                        format!("OK, pages={}", doc.pages().len()),
                    );
                }
                Err(e) => {
                    info.insert("parse_test".into(), format!("FAIL: {:?}", e));
                }
            }
        }
        Err(e) => {
            info.insert("load_result".into(), format!("FAIL: {}", e));
        }
    }

    Ok(info)
}

/// 获取所有候选 pdfium 库路径（按优先级排列）
///
/// 搜索顺序（因平台而异）：
/// - macOS: exe 同目录 → ../Resources/ → ../Frameworks/
/// - Windows: exe 同目录 → ../Resources/
/// - Linux: exe 同目录 → 扫描 ../lib/<productName>/ → ../Resources/ → AppImage $APPDIR
/// - Android: exe 同目录 → /proc/self/maps 推断 native lib 目录
/// - iOS: 空（由系统加载）
fn get_pdfium_candidate_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let Some(exe_dir) = exe_dir else {
        return paths;
    };

    #[cfg(target_os = "macos")]
    {
        // 1. 可执行文件同目录（dev: target/debug/libpdfium.dylib）
        paths.push(exe_dir.join("libpdfium.dylib"));
        // 2. Tauri bundle Resources 目录（release: Contents/Resources/libpdfium.dylib）
        paths.push(exe_dir.join("../Resources/libpdfium.dylib"));
        // 3. Frameworks 目录（旧路径，保持兼容）
        paths.push(exe_dir.join("../Frameworks/libpdfium.dylib"));
    }

    #[cfg(target_os = "windows")]
    {
        paths.push(exe_dir.join("pdfium.dll"));
        paths.push(exe_dir.join("../Resources/pdfium.dll"));
    }

    #[cfg(target_os = "linux")]
    {
        // 1. 可执行文件同目录（dev: target/debug/libpdfium.so）
        paths.push(exe_dir.join("libpdfium.so"));

        // 2. Tauri 资源目录：deb/rpm 安装在 /usr/lib/<productName>/ 下。
        //    productName 实际是 "Deep Student"（含空格与大写），早期实现
        //    硬编码了小写连字符目录（/usr/lib/deep-student/），导致 deb 安装
        //    后永远找不到 libpdfium.so（#480）。改为扫描 lib 根目录的一级
        //    子目录，productName 再变也不需要同步改这里。
        if let Some(lib_root) = exe_dir.parent().map(|p| p.join("lib")) {
            push_existing_pdfium_in_child_dirs(&mut paths, &lib_root);
        }
        // 兼容旧布局：资源文件直接放在可执行文件旁的 Resources 目录
        paths.push(exe_dir.join("../Resources/libpdfium.so"));

        // 3. AppImage：APPDIR 指向解包目录，资源同样位于
        //    $APPDIR/usr/lib/<productName>/ 下。
        if let Ok(appdir) = std::env::var("APPDIR") {
            let appdir = std::path::PathBuf::from(appdir);
            push_existing_pdfium_in_child_dirs(&mut paths, &appdir.join("usr/lib"));
            // 旧版打包路径，保持兼容
            let legacy = appdir.join("usr/lib/deep-student/libpdfium.so");
            if !paths.contains(&legacy) {
                paths.push(legacy);
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        // Android: .so 通过 jniLibs 打包到 APK，运行时解压到 nativeLibraryDir
        // 典型路径: /data/app/~~xxx==/com.example.app-xxx==/lib/arm64/libpdfium.so
        // 也尝试 exe 同目录（某些设备）
        paths.push(exe_dir.join("libpdfium.so"));

        // 尝试从 /proc/self/maps 推断 native lib 目录
        if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
            for line in maps.lines() {
                if line.contains("libdeep_student") || line.contains("libapp") {
                    // 从映射行提取目录路径
                    if let Some(path_start) = line.rfind('/') {
                        let dir = &line[line.find('/').unwrap_or(0)..path_start];
                        let candidate = std::path::PathBuf::from(dir).join("libpdfium.so");
                        if !paths.contains(&candidate) {
                            paths.push(candidate);
                        }
                    }
                    break;
                }
            }
        }
    }

    // iOS: 由系统加载，不添加候选路径

    paths
}

/// 扫描 `root` 的一级子目录，把其中存在的 `libpdfium.so` 追加到候选列表。
///
/// Tauri 的 Linux 资源目录名取自 `productName`（本项目为 `Deep Student`，
/// 含空格与大写），且可能随品牌文案变化。扫描目录而不是硬编码目录名，
/// 避免打包路径与查找路径再次漂移（#480）。
#[cfg(target_os = "linux")]
fn push_existing_pdfium_in_child_dirs(paths: &mut Vec<std::path::PathBuf>, root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join("libpdfium.so");
        if candidate.is_file() && !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn linux_candidate_scan_finds_product_name_dir_with_spaces() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let lib_root = tmp.path().join("lib");
        // Tauri deb/rpm 资源目录：/usr/lib/Deep Student/
        let product_dir = lib_root.join("Deep Student");
        std::fs::create_dir_all(&product_dir).unwrap();
        let expected = product_dir.join("libpdfium.so");
        std::fs::write(&expected, b"stub").unwrap();
        // 干扰项：没有 libpdfium.so 的子目录、根下同名文件都不应进候选
        std::fs::create_dir_all(lib_root.join("empty-dir")).unwrap();
        std::fs::write(lib_root.join("libpdfium.so"), b"stub").unwrap();

        let mut paths = Vec::new();
        push_existing_pdfium_in_child_dirs(&mut paths, &lib_root);
        // 重复调用不应追加重复候选
        push_existing_pdfium_in_child_dirs(&mut paths, &lib_root);

        assert_eq!(paths, vec![expected]);
    }

    #[test]
    fn linux_candidate_scan_skips_missing_root() {
        let mut paths = vec![std::path::PathBuf::from("/nonexistent/libpdfium.so")];
        push_existing_pdfium_in_child_dirs(&mut paths, Path::new("/nonexistent-dsw-480"));
        assert_eq!(paths.len(), 1);
    }
}
