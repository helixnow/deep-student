use std::{
    borrow::Cow,
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
};

use serde::Serialize;
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

/// 打开一个流式读取器（本地路径或 content:// 等虚拟 URI），调用方自行限流/限长。
/// 用于大文件分块暂存（`staged_upload`），避免整文件读入内存。
pub fn open_read_stream(
    window: &Window,
    raw_path: &str,
) -> Result<BufReader<Box<dyn Read + Send>>, AppError> {
    let path = classify_path(raw_path)?;
    open_reader(window, &path)
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

/// 拒绝包含隐藏路径段（点号开头）的本地路径
///
/// ★ 2026-06-12（审阅问题 R4 安全配套）：`read_file_bytes`/`read_file_text`
/// 没有任何路径白名单，前端任意 JS 都能读取 ~/.ssh、~/.aws 等敏感目录。
/// 正常导入/预览流程只会访问用户可见文件，封掉隐藏路径段不影响功能。
/// 应用自身数据目录（Linux 下位于 ~/.local/share）始终放行。
pub fn deny_hidden_local_path(window: &Window, raw_path: &str) -> Result<(), AppError> {
    use tauri::Manager;

    if is_virtual_uri(raw_path) {
        return Ok(());
    }

    // ★ 2026-07-19（安全加固）：先解码 + canonicalize 再做前缀/隐藏段判断。
    // 旧实现直接对原始字符串做 `starts_with`，`$APP_DATA/../../.ssh/key` 这类
    // 带 `..` 的路径可通过应用目录前缀放行，URL 编码（%2Essh）也能绕过隐藏段检查。
    let normalized_raw = sanitize_for_legacy(raw_path);
    let resolved = canonicalize_lenient(Path::new(&normalized_raw));

    // 应用数据目录内的路径（如 VFS blob）放行（目录本身也真实化，
    // 处理 macOS /var -> /private/var 之类的符号链接前缀差异）
    let app = window.app_handle();
    let in_app_dirs = [
        app.path().app_data_dir().ok(),
        app.path().app_local_data_dir().ok(),
        app.path().app_cache_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .any(|dir| {
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        resolved.starts_with(&dir)
    });
    if in_app_dirs {
        return Ok(());
    }

    let has_hidden_component = resolved.components().any(|c| {
        matches!(
            c,
            std::path::Component::Normal(name)
                if name.to_string_lossy().starts_with('.')
        )
    });
    if has_hidden_component {
        return Err(AppError::validation(format!(
            "拒绝读取隐藏路径: {}",
            raw_path
        )));
    }
    Ok(())
}

/// 尽力真实化路径：
/// - 文件存在时直接 `canonicalize`（消除 `..` 与符号链接）；
/// - 文件尚不存在时先词法归一化 `.`/`..`，再尝试真实化父目录后拼回文件名；
/// - 父目录也不存在时退化为纯词法归一化结果。
fn canonicalize_lenient(path: &Path) -> std::path::PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    let normalized = lexical_normalize_path(path);
    if let Some(parent) = normalized.parent() {
        if let (Ok(canonical_parent), Some(name)) =
            (std::fs::canonicalize(parent), normalized.file_name())
        {
            return canonical_parent.join(name);
        }
    }
    normalized
}

/// 词法归一化：消除 `.` 段，`..` 段弹出上一个普通段（到达根后忽略，
/// 与 `canonicalize` 对 `/..` 的行为一致）。不访问文件系统。
fn lexical_normalize_path(path: &Path) -> std::path::PathBuf {
    use std::path::Component;

    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // 相对路径开头的连续 `..` 无处可弹，原样保留；
                // 已到根（pop 返回 false）时按 POSIX 语义忽略。
                let ends_with_parent =
                    matches!(result.components().next_back(), Some(Component::ParentDir));
                if ends_with_parent || (!result.pop() && !result.has_root()) {
                    result.push(Component::ParentDir.as_os_str());
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// 旧版单文件队列名。MainActivity 仍双读，避免升级窗口丢掉已入队 URI。
pub const PENDING_SAF_PERSIST_FILE: &str = "pending_saf_persist.uri";

/// 新队列目录：每个 `content://` 一个 `*.uri`，原子 rename 落盘。
/// 并发导入/导出不得互相覆盖。
pub const PENDING_SAF_PERSIST_DIR: &str = "pending_saf_persist";

/// 本模块使用的 AppHandle（由 app 启动时在 `set_global_app_handle` 之后立即注入），
/// 避免存储层回引 app crate 的全局句柄。目前仅 Android SAF 唤醒读取。
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 注入 AppHandle（仅首次生效，与全局句柄语义一致）。
pub fn set_app_handle(app_handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle);
}

#[cfg(target_os = "android")]
struct SafPermissionHandle(tauri::plugin::PluginHandle<tauri::Wry>);

/// 原生插件只通知 MainActivity 扫描持久队列，不传递或缓存 URI grant。
#[cfg(target_os = "android")]
pub fn saf_permission_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("saf-permission")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.deepstudent.app", "SafPermissionPlugin")?;
            tauri::Manager::manage(app, SafPermissionHandle(handle));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn wake_saf_permission_queue() {
    use tauri::Manager;

    let Some(app) = APP_HANDLE.get() else {
        log::warn!("SAF persist wake skipped before app setup; queue retained for resume");
        return;
    };
    let Some(state) = app.try_state::<SafPermissionHandle>() else {
        log::warn!("SAF persist plugin unavailable; queue retained for resume");
        return;
    };
    let plugin = state.0.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = plugin
            .run_mobile_plugin_async::<serde_json::Value>("persistPending", serde_json::json!({}))
            .await
        {
            log::warn!("SAF persist wake failed; queue retained for resume: {error}");
        }
    });
}

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
    // Producers for the same URI share the final entry, but must never share
    // staging files: one producer's rename would consume another's temp file.
    let tmp = dest.with_extension(format!("uri.{}.tmp", Uuid::new_v4()));
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
    })?;
    // 必须先提交队列文件，再发唤醒；失败或 Activity 切换不会丢失持久条目。
    #[cfg(target_os = "android")]
    wake_saf_permission_queue();
    Ok(())
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

/// 导入通道分类使用的图片扩展名（与前端 IMAGE_EXTENSIONS / 附件白名单同一语义）。
const IMPORT_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif",
];

