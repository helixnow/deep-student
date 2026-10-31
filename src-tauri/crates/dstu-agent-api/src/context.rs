//! 执行上下文：从 35 字段神结构收敛为 Core + Services + Host。
//!
//! `ExecutionContext` 只持有共享 `Arc` 与本次调用的元数据；具体服务通过
//! [`crate::services::Services`] 以 `TypeId` 取用，宿主能力通过
//! [`crate::host`] 的五个 trait 注入。

use std::sync::Arc;

use dstu_core::agent::ToolCall;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::host::{
    AdmittedToolDispatcher, AppEventEmitter, HostBridge, RuntimeRootResolver, ToolBlockStore,
};
use crate::services::Services;

/// 本次调用的标识集合。
#[derive(Debug, Clone, Default)]
pub struct CallIds {
    /// 会话 ID。
    pub session_id: String,
    /// 消息 ID。
    pub message_id: String,
    /// 块 ID（多工具并发时由后端生成）。
    pub block_id: Option<String>,
    /// 工具调用 ID（关联 `ToolCall.id`）。
    pub tool_call_id: String,
    /// 工具轮次（从 0 开始）。
    pub round: u32,
}

/// 本次调用的功能开关。
#[derive(Debug, Clone, Copy, Default)]
pub struct ExecutionFlags {
    /// 是否允许记忆读写工具。
    pub memory_enabled: bool,
    /// 是否允许 RAG 检索。
    pub rag_enabled: bool,
    /// 是否允许外部搜索。
    pub web_search_enabled: bool,
    /// 模型是否支持工具调用。
    pub supports_tools: bool,
}

/// 单域请求参数（替代散落在 `SendOptions` 里的特例字段）。
#[derive(Debug, Clone, Default)]
pub struct RequestExt {
    /// RAG 召回条数。
    pub rag_top_k: Option<usize>,
    /// Canvas 笔记 ID。
    pub canvas_note_id: Option<String>,
    /// 出题创作配置（qbank 域）。
    pub question_authoring: Option<Value>,
}

/// 工具执行上下文。
pub struct ExecutionContext {
    /// 本次工具调用。
    pub call: ToolCall,
    /// 标识集合。
    pub ids: CallIds,
    /// 事件发射器。
    pub emitter: Arc<dyn AppEventEmitter>,
    /// 服务容器。
    pub services: Arc<Services>,
    /// 宿主桥。
    pub host: Arc<dyn HostBridge>,
    /// 运行时根目录。
    pub runtime_roots: Arc<dyn RuntimeRootResolver>,
    /// 工具块持久化。
    pub block_store: Arc<dyn ToolBlockStore>,
    /// 准入调度器（重入 pipeline）。
    pub dispatcher: Arc<dyn AdmittedToolDispatcher>,
    /// 取消令牌。
    pub cancel: CancellationToken,
    /// 功能开关。
    pub flags: ExecutionFlags,
    /// 单域请求参数。
    pub request: RequestExt,
}

impl ExecutionContext {
    /// 本次调用是否已请求取消。
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// 是否有可交互的前端窗口。
    pub fn has_frontend(&self) -> bool {
        self.host.has_frontend()
    }
}

impl std::fmt::Debug for ExecutionContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionContext")
            .field("call", &self.call)
            .field("ids", &self.ids)
            .field("cancelled", &self.is_cancelled())
            .field("has_frontend", &self.has_frontend())
            .finish_non_exhaustive()
    }
}
