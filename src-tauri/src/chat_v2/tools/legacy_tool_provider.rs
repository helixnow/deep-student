//! A2：`LegacyToolProvider` —— 把 pipeline 手写的 executor 花名册接入
//! `dstu_agent_api::ToolRegistryBuilder`，行为不变。
//!
//! ## 定位
//! - **分发仍走旧 [`ToolExecutorRegistry`]**（超时看门狗、取消、预算、审批前置都在那里）；
//!   本模块产出的 [`ToolRegistry`] 是同一批 executor 的显式只读视图，用于
//!   重名/缺失校验与新旧解析 oracle，后续按域把 slice 换成各域 provider。
//! - 整个旧花名册作为**一个 catch-all provider**注册：
//!   - `executors()` = 旧注册顺序（与 `EXPECTED_ROSTER` 同序，GeneralToolExecutor 最后）；
//!   - `executor(name)` 直接委托 [`ToolExecutorRegistry::get_executor`]，因此
//!     first-wins 顺序、外部 MCP 短路、4 个 MCP 管理名白名单、`strip_tool_namespace`
//!     的隐式前缀协议全部逐字复用，不另写一套；
//!   - `descriptors()` = `BUILTIN_DESCRIPTORS` 的投影（裸名 + `builtin-` 别名），
//!     动态名（外部 MCP、`workspace_*` 前缀等）经 catch-all 回落到同一个 `get_executor`。
//! - 旧 `ToolExecutor`（async_trait + 旧 `ExecutionContext`）与 agent-api 的
//!   `ToolExecutor` 签名不同，用 [`LegacyExecutorAdapter`] 桥接：元数据方法逐个转发，
//!   `execute` 不可经新 `ExecutionContext` 调用（返回 `Err`），迁移期不会走到。

use std::sync::{Arc, LazyLock};

use dstu_agent_api::{
    ExecutionContext as ApiExecutionContext, HeadlessPolicy, ProviderId, PtcPolicy,
    ToolDescriptor as ApiToolDescriptor, ToolExecutor as ApiToolExecutor, ToolFuture, ToolProvider,
    ToolRegistry, ToolRegistryBuilder, ToolRegistryError, ToolTimeout,
};
use serde_json::Value;

use super::executor::{ToolConcurrency, ToolExecutor as LegacyToolExecutor, ToolSensitivity};
use super::executor_registry::ToolExecutorRegistry;
use crate::chat_v2::tool_descriptors::{
    ToolDescriptor as LegacyToolDescriptor, BUILTIN_DESCRIPTORS, DEFAULT_TIMEOUT_SECS,
    NO_TIMEOUT_SECS,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

/// 旧花名册 provider 的 id。
pub const LEGACY_PROVIDER_ID: ProviderId = ProviderId::new("chat_v2.legacy");

// ============================================================================
// 旧 executor → agent-api executor 适配
// ============================================================================

/// 把旧 `chat_v2::tools::ToolExecutor` 包装成 `dstu_agent_api::ToolExecutor`。
pub struct LegacyExecutorAdapter {
    inner: Arc<dyn LegacyToolExecutor>,
}

impl LegacyExecutorAdapter {
    /// 包装一个旧 executor。
    pub fn wrap(inner: Arc<dyn LegacyToolExecutor>) -> Arc<dyn ApiToolExecutor> {
        Arc::new(Self { inner })
    }
}

impl ApiToolExecutor for LegacyExecutorAdapter {
    fn can_handle(&self, tool_name: &str) -> bool {
        self.inner.can_handle(tool_name)
    }

    fn execute<'a>(&'a self, call: &'a ToolCall, _ctx: &'a ApiExecutionContext) -> ToolFuture<'a> {
        // 旧 executor 依赖 35 字段的旧 ExecutionContext，无法由新上下文构造；
        // 迁移期所有分发都经 ToolExecutorRegistry::execute，这里只做显式拒绝。
        let message = format!(
            "legacy executor `{}` must be dispatched through ToolExecutorRegistry (tool `{}`)",
            self.inner.name(),
            call.name
        );
        Box::pin(async move { Err::<ToolResultInfo, String>(message) })
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        self.inner.sensitivity_level(tool_name)
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        self.inner.sensitivity_level_for_call(tool_name, arguments)
    }

    fn has_dynamic_sensitivity(&self, tool_name: &str) -> bool {
        self.inner.has_dynamic_sensitivity(tool_name)
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        self.inner.concurrency_class(tool_name)
    }

    fn manages_cancellation(&self, tool_name: &str) -> bool {
        self.inner.manages_cancellation(tool_name)
    }

    fn result_char_budget(&self, tool_name: &str) -> Option<usize> {
        self.inner.result_char_budget(tool_name)
    }

    fn name(&self) -> &'static str {
        self.inner.name()
    }
}

