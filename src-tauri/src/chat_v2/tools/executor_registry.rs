//! 工具执行器注册表
//!
//! 管理所有已注册的工具执行器，提供统一的执行入口。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 2.3.3 节

use std::sync::Arc;
use tokio::time::{timeout, Duration};

use super::arg_utils::with_localized_message;
use super::executor::{
    apply_tool_result_budget, ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity,
};
use super::types::is_external_mcp_tool_name;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use serde::Serialize;
use serde_json::{json, Value};

// ============================================================================
// 全局超时配置
// ============================================================================

/// 默认工具执行超时时间（秒）
const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 120;
const NO_TOOL_TIMEOUT_SECS: u64 = 0;
/// ACR 最长一次桥事务为 probe(3s) + apply_ops(120s)。外层 watchdog 必须
/// 留出完整事务预算，不能先于桥层超时丢弃已提交的 apply future。
const ACR_EXECUTOR_TIMEOUT_FLOOR_SECS: u64 = 180;

fn executor_may_delegate_to_acr(executor_name: &str) -> bool {
    matches!(
        executor_name,
        "WorkbenchToolExecutor" | "CanvasToolExecutor" | "BuiltinResourceExecutor"
    )
}

/// 裸名 `mcp_server_update` / `mcp_server_set_enabled` / `mcp_server_remove`
/// 是后端自有的 MCP 管理工具，与外部 MCP 的 `mcp_` 前缀撞名。它们必须由
/// McpManageExecutor 拦截（High/Medium 敏感度 + 审批），绝不能被当作外部
/// MCP 调用转发到 GeneralToolExecutor（见 pipeline.rs 注册顺序测试）。
fn is_builtin_mcp_management_tool_name(tool_name: &str) -> bool {
    matches!(
        tool_name,
        super::mcp_manage_executor::tool_names::MCP_SERVER_UPDATE
            | super::mcp_manage_executor::tool_names::MCP_SERVER_SET_ENABLED
            | super::mcp_manage_executor::tool_names::MCP_SERVER_REMOVE
    )
}

fn get_executor_timeout_secs(tool_name: &str, executor_name: &str) -> u64 {
    let configured = get_tool_timeout_secs(tool_name);
    if configured == NO_TOOL_TIMEOUT_SECS {
        return configured;
    }
    if executor_may_delegate_to_acr(executor_name) {
        configured.max(ACR_EXECUTOR_TIMEOUT_FLOOR_SECS)
    } else {
        configured
    }
}

