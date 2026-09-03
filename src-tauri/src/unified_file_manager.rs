use std::{
    borrow::Cow,
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
};

use tauri::Window;
use tauri_plugin_fs::{FsExt, OpenOptions, SafeFilePath};
use uuid::Uuid;

use crate::models::AppError;
use crate::utils::unicode::sanitize_unicode;

const SPECIAL_SCHEMES: [&str; 5] = ["content://", "asset://", "ph://", "image://", "camera://"];

// Android SAF 路径前缀 (e.g. primary:Download/QQ/file.pdf)
const ANDROID_SAF_PREFIXES: [&str; 3] = ["primary:", "secondary:", "raw:"];

#[derive(Debug)]
enum PathKind {
    Local(PathBuf),
    Virtual(String),
}

impl PathKind {
    fn display(&self) -> Cow<'_, str> {
        match self {
            PathKind::Local(path) => Cow::Owned(path.display().to_string()),
            PathKind::Virtual(url) => Cow::Borrowed(url.as_str()),
        }
    }

    fn is_virtual(&self) -> bool {
        matches!(self, PathKind::Virtual(_))
    }
}

fn is_special_scheme(path: &str) -> bool {
    let lower = path.trim_start().to_lowercase();
    SPECIAL_SCHEMES
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

fn is_android_saf_path(path: &str) -> bool {
    let lower = path.trim_start().to_lowercase();
    ANDROID_SAF_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn normalize_local_path(input: &str) -> Cow<'_, str> {
    if let Some(stripped) = input.strip_prefix("file://") {
        Cow::Owned(stripped.to_string())
    } else if let Some(stripped) = input.strip_prefix("tauri://localhost/") {
        Cow::Owned(format!("/{}", stripped))
    } else if let Some(stripped) = input.strip_prefix("tauri://") {
        Cow::Owned(format!("/{}", stripped))
    } else {
        Cow::Borrowed(input)
    }
}

fn decode_path(input: &str) -> Result<String, AppError> {
    match urlencoding::decode(input) {
        Ok(decoded) => Ok(decoded.into_owned()),
        Err(_) => Ok(input.to_string()),
    }
}

fn classify_path(raw: &str) -> Result<PathKind, AppError> {
    let trimmed = raw.trim_matches(char::from(0)).trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("路径不能为空"));
    }

    // 对于 content://, asset://, ph:// 等特殊 scheme，必须保留原始编码。
    // Android SAF 的 content:// URI 中 document ID 的 %3A、%2F 等编码具有语义意义，
    // 解码会破坏 URI 结构并导致 ContentResolver 权限校验失败（SecurityException）。
    if is_special_scheme(trimmed) {
        return Ok(PathKind::Virtual(trimmed.to_string()));
    }

    // 整段再编码的 content:// 不能当虚拟路径：一次解码会拆掉 document ID
    // 的 %3A/%2F，ContentResolver 可能 SecurityException。公开 is_virtual_uri
    // 也不认这类输入。拒绝并给可读错误，命令层不得误路由到本地半包。
    reject_double_encoded_virtual_uri(trimmed)?;

    let decoded_for_check = decode_path(trimmed).unwrap_or_else(|_| trimmed.to_string());

    if is_android_saf_path(&decoded_for_check) {
        return Ok(PathKind::Virtual(decoded_for_check));
    }

    if trimmed.starts_with("file://") || trimmed.starts_with("tauri://") {
        let normalized = normalize_local_path(trimmed);
        let decoded = decode_path(normalized.as_ref())?;
        return Ok(PathKind::Local(PathBuf::from(decoded)));
    }

    if trimmed.contains("://") {
        return Ok(PathKind::Virtual(trimmed.to_string()));
    }

    let decoded = decode_path(trimmed)?;
    Ok(PathKind::Local(PathBuf::from(decoded)))
}

fn parse_safe_path(raw: &str) -> Result<SafeFilePath, AppError> {
    SafeFilePath::from_str(raw)
        .map_err(|e| AppError::file_system(format!("无法解析系统路径 `{}`: {}", raw, e)))
}

fn open_reader(
    window: &Window,
    path: &PathKind,
) -> Result<BufReader<Box<dyn Read + Send>>, AppError> {
    match path {
        PathKind::Local(local_path) => {
            let file = File::open(local_path).map_err(|e| {
                AppError::file_system(format!("读取文件失败: {} ({})", local_path.display(), e))
            })?;
            Ok(BufReader::new(Box::new(file)))
        }
        PathKind::Virtual(uri) => {
            let safe_path = parse_safe_path(uri)?;
            let mut options = OpenOptions::new();
            options.read(true);
            let file = window
                .fs()
                .open(safe_path, options)
                .map_err(|e| AppError::file_system(format!("读取文件失败: {} ({})", uri, e)))?;
            Ok(BufReader::new(Box::new(file)))
        }
    }
}