// ============================================================================
// descriptor 投影
// ============================================================================

/// `BUILTIN_DESCRIPTORS` → agent-api descriptor（进程内只算一次）。
///
/// 只投影名字级元数据：`name`、`builtin-` 别名、敏感基线、看门狗超时、headless/PTC
/// 白名单位。`block_type`/`approval` 保持 agent-api 默认值——旧 executor 自己写块类型，
/// 审批仍由 ApprovalManager/AuthorityGate 决定；这些字段迁移期无消费者。
static LEGACY_DESCRIPTORS: LazyLock<Vec<ApiToolDescriptor>> =
    LazyLock::new(|| BUILTIN_DESCRIPTORS.iter().map(project_descriptor).collect());

fn project_descriptor(legacy: &LegacyToolDescriptor) -> ApiToolDescriptor {
    // 别名需要 'static：每条 descriptor 泄漏一次（约 2×344 个短字符串，进程生命周期）。
    let alias: &'static str = Box::leak(format!("builtin-{}", legacy.name).into_boxed_str());
    let aliases: &'static [&'static str] = Box::leak(vec![alias].into_boxed_slice());
    let timeout = match legacy.timeout_secs {
        None => ToolTimeout::Secs(DEFAULT_TIMEOUT_SECS),
        Some(NO_TIMEOUT_SECS) => ToolTimeout::None,
        Some(secs) => ToolTimeout::Secs(secs),
    };
    ApiToolDescriptor::new(legacy.name)
        .with_aliases(aliases)
        .with_sensitivity(legacy.sensitivity)
        .with_timeout(timeout)
        .with_headless(if legacy.headless_allowed {
            HeadlessPolicy::ReadOnly
        } else {
            HeadlessPolicy::Blocked
        })
        .with_ptc(if legacy.ptc_allowed {
            PtcPolicy::ReadOnly
        } else {
            PtcPolicy::Denied
        })
}

// ============================================================================
// provider
// ============================================================================

/// 包装旧 [`ToolExecutorRegistry`] 的 catch-all provider。
pub struct LegacyToolProvider {
    legacy: Arc<ToolExecutorRegistry>,
    /// 与 `legacy.executors()` 一一对应、同序。
    adapters: Vec<Arc<dyn ApiToolExecutor>>,
}

impl LegacyToolProvider {
    /// 包装一个已构建的旧注册表（通常来自 `ChatV2Pipeline::create_executor_registry_with_workspace`）。
    pub fn new(legacy: Arc<ToolExecutorRegistry>) -> Self {
        let adapters = legacy
            .executors()
            .iter()
            .map(|executor| LegacyExecutorAdapter::wrap(executor.clone()))
            .collect();
        Self { legacy, adapters }
    }

    fn adapter_for(
        &self,
        legacy: &Arc<dyn LegacyToolExecutor>,
    ) -> Option<Arc<dyn ApiToolExecutor>> {
        self.legacy
            .executors()
            .iter()
            .position(|candidate| Arc::ptr_eq(candidate, legacy))
            .map(|index| self.adapters[index].clone())
    }
}

impl ToolProvider for LegacyToolProvider {
    fn id(&self) -> ProviderId {
        LEGACY_PROVIDER_ID
    }

    fn descriptors(&self) -> Vec<ApiToolDescriptor> {
        LEGACY_DESCRIPTORS.clone()
    }

    fn executor(&self, tool_name: &str) -> Option<Arc<dyn ApiToolExecutor>> {
        // 逐字复用旧解析：外部 MCP 短路 → first-wins can_handle（GeneralToolExecutor 兜底）。
        let legacy = self.legacy.get_executor(tool_name)?;
        self.adapter_for(&legacy)
    }

