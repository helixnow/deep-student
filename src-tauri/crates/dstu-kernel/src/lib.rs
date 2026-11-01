//! Deep Student 插件内核（core 层，只用 std）。
//!
//! 拆分后的低层 crate（vfs、llm_manager、storage 等）不能反向依赖业务域，
//! 跨层回调统一通过这里的三组原语表达，不再在业务代码里手写全局静态注册表：
//!
//! - [`Slot`]：**单提供方**服务槽，替代 `OnceLock<Arc<dyn T>>`。低层声明槽位，
//!   上层在组合根注入；占用时“先注册者生效”，需要替换时显式 [`Slot::replace`]。
//! - [`HookSet`]：**多订阅者**回调集，替代 `RwLock<Vec<Arc<dyn T>>>`。注册返回
//!   [`Disposer`]；遍历先取快照再回调，不持锁执行。
//! - [`Kernel`]：在 [`HookSet`] 之上分带——安全关键钩子进不可移除的 Kernel 带，
//!   其余进 `Default` 带；带 observe / gate / waterfall 三种调用语义。
//! - [`Plugin`] + [`Scope`] + [`PluginHost`]：组合根把上层实现组织成显式有序的
//!   插件列表；`Scope` 收集注入产生的 `Disposer`，卸载/回滚按注册逆序执行。
//!
//! # 使用约定
//!
//! 1. 低层在**消费方旁边**声明 `static SLOT: Slot<dyn Trait> = Slot::new();` 或
//!    `static HOOKS: HookSet<dyn Trait> = HookSet::new();`，并提供薄的
//!    `register_* -> Disposer` / `get()` 函数；业务代码只通过它们访问。
//! 2. 上层实现 trait，在 `Plugin::apply(&mut scope)` 里调用低层 `register_*` 并
//!    `scope.add(disposer)`。组合根（`extensions.rs`）是**唯一**注册处，显式有序，
//!    禁止 `inventory` / `linkme` 等链接期自动收集（Android staticlib 会被裁剪）。
//! 3. 进程生命周期内插件不卸载；`PluginHost` 由全局持有。局部 `Scope` / `PluginHost`
//!    用于测试回滚与卸载逆序。
//! 4. **安全关键钩子（审批准入、Kill Switch）只能放 Kernel 带**：`Kernel` 带
//!    不可移除且始终先于 `Default` 带执行，避免运行期被默认带插件挤到后面。

#![forbid(unsafe_code)]

mod disposer;
mod hookset;
mod kernel;
mod plugin;
mod slot;

pub use disposer::Disposer;
pub use hookset::HookSet;
pub use kernel::{GateDecision, Kernel};
pub use plugin::{Plugin, PluginError, PluginHost, Scope};
pub use slot::{Slot, SlotOccupied};
