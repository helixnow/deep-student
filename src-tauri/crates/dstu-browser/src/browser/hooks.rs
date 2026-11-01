//! browser 对上层能力的回调注册点。
//!
//! 拆分后 browser 是 domain crate，不能反向依赖 chat_v2；Agent 会话的下载落盘目录
//! （per-session artifact 根）由 `extensions::register_extensions()` 在启动时接线。
//! 全部注册时的可观察行为与拆分前直接调用 `chat_v2::runtime_roots::artifact_root` 一致。
//!
//! 注册机制走 `dstu-kernel` 的 [`Slot`]（单提供方）：槽位被占用时保持“先注册者生效”
//! （返回 `Err(SlotOccupied)`），返回的 [`Disposer`] 由 `extensions.rs` 的插件 `Scope` 持有。

use std::path::PathBuf;
use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};
use tauri::AppHandle;

/// Agent 会话 artifact 根目录解析。
pub trait DownloadArtifactRoot: Send + Sync {
    /// 与 `chat_v2::runtime_roots::artifact_root(app, chat_session_id, true)` 等价，
    /// 返回其 `path`（`create = true`：必要时创建目录）。
    fn artifact_root(&self, app: &AppHandle, chat_session_id: &str) -> Result<PathBuf, String>;
}

static DOWNLOAD_ARTIFACT_ROOT: Slot<dyn DownloadArtifactRoot> = Slot::new();

/// 注册 artifact 根目录解析实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_download_artifact_root(
    resolver: Arc<dyn DownloadArtifactRoot>,
) -> Result<Disposer, SlotOccupied> {
    DOWNLOAD_ARTIFACT_ROOT.provide(resolver)
}

/// 解析 Agent 会话的 artifact 根目录；未注册实现时返回 `Err`（调用方按解析失败处理）。
pub(crate) fn download_artifact_root(
    app: &AppHandle,
    chat_session_id: &str,
) -> Result<PathBuf, String> {
    match DOWNLOAD_ARTIFACT_ROOT.get() {
        Some(resolver) => resolver.artifact_root(app, chat_session_id),
        None => Err("browser download artifact root resolver is not registered".to_string()),
    }
}
