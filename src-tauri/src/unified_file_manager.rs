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

    let decoded_for_check = decode_path(trimmed).unwrap_or_else(|_| trimmed.to_string());

    if is_special_scheme(&decoded_for_check) {
        return Ok(PathKind::Virtual(decoded_for_check));
    }

    if is_android_saf_path(&decoded_for_check) {
        return Ok(PathKind::Virtual(decoded_for_check));
    }

    if is_special_scheme(trimmed) {
        return Ok(PathKind::Virtual(trimmed.to_string()));
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
    SafeFilePath::from_str(raw).map_err(|e| {
        AppError::file_system(format!("无法解析系统路径 `{}`: {}", raw, e.to_string()))
    })
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
            let file = window.fs().open(safe_path, options).map_err(|e| {
                AppError::file_system(format!("读取文件失败: {} ({})", uri, e.to_string()))
            })?;
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
            let file = window.fs().open(safe_path, options).map_err(|e| {
                AppError::file_system(format!("写入文件失败: {} ({})", uri, e.to_string()))
            })?;
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

    let bytes_copied = std::io::copy(&mut reader, &mut writer).map_err(|e| {
        AppError::file_system(format!(
            "复制文件失败 ({} -> {}): {}",
            source_path.display(),
            target_path.display(),
            e
        ))
    })?;

    writer.flush().map_err(|e| {
        AppError::file_system(format!("刷新文件失败: {} ({})", target_path.display(), e))
    })?;

    Ok(bytes_copied)
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

            let legacy = sanitize_for_legacy(raw_path);
            let extension = Path::new(&legacy)
                .extension()
                .and_then(|ext| ext.to_str())
                .filter(|ext| !ext.is_empty());
            let file_name = match extension {
                Some(ext) => format!("dstu_materialized_{}.{}", Uuid::new_v4(), ext),
                None => format!("dstu_materialized_{}", Uuid::new_v4()),
            };
            let dest_path = temp_dir.join(file_name);
            let dest_str = dest_path.to_string_lossy().to_string();
            copy_file(window, raw_path, &dest_str)?;
            Ok(MaterializedPath {
                path: dest_path.clone(),
                cleanup: Some(dest_path),
            })
        }
    }
}
