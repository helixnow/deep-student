//! 工具执行接口（对象安全）。
//!
//! 与 `chat_v2::tools::executor::ToolExecutor` 语义一致，但只依赖
//! [`dstu_core::agent::{ToolCall, ToolResultInfo}`]，因此域 crate 不必依赖
//! agent/chat_v2。迁移期由 `LegacyToolProvider` 在 app/agent 侧做适配。

use std::future::Future;
use std::pin::Pin;

use dstu_core::agent::{ToolCall, ToolResultInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::budget::DEFAULT_TOOL_RESULT_CHAR_BUDGET;
use crate::context::ExecutionContext;

/// 工具执行 future 的别名（对象安全：不在 trait 上使用 `async fn`）。
pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<ToolResultInfo, String>> + Send + 'a>>;

/// 工具敏感等级。
///
/// 用于审批机制判断是否需要用户确认。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolSensitivity {
    /// 低敏感 - 直接执行
    #[default]
    Low,
    /// 中敏感 - 根据用户配置决定
    Medium,
    /// 高敏感 - 必须审批
    High,
}

/// 工具并发等级。
///
/// - `ReadOnly`：纯只读、无副作用（检索/读取/查询类）。可并行执行，且瞬时失败
///   （超时/网络/429/5xx）允许自动重试。
/// - `SafeParallel`：有副作用但相互隔离、可安全并行。可并行，但**不**自动重试。
/// - `Serial`：默认值。顺序执行，绝不自动重试。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolConcurrency {
    /// 只读工具 - 可并行 + 瞬时错误可自动重试
    ReadOnly,
    /// 并行安全（有隔离副作用）- 可并行，不自动重试
    SafeParallel,
    /// 串行（默认，保守）
    #[default]
    Serial,
}

/// 工具执行器契约。
///
/// ## 约定
/// - 执行器应发射 start/end/error 事件；
/// - 即使工具执行失败，也应返回 `Ok` 并设置 `success=false`；
/// - 只有执行器自身异常才返回 `Err`。
pub trait ToolExecutor: Send + Sync {
    /// 判断该执行器是否处理指定工具。
    ///
    /// 显式 owner 时注册表用 descriptor 的 name/alias 直连；`can_handle` 仅
    /// catch-all provider 还需要（迁移期保留）。
    fn can_handle(&self, tool_name: &str) -> bool;

    /// 执行工具调用。
    fn execute<'a>(&'a self, call: &'a ToolCall, ctx: &'a ExecutionContext) -> ToolFuture<'a>;

    /// 获取工具敏感等级。
    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    /// 解析一次具体调用的敏感度；同名多动作的执行器可覆写。
    fn sensitivity_level_for_call(&self, tool_name: &str, _arguments: &Value) -> ToolSensitivity {
        self.sensitivity_level(tool_name)
    }

    /// 该执行器的敏感度是否随参数变化（风险说明消费者用）。
    fn has_dynamic_sensitivity(&self, _tool_name: &str) -> bool {
        false
    }

    /// 工具并发等级（默认保守串行）。
    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::Serial
    }

    /// 执行器是否自行处理取消终态。
    ///
    /// 默认 false：注册表在 cancellation token 触发时立即中断 future。
    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        false
    }

    /// 工具结果字符预算；默认 [`DEFAULT_TOOL_RESULT_CHAR_BUDGET`]。
    ///
    /// 自带有界输出控制的执行器或聚合器返回 `None` 可关闭外层预算。
    fn result_char_budget(&self, _tool_name: &str) -> Option<usize> {
        Some(DEFAULT_TOOL_RESULT_CHAR_BUDGET)
    }
}