fn open_writer(
    window: &Window,
    path: &PathKind,
    truncate: bool,
) -> Result<BufWriter<Box<dyn Write + Send>>, AppError> {
    match path {
        PathKind::Local(local_path) => {
            if let Some(parent) = local_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        AppError::file_system(format!("创建目录失败: {} ({})", parent.display(), e))
                    })?;
                }
            }

            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true);
            if truncate {
                options.truncate(true);
            }

            let file = options.open(local_path).map_err(|e| {
                AppError::file_system(format!("写入文件失败: {} ({})", local_path.display(), e))
            })?;
            Ok(BufWriter::new(Box::new(file)))
        }
        PathKind::Virtual(uri) => {
            let safe_path = parse_safe_path(uri)?;
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(truncate);
            let file = window
                .fs()
                .open(safe_path, options)
                .map_err(|e| AppError::file_system(format!("写入文件失败: {} ({})", uri, e)))?;
            Ok(BufWriter::new(Box::new(file)))
        }
    }
}

pub fn read_all_bytes(window: &Window, raw_path: &str) -> Result<Vec<u8>, AppError> {
    let path = classify_path(raw_path)?;
    let mut reader = open_reader(window, &path)?;
    let mut buffer = Vec::new();
    reader
        .read_to_end(&mut buffer)
        .map_err(|e| AppError::file_system(format!("读取文件失败: {} ({})", path.display(), e)))?;
    Ok(buffer)
}

/// 带大小上限的全量读取。
///
/// ★ 2026-07-19（安全加固）：`read_file_bytes` 命令此前无上限，前端任意 JS
/// 可将超大文件一次性载入内存。此处双重防护：
/// - 本地文件先用 `metadata().len()` 预检，超限直接报错（错误信息含实际大小）；
/// - 实际读取用 `take(max_bytes + 1)` 截断，防止预检与读取之间文件增长（TOCTOU），
///   同时覆盖无法预检大小的虚拟 URI（content:// 等）。
pub fn read_all_bytes_bounded(
    window: &Window,
    raw_path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    let path = classify_path(raw_path)?;

    if let PathKind::Local(local_path) = &path {
        let meta = std::fs::metadata(local_path).map_err(|e| {
            AppError::file_system(format!(
                "获取文件信息失败: {} ({})",
                local_path.display(),
                e
            ))
        })?;
        if meta.len() > max_bytes {
            return Err(AppError::validation(format!(
                "文件过大: {} 字节，超过读取上限 {} 字节: {}",
                meta.len(),
                max_bytes,
                path.display()
            )));
        }
    }

    let reader = open_reader(window, &path)?;
    let mut limited = reader.take(max_bytes.saturating_add(1));
    let mut buffer = Vec::new();
    limited
        .read_to_end(&mut buffer)
        .map_err(|e| AppError::file_system(format!("读取文件失败: {} ({})", path.display(), e)))?;
    if buffer.len() as u64 > max_bytes {
        return Err(AppError::validation(format!(
            "文件过大: 超过读取上限 {} 字节: {}",
            max_bytes,
            path.display()
        )));
    }
    Ok(buffer)
}

pub fn read_to_string(window: &Window, raw_path: &str) -> Result<String, AppError> {
    let bytes = read_all_bytes(window, raw_path)?;
    String::from_utf8(bytes).map_err(|_| AppError::file_system("文件编码不是有效的 UTF-8"))
}

pub fn copy_file(window: &Window, source: &str, target: &str) -> Result<u64, AppError> {
    let source_path = classify_path(source)?;
    let target_path = classify_path(target)?;

    if let PathKind::Virtual(s) = &source_path {
        if s.is_empty() {
            return Err(AppError::validation("源文件路径无效"));
        }
    }
    if let PathKind::Virtual(t) = &target_path {
        if t.is_empty() {
            return Err(AppError::validation("目标路径无效"));
        }
    }

    let mut reader = open_reader(window, &source_path)?;
    let mut writer = open_writer(window, &target_path, true)?;
    let copy_label = format!("{} -> {}", source_path.display(), target_path.display());
    let (bytes_copied, source_digest) = digest_copy(&mut reader, &mut writer, &copy_label)?;

    writer.flush().map_err(|e| {
        AppError::file_system(format!("刷新文件失败: {} ({})", target_path.display(), e))
    })?;
    drop(writer);
    drop(reader);

    // [R12-saf-verify] 不能只凭 copy+flush 报成功：部分 DocumentsProvider 延迟提交，
    // 必须重新打开目标核对长度与 SHA-256。回读失败或内容不一致一律 fail-closed。
    let mut verify_reader = open_reader(window, &target_path).map_err(|e| {
        AppError::file_system(format!(
            "目标回读失败，已停止并不得报成功: {} ({})",
            target_path.display(),
            e
        ))
    })?;
    let (verified, target_digest) = digest_read(&mut verify_reader, &target_path.display())?;
    ensure_identical_copy(
        bytes_copied,
        source_digest,
        verified,
        target_digest,
        &target_path.display(),
    )?;

    Ok(bytes_copied)
}

