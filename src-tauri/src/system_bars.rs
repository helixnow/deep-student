//! Android 系统栏控制桥（#472 沉浸式全屏）。
//!
//! 背景：vivo 等平板的状态栏区域里还有厂商的分屏 / 原子工作台小横条，且该横条
//! 没有公开 API 可关。用户可在设置里开启「沉浸式全屏」：隐藏状态栏 + 导航栏，
//! 从屏幕边缘滑动临时呼出。
//!
//! 偏好由前端设置（`android.immersive_mode`）作为权威来源，启动时与切换时经本命令
//! 下发；Kotlin 侧另存一份 SharedPreferences，冷启动时先于前端生效，避免系统栏闪现。
//!
//! 配套文件（版本控制内的受控副本，构建时同步进 gen/android）：
//! - `src-tauri/mobile/android/SystemBarsPlugin.kt`（插件，只转发）
//! - `src-tauri/mobile/android/MainActivity.kt`（`setImmersiveMode` 显隐 + 持久化）

use crate::models::AppError;
use tauri::plugin::TauriPlugin;
use tauri::AppHandle;

type Result<T> = std::result::Result<T, AppError>;

/// 持有 Android 插件 handle 的托管状态。
#[cfg(target_os = "android")]
pub(crate) struct SystemBarsHandle(pub(crate) tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("system-bars")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.deepstudent.app", "SystemBarsPlugin")?;
                tauri::Manager::manage(app, SystemBarsHandle(handle));
            }
            let _ = app;
            let _ = api;
            Ok(())
        })
        .build()
}

/// 开关 Android 沉浸式全屏（隐藏状态栏 + 导航栏，边缘滑动临时呼出）。
///
/// 非 Android 平台没有系统栏概念，直接返回成功（前端只在 Android 上调用）。
#[tauri::command]
pub async fn set_android_immersive_mode(app: AppHandle, enabled: bool) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let state = app
            .try_state::<SystemBarsHandle>()
            .ok_or_else(|| AppError::unknown("system-bars 插件未初始化".to_string()))?;
        let plugin = state.0.clone();
        let payload = serde_json::json!({ "enabled": enabled });
        // run_mobile_plugin 内部同步阻塞等待 Kotlin 回调，放到 blocking 池。
        tauri::async_runtime::spawn_blocking(move || {
            plugin.run_mobile_plugin::<serde_json::Value>("setImmersive", payload)
        })
        .await
        .map_err(|e| AppError::unknown(format!("immersive task join error: {e}")))?
        .map_err(|e| AppError::unknown(format!("切换沉浸式全屏失败: {e}")))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}
