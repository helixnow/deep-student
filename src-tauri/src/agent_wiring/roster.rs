//! 生产执行器花名册（step 10 §2.2）。
//!
//! `AppExecutorRoster::executors` 的函数体从拆分前
//! `chat_v2/pipeline.rs::create_executor_registry_with_workspace` 逐字搬来（连
//! `super::tools::` / `super::skill_market_client::` 路径都保留，经 `agent_wiring/mod.rs`
//! 的私有导入解析）：顺序即分发顺序（`ToolExecutorRegistry` first-wins `can_handle`）。
//! 固定尾部 ToolPack(Weak) → Ptc → General 与 `validate_legacy_registry` 仍由
//! `chat_v2::pipeline::assemble_registry` 追加。
//!
//! 新增/删除 executor 时同步 `tool_descriptors` 的 `EXPECTED_ROSTER`
//! （`agent_wiring::tests::roster_tests` 的 oracle 测试会红灯）。

use std::sync::Arc;

use crate::chat_v2::pipeline::ExecutorRoster;
use crate::chat_v2::tools::{
    AcademicSearchExecutor, AttemptCompletionExecutor, AutomationExecutor, BuiltinResourceExecutor,
    BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, DataGovernanceToolExecutor,
    DstuToolExecutor, FetchExecutor, FileManagerExecutor, FsrsSettingsExecutor,
    ImageGenerationExecutor, IndexWebpageToolExecutor, InkToolExecutor, KnowledgeExecutor,
    LearningOverviewExecutor, LlmUsageToolExecutor, LocalShellExecuteExecutor,
    LocalShellPreflightExecutor, McpProposeExecutor, MediaToolExecutor, MemoryToolExecutor,
    OfficeFidelityExecutor, SettingsModelsToolExecutor, SkillsExecutor, TemplateDesignerExecutor,
    TextbookPdfToolExecutor, ToolExecutor, ToolExecutorRegistry, TranslationToolExecutor,
    UserTodoExecutor, WorkspaceFsExecutor, WorkspaceToolExecutor,
};
use crate::chat_v2::workspace::WorkspaceCoordinator;

/// app 的生产执行器花名册（含域执行器）。由 `lib.rs` 经
/// `ChatV2Pipeline::with_executor_roster` 注入。
pub struct AppExecutorRoster;