fn digest_copy(
    reader: &mut impl Read,
    writer: &mut impl Write,
    label: &str,
) -> Result<(u64, [u8; 32]), AppError> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| AppError::file_system(format!("复制文件失败 ({label}): {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        writer
            .write_all(&buffer[..n])
            .map_err(|e| AppError::file_system(format!("复制文件失败 ({label}): {e}")))?;
        total += n as u64;
    }
    Ok((total, hasher.finalize().into()))
}

fn digest_read(reader: &mut impl Read, label: &str) -> Result<(u64, [u8; 32]), AppError> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| AppError::file_system(format!("回读文件失败 ({label}): {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        total += n as u64;
    }
    Ok((total, hasher.finalize().into()))
}

fn ensure_identical_copy(
    copied: u64,
    source_digest: [u8; 32],
    verified: u64,
    target_digest: [u8; 32],
    target_label: &str,
) -> Result<(), AppError> {
    if copied != verified || source_digest != target_digest {
        return Err(AppError::file_system(format!(
            "目标回读校验失败: {target_label}（已写 {copied} 字节，回读 {verified} 字节，内容不一致则拒绝报成功）"
        )));
    }
    Ok(())
}

fn required_temp_copy_bytes(source_bytes: u64) -> u64 {
    source_bytes.saturating_mul(2)
}

fn ensure_enough_temp_space(
    available: u64,
    source_bytes: u64,
    label: &str,
) -> Result<(), AppError> {
    let required = required_temp_copy_bytes(source_bytes);
    if available < required {
        return Err(AppError::file_system(format!(
            "临时物化空间不足，已停止以免半包: {label}（源 {source_bytes} 字节，需要约 {required} 字节，可用 {available} 字节）"
        )));
    }
    Ok(())
}

pub fn write_text_file(window: &Window, raw_path: &str, content: &str) -> Result<(), AppError> {
    let path = classify_path(raw_path)?;
    let mut writer = open_writer(window, &path, true)?;
    writer
        .write_all(content.as_bytes())
        .map_err(|e| AppError::file_system(format!("写入文件失败: {} ({})", path.display(), e)))?;
    writer
        .flush()
        .map_err(|e| AppError::file_system(format!("刷新文件失败: {} ({})", path.display(), e)))
}

pub fn ensure_parent_exists(path: &Path) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::file_system(format!("创建目录失败: {} ({})", parent.display(), e))
            })?;
        }
    }
    Ok(())
}

pub fn sanitize_for_legacy(input: &str) -> String {
    // ★ BE-06 安全修复：先进行 Unicode 规范化
    let sanitized = sanitize_unicode(input);

    if is_special_scheme(&sanitized) {
        sanitized
    } else {
        let normalized = normalize_local_path(&sanitized);
        decode_path(normalized.as_ref()).unwrap_or_else(|_| normalized.into_owned())
    }
}

/// 判断路径是否为移动端虚拟 URI（content://, ph://, asset:// 等）或 Android SAF 路径。
///
/// 不解码：`content%3A%2F%2F...` 这类双重编码保持 false，避免命令层
/// 把拆坏的 URI 交给 ContentResolver。配合 [`reject_double_encoded_virtual_uri`]。
pub fn is_virtual_uri(path: &str) -> bool {
    let trimmed = path.trim();
    is_special_scheme(trimmed) || is_android_saf_path(trimmed)
}

/// 双重编码安全 URI 的稳定拒绝文案（命令层与锁定测共用）。
pub const DOUBLE_ENCODED_VIRTUAL_URI_REJECTED: &str =
    "路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址";

/// 原始路径不是 special scheme，但整段 URL 解码后是，则 fail-closed。
pub fn reject_double_encoded_virtual_uri(path: &str) -> Result<(), AppError> {
    let trimmed = path.trim();
    if is_special_scheme(trimmed) {
        return Ok(());
    }
    let decoded = decode_path(trimmed).unwrap_or_else(|_| trimmed.to_string());
    if is_special_scheme(&decoded) {
        return Err(AppError::validation(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED));
    }
    Ok(())
}

