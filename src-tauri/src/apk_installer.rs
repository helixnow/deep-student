//! Android 应用内 APK 安装桥（最小原生插件）。
//!
//! 背景：
//! - tauri-plugin-updater 不支持 Android/iOS，移动端更新检查由前端
//!   `useAppUpdater` 直接对比 latest.json 完成；
//! - tauri-plugin-opener 的 Android 实现只能 `ACTION_VIEW` 打开 URL
//!   （`Uri.parse`），无法把本地文件转成 FileProvider 的 `content://` URI
//!   （`file://` 在 Android 7+ 会触发 FileUriExposedException），
//!   也就无法触发系统安装器。
//!
//! 因此这里注册一个原生插件：Kotlin 侧 `ApkInstallerPlugin` 只负责
//! "FileProvider → ACTION_VIEW(application/vnd.android.package-archive)"；
//! APK 下载在前端完成（plugin-http 流式 + plugin-fs 分块写入 `$APPCACHE`），
//! Rust 不重复实现下载/进度逻辑。
//!
//! 配套文件（均为版本控制内的受控副本，构建时同步进 gen/android）：
//! - `src-tauri/mobile/android/ApkInstallerPlugin.kt`（插件实现）
//! - `src-tauri/mobile/android/res/xml/file_paths.xml`（FileProvider 路径）
//! - AndroidManifest.xml 的 `<provider>` 声明由
//!   `scripts/build_android.sh` / `reusable-build-android.yml` 注入并校验。

use tauri::plugin::TauriPlugin;

/// 持有 Android 插件 handle 的托管状态（供应用命令调用 Kotlin 侧 install）。
#[cfg(target_os = "android")]
pub(crate) struct ApkInstallerHandle(pub(crate) tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("apk-installer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.deepstudent.app", "ApkInstallerPlugin")?;
                app.manage(ApkInstallerHandle(handle));
            }
            let _ = app;
            let _ = api;
            Ok(())
        })
        .build()
}
