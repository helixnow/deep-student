//! 音视频学习：媒体转写流水线（解码 → VAD → ASR → 字幕段）
//!
//! 实现已迁至 dstu-media（`dstu_media::media`），这里按原路径重导出，保留
//! `crate::media::xxx` 与 `generate_handler!` 里的命令路径。取 `State<'_, AppState>`
//! 的命令以同名同签名的薄包装留在 app：[`commands`]（`media_transcribe_estimate` /
//! `media_transcribe_start`）、[`ledger`]（`media_checkpoints` / `media_chapters` /
//! `media_study_ledger`）。[`AppMediaHost`] 为 dstu-media 提供原来的
//! `try_state::<AppState>()` / `state::<AppState>()` 解析。

pub use dstu_media::media::*;

pub mod commands;
pub mod ledger;

use dstu_media::host::{MediaAppServices, MediaHost};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;

/// dstu-media 的 app 侧服务解析（实现体即拆分前 media 代码里的 `AppState` 取值）。
pub(crate) struct AppMediaHost;

impl MediaHost for AppMediaHost {
    fn try_services(&self, app: &AppHandle) -> Option<MediaAppServices> {
        app.try_state::<AppState>().map(|state| MediaAppServices {
            llm_manager: state.llm_manager.clone(),
            database: state.database.clone(),
        })
    }

    fn services(&self, app: &AppHandle) -> MediaAppServices {
        let state = app.state::<AppState>();
        MediaAppServices {
            llm_manager: state.llm_manager.clone(),
            database: state.database.clone(),
        }
    }
}

/// 由 `extensions::register_extensions()` 的 `MediaHostPlugin` 调用；幂等由
/// `PluginHost`（同名插件只 apply 一次）保证。
pub(crate) fn install_media_host(scope: &mut dstu_kernel::Scope) {
    let host = std::sync::Arc::new(AppMediaHost);
    if let Ok(disposer) = dstu_media::host::register_media_host(host) {
        scope.add(disposer);
    }
}
