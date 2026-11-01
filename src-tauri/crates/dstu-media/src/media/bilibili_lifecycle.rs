//! Android keeps the user-initiated loopback bridge alive only while paired work is active.
#[cfg(target_os = "android")]
pub struct BridgeLifecycleHandle(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("bilibili-bridge-lifecycle")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.deepstudent.app", "BiliBridgePlugin")?;
                tauri::Manager::manage(app, BridgeLifecycleHandle(handle));
            }
            let _ = (app, api);
            Ok(())
        })
        .build()
}

pub async fn set_active(app: &tauri::AppHandle, active: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BridgeLifecycleHandle>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<serde_json::Value>(
                "setActive",
                serde_json::json!({"active":active}),
            )
        })
        .await
        .map_err(|_| "浏览器桥服务任务失败".to_string())?
        .map_err(|_| "无法启动浏览器桥前台服务，请保持应用在前台".to_string())?;
    }
    let _ = (app, active);
    Ok(())
}

pub async fn touch(app: &tauri::AppHandle, bridge: bool) {
    if !bridge {
        return;
    }
    static LAST: std::sync::LazyLock<std::sync::Mutex<Option<std::time::Instant>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(None));
    let renew = {
        let mut last = LAST.lock().unwrap();
        if last.is_none_or(|at| at.elapsed() > std::time::Duration::from_secs(20)) {
            *last = Some(std::time::Instant::now());
            true
        } else {
            false
        }
    };
    if renew {
        let _ = set_active(app, true).await;
    }
}

pub fn watch(app: tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        use tauri::Manager;
        static WATCH: AtomicU64 = AtomicU64::new(0);
        let generation = WATCH.fetch_add(1, Ordering::SeqCst) + 1;
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if WATCH.load(Ordering::SeqCst) != generation {
                    break;
                }
                let handle = app.state::<BridgeLifecycleHandle>().0.clone();
                let active = tauri::async_runtime::spawn_blocking(move || {
                    handle
                        .run_mobile_plugin::<serde_json::Value>("getActive", serde_json::json!({}))
                })
                .await;
                if WATCH.load(Ordering::SeqCst) != generation {
                    break;
                }
                match active {
                    Ok(Ok(value)) if value["active"] == false => {
                        super::bilibili_transport::bridge::HUB.revoke();
                        break;
                    }
                    Ok(Ok(value)) if value["active"] == true => {
                        let hub = &super::bilibili_transport::bridge::HUB;
                        if hub.should_renew_lease() {
                            touch(&app, true).await;
                        }
                    }
                    // A plugin error is not proof that the user stopped the service.
                    _ => log::warn!("[bilibili_bridge] foreground service status unavailable"),
                }
            }
        });
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}