/// 获取工具特定的超时时间（秒）
///
/// 某些工具可能需要更长的执行时间，在此处配置特例。
///
/// ## 工具命名规范
/// - 内置工具使用 `builtin-` 前缀，如 `builtin-rag_search`、`builtin-web_search`
/// - MCP 工具使用 `mcp_` 前缀，如 `mcp_brave_search`
fn get_tool_timeout_secs(tool_name: &str) -> u64 {
    // 去掉 builtin- 前缀用于统一匹配
    let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);

    if stripped == "ask_user" {
        return NO_TOOL_TIMEOUT_SECS;
    }

    // 精确匹配：内置检索和搜索工具（使用 stripped name 以同时支持
    // `builtin-` 前缀和 ToolPack 子工具传入的无前缀名称）
    match stripped {
        // 网络搜索工具（需要较长时间）
        "web_search" => 180, // 3 分钟
        // 学术论文搜索工具（arXiv / OpenAlex API）
        "arxiv_search" | "scholar_search" => 180, // 3 分钟
        // 论文保存工具（下载 PDF + VFS 存储，批量最多 5 篇）
        "paper_save" => 600, // 10 分钟（批量下载+处理）
        // Long translation can require multiple sequential 100K-character segments.
        "translate_text" => 600,
        // 引用格式化工具（纯计算，无网络）
        "cite_format" => 30, // 30 秒
        // 网络请求和 HTML 解析工具（涉及网络请求和 HTML 解析）
        "web_fetch" => 180, // 3 分钟
        // RAG 检索工具（可能涉及大量数据）。
        // 注意：multimodal_search 已在工具暴露层收敛进 unified_search，但
        // 检索执行器仍接受该名称（历史会话回放 / retrieval executor 改造中），
        // 此处的超时配置必须保留，不要删除。
        "rag_search" | "multimodal_search" | "unified_search" => 180, // 3 分钟
        // VFS 全量索引重建：大 PDF 的抽取 + 分块 + 嵌入远超默认 120s，
        // 必须使用专用长超时，否则重建中途被 watchdog 掐断。
        "index_rebuild" => 600, // 10 分钟
        // 网页存档：大 Markdown（最大 4 MiB）落盘 + Unit 同步可能较慢
        "webpage_save" => 300, // 5 分钟
        // 文档写入/转换工具（大文件处理可能耗时较长）
        "docx_create" | "pptx_create" | "xlsx_create" | "docx_to_spec" | "pptx_to_spec"
        | "xlsx_to_spec" | "docx_replace_text" | "pptx_replace_text" | "xlsx_replace_text" => 300, // 5 分钟
        // 阻塞型协作工具：默认阻塞等待子代理终态，内部自带
        // SUBAGENT_WAIT_BUDGET_SECS（750s）等待预算与取消处理，外层看门狗
        // 若先行掐断会丢弃取消/回收逻辑，因此豁免。
        "subagent_call" => NO_TOOL_TIMEOUT_SECS,
        // 阻塞型协作工具：sleep 自身有 60 分钟硬上限 + 取消令牌
        // （见 sleep_executor.rs），默认睡眠 30 分钟远超 DEFAULT 120s，
        // 外层看门狗必须豁免，否则所有长睡眠都会被误判超时（P0）。
        "coordinator_sleep" => NO_TOOL_TIMEOUT_SECS,
        "tool_pack" => 600, // 10 minutes (matches ToolPack schema maximum)
        // The executor has its own bounded command deadline, but cleanup may need to unwind a
        // Windows AppContainer helper and temporary ACLs. Never drop that cleanup future here.
        "local_shell_execute" => NO_TOOL_TIMEOUT_SECS,
        _ => {
            // ChatAnki 工具：chatanki_wait 内部默认 5 分钟、timeoutMs 上限 60 分钟；
            // 外层看门狗只是防呆兜底，必须覆盖内部上限，否则显式长等待会被误杀。
            if stripped == "chatanki_wait" {
                61 * 60 // 61 分钟（内部 timeoutMs 上限 60 分钟 + 竞态缓冲）
            } else if stripped.starts_with("chatanki_") {
                600 // 10 分钟（chatanki_run/start/export/sync 可能涉及大量 IO）
            } else if stripped == "image_generate" {
                300 // 5 分钟（第三方生图 API 可能排队）
            } else if stripped.starts_with("workbench_") {
                // ACR workbench_*：桥调用 + 前端 pacing 演出，外层放宽到 180s（DESIGN §6）
                180 // 3 分钟
            } else if is_external_mcp_tool_name(stripped) {
                // 前缀匹配：MCP 工具通常需要网络请求
                180 // 3 分钟
            } else {
                DEFAULT_TOOL_TIMEOUT_SECS
            }
        }
    }
}

// ============================================================================
// 注册表级错误（结构化 + 中英双语，对齐 index 工具的 message/hint/retryable 契约）
// ============================================================================

/// 注册表级取消错误。
///
/// 英文 fallback 必须包含 "cancelled" 关键字：`is_transient_tool_error` 依赖
/// 该关键字排除自动重试（用户取消绝不重试）。
fn registry_cancelled_error(tool_name: &str) -> String {
    with_localized_message(
        json!({
            "code": "TOOL_CANCELLED",
            "hint": "The run was cancelled by the user or a parent task; do not retry automatically.",
            "retryable": false,
        }),
        "chat.tools.registry.errors.tool_cancelled",
        json!({ "tool": tool_name }),
        format!("工具 '{tool_name}' 执行已取消。"),
        format!("Tool '{tool_name}' execution cancelled."),
    )
    .to_string()
}