    fn executors(&self) -> Vec<Arc<dyn ApiToolExecutor>> {
        self.adapters.clone()
    }

    fn is_catch_all(&self) -> bool {
        true
    }
}

/// 用 `ToolRegistryBuilder` 构建旧花名册的 agent-api 视图。
pub fn build_tool_registry(
    legacy: &Arc<ToolExecutorRegistry>,
) -> Result<ToolRegistry, ToolRegistryError> {
    ToolRegistryBuilder::new()
        .with_provider(Arc::new(LegacyToolProvider::new(legacy.clone())))
        .build()
}

/// pipeline 启动时调用：构建并校验 agent-api 视图，失败只记日志（不影响分发）。
pub fn validate_legacy_registry(legacy: &Arc<ToolExecutorRegistry>) {
    match build_tool_registry(legacy) {
        Ok(registry) => log::debug!(
            "[ChatV2::legacy_tool_provider] agent-api registry validated: {:?}",
            registry
        ),
        Err(err) => log::error!(
            "[ChatV2::legacy_tool_provider] agent-api registry validation failed: {err}"
        ),
    }
}

// ============================================================================
// oracle 测试（迁移期并行跑新旧两套注册表）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::pipeline::ChatV2Pipeline;
    use crate::chat_v2::tool_descriptors::tests::EXPECTED_ROSTER;
    use crate::chat_v2::tools::CanvasToolExecutor;
    use crate::chat_v2::workspace::WorkspaceCoordinator;

    /// 生产花名册（含 workspace 分支），与 lib.rs 启动路径一致。
    fn production_registry() -> (tempfile::TempDir, Arc<ToolExecutorRegistry>) {
        let temp = tempfile::tempdir().expect("workspace coordinator temp dir");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));
        let registry = ChatV2Pipeline::create_executor_registry_with_workspace(Some(coordinator));
        (temp, registry)
    }

    /// 旧注册表能解析的全部已知名字：每个 descriptor 的裸名及各隐式前缀形态，
    /// 外加外部 MCP / MCP 管理名 / 未知名等边界样本。
    fn oracle_names() -> Vec<String> {
        let mut names = Vec::new();
        for descriptor in BUILTIN_DESCRIPTORS {
            for prefix in ["", "builtin-", "builtin-builtin-", "mcp_", "workspace_"] {
                names.push(format!("{prefix}{}", descriptor.name));
            }
        }
        for extra in [
            "totally_unknown_tool",
            "mcp_github_create_issue",
            "mcp_filesystem_read_file",
            "mcp_server_update",
            "mcp_server_set_enabled",
            "mcp_server_remove",
            "mcp_server_propose",
            "builtin-mcp_server_propose",
            "mcp_note_read",
            "builtin-subagent_call",
            "builtin-tool_pack",
            "builtin-ptc_run",
        ] {
            names.push(extra.to_string());
        }
        names
    }

    fn assert_oracle(old: &ToolExecutorRegistry, new: &ToolRegistry) {
        for name in oracle_names() {
            let old_name = old.get_executor(&name).map(|executor| executor.name());
            let new_name = new.executor_for(&name).map(|executor| executor.name());
            assert_eq!(
                new_name, old_name,
                "new registry resolves `{name}` differently from ToolExecutorRegistry"
            );
        }
    }

    #[test]
    fn oracle_new_registry_resolves_every_known_name_like_old_registry() {
        let (_temp, old) = production_registry();
        let new = build_tool_registry(&old).expect("legacy provider must build");
        assert_oracle(&old, &new);

        // 显式声明的名字/别名都归 legacy provider 所有，且带 descriptor。
        for descriptor in BUILTIN_DESCRIPTORS {
            for name in [
                descriptor.name.to_string(),
                format!("builtin-{}", descriptor.name),
            ] {
                assert_eq!(new.owner_of(&name), Some(LEGACY_PROVIDER_ID), "{name}");
                assert_eq!(
                    new.descriptor(&name).map(|projected| projected.name),
                    Some(descriptor.name)
                );
            }
        }
    }

    #[test]
    fn oracle_holds_without_workspace_coordinator() {
        // ChatV2Pipeline::new 首次构建（尚未 with_workspace_coordinator）时的花名册。
        let old = ChatV2Pipeline::create_executor_registry_with_workspace(None);
        let new = build_tool_registry(&old).expect("legacy provider must build");
        assert_oracle(&old, &new);
    }

    #[test]
    fn roster_order_matches_old_registry_and_expected_roster() {
        let (_temp, old) = production_registry();
        let new = build_tool_registry(&old).expect("legacy provider must build");
        let new_names: Vec<&'static str> = new
            .executors()
            .iter()
            .map(|executor| executor.name())
            .collect();
        assert_eq!(new_names, old.executor_names());
        assert_eq!(new_names, EXPECTED_ROSTER);
    }

    #[test]
    fn general_executor_stays_last_and_catches_unknown_names() {
        let (_temp, old) = production_registry();
        let new = build_tool_registry(&old).expect("legacy provider must build");
        assert_eq!(
            new.catch_all_provider().map(|provider| provider.id()),
            Some(LEGACY_PROVIDER_ID)
        );
        assert_eq!(
            new.executors().last().map(|executor| executor.name()),
            Some("GeneralToolExecutor")
        );
        for dynamic in ["totally_unknown_tool", "mcp_github_create_issue"] {
            assert_eq!(
                new.executor_for(dynamic).map(|executor| executor.name()),
                Some("GeneralToolExecutor"),
                "{dynamic}"
            );
            assert!(new.descriptor(dynamic).is_none());
            assert!(new.owner_of(dynamic).is_none());
        }
    }

    #[test]
    fn projected_sensitivity_matches_executor_baseline() {
        let (_temp, old) = production_registry();
        let new = build_tool_registry(&old).expect("legacy provider must build");
        for descriptor in BUILTIN_DESCRIPTORS {
            let projected = new.descriptor(descriptor.name).expect("descriptor");
            assert_eq!(
                projected.sensitivity, descriptor.sensitivity,
                "{}",
                descriptor.name
            );
            let executor = new.executor_for(descriptor.name).expect("executor");
            assert_eq!(
                executor.sensitivity_level(descriptor.name),
                descriptor.sensitivity,
                "{}",
                descriptor.name
            );
        }
    }

    /// 声明 `note_read` 的域 provider（模拟域 provider 接管 slice 时忘记从 legacy 移除）。
    struct ConflictingProvider {
        executor: Arc<dyn ApiToolExecutor>,
    }

    impl ToolProvider for ConflictingProvider {
        fn id(&self) -> ProviderId {
            ProviderId::new("test.conflict")
        }

        fn descriptors(&self) -> Vec<ApiToolDescriptor> {
            vec![ApiToolDescriptor::new("note_read")]
        }

        fn executor(&self, tool_name: &str) -> Option<Arc<dyn ApiToolExecutor>> {
            (tool_name == "note_read").then(|| self.executor.clone())
        }

        fn executors(&self) -> Vec<Arc<dyn ApiToolExecutor>> {
            vec![self.executor.clone()]
        }
    }

    #[test]
    fn conflicting_domain_provider_is_rejected() {
        let (_temp, old) = production_registry();
        let error = ToolRegistryBuilder::new()
            .with_provider(Arc::new(ConflictingProvider {
                executor: LegacyExecutorAdapter::wrap(Arc::new(CanvasToolExecutor::new())),
            }))
            .with_provider(Arc::new(LegacyToolProvider::new(old)))
            .build()
            .unwrap_err();
        assert_eq!(
            error,
            ToolRegistryError::DuplicateToolName {
                name: "note_read".to_string(),
                first: "test.conflict".to_string(),
                second: LEGACY_PROVIDER_ID.as_str().to_string(),
            }
        );
    }

    #[test]
    fn second_catch_all_provider_is_rejected() {
        let (_temp, old) = production_registry();
        let error = ToolRegistryBuilder::new()
            .with_provider(Arc::new(LegacyToolProvider::new(old.clone())))
            .with_provider(Arc::new(LegacyToolProvider::new(old)))
            .build()
            .unwrap_err();
        assert!(matches!(
            error,
            ToolRegistryError::MultipleCatchAllProviders { .. }
        ));
    }
}