/// 旧版单文件队列名。MainActivity 仍双读，避免升级窗口丢掉已入队 URI。
pub const PENDING_SAF_PERSIST_FILE: &str = "pending_saf_persist.uri";

/// 新队列目录：每个 `content://` 一个 `*.uri`，原子 rename 落盘。
/// 并发导入/导出不得互相覆盖。
pub const PENDING_SAF_PERSIST_DIR: &str = "pending_saf_persist";

fn persistable_saf_entry_name(uri: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(uri.as_bytes());
    format!("{}.uri", hex::encode(&digest[..8]))
}

/// 新队列中某条 `content://` 的落盘路径（测试与 MainActivity 目录约定共用）。
pub fn persistable_saf_queue_file(app_data_dir: &Path, uri: &str) -> PathBuf {
    app_data_dir
        .join(PENDING_SAF_PERSIST_DIR)
        .join(persistable_saf_entry_name(uri))
}

/// 异步 ZIP/同步在虚拟 `content://` 上依赖当前进程 URI grant。
/// 把 URI 原子写入应用私有队列目录，交给 MainActivity 调用
/// `takePersistableUriPermission`。选择器若是 `ACTION_GET_CONTENT`，
/// 系统可能拒绝 persist——不得假装已授权。
pub fn queue_persistable_saf_uri(app_data_dir: &Path, uri: &str) -> Result<(), AppError> {
    reject_double_encoded_virtual_uri(uri)?;
    let trimmed = uri.trim();
    if !trimmed.to_ascii_lowercase().starts_with("content://") {
        return Ok(());
    }
    if trimmed.len() > 8 * 1024 || trimmed.bytes().any(|b| b == b'\n' || b == b'\r') {
        return Err(AppError::validation(
            "SAF persist 队列拒绝过长或含换行的 URI",
        ));
    }
    let queue_dir = app_data_dir.join(PENDING_SAF_PERSIST_DIR);
    std::fs::create_dir_all(&queue_dir).map_err(|e| {
        AppError::file_system(format!(
            "创建 SAF persist 队列目录失败: {} ({})",
            queue_dir.display(),
            e
        ))
    })?;
    let dest = persistable_saf_queue_file(app_data_dir, trimmed);
    let tmp = dest.with_extension("uri.tmp");
    std::fs::write(&tmp, trimmed).map_err(|e| {
        AppError::file_system(format!(
            "写入 SAF persist 队列失败: {} ({})",
            tmp.display(),
            e
        ))
    })?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::file_system(format!(
            "提交 SAF persist 队列失败: {} ({})",
            dest.display(),
            e
        ))
    })
}

/// 从任意路径（本地路径、Windows 反斜杠路径或 content:// URI）中安全提取文件名。
///
/// 对于 `content://...document/primary%3ADownload%2FQuarkDownloads%2Ffile.pdf`，
/// 解码最后一段 document ID 后返回 `file.pdf`。
/// 对于 `C:\Users\alice\Documents\file.pdf`，返回 `file.pdf`。
pub fn extract_file_name(raw_path: &str) -> String {
    let trimmed = raw_path.trim();
    // 同时处理 `/` 和 `\`：取最后一段路径组件
    let last_segment = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    // 尝试 URL 解码（content:// 的 document ID 中 %2F 代表 /）
    let decoded = urlencoding::decode(last_segment)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| last_segment.to_string());
    // 解码后可能包含子路径（如 primary:Download/QuarkDownloads/file.pdf），取最后一段
    decoded.rsplit('/').next().unwrap_or(&decoded).to_string()
}

/// 从任意路径中安全提取文件扩展名（小写，不含点号）。
pub fn extract_extension(raw_path: &str) -> Option<String> {
    let name = extract_file_name(raw_path);
    Path::new(&name)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_lowercase())
}

/// 获取文件大小（字节）。
/// - 对于本地文件，使用元数据快速获取长度。
/// - 对于虚拟/移动端安全URI，使用流式读取累计字节数，避免一次性载入内存。
pub fn get_file_size(window: &Window, raw_path: &str) -> Result<u64, AppError> {
    let path = classify_path(raw_path)?;
    match &path {
        PathKind::Local(local_path) => {
            let meta = std::fs::metadata(local_path).map_err(|e| {
                AppError::file_system(format!(
                    "获取文件信息失败: {} ({})",
                    local_path.display(),
                    e
                ))
            })?;
            Ok(meta.len())
        }
        _ => {
            let mut reader = open_reader(window, &path)?;
            let mut buf = [0u8; 1024 * 1024]; // 1MB buffer
            let mut total: u64 = 0;
            loop {
                let n = reader.read(&mut buf).map_err(|e| {
                    AppError::file_system(format!("读取文件失败: {} ({})", path.display(), e))
                })?;
                if n == 0 {
                    break;
                }
                total += n as u64;
            }
            Ok(total)
        }
    }
}