/// 注册表级超时错误。
///
/// 英文 fallback 必须包含 "timed out" 关键字且 `retryable` 为 true：
/// `is_transient_tool_error` 依赖它们把只读工具的超时判定为可自动重试。
fn registry_timeout_error(tool_name: &str, timeout_secs: u64) -> String {
    with_localized_message(
        json!({
            "code": "TOOL_TIMEOUT",
            "hint": "Retry the call; if it keeps timing out, reduce the workload or check network / index status first.",
            "retryable": true,
        }),
        "chat.tools.registry.errors.tool_timeout",
        json!({ "tool": tool_name, "timeoutSecs": timeout_secs }),
        format!("工具 '{tool_name}' 执行超时（{timeout_secs} 秒）。"),
        format!("Tool '{tool_name}' execution timed out after {timeout_secs}s."),
    )
    .to_string()
}

// ============================================================================
// 执行器注册表
// ============================================================================

/// 工具执行器注册表
///
/// 管理多个工具执行器，按注册顺序遍历查找能处理指定工具的执行器。
pub struct ToolExecutorRegistry {
    /// 已注册的执行器列表（按注册顺序）
    executors: Vec<Arc<dyn ToolExecutor>>,
}

/// Executor-declared risk facts for one concrete tool call.
///
/// This is intentionally derived from the registry instead of maintaining a
/// parallel tool list for Settings. `base_sensitivity` is the concrete-call
/// result used by the runtime before user policy overrides are applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRiskSnapshot {
    pub tool_name: String,
    pub base_sensitivity: ToolSensitivity,
    pub dynamic: bool,
    /// A broad approval bypass cannot lower this call to `Low`; the runtime
    /// still retains base/dynamic High as an approval lower bound in Relaxed.
    pub protected: bool,
    /// An approval for this call cannot be persisted or reused.
    pub never_remember: bool,
}

impl ToolExecutorRegistry {
    /// 创建空的注册表
    pub fn new() -> Self {
        Self {
            executors: Vec::new(),
        }
    }

    /// Create registry from existing executor Vec
    ///
    /// Used with `Arc::new_cyclic` to avoid circular initialization.
    pub fn from_vec(executors: Vec<Arc<dyn ToolExecutor>>) -> Self {
        Self { executors }
    }

    /// 注册执行器
    ///
    /// ## 参数
    /// - `executor`: 要注册的执行器
    ///
    /// ## 注意
    /// 执行器的注册顺序决定了查找顺序，先注册的优先匹配。
    pub fn register(&mut self, executor: Arc<dyn ToolExecutor>) {
        log::debug!(
            "[ToolExecutorRegistry] Registering executor: {}",
            executor.name()
        );
        self.executors.push(executor);
    }

    /// 获取能处理指定工具的执行器
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称
    ///
    /// ## 返回
    /// - `Some(executor)`: 找到的执行器
    /// - `None`: 没有执行器能处理此工具
    pub fn get_executor(&self, tool_name: &str) -> Option<Arc<dyn ToolExecutor>> {
        if is_external_mcp_tool_name(tool_name) && !is_builtin_mcp_management_tool_name(tool_name) {
            // External MCP names must never be normalized into a builtin
            // executor. GeneralToolExecutor forwards them to ToolRegistry,
            // which preserves the MCP bridge/source routing.
            return self
                .executors
                .iter()
                .find(|executor| executor.name() == "GeneralToolExecutor")
                .cloned();
        }

        for executor in &self.executors {
            if executor.can_handle(tool_name) {
                return Some(executor.clone());
            }
        }
        None
    }

