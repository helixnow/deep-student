//! headless 白名单 × app 域执行器的敏感度测试（step 10 §3.3）。
//!
//! 从 `chat_v2::headless::tests` 原样搬来（函数名不变）：白名单覆盖的执行器
//! 大多是 app 域执行器（retrieval / resource / dstu / qbank / memory …），
//! chat_v2 搬入 dstu-agent 后只能在 app 侧组装。

use std::sync::Arc;

use crate::chat_v2::headless::headless_allowed_tools;
use crate::chat_v2::tools::{
    AttemptCompletionExecutor, BuiltinResourceExecutor, BuiltinRetrievalExecutor,
    DataGovernanceToolExecutor, DstuToolExecutor, FetchExecutor, FsrsSettingsExecutor,
    IndexWebpageToolExecutor, LearningOverviewExecutor, LlmUsageToolExecutor, MemoryToolExecutor,
    ReviewToolExecutor, SettingsModelsToolExecutor, TodoListExecutor, ToolExecutor,
    ToolExecutorRegistry, ToolSensitivity, UserTodoExecutor,
};

/// 构建覆盖白名单全部工具的执行器注册表（顺序与 pipeline 注册一致的子集）
fn whitelist_registry() -> ToolExecutorRegistry {
    let executors: Vec<Arc<dyn ToolExecutor>> = vec![
        Arc::new(AttemptCompletionExecutor::new()),
        Arc::new(BuiltinRetrievalExecutor::new()),
        Arc::new(BuiltinResourceExecutor::new()),
        Arc::new(DstuToolExecutor::new()),
        Arc::new(FetchExecutor::new()),
        Arc::new(SettingsModelsToolExecutor::new()),
        Arc::new(LlmUsageToolExecutor::new()),
        Arc::new(DataGovernanceToolExecutor::new()),
        Arc::new(LearningOverviewExecutor::new()),
        Arc::new(FsrsSettingsExecutor::new()),
        Arc::new(IndexWebpageToolExecutor::new()),
        Arc::new(TodoListExecutor::new()),
        Arc::new(crate::chat_v2::tools::qbank_executor::QBankExecutor::new()),
        Arc::new(MemoryToolExecutor::new()),
        Arc::new(UserTodoExecutor::new()),
        Arc::new(ReviewToolExecutor::new()),
    ];
    ToolExecutorRegistry::from_vec(executors)
}

// —— 审批 fail-closed：白名单必须全部是 Low 敏感度 ————————————

/// 核心安全不变量：headless 无人审批，白名单内任何工具到达敏感度检查时
/// 必须是 Low（否则会进入审批等待→60s 超时挂起）。
/// 该测试守护"新工具加入白名单前必须确认 Low 敏感度"的约定。
#[test]
fn all_whitelisted_tools_are_low_sensitivity() {
    let registry = whitelist_registry();
    for tool_name in headless_allowed_tools() {
        let sensitivity = registry.get_sensitivity(&tool_name);
        assert_eq!(
            sensitivity,
            Some(ToolSensitivity::Low),
            "白名单工具 '{}' 敏感度必须为 Low（实际: {:?}），否则 headless 下会触发审批挂起",
            tool_name,
            sensitivity
        );
    }
}