/// 计算文件的 SHA-256 哈希（十六进制小写）。
/// - 流式读取，避免一次性载入大文件。
/// - 兼容本地文件与移动端安全 URI（content:// 等）。
pub fn hash_file_sha256(window: &Window, raw_path: &str) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};

    let path = classify_path(raw_path)?;
    let mut reader = open_reader(window, &path)?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 64];
    loop {
        let n = reader.read(&mut buffer).map_err(|e| {
            AppError::file_system(format!("读取文件失败: {} ({})", path.display(), e))
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let digest = hasher.finalize();
    Ok(format!("{:x}", digest))
}

pub struct MaterializedPath {
    path: PathBuf,
    cleanup: Option<PathBuf>,
}

impl MaterializedPath {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn into_owned(mut self) -> (PathBuf, Option<PathBuf>) {
        let path = self.path.clone();
        let cleanup = self.cleanup.take();
        (path, cleanup)
    }
}

impl Drop for MaterializedPath {
    fn drop(&mut self) {
        if let Some(temp) = self.cleanup.take() {
            if let Err(err) = std::fs::remove_file(&temp) {
                eprintln!("⚠️ 临时文件清理失败: {} ({})", temp.display(), err);
            }
        }
    }
}

/// 所有支持导入的文件扩展名（小写）。
const SUPPORTED_IMPORT_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "txt", "md", "xlsx", "xls", "ods", "html", "htm", "pptx", "epub", "rtf", "csv",
    "json", "xml",
];

/// 从文件头 magic bytes 检测文件扩展名。
/// 只读取前 8 字节进行初步判断；对 ZIP 容器再读取更多字节区分 DOCX/XLSX/PPTX/EPUB/ODS。
/// 返回 None 表示无法识别。
pub fn detect_extension_from_magic(window: &Window, raw_path: &str) -> Option<String> {
    let header = read_first_bytes(window, raw_path, 8).ok()?;
    if header.len() < 4 {
        return None;
    }

    // PDF: %PDF
    if header.starts_with(b"%PDF") {
        return Some("pdf".into());
    }

    // ZIP 容器（DOCX/XLSX/PPTX/EPUB/ODS）
    if header.starts_with(b"PK\x03\x04") {
        return detect_zip_subtype(window, raw_path);
    }

    // RTF: {\rtf
    if header.starts_with(b"{\\rtf") {
        return Some("rtf".into());
    }

    // OLE2 Compound Document (旧版 .doc/.xls/.ppt)
    if header.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return None; // 不支持旧版 Office 格式
    }

    // 跳过可能的 UTF-8 BOM
    let content = if header.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &header[3..]
    } else {
        &header[..]
    };

    // XML: <?xml
    if content.starts_with(b"<?xm") {
        // 读取更多内容来区分 XML 和 HTML (XHTML)
        if let Ok(more) = read_first_bytes(window, raw_path, 512) {
            let lower = String::from_utf8_lossy(&more).to_lowercase();
            if lower.contains("<html") || lower.contains("<!doctype html") {
                return Some("html".into());
            }
        }
        return Some("xml".into());
    }

    // HTML: <html, <!DOCTYPE, <HTML
    if content.starts_with(b"<htm")
        || content.starts_with(b"<HTM")
        || content.starts_with(b"<!DO")
        || content.starts_with(b"<!do")
    {
        return Some("html".into());
    }

    // 读取更多字节做文本格式启发式检测
    let text_sample = read_first_bytes(window, raw_path, 1024).ok()?;
    let text_str = String::from_utf8_lossy(&text_sample);
    let trimmed_text = text_str.trim_start_matches('\u{FEFF}').trim();

    // JSON: 以 { 或 [ 开头
    if (trimmed_text.starts_with('{') || trimmed_text.starts_with('['))
        && (serde_json::from_str::<serde_json::Value>(trimmed_text).is_ok()
            || trimmed_text.len() >= 1024)
    {
        return Some("json".into());
    }

    // CSV 启发式：多行、含逗号分隔
    if looks_like_csv(trimmed_text) {
        return Some("csv".into());
    }

    // Markdown 启发式：含 # 标题或 ```代码块
    if looks_like_markdown(trimmed_text) {
        return Some("md".into());
    }

    // 纯文本兜底：全部为合法 UTF-8 可打印字符
    if !text_sample.is_empty() && std::str::from_utf8(&text_sample).is_ok() {
        return Some("txt".into());
    }

    None
}