/// 音视频扩展名（走附件/媒体通道，不进入文档解析）。
const IMPORT_MEDIA_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "ogg", "m4a", "flac", "aac", "wma", "opus", "mp4", "webm", "mov", "avi", "mkv",
    "m4v", "wmv", "flv",
];

/// 文档通道扩展名：命中后走 textbooks_add / 文档解析，而不是普通附件。
const IMPORT_DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf",
    "docx",
    "txt",
    "md",
    "markdown",
    "html",
    "htm",
    "xlsx",
    "xls",
    "xlsb",
    "ods",
    "pptx",
    "epub",
    "rtf",
    "csv",
    "json",
    "xml",
    // 代码/纯文本（与前端 ATTACHMENT_CODE_TEXT_EXTENSIONS 对齐，按 txt 解析）
    "py",
    "pyw",
    "ipynb",
    "rs",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "java",
    "c",
    "cpp",
    "cc",
    "cxx",
    "h",
    "hpp",
    "hh",
    "cs",
    "go",
    "rb",
    "php",
    "swift",
    "kt",
    "kts",
    "scala",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "properties",
    "env",
    "log",
    "tex",
    "bib",
    "rst",
    "adoc",
    "vue",
    "svelte",
    "astro",
    "lua",
    "pl",
    "pm",
    "r",
    "jl",
    "dart",
    "gradle",
    "cmake",
    "makefile",
    "mk",
    "dockerfile",
    "gitignore",
    "editorconfig",
    "proto",
    "graphql",
    "gql",
    "prisma",
    "sol",
    "asm",
    "s",
    "vb",
    "fs",
    "fsx",
    "ex",
    "exs",
    "erl",
    "hrl",
    "clj",
    "cljs",
    "hs",
    "elm",
    "nim",
    "zig",
];

/// 导入描述：分流唯一依据，不直接决定内容是否完整/可解析。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedImportInfo {
    pub display_name: String,
    pub extension: Option<String>,
    pub mime_type: String,
    /// `document` | `image` | `media` | `file`
    pub kind: String,
}

/// 扩展名 -> 规范化 MIME。未知/缺失返回 `application/octet-stream`。
///
/// 这是导入分流与附件元数据的共享 helper；A3 重识别也应复用它，避免
/// 前端/后端各自维护一套映射。扩展名不区分大小写。
pub fn import_mime_type(extension: Option<&str>) -> &'static str {
    let ext = extension
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "xlsb" => "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ppt" => "application/vnd.ms-powerpoint",
        "epub" => "application/epub+zip",
        "rtf" => "application/rtf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "opus" => "audio/opus",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "m4v" => "video/x-m4v",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "apkg" | "colpkg" => "application/apkg",
        _ if IMPORT_DOCUMENT_EXTENSIONS.contains(&ext.as_str()) => "text/plain",
        _ => "application/octet-stream",
    }
}

/// 扩展名 -> 导入通道：`document` | `image` | `media` | `file`。
pub fn import_kind(extension: Option<&str>) -> &'static str {
    let ext = extension
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .unwrap_or_default();
    if IMPORT_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        "image"
    } else if IMPORT_MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        "media"
    } else if IMPORT_DOCUMENT_EXTENSIONS.contains(&ext.as_str()) {
        "document"
    } else {
        "file"
    }
}

/// 从文件头 magic bytes 检测文件扩展名。
/// 只读取前 64KB（有界），对 ZIP 容器在头部内区分 DOCX/XLSX/PPTX/EPUB/ODS。
/// 返回 None 表示无法识别。
pub fn detect_extension_from_magic(window: &Window, raw_path: &str) -> Option<String> {
    let data = read_first_bytes(window, raw_path, 64 * 1024).ok()?;
    detect_import_extension(&data)
}

