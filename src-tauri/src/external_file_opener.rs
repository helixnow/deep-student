//! 移动端「用其他应用打开 / 分享文件」桥（Android）。
//!
//! 背景：
//! - `tauri-plugin-opener` 2.5.x 的移动端 `open_path` 把裸字符串发给 Kotlin
//!   `open`，而 Kotlin 侧按 `OpenArgs { url }` 解析 → 参数解析必然失败；即使
//!   解析成功，`file://` 在 Android 7+ 也会触发 FileUriExposedException。
//! - `reveal_item_in_dir` 在 Android/iOS 直接返回 UnsupportedPlatform——移动端
//!   根本没有"在文件管理器中显示"这个概念。
//!
//! 因此移动端所有"打开 / 在文件夹中显示"统一走本模块：
//! 1. Rust 校验路径（必须是应用自有目录下的普通文件，或 `content://` URI），
//!    把本地文件复制到 `$APPCACHE/shared/<uuid>/<文件名>`；
//! 2. Kotlin `ExternalFilePlugin` 用 FileProvider（仅暴露 `cache/shared/`，
//!    见 `res/xml/file_paths.xml`）生成 `content://` URI，按 MIME 发
//!    `ACTION_VIEW`（`FLAG_GRANT_READ_URI_PERMISSION`）；没有应用能打开时回退
//!    `ACTION_SEND` 分享面板。`mode = "share"` 直接走分享面板。
//!
//! 只暴露副本而不是原文件：FileProvider 根目录保持窄（不暴露 files/ 下的数据库），
//! 外部应用拿到的只是一次性的只读副本。副本超过 [`SHARED_TTL`] 后在下一次调用时清理。
//!
//! 配套文件（版本控制内的受控副本，构建时同步进 gen/android）：
//! - `src-tauri/mobile/android/ExternalFilePlugin.kt`
//! - `src-tauri/mobile/android/res/xml/file_paths.xml`（`<cache-path name="shared">`）

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::models::AppError;
use tauri::plugin::TauriPlugin;
use tauri::AppHandle;

type Result<T> = std::result::Result<T, AppError>;

/// 与 `file_paths.xml` 的 `<cache-path name="shared" path="shared/" />` 一致。
pub const SHARED_CACHE_SUBDIR: &str = "shared";
/// 分享副本的保留时长：外部应用可能稍后才读取（如邮件附件），留足一天。
pub const SHARED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 持有 Android 插件 handle 的托管状态。
#[cfg(target_os = "android")]
pub(crate) struct ExternalFileHandle(pub(crate) tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("external-file")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.deepstudent.app", "ExternalFilePlugin")?;
                tauri::Manager::manage(app, ExternalFileHandle(handle));
            }
            let _ = app;
            let _ = api;
            Ok(())
        })
        .build()
}

/// 打开方式：`view` = 用其他应用打开（无应用可打开时 Kotlin 自动回退分享），
/// `share` = 直接弹系统分享面板。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalOpenMode {
    View,
    Share,
}

