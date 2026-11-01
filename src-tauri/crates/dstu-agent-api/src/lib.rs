//! `dstu-agent-api`：agent 工具执行的稳定契约层（A0/A1 前置层）。
//!
//! 只放 trait 与纯数据，不放业务实现，也不依赖 tauri / chat_v2 / vfs / llm：
//! - [`executor::ToolExecutor`]：对象安全的工具执行接口（`Pin<Box<dyn Future>>`）；
//! - [`descriptor::ToolDescriptor`]：工具名字/别名、块类型、超时、headless/PTC/审批策略；
//! - [`provider::ToolProvider`]：按 provider 声明 descriptor 与 executor 花名册；
//! - [`registry::ToolRegistryBuilder`]：启动时校验重名/别名、缺失 executor、catch-all 规则；
//! - [`context::ExecutionContext`] + [`services::Services`]：取代 35 字段神结构；
//! - [`host`]：`HostBridge` / `AppEventEmitter` / `RuntimeRootResolver` /
//!   `ToolBlockStore` / `AdmittedToolDispatcher` 五个宿主端口（Tauri 实现留在 dstu-app）；
//! - [`budget`]：工具结果的统一字符预算出口。
//!
//! 迁移策略见 `agent-api-design.md`：先由 `LegacyToolProvider` 包装现有注册表保持行为
//! 不变，再按域把 executor 换成各域 provider；本 crate 只提供契约，不迁移 executor。

pub mod budget;
pub mod context;
pub mod descriptor;
pub mod executor;
pub mod host;
pub mod provider;
pub mod registry;
pub mod services;

pub use budget::{apply_tool_result_budget, DEFAULT_TOOL_RESULT_CHAR_BUDGET};
pub use context::{CallIds, ExecutionContext, ExecutionFlags, RequestExt};
pub use descriptor::{ApprovalPolicy, HeadlessPolicy, PtcPolicy, ToolDescriptor, ToolTimeout};
pub use executor::{ToolConcurrency, ToolExecutor, ToolFuture, ToolSensitivity};
pub use host::{
    AdmittedToolDispatcher, AppEventEmitter, HostBridge, HostRequest, RuntimeRootResolver,
    ToolBlockStore,
};
pub use provider::{ProviderId, ToolProvider};
pub use registry::{DescriptorTable, ToolRegistry, ToolRegistryBuilder, ToolRegistryError};
pub use services::{ServiceNotFound, Services};
