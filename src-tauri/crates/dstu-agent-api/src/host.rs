//! 宿主端口（替代 `tauri::Window` / `AppState` / `AppHandle`）。
//!
//! 这些 trait 只描述能力，Tauri 适配器（`WindowHostBridge`、`HeadlessHostBridge`、
//! `RuntimeRootResolver`、`AppEventEmitter`、`ToolBlockStore`）留在 `dstu-app`。

use std::any::Any;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use dstu_core::agent::{ToolCall, ToolResultInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::context::ExecutionContext;

/// `HostBridge::round_trip` 的 future 别名。
pub type HostFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// 一次往返请求（前端桥 / 桌面桥 / ACR）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRequest {
    /// 桥通道名（如 `acr_bridge_call`、`mcp-bridge-request`）。
    pub channel: String,
    /// 请求载荷。
    pub payload: Value,
    /// 可选超时（毫秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl HostRequest {
    /// 构造一次往返请求。
    pub fn new(channel: impl Into<String>, payload: Value) -> Self {
        Self {
            channel: channel.into(),
            payload,
            timeout_ms: None,
        }
    }

    /// 设置超时（毫秒）。
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }
}

/// 宿主桥：前端是否在线、单向事件、往返请求。
pub trait HostBridge: Send + Sync {
    /// 是否有可交互的前端窗口（替代 `window_ref()` 的存在性判断）。
    fn has_frontend(&self) -> bool;

    /// 发一条单向事件。
    fn emit(&self, event: &str, payload: Value) -> Result<(), String>;

    /// 发起一次往返请求（前端桥/桌面桥）。
    fn round_trip(&self, request: HostRequest) -> HostFuture<'_>;

    /// 仅 app 内部降级用（取回具体 `AppHandle` 等）。
    fn as_any(&self) -> &dyn Any;
}

/// 块级/会话级事件发射器。
pub trait AppEventEmitter: Send + Sync {
    /// 是否有可交互的前端窗口。
    fn has_frontend(&self) -> bool;

    /// 发射块级事件（`chat_v2_event_{session_id}`）。
    fn emit_block_event(&self, event: &str, payload: Value);

    /// 发射会话级事件（`chat_v2_session_{session_id}`）。
    fn emit_session_event(&self, event: &str, payload: Value);
}

/// 运行时根目录解析与授权。
pub trait RuntimeRootResolver: Send + Sync {
    /// artifact 根目录。
    fn artifact_root(&self) -> PathBuf;

    /// 临时运行根目录。
    fn temp_root(&self) -> PathBuf;

    /// 工作区根目录。
    fn workspace_root(&self) -> PathBuf;

    /// 解析相对路径到运行时根内。
    fn resolve(&self, relative: &str) -> Result<PathBuf, String>;

    /// 校验路径已授权（沙箱边界）。
    fn authorize(&self, path: &Path) -> Result<(), String>;
}

/// 工具块持久化出口（替代 `ExecutionContext::save_tool_block` 的裸 SQL）。
pub trait ToolBlockStore: Send + Sync {
    /// 写入/更新一个工具块。
    fn upsert_tool_block(
        &self,
        call: &ToolCall,
        block_type: &str,
        payload: &Value,
    ) -> Result<(), String>;
}

/// 重入 pipeline 的准入调度器（Workspace/Subagent/ToolPack/PTC 用）。
pub trait AdmittedToolDispatcher: Send + Sync {
    /// 调度一次已经过审批/白名单的子工具调用。
    fn dispatch_admitted<'a>(
        &'a self,
        call: ToolCall,
        ctx: &'a ExecutionContext,
    ) -> Pin<Box<dyn Future<Output = Result<ToolResultInfo, String>> + Send + 'a>>;
}