/// 读取文件的前 N 字节。兼容本地路径与 content:// 等虚拟 URI。
fn read_first_bytes(window: &Window, raw_path: &str, n: usize) -> Result<Vec<u8>, AppError> {
    let path = classify_path(raw_path)?;
    let mut reader = open_reader(window, &path)?;
    let mut buf = vec![0u8; n];
    let mut total = 0;
    while total < n {
        let read = reader.read(&mut buf[total..]).map_err(|e| {
            AppError::file_system(format!("读取文件头失败: {} ({})", path.display(), e))
        })?;
        if read == 0 {
            break;
        }
        total += read;
    }
    buf.truncate(total);
    Ok(buf)
}

/// 对 ZIP 容器，通过扫描 Local File Header 中的文件名区分 DOCX/XLSX/PPTX/EPUB/ODS。
///
/// 不使用 `ZipArchive::new()`，因为它需要文件末尾的 End-of-Central-Directory 记录，
/// 而我们只读取了前 N 字节——对大文件（>64KB）会失败。
/// 改为直接解析 ZIP Local File Header（位于文件头部），只需前 64KB 即可覆盖大多数条目名称。
fn detect_zip_subtype(window: &Window, raw_path: &str) -> Option<String> {
    let data = read_first_bytes(window, raw_path, 64 * 1024).ok()?;

    // 手动解析 ZIP Local File Headers 提取条目名称
    let mut offset = 0;
    let mut has_content_xml = false;
    let mut mimetype_content: Option<String> = None;

    while offset + 30 <= data.len() {
        // Local File Header signature = PK\x03\x04
        if data[offset..offset + 4] != [0x50, 0x4B, 0x03, 0x04] {
            break;
        }

        let name_len = u16::from_le_bytes([data[offset + 26], data[offset + 27]]) as usize;
        let extra_len = u16::from_le_bytes([data[offset + 28], data[offset + 29]]) as usize;
        let compressed_size = u32::from_le_bytes([
            data[offset + 18],
            data[offset + 19],
            data[offset + 20],
            data[offset + 21],
        ]) as usize;

        let name_start = offset + 30;
        let name_end = name_start + name_len;
        if name_end > data.len() {
            break;
        }

        let entry_name = String::from_utf8_lossy(&data[name_start..name_end]).to_lowercase();

        if entry_name.starts_with("word/") {
            return Some("docx".into());
        }
        if entry_name.starts_with("xl/") {
            return Some("xlsx".into());
        }
        if entry_name.starts_with("ppt/") {
            return Some("pptx".into());
        }
        if entry_name == "meta-inf/container.xml" {
            return Some("epub".into());
        }
        if entry_name == "content.xml" {
            has_content_xml = true;
        }

        // 读取 mimetype 条目的内容（通常是 ZIP 中的第一个条目，且不压缩）
        if entry_name == "mimetype" {
            let data_start = name_end + extra_len;
            let data_end = data_start + compressed_size;
            if data_end <= data.len() {
                let mime = String::from_utf8_lossy(&data[data_start..data_end]);
                mimetype_content = Some(mime.to_string());
            }
        }

        // 跳到下一个 Local File Header
        let next_offset = name_end + extra_len + compressed_size;
        if next_offset <= offset {
            break; // 防止无限循环
        }
        offset = next_offset;
    }

    // ODF 判断
    if let Some(ref mime) = mimetype_content {
        if mime.contains("spreadsheet") {
            return Some("ods".into());
        }
        if mime.contains("presentation") {
            return Some("pptx".into());
        }
        if mime.contains("text") || mime.contains("opendocument") {
            return Some("docx".into());
        }
    }
    if has_content_xml || mimetype_content.is_some() {
        return Some("ods".into()); // ODF 兜底
    }

    None
}

fn looks_like_csv(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().take(5).collect();
    if lines.len() < 2 {
        return false;
    }
    let comma_counts: Vec<usize> = lines.iter().map(|l| l.matches(',').count()).collect();
    // 至少每行有 1 个逗号，且各行逗号数量一致
    comma_counts[0] >= 1 && comma_counts.iter().all(|&c| c == comma_counts[0])
}

fn looks_like_markdown(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().take(20).collect();
    lines
        .iter()
        .any(|l| l.starts_with('#') || l.starts_with("```") || l.starts_with("- "))
}