/// 纯字节版导入类型检测：不访问文件系统，调用方负责提供有界头部（<= 64KB）。
///
/// 与 `detect_extension_from_magic` 共用同一实现，供暂存/描述解析和测试复用。
pub fn detect_import_extension(data: &[u8]) -> Option<String> {
    if data.len() < 4 {
        return None;
    }

    // PDF: %PDF
    if data.starts_with(b"%PDF") {
        return Some("pdf".into());
    }

    // ZIP 容器（DOCX/XLSX/PPTX/EPUB/ODS）
    if data.starts_with(b"PK\x03\x04") {
        return detect_zip_subtype(data);
    }

    // RTF: {\rtf
    if data.starts_with(b"{\\rtf") {
        return Some("rtf".into());
    }

    // OLE2 Compound Document (旧版 .doc/.xls/.ppt)
    if data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return None; // 不支持旧版 Office 格式
    }

    // 图片签名：provider 的 opaque 名称/octet-stream 不能作为通道依据，
    // 这里用有界文件头识别常见图片，避免 PNG/JPEG/WebP 落进普通附件。
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png".into());
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg".into());
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("gif".into());
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP".as_slice() {
        return Some("webp".into());
    }
    if looks_like_bmp_header(data) {
        return Some("bmp".into());
    }
    if data.len() >= 12 && &data[4..8] == b"ftyp".as_slice() {
        let brand = &data[8..12];
        if brand == b"heic".as_slice()
            || brand == b"heix".as_slice()
            || brand == b"hevc".as_slice()
            || brand == b"hevx".as_slice()
        {
            return Some("heic".into());
        }
        if brand == b"mif1".as_slice() || brand == b"msf1".as_slice() {
            return Some("heif".into());
        }
    }

    // 跳过可能的 UTF-8 BOM
    let content = if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &data[3..]
    } else {
        data
    };

    // XML: <?xml
    if content.starts_with(b"<?xm") {
        // 用同一份有界头部区分 XML 和 HTML (XHTML)
        let more = &data[..data.len().min(512)];
        let lower = String::from_utf8_lossy(more).to_lowercase();
        if lower.contains("<html") || lower.contains("<!doctype html") {
            return Some("html".into());
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

    // 控制字节（含 NUL）说明不是可靠纯文本；不得被 UTF-8 兜底或
    // Markdown/CSV 启发式误判为可读文档。调用方保证头部 <= 64KiB，
    // 这里仍显式截断，扫描整个有界样本而不是只看前 1024 字节。
    let control_sample = &data[..data.len().min(64 * 1024)];
    let has_binary_controls = control_sample
        .iter()
        .any(|byte| *byte == 0 || (*byte < 0x20 && !matches!(*byte, b'\n' | b'\r' | b'\t' | 0x0C)));
    if has_binary_controls {
        return None;
    }
    // 文本启发式仍使用小样本；UTF-8 校验需容忍样本在字符中间截断。
    let text_sample = &data[..data.len().min(1024)];
    let utf8_text = match std::str::from_utf8(text_sample) {
        Ok(text) => Some(text),
        Err(err) if err.error_len().is_none() => {
            std::str::from_utf8(&text_sample[..err.valid_up_to()]).ok()
        }
        Err(_) => None,
    };
    let text_str = String::from_utf8_lossy(text_sample);
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

    // 纯文本兜底：合法 UTF-8（允许样本在末尾字符中间截断）
    if !text_sample.is_empty() && utf8_text.is_some() {
        return Some("txt".into());
    }

    None
}

/// 有界 BMP 结构校验：只用于路由，不承诺能完整解码。
///
/// 支持 12 字节 OS/2 v1 BITMAPCOREHEADER（u16 宽高/planes/bpp）和
/// >= 40 字节 Windows BITMAPINFOHEADER；文件大小、像素偏移、DIB 大小、
/// 宽高、planes、bpp、compression 必须自洽，以排除仅以 `BM` 开头的普通文本。
/// 样本截断在像素数据中仍然接受，因此不要求 `data.len()` 覆盖整个文件。
fn looks_like_bmp_header(data: &[u8]) -> bool {
    if data.len() < 26 || !data.starts_with(b"BM") {
        return false;
    }
    let file_size = u32::from_le_bytes([data[2], data[3], data[4], data[5]]) as usize;
    let pixel_offset = u32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;
    let dib_size = u32::from_le_bytes([data[14], data[15], data[16], data[17]]) as usize;

    let header_end = match 14usize.checked_add(dib_size) {
        Some(value) => value,
        None => return false,
    };
    if header_end > data.len() || header_end > file_size {
        return false;
    }
    if pixel_offset < header_end || pixel_offset > file_size {
        return false;
    }

    // OS/2 v1 BITMAPCOREHEADER：宽高与 planes/bpp 均为 u16，无 compression 字段。
    if dib_size == 12 {
        let width = u16::from_le_bytes([data[18], data[19]]);
        let height = u16::from_le_bytes([data[20], data[21]]);
        let planes = u16::from_le_bytes([data[22], data[23]]);
        let bits_per_pixel = u16::from_le_bytes([data[24], data[25]]);
        return width > 0
            && height > 0
            && planes == 1
            && matches!(bits_per_pixel, 1 | 4 | 8 | 16 | 24 | 32);
    }

    if dib_size < 40 {
        return false;
    }

    let width = i32::from_le_bytes([data[18], data[19], data[20], data[21]]);
    let height = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
    let planes = u16::from_le_bytes([data[26], data[27]]);
    let bits_per_pixel = u16::from_le_bytes([data[28], data[29]]);
    let compression = u32::from_le_bytes([data[30], data[31], data[32], data[33]]);

    if width <= 0 || height == 0 || planes != 1 {
        return false;
    }
    if !matches!(bits_per_pixel, 1 | 4 | 8 | 16 | 24 | 32) {
        return false;
    }
    matches!(compression, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 11 | 12 | 13)
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
fn detect_zip_subtype(data: &[u8]) -> Option<String> {
    // 手动解析 ZIP Local File Headers 提取条目名称；所有偏移加法都用 checked，
    // 样本在条目内容中截断时停止，不把不完整条目当成类型证据。
    let mut offset: usize = 0;
    let mut mimetype_content: Option<String> = None;

    loop {
        let Some(header_end) = offset.checked_add(30) else {
            break;
        };
        if header_end > data.len() {
            break;
        }
        let header = &data[offset..header_end];
        // Local File Header signature = PK\x03\x04
        if !header.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
            break;
        }

        let compression = u16::from_le_bytes([header[8], header[9]]);
        let compressed_size =
            u32::from_le_bytes([header[18], header[19], header[20], header[21]]) as usize;
        let uncompressed_size =
            u32::from_le_bytes([header[22], header[23], header[24], header[25]]) as usize;
        let name_len = u16::from_le_bytes([header[26], header[27]]) as usize;
        let extra_len = u16::from_le_bytes([header[28], header[29]]) as usize;

        let name_start = header_end;
        let Some(name_end) = name_start.checked_add(name_len) else {
            break;
        };
        if name_end > data.len() {
            break;
        }

        let entry_name = String::from_utf8_lossy(&data[name_start..name_end]).to_lowercase();

        // 只认 OOXML 的精确主 part；任意 word/xl/ppt 目录不算 OOXML。
        let is_ppt_slide = entry_name
            .strip_prefix("ppt/slides/slide")
            .and_then(|rest| rest.strip_suffix(".xml"))
            .is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
            });
        if entry_name == "word/document.xml" {
            return Some("docx".into());
        }
        if entry_name == "xl/workbook.xml" {
            return Some("xlsx".into());
        }
        if entry_name == "ppt/presentation.xml" || is_ppt_slide {
            return Some("pptx".into());
        }

        let Some(data_start) = name_end.checked_add(extra_len) else {
            break;
        };
        let Some(data_end) = data_start.checked_add(compressed_size) else {
            break;
        };
        // 样本在大条目内容中截断：无法跳到下一个头部，也不能从不完整
        // container.xml/extra 或截断的 mimetype 宣称类型。
        if data_end > data.len() {
            break;
        }

        // EPUB 的 container.xml 必须在样本内完整。
        if entry_name == "meta-inf/container.xml" {
            return Some("epub".into());
        }
        // mimetype 必须是样本内完整、未压缩的 payload。
        if entry_name == "mimetype"
            && compression == 0
            && compressed_size == uncompressed_size
            && compressed_size > 0
        {
            let mime = String::from_utf8_lossy(&data[data_start..data_end]);
            mimetype_content = Some(mime.to_string());
        }

        // 跳到下一个 Local File Header
        if data_end <= offset {
            break; // 防止无限循环
        }
        offset = data_end;
    }

    // 只按精确 stored mimetype 识别明确支持的 ODF/EPUB；ODT/ODP 等保持不支持，
    // 不能因任意 content.xml 或 opendocument 前缀冒充 OOXML/ODS。
    if let Some(ref mime) = mimetype_content {
        match mime.trim() {
            "application/vnd.oasis.opendocument.spreadsheet" => return Some("ods".into()),
            "application/epub+zip" => return Some("epub".into()),
            _ => {}
        }
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

/// Android provider 元数据。只作为描述线索，不证明内容完整或格式有效。
#[derive(Debug, Clone, Default)]
pub struct AndroidSafDisplayInfo {
    pub display_name: Option<String>,
    pub mime_type: Option<String>,
}

/// 通过既有 saf-permission 插件查询 content:// 的 DISPLAY_NAME / MIME。
/// 查询失败返回 None，由有界内容检测继续兜底；不缓存、不复制 URI grant。
#[cfg(target_os = "android")]
pub async fn query_android_saf_display_info(path: &str) -> Option<AndroidSafDisplayInfo> {
    use tauri::Manager;

    let app = APP_HANDLE.get()?;
    let state = app.try_state::<SafPermissionHandle>()?;
    let plugin = state.0.clone();
    let value = plugin
        .run_mobile_plugin_async::<serde_json::Value>(
            "resolveFileInfo",
            serde_json::json!({ "path": path }),
        )
        .await
        .ok()?;
    Some(AndroidSafDisplayInfo {
        display_name: value
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        mime_type: value
            .get("mimeType")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// 从名称中取“真正的点号后缀”，opaque ID 和过长的伪扩展名返回 None。
fn extension_from_name(name: &str) -> Option<String> {
    if is_opaque_document_id(name) {
        return None;
    }
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

/// provider MIME 缺失扩展名时的保守回退（仅常见可识别类型）。
fn extension_from_mime(mime: &str) -> Option<&'static str> {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "application/pdf" => Some("pdf"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        "application/epub+zip" => Some("epub"),
        "text/markdown" => Some("md"),
        "text/html" => Some("html"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        "application/xml" | "text/xml" => Some("xml"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "audio/mpeg" => Some("mp3"),
        "video/mp4" => Some("mp4"),
        _ => None,
    }
}

/// 强内容签名 > 可靠 provider 名称后缀 > provider 可识别 MIME > URI 后缀/code 名 > 弱检测。
/// `text/plain` / `application/octet-stream` 不映射为具体后缀，不会覆盖普通路径。
fn pick_import_extension(
    detected: Option<String>,
    provider_ext: Option<String>,
    provider_mime_ext: Option<&'static str>,
    uri_ext: Option<String>,
) -> Option<String> {
    let detected_is_strong = detected.as_deref().is_some_and(|ext| {
        matches!(
            ext,
            "pdf"
                | "docx"
                | "xlsx"
                | "pptx"
                | "epub"
                | "ods"
                | "rtf"
                | "png"
                | "jpg"
                | "gif"
                | "webp"
                | "bmp"
                | "heic"
                | "heif"
        )
    });
    if detected_is_strong {
        return detected;
    }
    provider_ext
        .or_else(|| provider_mime_ext.map(str::to_string))
        .or(uri_ext)
        .or(detected)
}

/// 同一格式的常见后缀别名；HEIC/HEIF 是不同容器标识，不在此列。
fn extensions_are_equivalent(left: &str, right: &str) -> bool {
    left == right
        || matches!(
            (left, right),
            ("jpg", "jpeg")
                | ("jpeg", "jpg")
                | ("html", "htm")
                | ("htm", "html")
                | ("md", "markdown")
                | ("markdown", "md")
        )
}

/// 组装导入描述：native 有界检测 + Android provider 元数据。
///
/// 返回 Err 仅用于“既无可靠名称/后缀、又无法从内容识别”的 opaque 输入；
/// 此时调用方必须显式报失败，不能以 octet-stream 静默落库。检测到头部
/// 不等于文件完整或可解析，后续解析器仍需独立校验。
pub fn resolve_import_info(
    window: &Window,
    raw_path: &str,
    provider: Option<AndroidSafDisplayInfo>,
) -> Result<ResolvedImportInfo, AppError> {
    let uri_name = extract_file_name(raw_path);
    let detected = detect_extension_from_magic(window, raw_path);
    build_import_info(&uri_name, provider, detected)
}

/// 纯描述组装接缝：调用方提供 URI 名称和有界检测结果，不触碰 IO。
fn build_import_info(
    uri_name: &str,
    provider: Option<AndroidSafDisplayInfo>,
    detected: Option<String>,
) -> Result<ResolvedImportInfo, AppError> {
    let uri_ext = extension_from_name(uri_name);
    let provider = provider.unwrap_or_default();
    let provider_name = provider
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let provider_ext = provider_name
        .and_then(extension_from_name)
        .filter(|ext| import_mime_type(Some(ext.as_str())) != "application/octet-stream");
    let provider_name_is_reliable = provider_name.is_some_and(|name| !is_opaque_document_id(name));
    let provider_mime = provider
        .mime_type
        .as_deref()
        .map(|mime| mime.split(';').next().unwrap_or(mime).trim())
        .filter(|mime| !mime.is_empty() && *mime != "application/octet-stream");

    let provider_mime_ext = provider_mime.and_then(extension_from_mime);
    let extension = pick_import_extension(detected, provider_ext, provider_mime_ext, uri_ext);

    if extension.is_none() && is_opaque_document_id(uri_name) && !provider_name_is_reliable {
        return Err(AppError::validation(
            "无法从内容或文件元数据识别导入文件类型",
        ));
    }

    let raw_display_name = provider_name
        .map(str::to_string)
        .unwrap_or_else(|| uri_name.to_string());
    let mut display_name: String = raw_display_name
        .chars()
        .map(|c| if c.is_control() { '_' } else { c })
        .collect();
    display_name = display_name.trim().to_string();
    if display_name.is_empty() || is_opaque_document_id(&display_name) {
        display_name = "imported-document".to_string();
    }
    if let Some(ext) = extension.as_deref() {
        match extension_from_name(&display_name) {
            Some(display_ext) if extensions_are_equivalent(&display_ext, ext) => {}
            _ => display_name = format!("{}.{}", display_name, ext),
        }
    }

    let mime_type = extension
        .as_deref()
        .map(|ext| import_mime_type(Some(ext)))
        .filter(|mime| *mime != "application/octet-stream")
        .map(str::to_string)
        .or_else(|| provider_mime.map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let kind = import_kind(extension.as_deref()).to_string();

    Ok(ResolvedImportInfo {
        display_name,
        extension,
        mime_type,
        kind,
    })
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
        build_import_info, detect_import_extension, digest_copy, digest_read,
        ensure_enough_temp_space, ensure_identical_copy, persistable_saf_queue_file,
        queue_persistable_saf_uri, reject_double_encoded_virtual_uri, required_temp_copy_bytes,
        AndroidSafDisplayInfo, DOUBLE_ENCODED_VIRTUAL_URI_REJECTED, PENDING_SAF_PERSIST_DIR,
        PENDING_SAF_PERSIST_FILE,
    };
    use std::io::Cursor;

    #[test]
    fn build_import_info_uses_provider_mime_when_detected_is_none() {
        // 对应 >64KiB OOXML ZIP：有界样本看不到 word/xl/ppt 条目名，
        // detected 为 None，描述必须回退到 provider MIME。
        let cases = [
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
            ),
            (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "xlsx",
            ),
            (
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx",
            ),
        ];
        for (mime, expected_ext) in cases {
            let provider = AndroidSafDisplayInfo {
                display_name: Some("provider-export".to_string()),
                mime_type: Some(mime.to_string()),
            };
            let info = build_import_info("provider-export", Some(provider), None)
                .expect("provider MIME should describe the import");

            assert_eq!(info.extension.as_deref(), Some(expected_ext));
            assert_eq!(info.mime_type, mime);
            assert_eq!(info.kind, "document");
            assert_eq!(info.display_name, format!("provider-export.{expected_ext}"));
        }
    }

    #[test]
    fn build_import_info_prefers_provider_name_for_opaque_uri() {
        let provider = AndroidSafDisplayInfo {
            display_name: Some("课程讲义.pdf".to_string()),
            mime_type: None,
        };
        let info = build_import_info("446", Some(provider), None)
            .expect("provider display name should describe the import");

        assert_eq!(info.display_name, "课程讲义.pdf");
        assert_eq!(info.extension.as_deref(), Some("pdf"));
        assert_eq!(info.kind, "document");
        assert_eq!(info.mime_type, "application/pdf");
    }

    #[test]
    fn build_import_info_strong_magic_suffix_conflicts_with_provider_name() {
        let provider = AndroidSafDisplayInfo {
            display_name: Some("sheet.docx".to_string()),
            mime_type: None,
        };
        let info = build_import_info("upload", Some(provider), Some("xlsx".to_string()))
            .expect("strong xlsx magic should describe the import");

        assert_eq!(info.extension.as_deref(), Some("xlsx"));
        assert_eq!(
            info.mime_type,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        let actual_suffix = std::path::Path::new(&info.display_name)
            .extension()
            .and_then(|ext| ext.to_str());
        assert_eq!(
            actual_suffix,
            Some("xlsx"),
            "display_name 的真实后缀必须跟 effective extension 一致，got {:?}",
            info.display_name
        );
    }

    #[test]
    fn build_import_info_prefers_provider_mime_over_generic_uri_suffix() {
        let provider = AndroidSafDisplayInfo {
            display_name: Some("sheet".to_string()),
            mime_type: Some(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
            ),
        };
        let info = build_import_info("upload.bin", Some(provider), None)
            .expect("provider MIME should describe the opaque .bin import");

        assert_eq!(info.extension.as_deref(), Some("xlsx"));
        assert_eq!(
            info.mime_type,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        let actual_suffix = std::path::Path::new(&info.display_name)
            .extension()
            .and_then(|ext| ext.to_str());
        assert_eq!(
            actual_suffix,
            Some("xlsx"),
            "display_name 的真实后缀必须跟 effective extension 一致，got {:?}",
            info.display_name
        );
    }

    #[test]
    fn build_import_info_prefers_provider_mime_over_weak_text_detection() {
        let provider = AndroidSafDisplayInfo {
            display_name: Some("sheet".to_string()),
            mime_type: Some(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_string(),
            ),
        };
        let info = build_import_info("446", Some(provider), Some("txt".to_string()))
            .expect("provider MIME should override weak text detection");

        assert_eq!(info.extension.as_deref(), Some("docx"));
        assert_eq!(
            info.mime_type,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        let actual_suffix = std::path::Path::new(&info.display_name)
            .extension()
            .and_then(|ext| ext.to_str());
        assert_eq!(
            actual_suffix,
            Some("docx"),
            "display_name 的真实后缀必须跟 effective extension 一致，got {:?}",
            info.display_name
        );
    }

    #[test]
    fn build_import_info_ignores_unreliable_provider_suffix_for_specific_mime() {
        let cases = [
            ("lecture 1.2", "application/pdf", "pdf"),
            (
                "paper.bin",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
            ),
        ];
        for (provider_name, mime, expected_ext) in cases {
            let provider = AndroidSafDisplayInfo {
                display_name: Some(provider_name.to_string()),
                mime_type: Some(mime.to_string()),
            };
            let info = build_import_info("upload", Some(provider), None)
                .expect("specific provider MIME should beat an unreliable name suffix");

            assert_eq!(info.extension.as_deref(), Some(expected_ext));
            assert_eq!(info.mime_type, mime);
            let actual_suffix = std::path::Path::new(&info.display_name)
                .extension()
                .and_then(|ext| ext.to_str());
            assert_eq!(
                actual_suffix,
                Some(expected_ext),
                "display_name 的真实后缀必须跟 effective extension 一致，got {:?}",
                info.display_name
            );
        }
    }

    #[test]
    fn build_import_info_rejects_two_opaque_names_without_content_evidence() {
        let provider = AndroidSafDisplayInfo {
            display_name: Some("789".to_string()),
            mime_type: None,
        };
        let result = build_import_info("446", Some(provider), None);
        assert!(
            result.is_err(),
            "opaque provider name must not make an opaque URI trustworthy"
        );
    }

    #[test]
    fn build_import_info_does_not_append_equivalent_alias_suffixes() {
        let jpeg = build_import_info("photo.jpeg", None, Some("jpg".to_string()))
            .expect("strong jpg detection should describe the import");
        assert_eq!(jpeg.extension.as_deref(), Some("jpg"));
        assert_eq!(jpeg.display_name, "photo.jpeg", "jpg/jpeg 不应重复追加");

        let html_provider = AndroidSafDisplayInfo {
            display_name: None,
            mime_type: Some("text/html".to_string()),
        };
        let html = build_import_info("page.htm", Some(html_provider), Some("html".to_string()))
            .expect("html MIME should describe the import");
        assert_eq!(html.extension.as_deref(), Some("html"));
        assert_eq!(html.display_name, "page.htm", "html/htm 不应重复追加");

        let markdown_provider = AndroidSafDisplayInfo {
            display_name: None,
            mime_type: Some("text/markdown".to_string()),
        };
        let markdown = build_import_info(
            "note.markdown",
            Some(markdown_provider),
            Some("md".to_string()),
        )
        .expect("markdown MIME should describe the import");
        assert_eq!(markdown.extension.as_deref(), Some("md"));
        assert_eq!(
            markdown.display_name, "note.markdown",
            "md/markdown 不应重复追加"
        );

        let heic = build_import_info("photo.heif", None, Some("heic".to_string()))
            .expect("strong heic detection should describe the import");
        assert_eq!(heic.extension.as_deref(), Some("heic"));
        assert_eq!(
            heic.display_name, "photo.heif.heic",
            "heic/heif 不是等价别名，必须保留真实后缀"
        );
    }

    #[test]
    fn lexical_normalize_path_resolves_dot_segments() {
        use super::lexical_normalize_path;
        use std::path::{Path, PathBuf};

        assert_eq!(
            lexical_normalize_path(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        // `..` 穿越应用目录前缀的攻击面：归一化后前缀判断不再被欺骗
        assert_eq!(
            lexical_normalize_path(Path::new("/app/data/../../home/user/.ssh/key")),
            PathBuf::from("/home/user/.ssh/key")
        );
        // 根之上的 `..` 按 POSIX 语义忽略
        assert_eq!(
            lexical_normalize_path(Path::new("/../a")),
            PathBuf::from("/a")
        );
        // 相对路径开头的连续 `..` 原样保留
        assert_eq!(
            lexical_normalize_path(Path::new("../../a/b/../c")),
            PathBuf::from("../../a/c")
        );
    }

    #[test]
    fn canonicalize_lenient_handles_missing_files() {
        use super::canonicalize_lenient;

        let temp = std::env::temp_dir();
        let canonical_temp = std::fs::canonicalize(&temp).unwrap();

        // 不存在的文件：父目录真实化 + 拼回文件名
        let missing = temp.join("deep_student_test_missing_file.bin");
        assert_eq!(
            canonicalize_lenient(&missing),
            canonical_temp.join("deep_student_test_missing_file.bin")
        );

        // 不存在的文件 + `..` 段：词法归一化后仍能消除穿越
        let traversal = temp.join("nonexistent_dir/../deep_student_test_missing_file.bin");
        assert_eq!(
            canonicalize_lenient(&traversal),
            canonical_temp.join("deep_student_test_missing_file.bin")
        );
    }

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

    #[test]
    fn queue_persistable_saf_uri_handles_concurrent_producers() {
        let dir = tempfile::tempdir().expect("persist queue dir");
        let same = "content://com.android.providers.downloads.documents/document/445";
        let other = "content://com.android.providers.downloads.documents/document/446";
        let third = "content://com.android.providers.downloads.documents/document/447";
        let uris = [same, same, same, same, other, third];
        let start = std::sync::Barrier::new(uris.len());

        std::thread::scope(|scope| {
            let handles: Vec<_> = uris
                .into_iter()
                .map(|uri| {
                    let start = &start;
                    let app_data_dir = dir.path();
                    scope.spawn(move || {
                        start.wait();
                        queue_persistable_saf_uri(app_data_dir, uri)
                    })
                })
                .collect();
            for handle in handles {
                handle
                    .join()
                    .expect("SAF producer must not panic")
                    .expect("same-URI and distinct-URI producers must all commit");
            }
        });

        for uri in [same, other, third] {
            assert_eq!(
                std::fs::read_to_string(persistable_saf_queue_file(dir.path(), uri))
                    .expect("consumer-readable queue entry"),
                uri
            );
        }
        let entries = std::fs::read_dir(dir.path().join(PENDING_SAF_PERSIST_DIR))
            .expect("queue directory")
            .collect::<std::io::Result<Vec<_>>>()
            .expect("queue entries");
        assert_eq!(entries.len(), 3, "one committed entry per distinct URI");
        assert!(entries
            .iter()
            .all(|entry| entry.path().extension().is_some_and(|ext| ext == "uri")));
    }

    /// 手工核对的 2x2、24bpp、BI_RGB 小 BMP：
    /// 14 字节文件头 + 40 字节 BITMAPINFOHEADER + 16 字节像素 = 70 字节。
    /// 每行 2 个像素 * 3 字节 = 6，按 4 字节对齐补 2 字节，共两行 16 字节。
    fn hand_checked_2x2_24bit_bmp() -> Vec<u8> {
        let mut bmp = Vec::with_capacity(70);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&70u32.to_le_bytes()); // 文件总大小
        bmp.extend_from_slice(&0u32.to_le_bytes()); // 保留
        bmp.extend_from_slice(&54u32.to_le_bytes()); // 像素数据偏移
        bmp.extend_from_slice(&40u32.to_le_bytes()); // DIB 头大小
        bmp.extend_from_slice(&2i32.to_le_bytes()); // 宽
        bmp.extend_from_slice(&2i32.to_le_bytes()); // 高（正数表示自底向上）
        bmp.extend_from_slice(&1u16.to_le_bytes()); // planes
        bmp.extend_from_slice(&24u16.to_le_bytes()); // 每像素位数
        bmp.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
        bmp.extend_from_slice(&16u32.to_le_bytes()); // 像素数据大小
        bmp.extend_from_slice(&2835i32.to_le_bytes()); // 水平像素/米
        bmp.extend_from_slice(&2835i32.to_le_bytes()); // 垂直像素/米
        bmp.extend_from_slice(&0u32.to_le_bytes()); // 调色板颜色数
        bmp.extend_from_slice(&0u32.to_le_bytes()); // 重要颜色数
                                                    // 自底向上：底行红、绿；顶行蓝、白（BGR + 每行 2 字节对齐）
        bmp.extend_from_slice(&[0, 0, 255, 0, 255, 0, 0, 0]);
        bmp.extend_from_slice(&[255, 0, 0, 255, 255, 255, 0, 0]);
        bmp
    }

    /// 手工核对的 4x4、24bpp、OS/2 v1 BITMAPCOREHEADER 小 BMP：
    /// 14 字节文件头 + 12 字节 DIB 头 + 48 字节像素 = 74 字节。
    /// 每行 4 个像素 * 3 字节 = 12，无需行对齐；共 4 行 48 字节。
    fn hand_checked_4x4_24bit_os2_bmp() -> Vec<u8> {
        let mut bmp = Vec::with_capacity(74);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&74u32.to_le_bytes()); // 文件总大小
        bmp.extend_from_slice(&0u32.to_le_bytes()); // 保留
        bmp.extend_from_slice(&26u32.to_le_bytes()); // 像素数据偏移
        bmp.extend_from_slice(&12u32.to_le_bytes()); // BITMAPCOREHEADER 大小
        bmp.extend_from_slice(&4u16.to_le_bytes()); // 宽
        bmp.extend_from_slice(&4u16.to_le_bytes()); // 高
        bmp.extend_from_slice(&1u16.to_le_bytes()); // planes
        bmp.extend_from_slice(&24u16.to_le_bytes()); // 每像素位数
        bmp.extend_from_slice(&[0u8; 48]); // 4 行 * 12 字节，全黑像素
        bmp
    }

    /// 构造一段文本样本：prefix 后补 'x' 到 `pad_to`，再追加一个控制字节。
    /// 用于验证控制字节检查覆盖整个有界样本，而不只前 1024 字节。
    fn text_sample_with_control_after(prefix: &str, pad_to: usize, control: u8) -> Vec<u8> {
        let mut data = prefix.as_bytes().to_vec();
        assert!(data.len() <= pad_to);
        data.resize(pad_to, b'x');
        data.push(control);
        data
    }

    /// 构造单个 ZIP Local File Header 夹具，允许声明任意 extra 长度和压缩后大小，
    /// 用于验证检测器面对自相矛盾的头部必须有界失败。
    fn zip_local_header_with_declared_sizes(
        entry: &str,
        extra_len: u16,
        compressed_size: u32,
    ) -> Vec<u8> {
        let name = entry.as_bytes();
        let mut data = Vec::new();
        data.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]); // local header
        data.extend_from_slice(&[20, 0]); // version needed
        data.extend_from_slice(&[0, 0]); // flags
        data.extend_from_slice(&[0, 0]); // compression: stored
        data.extend_from_slice(&[0, 0, 0, 0]); // mod time/date
        data.extend_from_slice(&[0, 0, 0, 0]); // crc32
        data.extend_from_slice(&compressed_size.to_le_bytes());
        data.extend_from_slice(&[0, 0, 0, 0]); // uncompressed size
        data.extend_from_slice(&(name.len() as u16).to_le_bytes());
        data.extend_from_slice(&extra_len.to_le_bytes());
        data.extend_from_slice(name);
        data
    }

    /// 仅构造 ZIP Local File Header 的头部夹具：检测器只扫描文件头，
    /// 不依赖中央目录。用于验证类型识别边界，不冒充完整可解压文档。
    fn zip_with_local_entries(entries: &[&str]) -> Vec<u8> {
        let mut data = Vec::new();
        for entry in entries {
            let name = entry.as_bytes();
            data.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]); // local header
            data.extend_from_slice(&[20, 0]); // version needed
            data.extend_from_slice(&[0, 0]); // flags
            data.extend_from_slice(&[0, 0]); // compression: stored
            data.extend_from_slice(&[0, 0, 0, 0]); // mod time/date
            data.extend_from_slice(&[0, 0, 0, 0]); // crc32
            data.extend_from_slice(&[0, 0, 0, 0]); // compressed size
            data.extend_from_slice(&[0, 0, 0, 0]); // uncompressed size
            data.extend_from_slice(&(name.len() as u16).to_le_bytes());
            data.extend_from_slice(&[0, 0]); // extra length
            data.extend_from_slice(name);
        }
        data
    }

    #[test]
    fn detect_import_extension_classifies_document_signatures() {
        assert_eq!(
            detect_import_extension(b"%PDF-1.7\n1 0 obj\n"),
            Some("pdf".to_string())
        );
        assert_eq!(
            detect_import_extension(&zip_with_local_entries(&["word/document.xml"])),
            Some("docx".to_string())
        );
        assert_eq!(
            detect_import_extension(&zip_with_local_entries(&["ppt/slides/slide1.xml"])),
            Some("pptx".to_string())
        );
        assert_eq!(
            detect_import_extension(&zip_with_local_entries(&["xl/workbook.xml"])),
            Some("xlsx".to_string())
        );
        assert_eq!(
            detect_import_extension(b"{\\rtf1\\ansi"),
            Some("rtf".to_string())
        );
    }

    #[test]
    fn detect_import_extension_classifies_supported_image_signatures() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F'];
        let mut webp = Vec::from(*b"RIFF");
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");

        assert_eq!(detect_import_extension(&png), Some("png".to_string()));
        assert_eq!(detect_import_extension(&jpeg), Some("jpg".to_string()));
        assert_eq!(detect_import_extension(&webp), Some("webp".to_string()));
    }

    #[test]
    fn detect_import_extension_keeps_malformed_and_binary_data_unknown() {
        // 截断的 ZIP 头：不得把任意 ZIP/办公文档前缀当成可识别格式。
        assert_eq!(
            detect_import_extension(&[0x50, 0x4B, 0x03, 0x04, 0, 0]),
            None
        );

        let mut malformed_zip = zip_with_local_entries(&["word/document.xml"]);
        malformed_zip[26] = 0xFF;
        malformed_zip[27] = 0xFF; // 声称超长条目名，但头部没有对应数据
        assert_eq!(detect_import_extension(&malformed_zip), None);

        // 控制字节（包括 NUL）不得按 UTF-8 纯文本兜底。
        assert_eq!(detect_import_extension(b"hello\0world"), None);
        assert_eq!(detect_import_extension(b"hello\x01world"), None);
        assert_eq!(detect_import_extension(&[0x00, 0x01, 0x02, 0xFF]), None);
    }

    #[test]
    fn detect_import_extension_does_not_misclassify_bmp_prefixed_text() {
        // 以 BM 开头、长度 >= 14 的普通文本不是位图，应按纯文本处理。
        assert_eq!(
            detect_import_extension(b"BMP is a raster image format.\n"),
            Some("txt".to_string())
        );
        // 同样的 BM 前缀下，真实 Markdown 结构仍应走 md。
        assert_eq!(
            detect_import_extension(b"BMW owners guide\n\n# Chapter 1\n"),
            Some("md".to_string())
        );
        // 长度越过 54 字节的 BM 普通可打印文本仍不是位图。
        let long_text = format!("BM{}", "printable text ".repeat(4));
        assert!(long_text.len() >= 60);
        assert_eq!(
            detect_import_extension(long_text.as_bytes()),
            Some("txt".to_string())
        );
    }

    #[test]
    fn detect_import_extension_accepts_hand_checked_small_bmp() {
        // 正对照：真正有效的小 BMP 不能被更严格的 BMP 结构校验误伤。
        let bmp = hand_checked_2x2_24bit_bmp();
        assert_eq!(bmp.len(), 70);
        assert_eq!(&bmp[2..6], &[70, 0, 0, 0]); // 文件大小与像素偏移须自洽
        assert_eq!(&bmp[10..14], &[54, 0, 0, 0]);
        assert_eq!(detect_import_extension(&bmp), Some("bmp".to_string()));
    }

    #[test]
    fn detect_import_extension_accepts_hand_checked_os2_bitmapcoreheader_bmp() {
        // 12 字节 BITMAPCOREHEADER 也是有效 BMP；routing 不应要求 40 字节 DIB 头。
        let bmp = hand_checked_4x4_24bit_os2_bmp();
        assert_eq!(bmp.len(), 74);
        assert_eq!(&bmp[10..14], &[26, 0, 0, 0]); // 像素偏移 26
        assert_eq!(&bmp[14..18], &[12, 0, 0, 0]); // DIB 头大小 12
        assert_eq!(detect_import_extension(&bmp), Some("bmp".to_string()));
    }

    #[test]
    fn detect_import_extension_accepts_bmp_sample_truncated_in_pixels() {
        // 只采样 54 字节头、像素数据被截断时仍应按头部结构识别为 bmp。
        let bmp = hand_checked_2x2_24bit_bmp();
        assert_eq!(detect_import_extension(&bmp[..54]), Some("bmp".to_string()));
    }

    #[test]
    fn detect_import_extension_rejects_control_bytes_past_first_kib() {
        // 前 1024 字节为普通文本，之后出现 NUL：整个有界样本仍是二进制。
        assert_eq!(
            detect_import_extension(&text_sample_with_control_after(
                "plain text without markup\n",
                4096,
                0
            )),
            None
        );
        // Markdown 前缀同样不得因 1024 字节窗口干净而被判为 md。
        assert_eq!(
            detect_import_extension(&text_sample_with_control_after("# Heading\n\n", 4096, 0x01)),
            None
        );
        // CSV 前缀 + 第 1024 字节后的 NUL 不得被判为 csv。
        let csv_prefix = "a,b\n".repeat(256);
        assert_eq!(csv_prefix.len(), 1024);
        assert_eq!(
            detect_import_extension(&text_sample_with_control_after(&csv_prefix, 4096, 0)),
            None
        );
        // 64KiB 有界样本的最末端出现 NUL 也必须拒绝。
        let at_limit = text_sample_with_control_after("plain text\n", 65_535, 0);
        assert_eq!(at_limit.len(), 65_536);
        assert_eq!(detect_import_extension(&at_limit), None);
    }

    #[test]
    fn detect_import_extension_bounds_malformed_zip_local_headers() {
        // 声明 u32::MAX compressed_size：条目无法在样本内跳过，不能退化成 ODF。
        let unbounded_compressed = zip_local_header_with_declared_sizes("content.xml", 0, u32::MAX);
        assert_eq!(detect_import_extension(&unbounded_compressed), None);

        // extra 长度声明超出实际样本。
        let extra_out_of_bounds = zip_local_header_with_declared_sizes("content.xml", u16::MAX, 0);
        assert_eq!(detect_import_extension(&extra_out_of_bounds), None);

        // 条目名长度声明超出实际样本。
        let mut name_out_of_bounds =
            zip_local_header_with_declared_sizes("word/document.xml", 0, 0);
        name_out_of_bounds[26] = 0xFF;
        name_out_of_bounds[27] = 0xFF;
        assert_eq!(detect_import_extension(&name_out_of_bounds), None);
    }

    /// 真实 ZIP 容器夹具：使用 `zip::ZipWriter` 的 stored 条目，
    /// 本地文件头带真实名称/大小，而不是只拼签名。
    fn zip_with_stored_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::{Cursor, Write};
        use zip::write::FileOptions;

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).expect("start zip entry");
            writer.write_all(content).expect("write zip entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    #[test]
    fn detect_import_extension_keeps_odf_text_and_presentation_unsupported() {
        // ODF 的 stored mimetype 不能伪装成 docx/pptx；ODT/ODP 保持不支持。
        let odt =
            zip_with_stored_entries(&[("mimetype", b"application/vnd.oasis.opendocument.text")]);
        assert_eq!(detect_import_extension(&odt), None);

        let odp = zip_with_stored_entries(&[(
            "mimetype",
            b"application/vnd.oasis.opendocument.presentation",
        )]);
        assert_eq!(detect_import_extension(&odp), None);
    }

    #[test]
    fn detect_import_extension_requires_real_ooxml_entry_names() {
        // 普通 ZIP 里仅有 word/xl/ppt 前缀的文本不是 OOXML。
        for entry in ["word/readme.txt", "xl/readme.txt", "ppt/readme.txt"] {
            let zip = zip_with_stored_entries(&[(entry, b"not an OOXML part")]);
            assert_eq!(
                detect_import_extension(&zip),
                None,
                "{entry} 不得识别为 OOXML"
            );
        }

        // 真正的 OOXML 条目名继续识别。
        assert_eq!(
            detect_import_extension(&zip_with_stored_entries(&[(
                "word/document.xml",
                b"<w:document/>",
            )])),
            Some("docx".to_string())
        );
        assert_eq!(
            detect_import_extension(&zip_with_stored_entries(&[(
                "xl/workbook.xml",
                b"<workbook/>",
            )])),
            Some("xlsx".to_string())
        );
        for entry in ["ppt/presentation.xml", "ppt/slides/slide1.xml"] {
            assert_eq!(
                detect_import_extension(&zip_with_stored_entries(&[
                    (entry, b"<p:presentation/>",)
                ])),
                Some("pptx".to_string()),
                "{entry} 应识别为 pptx"
            );
        }
    }
}