impl ExternalOpenMode {
    pub fn parse(raw: Option<&str>) -> Result<Self> {
        match raw.map(str::trim).unwrap_or("view") {
            "" | "view" => Ok(Self::View),
            "share" => Ok(Self::Share),
            other => Err(AppError::validation(format!("不支持的打开方式: {other}"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Share => "share",
        }
    }
}

pub fn is_content_uri(path: &str) -> bool {
    path.trim_start()
        .get(..10)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("content://"))
}

/// 校验 `source` 是 `allowed_roots` 之一下的普通文件，返回规范化路径。
///
/// 只允许应用自有目录：这条通道会把文件交给第三方应用，不能被用来外发任意路径。
pub fn resolve_shareable_source(source: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf> {
    let canonical = source
        .canonicalize()
        .map_err(|e| AppError::not_found(format!("文件不存在或无法访问: {e}")))?;
    if !canonical.is_file() {
        return Err(AppError::validation("只能打开文件，不能打开目录"));
    }
    let inside_allowed_root = allowed_roots.iter().any(|root| {
        root.canonicalize()
            .map(|root| canonical.starts_with(&root))
            .unwrap_or(false)
    });
    if !inside_allowed_root {
        return Err(AppError::validation("只能打开应用数据目录内的文件"));
    }
    Ok(canonical)
}

/// 把 `source` 复制成 `<cache_dir>/shared/<uuid>/<文件名>` 并返回副本路径；
/// 已经位于 shared 目录内的文件直接复用。顺带清理过期副本。
pub fn stage_for_sharing(cache_dir: &Path, source: &Path) -> Result<PathBuf> {
    let shared_root = cache_dir.join(SHARED_CACHE_SUBDIR);
    std::fs::create_dir_all(&shared_root)
        .map_err(|e| AppError::file_system(format!("创建分享缓存目录失败: {e}")))?;
    let shared_root = shared_root
        .canonicalize()
        .map_err(|e| AppError::file_system(format!("分享缓存目录不可用: {e}")))?;
    if source.starts_with(&shared_root) {
        return Ok(source.to_path_buf());
    }

    purge_expired_shared_copies(&shared_root, SHARED_TTL);

    let raw_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut file_name =
        crate::unified_file_manager::sanitize_file_name_for_fs(&raw_name).replace(['/', '\\'], "_");
    if file_name.trim().is_empty() || file_name == "." || file_name == ".." {
        file_name = "file".to_string();
    }

    let staging_dir = shared_root.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| AppError::file_system(format!("创建分享副本目录失败: {e}")))?;
    let target = staging_dir.join(file_name);
    if let Err(e) = std::fs::copy(source, &target) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(AppError::file_system(format!("复制分享副本失败: {e}")));
    }
    Ok(target)
}

/// 删除 shared 目录下修改时间早于 `ttl` 的条目（尽力而为，失败忽略）。
pub fn purge_expired_shared_copies(shared_root: &Path, ttl: Duration) {
    let Ok(entries) = std::fs::read_dir(shared_root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= ttl);
        if !expired {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// 用其他应用打开（`mode = "view"`）或分享（`mode = "share"`）文件。仅 Android。
///
/// `path` 可以是应用自有目录下的本地文件，或 SAF 保存得到的 `content://` URI。
/// 返回实际执行的动作：`"view"` 或 `"share"`（无应用可打开时 Kotlin 回退分享）。
#[tauri::command]
pub async fn open_file_externally(
    app: AppHandle,
    path: String,
    mode: Option<String>,
) -> Result<String> {
    let mode = ExternalOpenMode::parse(mode.as_deref())?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let plugin = app
            .try_state::<ExternalFileHandle>()
            .ok_or_else(|| AppError::unknown("external-file 插件未初始化".to_string()))?
            .0
            .clone();

        let target = if is_content_uri(&path) {
            path.trim().to_string()
        } else {
            let resolver = app.path();
            let cache_dir = resolver
                .app_cache_dir()
                .map_err(|e| AppError::file_system(format!("无法解析缓存目录: {e}")))?;
            let mut roots: Vec<PathBuf> = [
                resolver.app_data_dir(),
                resolver.app_local_data_dir(),
                resolver.app_config_dir(),
                resolver.app_log_dir(),
            ]
            .into_iter()
            .filter_map(|dir| dir.ok())
            .collect();
            roots.push(cache_dir.clone());
            if let Some(state) = app.try_state::<crate::commands::AppState>() {
                roots.push(state.file_manager.get_app_data_dir().to_path_buf());
            }
            let source = PathBuf::from(path.trim());
            tauri::async_runtime::spawn_blocking(move || -> Result<String> {
                let canonical = resolve_shareable_source(&source, &roots)?;
                let staged = stage_for_sharing(&cache_dir, &canonical)?;
                Ok(staged.to_string_lossy().to_string())
            })
            .await
            .map_err(|e| AppError::unknown(format!("准备分享副本失败: {e}")))??
        };

        let payload = serde_json::json!({ "path": target, "mode": mode.as_str() });
        // run_mobile_plugin 内部同步阻塞等待 Kotlin 回调；只是发 Intent，但仍放到
        // blocking 池，避免占住异步运行时线程。
        let response = tauri::async_runtime::spawn_blocking(move || {
            plugin.run_mobile_plugin::<serde_json::Value>("open", payload)
        })
        .await
        .map_err(|e| AppError::unknown(format!("open task join error: {e}")))?
        .map_err(|e| AppError::unknown(format!("无法调起其他应用: {e}")))?;
        let action = response
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or(mode.as_str())
            .to_string();
        return Ok(action);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, mode);
        Err(AppError::validation(
            "open_file_externally is only supported on Android",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ds-external-file-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mode_parse_defaults_to_view_and_rejects_unknown() {
        assert_eq!(
            ExternalOpenMode::parse(None).unwrap(),
            ExternalOpenMode::View
        );
        assert_eq!(
            ExternalOpenMode::parse(Some("")).unwrap(),
            ExternalOpenMode::View
        );
        assert_eq!(
            ExternalOpenMode::parse(Some("share")).unwrap(),
            ExternalOpenMode::Share
        );
        assert!(ExternalOpenMode::parse(Some("reveal")).is_err());
    }

    #[test]
    fn content_uri_detection_is_case_insensitive() {
        assert!(is_content_uri("content://com.android.providers/document/1"));
        assert!(is_content_uri("  CONTENT://x/y"));
        assert!(!is_content_uri("/data/user/0/app/files/a.pdf"));
        assert!(!is_content_uri("file:///sdcard/a.pdf"));
        assert!(!is_content_uri("content:"));
    }

    #[test]
    fn source_must_be_a_file_inside_an_allowed_root() {
        let app_root = temp_root("app");
        let outside = temp_root("outside");
        let inside_file = app_root.join("workspace/report.pdf");
        std::fs::create_dir_all(inside_file.parent().unwrap()).unwrap();
        std::fs::write(&inside_file, b"pdf").unwrap();
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, b"x").unwrap();
        let roots = vec![app_root.clone()];

        assert!(resolve_shareable_source(&inside_file, &roots).is_ok());
        assert!(resolve_shareable_source(&outside_file, &roots).is_err());
        assert!(resolve_shareable_source(&app_root.join("workspace"), &roots).is_err());
        assert!(resolve_shareable_source(&app_root.join("missing.pdf"), &roots).is_err());
        // `..` 逃逸经 canonicalize 后落在根外，必须拒绝
        let escape = app_root
            .join("workspace/../../")
            .join(outside.file_name().unwrap());
        assert!(resolve_shareable_source(&escape.join("secret.txt"), &roots).is_err());

        let _ = std::fs::remove_dir_all(app_root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn staging_copies_into_shared_subdir_and_reuses_shared_files() {
        let cache = temp_root("cache");
        let data = temp_root("data");
        let source = data.join("讲义 第1章.pptx");
        std::fs::write(&source, b"pptx-bytes").unwrap();

        let staged = stage_for_sharing(&cache, &source).unwrap();
        let shared_root = cache.join(SHARED_CACHE_SUBDIR).canonicalize().unwrap();
        assert!(staged.starts_with(&shared_root));
        assert_eq!(staged.file_name().unwrap(), "讲义 第1章.pptx");
        assert_eq!(std::fs::read(&staged).unwrap(), b"pptx-bytes");
        assert!(source.exists(), "原文件必须保留");

        // 已在 shared 目录内的文件（如诊断包）不再二次复制
        let again = stage_for_sharing(&cache, &staged).unwrap();
        assert_eq!(again, staged);

        let _ = std::fs::remove_dir_all(cache);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn purge_removes_only_expired_entries() {
        let shared = temp_root("purge");
        let fresh = shared.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        purge_expired_shared_copies(&shared, SHARED_TTL);
        assert!(fresh.exists());
        purge_expired_shared_copies(&shared, Duration::ZERO);
        assert!(!fresh.exists());
        let _ = std::fs::remove_dir_all(shared);
    }
}
