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

/// 默认工具执行超时时间（秒）。
///
/// G01-c：数值的唯一来源是 `tool_descriptors::DEFAULT_TIMEOUT_SECS`（注册表
/// 驱动超时的默认档位），此处保留别名避免 churn 既有引用。
const DEFAULT_TOOL_TIMEOUT_SECS: u64 = crate::chat_v2::tool_descriptors::DEFAULT_TIMEOUT_SECS;
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
///
/// `mcp_server_propose`（McpProposeExecutor，High）同理——G01-c 注册表同步
/// 测试发现裸名此前被漏掉：一直静默走 GeneralToolExecutor（Medium 兜底），
/// 只有 `builtin-` 前缀名能到达专属 executor。
fn is_builtin_mcp_management_tool_name(tool_name: &str) -> bool {
    matches!(
        tool_name,
        super::mcp_manage_executor::tool_names::MCP_SERVER_UPDATE
            | super::mcp_manage_executor::tool_names::MCP_SERVER_SET_ENABLED
            | super::mcp_manage_executor::tool_names::MCP_SERVER_REMOVE
            | super::mcp_propose_executor::tool_names::MCP_SERVER_PROPOSE
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
/// G01-c：内建工具的超时由 [`crate::chat_v2::tool_descriptors`] 注册表驱动
/// （`ToolDescriptor::timeout_secs`；`None` = 默认 120s，`Some(0)` = 豁免看门狗）。
/// 注册表未覆盖的名字（外部 MCP 动态工具 / 未知工具）保留迁移前兜底：
/// `mcp_` / `mcp.tools.` 前缀 180s，其余默认 120s。
///
/// 有意的语义收窄：旧实现用 `chatanki_*` / `workbench_*` 前缀规则覆盖整族
/// （含未登记名字）；迁移后这两个家族的全部真实工具（29 + 11 个，由
/// tool_descriptors 同步测试保证覆盖）在注册表内显式携带超时，未登记的
/// 同前缀名字落默认值——新增同族工具必须登记 descriptor 并显式选择超时。
///
/// 行为与迁移前的字符串匹配表**逐字节等价**，由本文件测试模块的
/// `timeout_migration_matches_legacy_mapping_for_every_tool` 锁定
/// （迁移前的完整匹配表作为 legacy 对照实现保留在测试中）。
///
/// ## 工具命名规范
/// - 内置工具使用 `builtin-` 前缀，如 `builtin-rag_search`、`builtin-web_search`
/// - MCP 工具使用 `mcp_` 前缀，如 `mcp_brave_search`
fn get_tool_timeout_secs(tool_name: &str) -> u64 {
    // 去掉 builtin- 前缀用于统一匹配（剥一次，与迁移前口径一致：
    // 双前缀输入会落到未登记兜底分支）
    let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);

    if let Some(descriptor) = crate::chat_v2::tool_descriptors::lookup(stripped) {
        return descriptor
            .timeout_secs
            .unwrap_or(DEFAULT_TOOL_TIMEOUT_SECS);
    }

    // 注册表未覆盖的名字：外部 MCP 动态工具通常需要网络请求
    if is_external_mcp_tool_name(stripped) {
        180 // 3 分钟
    } else {
        DEFAULT_TOOL_TIMEOUT_SECS
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

    // ========================================================================
    // G01-c：超时迁移等价性（注册表驱动 vs 迁移前字符串匹配表）
    // ========================================================================

    /// 迁移前 `get_tool_timeout_secs` 的完整对照实现（2026-09 冻结，勿再修改）。
    ///
    /// 若新实现需要有意变更某工具超时，应改 `tool_descriptors::BUILTIN_DESCRIPTORS`
    /// 并同步本对照（测试会迫使变更显式化）。
    fn legacy_get_tool_timeout_secs(tool_name: &str) -> u64 {
        let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);

        if stripped == "ask_user" {
            return NO_TOOL_TIMEOUT_SECS;
        }

        match stripped {
            "web_search" => 180,
            "arxiv_search" | "scholar_search" => 180,
            "paper_save" => 600,
            "translate_text" => 600,
            "cite_format" => 30,
            "web_fetch" => 180,
            "rag_search" | "multimodal_search" | "unified_search" => 180,
            "index_rebuild" => 600,
            "webpage_save" => 300,
            "docx_create" | "pptx_create" | "xlsx_create" | "docx_to_spec" | "pptx_to_spec"
            | "xlsx_to_spec" | "docx_replace_text" | "pptx_replace_text" | "xlsx_replace_text" => {
                300
            }
            "subagent_call" => NO_TOOL_TIMEOUT_SECS,
            "coordinator_sleep" => NO_TOOL_TIMEOUT_SECS,
            "tool_pack" => 600,
            "ptc_run" => 600,
            "local_shell_execute" => NO_TOOL_TIMEOUT_SECS,
            _ => {
                if stripped == "chatanki_wait" {
                    61 * 60
                } else if stripped.starts_with("chatanki_") {
                    600
                } else if stripped == "image_generate" {
                    300
                } else if stripped.starts_with("workbench_") {
                    180
                } else if is_external_mcp_tool_name(stripped) {
                    180
                } else {
                    DEFAULT_TOOL_TIMEOUT_SECS
                }
            }
        }
    }

    /// 注册表驱动实现与 legacy 对照对**每个已登记工具名**（裸名 + `builtin-`
    /// 前缀两种形态）逐一相等；注册表外名字走兜底分支也逐一相等。
    #[test]
    fn timeout_migration_matches_legacy_mapping_for_every_tool() {
        for descriptor in crate::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS {
            for name in [
                descriptor.name.to_string(),
                format!("builtin-{}", descriptor.name),
            ] {
                assert_eq!(
                    get_tool_timeout_secs(&name),
                    legacy_get_tool_timeout_secs(&name),
                    "timeout drift for tool '{name}'"
                );
            }
        }

        // 未登记名字：外部 MCP 前缀、未知工具、双前缀等兜底形态
        for name in [
            "mcp_brave_search",
            "mcp.tools.brave_search",
            "builtin-mcp_unknown_tool",
            "totally_unknown_tool",
            "builtin-totally_unknown_tool",
            "builtin-builtin-web_search",
        ] {
            assert_eq!(
                get_tool_timeout_secs(name),
                legacy_get_tool_timeout_secs(name),
                "fallback drift for '{name}'"
            );
        }

        // 有意的语义收窄（2026-09 G01-c）：旧表对未登记的 `chatanki_*` /
        // `workbench_*` 名字经前缀规则给 600s/180s；注册表化后只有登记在册的
        // 29 个 chatanki 工具与 11 个 workbench 工具携带对应超时，未登记的
        // 同前缀名字落默认 120s。两族现有全部真实工具均在注册表内（由
        // tool_descriptors 的同步测试保证覆盖），未来新增同族工具必须登记
        // descriptor 并显式选择超时，不再被前缀规则静默覆盖。
        assert_eq!(get_tool_timeout_secs("builtin-chatanki_x"), 120);
        assert_eq!(get_tool_timeout_secs("builtin-workbench_x"), 120);
    }
}