impl ExecutorRoster for AppExecutorRoster {
    fn executors(
        &self,
        workspace: Option<&Arc<WorkspaceCoordinator>>,
    ) -> Vec<Arc<dyn ToolExecutor>> {
        // 拆分前的参数形态（`Option<Arc<_>>`，coordinator 组共享同一 `Arc`）。
        let workspace_coordinator: Option<Arc<WorkspaceCoordinator>> = workspace.cloned();

        let mut executors: Vec<Arc<dyn super::tools::ToolExecutor>> = Vec::new();

        executors.push(Arc::new(AttemptCompletionExecutor::new()));
        executors.push(Arc::new(CanvasToolExecutor::new()));
        // AnkiToolExecutor 已移除 — 旧 CardForge 2.0 管线由 ChatAnki 完全接管
        executors.push(Arc::new(ChatAnkiToolExecutor::new()));
        executors.push(Arc::new(BuiltinRetrievalExecutor::new()));
        executors.push(Arc::new(super::tools::InsightRecallExecutor::new()));
        executors.push(Arc::new(BuiltinResourceExecutor::new()));
        executors.push(Arc::new(super::tools::ConnectorToolExecutor::new()));
        executors.push(Arc::new(super::tools::TaskAuditExecutor::new()));
        executors.push(Arc::new(DstuToolExecutor::new()));
        executors.push(Arc::new(super::tools::AttachmentToolExecutor::new())); // 🆕 附件工具执行器（解决 P0 断裂点）
        executors.push(Arc::new(FetchExecutor::new())); // 🆕 内置 Web Fetch 工具
        executors.push(Arc::new(super::tools::BrowserToolExecutor::new())); // 🆕 内置浏览器 Agent 工具（非 Playwright）
        executors.push(Arc::new(MediaToolExecutor::new())); // Managed attachment audio transcription
        executors.push(Arc::new(OfficeFidelityExecutor::new())); // Read-only Office/PDF fidelity inventory
        executors.push(Arc::new(McpProposeExecutor::new())); // 🆕 MCP server 提案工具（High 敏感度）
        executors.push(Arc::new(super::tools::McpManageExecutor::new())); // 🆕 MCP server 修改/启停/删除（update/remove High，set_enabled Medium）
        executors.push(Arc::new(AutomationExecutor::new())); // 🆕 周期自动化工具（propose High / set_enabled Medium）
        executors.push(Arc::new(AcademicSearchExecutor::new())); // 🆕 学术论文搜索工具（arXiv + OpenAlex）
        executors.push(Arc::new(super::tools::PaperSaveExecutor::new())); // 🆕 论文保存+引用格式化工具
        executors.push(Arc::new(KnowledgeExecutor::new()));
        executors.push(Arc::new(super::tools::TodoListExecutor::new()));
        executors.push(Arc::new(super::tools::GoalExecutor::new())); // 🆕 Goal 模式工具执行器（goal_*，P0）
        executors.push(Arc::new(super::tools::qbank_executor::QBankExecutor::new()));
        executors.push(Arc::new(TranslationToolExecutor::new()));
        executors.push(Arc::new(SettingsModelsToolExecutor::new()));
        executors.push(Arc::new(LlmUsageToolExecutor::new()));
        executors.push(Arc::new(LearningOverviewExecutor::new()));
        executors.push(Arc::new(FsrsSettingsExecutor::new())); // 🆕 闪卡调度设置 get/update（与设置面板同源）
        executors.push(Arc::new(DataGovernanceToolExecutor::new()));
        executors.push(Arc::new(MemoryToolExecutor::new()));
        executors.push(Arc::new(UserTodoExecutor::new()));
        executors.push(Arc::new(SkillsExecutor::new())); // 🆕 Skills 工具执行器（渐进披露架构）
        executors.push(Arc::new(TemplateDesignerExecutor::new())); // 🆕 模板设计师工具执行器
        executors.push(Arc::new(TextbookPdfToolExecutor::new()));
        executors.push(Arc::new(InkToolExecutor::new()));
        executors.push(Arc::new(IndexWebpageToolExecutor::new()));
        executors.push(Arc::new(super::tools::AskUserExecutor::new())); // 🆕 用户提问工具执行器
        executors.push(Arc::new(super::tools::SessionToolExecutor::new())); // 🆕 会话管理工具执行器
        executors.push(Arc::new(super::tools::DocxToolExecutor::new())); // 🆕 DOCX 文档读写工具执行器
        executors.push(Arc::new(super::tools::PptxToolExecutor::new())); // 🆕 PPTX 演示文稿读写工具执行器
        executors.push(Arc::new(super::tools::XlsxToolExecutor::new())); // 🆕 XLSX 电子表格读写工具执行器
        executors.push(Arc::new(ImageGenerationExecutor::new())); // 🆕 内置图片生成工具执行器
        executors.push(Arc::new(super::tools::GenerativeUiExecutor::new())); // 🆕 生成式 UI 工具执行器
        executors.push(Arc::new(WorkspaceFsExecutor::new()));
        executors.push(Arc::new(super::tools::LspNavigationExecutor::new()));
        executors.push(Arc::new(super::tools::CodeNavigationExecutor::new()));
        executors.push(Arc::new(FileManagerExecutor::new()));
        executors.push(Arc::new(
            super::tools::attachment_stage_executor::AttachmentStageExecutor::new(),
        )); // 🆕 附件物化工具执行器（附件原始字节 → temp root 路径 + 受管 zip 解压）
        executors.push(Arc::new(
            super::tools::notes_import_executor::NotesImportExecutor::new(),
        )); // 🆕 笔记库 zip 导入执行器（staged zip → NotesImporter，Medium）
        executors.push(Arc::new(
            super::tools::skill_install_executor::SkillInstallExecutor::new(),
        )); // 🆕 skill_scan / skill_install 技能包自装（High 安装必审批 + provenance）
        executors.push(Arc::new(
            super::skill_market_client::SkillMarketReadToolExecutor::new(),
        )); // 🆕 skill_market_search / skill_market_skill_detail 只读市场工具
        executors.push(Arc::new(
            super::skill_market_client::SkillMarketInstallToolExecutor::new(),
        )); // 🆕 skill_market_verify / skill_market_download_and_scan 治理安装正门
        executors.push(Arc::new(
            super::tools::skill_workshop_executor::SkillWorkshopExecutor::new(),
        )); // 🆕 skill_workshop_propose / skill_workshop_apply 提案式自建/自改技能
        executors.push(Arc::new(
            super::tools::skill_lifecycle_executor::SkillLifecycleExecutor::new(),
        )); // 🆕 skill_set_enabled / skill_remove / skill_trust_request 技能生命周期治理正门
        executors.push(Arc::new(LocalShellPreflightExecutor::new()));
        executors.push(Arc::new(super::tools::GitToolExecutor::new()));
        executors.push(Arc::new(
            super::tools::self_inspect_executor::SelfInspectExecutor::new(),
        )); // 🆕 self_inspect 只读自查工具（Low 敏感度，脱敏输出）
        executors.push(Arc::new(
            super::tools::role_pack_executor::RolePackExecutor::new(),
        )); // Versioned role pack list/get/validate (read-only + auditable selection)
        executors.push(Arc::new(
            super::tools::runtime_root_request_executor::RuntimeRootRequestExecutor::new(),
        )); // 🆕 runtime_root_request 授权请求（High，never-remember，critical 直接拒绝）
        executors.push(Arc::new(LocalShellExecuteExecutor::new()));
        executors.push(Arc::new(super::tools::EssayGradingExecutor::new())); // 🆕 作文批改工具执行器（essay_* 异步任务 + 历史查询）
        executors.push(Arc::new(super::tools::ReviewToolExecutor::new())); // 🆕 间隔重复复习计划工具执行器（review_*，SM-2）
        executors.push(Arc::new(super::tools::DocumentProcessingExecutor::new())); // 🆕 文档解析/OCR 主动触发执行器（document_parse/status）
        executors.push(Arc::new(super::tools::WorkbenchToolExecutor::new())); // ACR R1-02：workbench_* 桌面操控工具

        if let Some(coordinator) = workspace_coordinator {
            executors.push(Arc::new(WorkspaceToolExecutor::new(coordinator.clone())));
            // 注册 SubagentExecutor（subagent_call 语法糖）
            executors.push(Arc::new(super::tools::SubagentExecutor::new(
                coordinator.clone(),
            )));
            // Super 会话 Router 工具（super_dispatch/message/close/list_worker[s]；
            // 仅活跃 Super 回合可执行，执行器内部 fail-closed）
            executors.push(Arc::new(super::tools::SuperSessionExecutor::new(
                coordinator.clone(),
            )));
            // 🆕 custom_agent_* 自定义子代理 persona 管理
            // （list/get Low，propose Medium，apply/remove High 必审批）
            executors.push(Arc::new(super::tools::CustomAgentExecutor::new(
                coordinator.clone(),
            )));
            // 🆕 注册 CoordinatorSleepExecutor（主代理睡眠/唤醒机制）
            executors.push(Arc::new(super::tools::CoordinatorSleepExecutor::new(
                coordinator,
            )));
        }

        executors
    }
}

/// 注册表里没有特异性（非 `GeneralToolExecutor` 兜底）执行器受理的 descriptor 工具名。
///
/// 生产注册表（完整花名册 + workspace coordinator）应为空；漏注入 `AppExecutorRoster`
/// 时域工具会静默落到 GeneralToolExecutor，这里能把它们列出来。
pub fn missing_descriptor_tools(registry: &ToolExecutorRegistry) -> Vec<&'static str> {
    crate::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS
        .iter()
        .filter(|descriptor| !registry.has_specific_executor(descriptor.name))
        .map(|descriptor| descriptor.name)
        .collect()
}

/// 启动期花名册自检（step 10 §6 #3）：只记日志（debug 构建额外断言），不改变分发。
pub fn verify_roster_coverage(registry: &ToolExecutorRegistry) {
    let missing = missing_descriptor_tools(registry);
    if !missing.is_empty() {
        log::error!(
            "[agent_wiring] ToolExecutorRegistry has {} executors but {} descriptor-backed tools have no specific executor (executor roster not injected?): {:?}",
            registry.len(),
            missing.len(),
            missing
        );
    }
    debug_assert!(
        missing.is_empty(),
        "executor roster misses descriptor-backed tools: {missing:?}"
    );
}
