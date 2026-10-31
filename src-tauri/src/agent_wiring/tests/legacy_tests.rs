//! `LegacyToolProvider` 新旧注册表 oracle 测试（step 10 §3.3）。
//!
//! 从 `chat_v2::tools::legacy_tool_provider::tests` 原样搬来（函数名不变）：
//! oracle 对照的是 app 生产花名册（含域执行器），chat_v2 搬入 dstu-agent 后
//! 只能在 app 侧组装。原 `ChatV2Pipeline::create_executor_registry_with_workspace`
//! 测试垫片随之删除，改为本文件的同名私有函数（同一实现）。

use std::sync::Arc;

use dstu_agent_api::{
    ProviderId, ToolDescriptor as ApiToolDescriptor, ToolExecutor as ApiToolExecutor, ToolProvider,
    ToolRegistry, ToolRegistryBuilder, ToolRegistryError,
};

use crate::agent_wiring::roster::AppExecutorRoster;
use crate::chat_v2::pipeline::{assemble_registry, ExecutorRoster};
use crate::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS;
use crate::chat_v2::tools::executor_registry::ToolExecutorRegistry;
use crate::chat_v2::tools::legacy_tool_provider::{
    build_tool_registry, LegacyExecutorAdapter, LegacyToolProvider, LEGACY_PROVIDER_ID,
};
use crate::chat_v2::tools::CanvasToolExecutor;
use crate::chat_v2::workspace::WorkspaceCoordinator;

use super::descriptor_tests::EXPECTED_ROSTER;

/// 拆分前 `ChatV2Pipeline::create_executor_registry_with_workspace`：生产花名册
/// （`AppExecutorRoster`）+ 固定尾部，与 lib.rs 启动路径一致。
fn create_executor_registry_with_workspace(
    workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
) -> Arc<ToolExecutorRegistry> {
    assemble_registry(AppExecutorRoster.executors(workspace_coordinator.as_ref()))
}

/// 生产花名册（含 workspace 分支），与 lib.rs 启动路径一致。
fn production_registry() -> (tempfile::TempDir, Arc<ToolExecutorRegistry>) {
    let temp = tempfile::tempdir().expect("workspace coordinator temp dir");
    let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));
    let registry = create_executor_registry_with_workspace(Some(coordinator));
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
    let old = create_executor_registry_with_workspace(None);
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