/// 清洗文件名中不安全的字符（`:` `?` `*` `"` `<` `>` `|`），替换为 `_`。
pub fn sanitize_file_name_for_fs(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            ':' | '?' | '*' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

/// 判断提取出的文件名是否像 Android document ID（而非真实文件名）。
/// 例如 `document:1000019790`、`image:12345`、`msf:62`、纯数字 `446` 等。
pub fn is_opaque_document_id(name: &str) -> bool {
    // 含冒号且冒号后全是数字（如 document:1000019790、image:12345、msf:62）
    if let Some(pos) = name.find(':') {
        let after = &name[pos + 1..];
        if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    // 纯数字（如 Downloads provider 的 446）
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    false
}

/// 为 content:// URI 解析出可用的文件名和扩展名。
///
/// 三层降级策略：
/// 1. 从 URI 路径提取文件名（适用于 ExternalStorage / raw 路径）
/// 2. 若提取的名字是不透明 ID（无扩展名），用 magic bytes 检测文件类型
/// 3. 若仍无法识别，返回 None 扩展名
///
/// 返回 `(display_name, Option<extension>)`。
pub fn resolve_file_info(window: &Window, raw_path: &str) -> (String, Option<String>) {
    let uri_name = extract_file_name(raw_path);
    let uri_ext = Path::new(&uri_name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase());

    // Layer 1: URI 路径已包含有效扩展名
    if let Some(ref ext) = uri_ext {
        if SUPPORTED_IMPORT_EXTENSIONS.contains(&ext.as_str()) || !is_opaque_document_id(&uri_name)
        {
            return (sanitize_file_name_for_fs(&uri_name), Some(ext.clone()));
        }
    }

    // Layer 2: Magic bytes 检测
    if let Some(detected_ext) = detect_extension_from_magic(window, raw_path) {
        let safe_name = if is_opaque_document_id(&uri_name) || uri_ext.is_none() {
            // 用检测到的扩展名构造文件名
            let base = sanitize_file_name_for_fs(&uri_name);
            format!("{}.{}", base, detected_ext)
        } else {
            sanitize_file_name_for_fs(&uri_name)
        };
        return (safe_name, Some(detected_ext));
    }

    // Layer 3: 无法识别
    (sanitize_file_name_for_fs(&uri_name), uri_ext)
}

pub fn ensure_local_path(
    window: &Window,
    raw_path: &str,
    temp_dir: &Path,
) -> Result<MaterializedPath, AppError> {
    let classified = classify_path(raw_path)?;
    match classified {
        PathKind::Local(local_path) => {
            let canonical = if local_path.exists() {
                std::fs::canonicalize(&local_path).unwrap_or_else(|_| local_path.clone())
            } else {
                return Err(AppError::file_system(format!(
                    "文件不存在: {}",
                    local_path.display()
                )));
            };
            Ok(MaterializedPath {
                path: canonical,
                cleanup: None,
            })
        }
        PathKind::Virtual(_) => {
            if !temp_dir.exists() {
                std::fs::create_dir_all(temp_dir).map_err(|e| {
                    AppError::file_system(format!(
                        "创建临时目录失败: {} ({})",
                        temp_dir.display(),
                        e
                    ))
                })?;
            }

            // ★ Android 修复：URI 路径提取失败时，用 magic bytes 降级检测扩展名
            let extension = extract_extension(raw_path)
                .or_else(|| detect_extension_from_magic(window, raw_path));
            let file_name = match extension {
                Some(ext) => format!("dstu_materialized_{}.{}", Uuid::new_v4(), ext),
                None => format!("dstu_materialized_{}", Uuid::new_v4()),
            };
            let dest_path = temp_dir.join(file_name);
            let dest_str = dest_path.to_string_lossy().to_string();
            // [R12-saf-space] 物化前按源大小 2 倍预检临时卷；不足不得开拷，以免半包。
            // SAF 目标卷空间仍不可见，这里只守应用私有临时目录。
            let source_bytes = get_file_size(window, raw_path)?;
            let available = crate::backup_common::get_available_disk_space(temp_dir)?;
            ensure_enough_temp_space(available, source_bytes, raw_path)?;
            copy_file(window, raw_path, &dest_str)?;
            Ok(MaterializedPath {
                path: dest_path.clone(),
                cleanup: Some(dest_path),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        digest_copy, digest_read, ensure_enough_temp_space, ensure_identical_copy,
        persistable_saf_queue_file, queue_persistable_saf_uri, reject_double_encoded_virtual_uri,
        required_temp_copy_bytes, DOUBLE_ENCODED_VIRTUAL_URI_REJECTED, PENDING_SAF_PERSIST_DIR,
        PENDING_SAF_PERSIST_FILE,
    };
    use std::io::Cursor;

    #[test]
    fn digest_copy_roundtrip_matches_reread() {
        let payload = b"saf-export-verify-payload";
        let mut source = Cursor::new(payload.as_slice());
        let mut dest = Cursor::new(Vec::new());
        let (copied, source_digest) = digest_copy(&mut source, &mut dest, "roundtrip").unwrap();
        assert_eq!(copied, payload.len() as u64);
        dest.set_position(0);
        let (verified, target_digest) = digest_read(&mut dest, "roundtrip").unwrap();
        ensure_identical_copy(copied, source_digest, verified, target_digest, "roundtrip")
            .expect("相同内容必须通过回读校验");
    }

    #[test]
    fn ensure_identical_copy_rejects_size_or_hash_mismatch() {
        let mut source = Cursor::new(b"abc");
        let mut dest = Cursor::new(Vec::new());
        let (copied, source_digest) = digest_copy(&mut source, &mut dest, "mismatch").unwrap();
        let err = ensure_identical_copy(copied, source_digest, copied + 1, source_digest, "short")
            .expect_err("长度不一致必须 fail-closed");
        assert!(err.to_string().contains("目标回读校验失败"));

        let other = [0u8; 32];
        let err = ensure_identical_copy(copied, source_digest, copied, other, "tampered")
            .expect_err("哈希不一致必须 fail-closed");
        assert!(err.to_string().contains("目标回读校验失败"));
    }

    #[test]
    fn ensure_enough_temp_space_requires_double_source_size() {
        assert_eq!(required_temp_copy_bytes(80), 160);
        ensure_enough_temp_space(160, 80, "enough").expect("恰好 2 倍必须通过");
        let err =
            ensure_enough_temp_space(159, 80, "short").expect_err("不足 2 倍必须 fail-closed");
        assert!(err.to_string().contains("临时物化空间不足，已停止以免半包"));
    }

    #[test]
    fn reject_double_encoded_virtual_uri_keeps_raw_content_ok() {
        reject_double_encoded_virtual_uri(
            "content://com.android.externalstorage.documents/document/primary%3Abackup.zip",
        )
        .expect("原始 content:// 必须放行");
        reject_double_encoded_virtual_uri("/tmp/backup.zip").expect("本地路径必须放行");
        let err = reject_double_encoded_virtual_uri(
            "content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip",
        )
        .expect_err("双重编码必须 fail-closed");
        assert_eq!(err.to_string(), DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
    }

    #[test]
    fn queue_persistable_saf_uri_writes_content_only() {
        let dir = tempfile::tempdir().expect("persist queue dir");
        let content =
            "content://com.android.externalstorage.documents/document/primary%3Abackup.zip";
        queue_persistable_saf_uri(dir.path(), &format!("  {content}  "))
            .expect("原始 content:// 必须入队");
        let pending = persistable_saf_queue_file(dir.path(), content);
        assert_eq!(
            std::fs::read_to_string(&pending).expect("read queue"),
            content,
            "入队必须写入 trim 后的原始 content://，不得改编码"
        );
        assert!(
            pending.starts_with(dir.path().join(PENDING_SAF_PERSIST_DIR)),
            "新队列必须落在 pending_saf_persist/ 目录"
        );
        assert!(
            !dir.path().join(PENDING_SAF_PERSIST_FILE).exists(),
            "新写入不得再覆盖旧单文件队列"
        );

        let other = "content://com.android.providers.downloads.documents/document/446";
        queue_persistable_saf_uri(dir.path(), other).expect("第二条 content:// 必须并列入队");
        assert_eq!(
            std::fs::read_to_string(persistable_saf_queue_file(dir.path(), other))
                .expect("read second"),
            other
        );
        assert_eq!(
            std::fs::read_to_string(&pending).expect("first survives"),
            content,
            "并发入队不得互相覆盖"
        );

        queue_persistable_saf_uri(dir.path(), "/tmp/backup.zip").expect("本地路径必须静默跳过");
        queue_persistable_saf_uri(dir.path(), "primary:Download/backup.zip")
            .expect("SAF 树路径不是 content://，不得入队");
        assert_eq!(
            std::fs::read_to_string(&pending).expect("queue unchanged"),
            content,
            "非 content:// 不得改写或清空已有队列"
        );

        let err = queue_persistable_saf_uri(
            dir.path(),
            "content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip",
        )
        .expect_err("双重编码必须在入队前可读拒绝");
        assert_eq!(err.to_string(), DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
        assert_eq!(
            std::fs::read_to_string(&pending).expect("queue survives reject"),
            content,
            "入队失败不得改写已有队列"
        );

        let err = queue_persistable_saf_uri(dir.path(), "content://authority/document/1\nextra")
            .expect_err("含换行必须拒绝");
        assert!(err
            .to_string()
            .contains("SAF persist 队列拒绝过长或含换行的 URI"));
    }
}