    /// 执行工具调用
    ///
    /// 遍历所有执行器，找到能处理的执行器并执行。
    ///
    /// ## 参数
    /// - `call`: 工具调用信息
    /// - `ctx`: 执行上下文（包含可选的取消令牌）
    ///
    /// ## 返回
    /// - `Ok(ToolResultInfo)`: 执行结果
    /// - `Err`: 没有执行器能处理、执行异常、超时或取消
    ///
    /// ## 超时保护
    /// 每个工具调用都有全局超时保护，防止 Pipeline 因单个工具执行卡死。
    /// 默认超时为 120 秒，某些特殊工具（如网络请求、代码执行）有更长的超时时间。
    /// `ask_user` 例外：它表示显式等待用户交互，不应被通用工具 watchdog 截断。
    ///
    /// ## 🆕 取消支持（2026-02）
    /// 如果 `ctx.cancellation_token` 存在，执行会在取消时提前终止。
    /// 取消优先级高于超时，可以立即响应用户取消请求。
    pub async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            log::info!(
                "[ToolExecutorRegistry] Tool execution cancelled before start: {} (id={})",
                call.name,
                call.id
            );
            return Err(registry_cancelled_error(&call.name));
        }

        // 查找能处理的执行器
        let executor = self
            .get_executor(&call.name)
            .ok_or_else(|| format!("No executor found for tool: {}", call.name))?;

        log::debug!(
            "[ToolExecutorRegistry] Executing tool '{}' with executor '{}'",
            call.name,
            executor.name()
        );

        // 🆕 P1 修复：获取工具特定的超时时间并添加超时保护
        let timeout_secs = get_executor_timeout_secs(&call.name, executor.name());
        // 执行工具（带超时和取消保护）
        // 🆕 取消支持：使用 tokio::select! 同时监听取消信号
        let executor_manages_cancellation = executor.manages_cancellation(&call.name);

        // 🆕 副作用窗口收敛（2026-07 分区 J 第二轮）：为每次执行派生 scoped
        // child token。注册表在超时/取消返回错误前先 cancel 该 token，使执行器
        // 内部 spawn 的后台任务观察到取消并停止发射事件/落库——调用方已经
        // 记录了超时/取消结果，之后不允许再出现可见副作用。父 token 的取消
        // 会自动传播到 child，原有取消语义不变。
        let scoped_token = ctx
            .cancellation_token()
            .map(|token| token.child_token())
            .unwrap_or_default();
        let exec_ctx = ctx.scoped_with_cancellation_token(scoped_token.clone());
        let execute_future = executor.execute(call, &exec_ctx);

        let raw_result = if timeout_secs == NO_TOOL_TIMEOUT_SECS {
            log::debug!(
                "[ToolExecutorRegistry] Tool '{}' timeout disabled",
                call.name,
            );

            if executor_manages_cancellation {
                execute_future.await
            } else if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    result = execute_future => result,
                    _ = cancel_token.cancelled() => {
                        log::info!(
                            "[ToolExecutorRegistry] Tool execution cancelled: {} (id={})",
                            call.name,
                            call.id
                        );
                        scoped_token.cancel();
                        Err(registry_cancelled_error(&call.name))
                    }
                }
            } else {
                execute_future.await
            }
        } else {
            let timeout_duration = Duration::from_secs(timeout_secs);

            log::debug!(
                "[ToolExecutorRegistry] Tool '{}' timeout set to {}s",
                call.name,
                timeout_secs
            );

            let timeout_future = timeout(timeout_duration, execute_future);

            if executor_manages_cancellation {
                match timeout_future.await {
                    Ok(result) => result,
                    Err(_elapsed) => {
                        log::error!(
                            "[ToolExecutorRegistry] Self-cancelling tool execution timeout after {}s: {} (id={})",
                            timeout_secs,
                            call.name,
                            call.id
                        );
                        // 超时后 future 已被 drop；cancel scoped token 让执行器
                        // 内部残留的后台任务尽快停止产生可见副作用。
                        scoped_token.cancel();
                        // 带 RESULT_UNKNOWN 前缀与桥层错误码体系对齐
                        // （workbench 等 ACR 工具的调用方按前缀识别「已提交、
                        // 终态未知、禁止自动重试」）。
                        Err(format!(
                            "RESULT_UNKNOWN: Tool '{}' execution timed out after {}s; terminal result unknown",
                            call.name, timeout_secs
                        ))
                    }
                }
            } else if let Some(cancel_token) = ctx.cancellation_token() {
                tokio::select! {
                    result = timeout_future => {
                        match result {
                            Ok(inner_result) => inner_result,
                            Err(_elapsed) => {
                                log::error!(
                                    "[ToolExecutorRegistry] Tool execution timeout after {}s: {} (id={})",
                                    timeout_secs,
                                    call.name,
                                    call.id
                                );
                                scoped_token.cancel();
                                Err(registry_timeout_error(&call.name, timeout_secs))
                            }
                        }
                    }
                    _ = cancel_token.cancelled() => {
                        log::info!(
                            "[ToolExecutorRegistry] Tool execution cancelled: {} (id={})",
                            call.name,
                            call.id
                        );
                        scoped_token.cancel();
                        Err(registry_cancelled_error(&call.name))
                    }
                }
            } else {
                match timeout_future.await {
                    Ok(result) => result,
                    Err(_elapsed) => {
                        log::error!(
                            "[ToolExecutorRegistry] Tool execution timeout after {}s: {} (id={})",
                            timeout_secs,
                            call.name,
                            call.id
                        );
                        scoped_token.cancel();
                        Err(registry_timeout_error(&call.name, timeout_secs))
                    }
                }
            }
        };

        // 🆕 统一结果截断出口（2026-07）：在注册表返回路径按执行器声明的
        // 预算包装输出，防止单个工具结果撑爆 LLM 上下文与事件通道。自带
        // 有界输出控制的执行器（local_shell / tool_pack）覆写
        // result_char_budget 为 None，保持既有截断行为不回退。
        match raw_result {
            Ok(mut result) => {
                if let Some(budget) = executor.result_char_budget(&call.name) {
                    result.output = apply_tool_result_budget(result.output, budget);
                }
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }

    /// 获取工具敏感等级
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称
    ///
    /// ## 返回
    /// - `Some(sensitivity)`: 工具敏感等级
    /// - `None`: 没有执行器能处理此工具
    pub fn get_sensitivity(&self, tool_name: &str) -> Option<ToolSensitivity> {
        self.get_executor(tool_name)
            .map(|e| e.sensitivity_level(tool_name))
    }

    /// Resolve sensitivity for the concrete arguments of a tool call.
    /// Unknown tools remain `None` so approval stays fail-closed upstream.
    pub fn get_sensitivity_for_call(
        &self,
        tool_name: &str,
        arguments: &Value,
    ) -> Option<ToolSensitivity> {
        self.get_executor(tool_name)
            .map(|e| e.sensitivity_level_for_call(tool_name, arguments))
    }

    /// Describe the runtime risk contract for one concrete call.
    ///
    /// Settings/query backends should call this method with the same arguments
    /// that will be executed. The returned base sensitivity delegates to
    /// `get_sensitivity_for_call`, so dynamic executors remain the single
    /// runtime source of truth.
    pub fn describe_risk_for_call(
        &self,
        tool_name: &str,
        arguments: &Value,
    ) -> Option<ToolRiskSnapshot> {
        let executor = self.get_executor(tool_name)?;
        let base_sensitivity = self.get_sensitivity_for_call(tool_name, arguments)?;
        Some(ToolRiskSnapshot {
            tool_name: tool_name.to_string(),
            base_sensitivity,
            dynamic: executor.has_dynamic_sensitivity(tool_name),
            protected: crate::chat_v2::approval_scope::ignores_broad_approval_bypass_for_args(
                tool_name, arguments,
            ),
            never_remember: crate::chat_v2::approval_scope::never_remember_approval_for_args(
                tool_name, arguments,
            ),
        })
    }

    /// 获取工具并发等级（2026-07 并行工具调用改造）
    ///
    /// 无匹配执行器时返回 `Serial`（保守兜底，与无执行器时走
    /// GeneralToolExecutor / 报错路径一致，不影响正确性）。
    pub fn get_concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        self.get_executor(tool_name)
            .map(|e| e.concurrency_class(tool_name))
            .unwrap_or(ToolConcurrency::Serial)
    }

    /// 检查是否有执行器能处理指定工具
    pub fn can_handle(&self, tool_name: &str) -> bool {
        self.get_executor(tool_name).is_some()
    }

    /// 检查是否有特异性（非兜底）执行器能处理指定工具
    ///
    /// 与 `can_handle` 不同，此方法排除 `GeneralToolExecutor` 等兜底执行器。
    /// 用于验证工具是否在注册表中实际存在（而非被兜底捕获）。
    pub fn has_specific_executor(&self, tool_name: &str) -> bool {
        self.get_executor(tool_name)
            .map(|e| e.name() != "GeneralToolExecutor")
            .unwrap_or(false)
    }

    pub(crate) fn is_no_timeout_tool(&self, tool_name: &str) -> bool {
        get_tool_timeout_secs(tool_name) == NO_TOOL_TIMEOUT_SECS
    }

    /// 获取已注册的执行器数量
    pub fn len(&self) -> usize {
        self.executors.len()
    }

    /// 检查注册表是否为空
    pub fn is_empty(&self) -> bool {
        self.executors.is_empty()
    }

    /// 获取所有执行器名称（用于调试）
    pub fn executor_names(&self) -> Vec<&'static str> {
        self.executors.iter().map(|e| e.name()).collect()
    }
}

