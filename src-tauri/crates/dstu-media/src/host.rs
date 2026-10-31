//! app 侧服务的注入点。
//!
//! 拆分前 media 代码直接 `app.try_state::<AppState>()` / `app.state::<AppState>()`
//! 取主库（`database`）与 `llm_manager`。`AppState` 定义在 app，本 crate 不能引用，
//! 改由 app 在 `extensions::register_extensions()` 中提供 [`MediaHost`] 实现
//! （实现体就是原来的 `try_state` / `state` 调用），行为与拆分前一致。

use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};
use tauri::AppHandle;

use crate::database::Database;
use crate::llm_manager::LLMManager;

/// `AppState` 中 media 用到的服务（与 `AppState` 持有的是同一组 `Arc`）。
#[derive(Clone)]
pub struct MediaAppServices {
    pub llm_manager: Arc<LLMManager>,
    pub database: Arc<Database>,
}

/// app 提供的服务解析（实现见 app 的 `media` 模块）。
pub trait MediaHost: Send + Sync {
    /// 等价于 `app.try_state::<AppState>()`：`AppState` 尚未注入时返回 `None`。
    fn try_services(&self, app: &AppHandle) -> Option<MediaAppServices>;
    /// 等价于 `app.state::<AppState>()`：`AppState` 未注入时 panic（与原行为一致）。
    fn services(&self, app: &AppHandle) -> MediaAppServices;
}

static MEDIA_HOST: Slot<dyn MediaHost> = Slot::new();

/// 注册 app 侧服务解析；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_media_host(host: Arc<dyn MediaHost>) -> Result<Disposer, SlotOccupied> {
    MEDIA_HOST.provide(host)
}

/// 原 `app.try_state::<AppState>()`；未注册实现时视同 `AppState` 不存在。
pub(crate) fn try_services(app: &AppHandle) -> Option<MediaAppServices> {
    MEDIA_HOST.get().and_then(|host| host.try_services(app))
}

/// 原 `app.state::<AppState>()`。
pub(crate) fn services(app: &AppHandle) -> MediaAppServices {
    MEDIA_HOST
        .get()
        .expect("dstu_media::host: MediaHost 未注册（extensions::register_extensions）")
        .services(app)
}
