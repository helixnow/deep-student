//! 题库命令与后台任务的运行期依赖。
//!
//! 拆分前命令直接取 `State<'_, AppState>`、后台任务用 `app.state::<AppState>()`，
//! 只读其中的 `vfs_db` 与 `llm_manager`。`AppState` 定义在 app，本 crate 不能引用：
//! - 命令的 `#[tauri::command]` 薄包装留在 app（签名不变），从 `AppState` 取出
//!   [`QbankState`] 传给这里的业务体；
//! - 后台任务（练习截止自动交卷、批改队列）只持有 `AppHandle`，经 [`resolve_state`]
//!   向组合根（app `extensions.rs`）注入的 [`QbankStateResolver`] 取同样的字段。

use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;

/// `AppState` 中题库用到的字段（与 `AppState` 同名同型）。
#[derive(Clone)]
pub struct QbankState {
    pub vfs_db: Option<Arc<VfsDatabase>>,
    pub llm_manager: Arc<LLMManager>,
}

/// 从 `AppHandle` 读取 [`QbankState`]（app 实现：`app.state::<AppState>()`）。
pub trait QbankStateResolver: Send + Sync {
    fn resolve(&self, app: &tauri::AppHandle) -> QbankState;
}

static STATE_RESOLVER: Slot<dyn QbankStateResolver> = Slot::new();

/// 由 app `extensions::register_extensions()` 注入；先注册者生效。
pub fn provide_state_resolver(
    resolver: Arc<dyn QbankStateResolver>,
) -> Result<Disposer, SlotOccupied> {
    STATE_RESOLVER.provide(resolver)
}

/// 等价于拆分前的 `app.state::<AppState>()`：未注入时 panic（与 state 未 manage 时一致）。
pub fn resolve_state(app: &tauri::AppHandle) -> QbankState {
    STATE_RESOLVER
        .get()
        .expect("qbank state resolver not registered; call extensions::register_extensions()")
        .resolve(app)
}