impl Default for ToolExecutorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// 测试用执行器
    struct TestExecutor {
        name: &'static str,
        handles: Vec<String>,
    }

    struct DynamicTestExecutor;

    #[async_trait]
    impl ToolExecutor for TestExecutor {
        fn can_handle(&self, tool_name: &str) -> bool {
            self.handles.contains(&tool_name.to_string())
        }

        async fn execute(
            &self,
            call: &ToolCall,
            _ctx: &ExecutionContext,
        ) -> Result<ToolResultInfo, String> {
            Ok(ToolResultInfo::success(
                Some(call.id.clone()),
                Some("test_block".to_string()),
                call.name.clone(),
                call.arguments.clone(),
                serde_json::json!({"executed_by": self.name}),
                10,
            ))
        }

        fn name(&self) -> &'static str {
            self.name
        }
    }

    #[async_trait]
    impl ToolExecutor for DynamicTestExecutor {
        fn can_handle(&self, tool_name: &str) -> bool {
            tool_name == "dynamic_tool"
        }

        async fn execute(
            &self,
            _call: &ToolCall,
            _ctx: &ExecutionContext,
        ) -> Result<ToolResultInfo, String> {
            unreachable!("risk metadata tests do not execute tools")
        }

        fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
            ToolSensitivity::Medium
        }

        fn sensitivity_level_for_call(
            &self,
            _tool_name: &str,
            arguments: &Value,
        ) -> ToolSensitivity {
            if arguments.get("destructive").and_then(Value::as_bool) == Some(true) {
                ToolSensitivity::High
            } else {
                ToolSensitivity::Medium
            }
        }

        fn has_dynamic_sensitivity(&self, _tool_name: &str) -> bool {
            true
        }

        fn name(&self) -> &'static str {
            "dynamic-test"
        }
    }

    #[test]
    fn test_registry_creation() {
        let registry = ToolExecutorRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_register_executor() {
        let mut registry = ToolExecutorRegistry::new();
        let executor = Arc::new(TestExecutor {
            name: "test",
            handles: vec!["tool_a".to_string()],
        });
        registry.register(executor);
        assert_eq!(registry.len(), 1);
        assert!(registry.can_handle("tool_a"));
        assert!(!registry.can_handle("tool_b"));
    }

    #[test]
    fn test_executor_priority() {
        let mut registry = ToolExecutorRegistry::new();

        // 第一个执行器处理 tool_a
        let executor1 = Arc::new(TestExecutor {
            name: "executor1",
            handles: vec!["tool_a".to_string()],
        });
        registry.register(executor1);

        // 第二个执行器也处理 tool_a
        let executor2 = Arc::new(TestExecutor {
            name: "executor2",
            handles: vec!["tool_a".to_string()],
        });
        registry.register(executor2);

        // 应该返回第一个注册的执行器
        let found = registry.get_executor("tool_a").unwrap();
        assert_eq!(found.name(), "executor1");
    }

    #[test]
    fn test_get_sensitivity() {
        let mut registry = ToolExecutorRegistry::new();
        let executor = Arc::new(TestExecutor {
            name: "test",
            handles: vec!["tool_a".to_string()],
        });
        registry.register(executor);

        // 默认敏感等级是 Low
        assert_eq!(
            registry.get_sensitivity("tool_a"),
            Some(ToolSensitivity::Low)
        );
        assert_eq!(registry.get_sensitivity("unknown_tool"), None);
        assert_eq!(
            registry.get_sensitivity_for_call("tool_a", &serde_json::json!({"action": "get"})),
            Some(ToolSensitivity::Low)
        );
        assert_eq!(
            registry.get_sensitivity_for_call("unknown_tool", &serde_json::json!({})),
            None
        );
    }

    #[test]
    fn risk_snapshot_uses_concrete_call_ssot_and_exposes_policy_guards() {
        let mut registry = ToolExecutorRegistry::new();
        registry.register(Arc::new(DynamicTestExecutor));
        registry.register(Arc::new(TestExecutor {
            name: "protected-test",
            handles: vec![
                "builtin-workspace_file_delete".to_string(),
                "builtin-qbank_delete_questions".to_string(),
            ],
        }));

        let dynamic = registry
            .describe_risk_for_call("dynamic_tool", &json!({"destructive": true}))
            .expect("known dynamic tool");
        assert_eq!(dynamic.base_sensitivity, ToolSensitivity::High);
        assert!(dynamic.dynamic);
        assert!(!dynamic.protected);
        assert!(!dynamic.never_remember);

        let workspace = registry
            .describe_risk_for_call("builtin-workspace_file_delete", &json!({"path": "a.txt"}))
            .expect("known workspace tool");
        assert!(workspace.protected);
        assert!(!workspace.never_remember);

        let destructive = registry
            .describe_risk_for_call(
                "builtin-qbank_delete_questions",
                &json!({"question_ids": ["q-1"]}),
            )
            .expect("known destructive domain tool");
        assert!(destructive.protected);
        assert!(destructive.never_remember);
        assert!(registry
            .describe_risk_for_call("unknown_tool", &json!({}))
            .is_none());
    }

    #[test]
    fn test_get_concurrency_class_defaults_to_serial() {
        let mut registry = ToolExecutorRegistry::new();
        let executor = Arc::new(TestExecutor {
            name: "test",
            handles: vec!["tool_a".to_string()],
        });
        registry.register(executor);

        // 未覆写的执行器默认 Serial；未知工具兜底 Serial
        assert_eq!(
            registry.get_concurrency_class("tool_a"),
            ToolConcurrency::Serial
        );
        assert_eq!(
            registry.get_concurrency_class("unknown_tool"),
            ToolConcurrency::Serial
        );
        let found = registry.get_executor("tool_a").expect("test executor");
        assert!(
            !found.manages_cancellation("tool_a"),
            "non-ACR executors retain registry-level immediate cancellation"
        );
    }

    #[test]
    fn image_generation_tool_uses_five_minute_timeout() {
        assert_eq!(get_tool_timeout_secs("builtin-image_generate"), 300);
        assert_eq!(get_tool_timeout_secs("image_generate"), 300);
    }

    #[test]
    fn external_mcp_namespaces_use_three_minute_timeout() {
        assert_eq!(get_tool_timeout_secs("mcp_brave_search"), 180);
        assert_eq!(get_tool_timeout_secs("mcp.tools.brave_search"), 180);
    }

    #[test]
    fn ask_user_tool_is_not_subject_to_global_timeout() {
        assert_eq!(get_tool_timeout_secs("builtin-ask_user"), 0);
        assert_eq!(get_tool_timeout_secs("ask_user"), 0);
    }

    #[test]
    fn ask_user_is_no_timeout_tool_for_pack_validation() {
        let registry = ToolExecutorRegistry::new();
        assert!(registry.is_no_timeout_tool("builtin-ask_user"));
        assert!(registry.is_no_timeout_tool("ask_user"));
        assert!(!registry.is_no_timeout_tool("builtin-template_validate"));
        assert!(!registry.is_no_timeout_tool("builtin-tool_pack"));
    }

    #[test]
    fn tool_pack_uses_ten_minute_timeout() {
        assert_eq!(get_tool_timeout_secs("builtin-tool_pack"), 600);
        assert_eq!(get_tool_timeout_secs("tool_pack"), 600);
    }

    #[test]
    fn index_rebuild_and_webpage_save_use_dedicated_long_timeouts() {
        assert_eq!(get_tool_timeout_secs("builtin-index_rebuild"), 600);
        assert_eq!(get_tool_timeout_secs("index_rebuild"), 600);
        assert_eq!(get_tool_timeout_secs("builtin-webpage_save"), 300);
        assert_eq!(get_tool_timeout_secs("webpage_save"), 300);
        // index_status 是只读查询，保持默认超时即可
        assert_eq!(
            get_tool_timeout_secs("builtin-index_status"),
            DEFAULT_TOOL_TIMEOUT_SECS
        );
    }

    #[test]
    fn registry_errors_are_structured_and_keep_retry_keywords() {
        let cancelled: Value = serde_json::from_str(&registry_cancelled_error("builtin-web_fetch"))
            .expect("cancelled error must be structured JSON");
        assert_eq!(cancelled["code"], "TOOL_CANCELLED");
        assert_eq!(cancelled["retryable"], false);
        assert!(cancelled["messageFallback"]["zh-CN"]
            .as_str()
            .is_some_and(|m| m.contains("已取消")));
        // is_transient_tool_error 依赖 "cancel" 关键字排除自动重试
        assert!(cancelled["message"]
            .as_str()
            .is_some_and(|m| m.to_lowercase().contains("cancel")));

        let timed_out: Value =
            serde_json::from_str(&registry_timeout_error("builtin-web_fetch", 180))
                .expect("timeout error must be structured JSON");
        assert_eq!(timed_out["code"], "TOOL_TIMEOUT");
        assert_eq!(timed_out["retryable"], true);
        assert_eq!(timed_out["messageParams"]["timeoutSecs"], 180);
        // is_transient_tool_error 依赖 "timed out" 关键字判定可重试
        assert!(timed_out["message"]
            .as_str()
            .is_some_and(|m| m.to_lowercase().contains("timed out")));
    }

    #[test]
    fn translation_uses_ten_minute_timeout() {
        assert_eq!(get_tool_timeout_secs("builtin-translate_text"), 600);
        assert_eq!(get_tool_timeout_secs("translate_text"), 600);
        assert_eq!(get_tool_timeout_secs("builtin-translation_save"), 120);
    }

    #[test]
    fn local_shell_registry_watchdog_is_disabled_for_authoritative_cleanup() {
        assert_eq!(
            get_tool_timeout_secs("builtin-local_shell_execute"),
            NO_TOOL_TIMEOUT_SECS
        );
    }

    #[test]
    fn blocking_collaboration_tools_are_exempt_from_registry_watchdog() {
        // subagent_call 阻塞等待子代理终态，内部自管理 750s 等待预算与取消
        assert_eq!(
            get_tool_timeout_secs("builtin-subagent_call"),
            NO_TOOL_TIMEOUT_SECS
        );
        assert_eq!(get_tool_timeout_secs("subagent_call"), NO_TOOL_TIMEOUT_SECS);
        // coordinator_sleep 内部有 60 分钟硬上限 + 取消令牌，
        // 默认 30 分钟睡眠不得被 120s 默认看门狗掐断
        assert_eq!(
            get_tool_timeout_secs("builtin-coordinator_sleep"),
            NO_TOOL_TIMEOUT_SECS
        );
        assert_eq!(
            get_tool_timeout_secs("coordinator_sleep"),
            NO_TOOL_TIMEOUT_SECS
        );

        let registry = ToolExecutorRegistry::new();
        assert!(registry.is_no_timeout_tool("builtin-subagent_call"));
        assert!(registry.is_no_timeout_tool("builtin-coordinator_sleep"));
    }

    #[test]
    fn acr_capable_executors_outlive_the_full_bridge_transaction_budget() {
        assert_eq!(
            get_executor_timeout_secs("builtin-note_update", "CanvasToolExecutor"),
            ACR_EXECUTOR_TIMEOUT_FLOOR_SECS
        );
        assert_eq!(
            get_executor_timeout_secs("builtin-resource_update", "BuiltinResourceExecutor"),
            ACR_EXECUTOR_TIMEOUT_FLOOR_SECS
        );
        assert_eq!(
            get_executor_timeout_secs("builtin-workbench_app_command", "WorkbenchToolExecutor"),
            ACR_EXECUTOR_TIMEOUT_FLOOR_SECS
        );
        assert_eq!(
            get_executor_timeout_secs("builtin-template_validate", "TemplateExecutor"),
            DEFAULT_TOOL_TIMEOUT_SECS
        );
    }
}
