//! Chat V2 编排引擎 (Pipeline)
//!
//! 实现完整的消息发送流水线，协调检索、LLM 调用、工具执行和数据持久化。
//!
//! ## 流水线阶段
//! 1. 创建用户消息和助手消息
//! 2. 执行检索（RAG/图谱/记忆/网络搜索）- 并行执行
//! 3. 构建 system prompt
//! 4. 调用 LLM（流式）
//! 5. 处理工具调用（支持递归）
//! 6. 保存结果
//!
//! ## 约束
//! - 并行检索：使用 `tokio::join!`
//! - 取消支持：使用 `tokio_util::sync::CancellationToken`
//! - 工具并行：使用 `futures::future::join_all`
//! - 工具递归：最多递归 5 次
//! - 数据持久化：每个阶段完成后立即保存

pub(crate) use std::collections::{HashMap, HashSet};
pub(crate) use std::sync::atomic::{AtomicBool, AtomicI64};
pub(crate) use std::sync::Arc;
pub(crate) use std::time::Instant;

pub(crate) use serde_json::{json, Value};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use tauri::Window;
pub(crate) use tokio::time::{timeout, Duration};
pub(crate) use tokio_util::sync::CancellationToken;
pub(crate) use uuid::Uuid;

pub(crate) use crate::llm_manager::{LLMManager, LLMStreamHooks};

pub(crate) use super::approval_manager::{ApprovalManager, ApprovalRequest};
pub(crate) use super::database::ChatV2Database;
pub(crate) use super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE;
pub(crate) use super::tools::{
    AcademicSearchExecutor, AttemptCompletionExecutor, AutomationExecutor, BuiltinResourceExecutor,
    BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, DataGovernanceToolExecutor,
    DstuToolExecutor, ExecutionContext, FetchExecutor, FileManagerExecutor, GeneralToolExecutor,
    ImageGenerationExecutor, IndexWebpageToolExecutor, KnowledgeExecutor, LearningOverviewExecutor,
    LlmUsageToolExecutor, LocalShellExecuteExecutor, LocalShellPreflightExecutor,
    McpProposeExecutor, MediaToolExecutor, MemoryToolExecutor, OfficeFidelityExecutor,
    SettingsModelsToolExecutor, SkillsExecutor, TemplateDesignerExecutor, TextbookPdfToolExecutor,
    ToolExecutorRegistry, ToolSensitivity, TranslationToolExecutor, UserTodoExecutor,
    WorkspaceFsExecutor, WorkspaceToolExecutor,
};
pub(crate) use crate::database::Database as MainDatabase;
pub(crate) use crate::models::{
    ChatMessage as LegacyChatMessage, MultimodalContentPart, RagSourceInfo,
};
pub(crate) use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};
pub(crate) use crate::tools::ToolRegistry;

pub(crate) use super::error::{ChatV2Error, ChatV2Result};
pub(crate) use super::events::{event_types, ChatV2EventEmitter};
pub(crate) use super::prompt_builder;
pub(crate) use super::repo::ChatV2Repo;
// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db 的 VfsResourceRepo
pub(crate) use crate::vfs::database::VfsDatabase;
pub(crate) use crate::vfs::repos::VfsResourceRepo;
// 🆕 VFS RAG 统一知识管理（2025-01）：使用 VFS 向量检索
pub(crate) use crate::vfs::lance_store::VfsLanceStore;
pub(crate) use crate::vfs::multimodal_service::VfsMultimodalService;
// 🆕 MCP 工具注入支持：现在使用前端传递的 mcp_tool_schemas，无需后端 MCP Client
pub(crate) use super::context::PipelineContext;
pub(crate) use super::resource_types::{ContentBlock, ContextRef, ContextSnapshot, SendContextRef};
pub(crate) use super::types::{
    block_status, block_types, feature_flags, variant_status, AttachmentInput, ChatMessage,
    MessageBlock, MessageMeta, MessageRole, MessageSources, SendMessageRequest, SendOptions,
    SharedContext, SourceInfo, TokenUsage, ToolCall, ToolResultInfo, Variant,
};
pub(crate) use super::user_message_builder::{build_user_message, UserMessageParams};
pub(crate) use super::workspace::WorkspaceCoordinator;
pub(crate) use std::sync::Mutex;

pub mod authority_mode; // Ask / Plan / Craft session authority gate
pub mod compaction; // 🆕 P1: 上下文压缩 agent（锚定摘要 + 尾部保真）
pub mod constants;
pub mod context_compiler;
pub mod helpers;
pub mod history;
pub mod hooks; // WI-13: 流水线钩子（审批准入 + 审计记录内置 hook）
pub mod llm_adapter;
#[cfg(test)]
mod llm_content_crash_tests;
#[cfg(test)]
mod llm_content_retry_gap_tests;
pub mod multi_variant;
#[cfg(test)]
mod parallel_exec_tests;
pub mod persistence;
#[cfg(test)]
mod prefix_generation_fork_finale_tests;
#[cfg(test)]
mod prefix_generation_fork_tests;
#[cfg(test)]
mod prefix_generation_restore_tests;
#[cfg(test)]
mod prefix_snapshot_tests;
pub mod prompt;
pub mod retrieval;
#[cfg(test)]
mod skill_replay_digest_tests;
#[cfg(test)]
mod skill_replay_edit_delete_tests;
pub(crate) mod stream_filter_core;
pub mod summary;
pub mod token_resources;
pub mod tool_loop;
pub mod variant_adapter;

pub use authority_mode::*;
pub use compaction::*;
pub(crate) use constants::*;
pub(crate) use helpers::*;
pub use hooks::*;
pub use llm_adapter::*;
pub(crate) use variant_adapter::*;

// ============================================================
// 托管 VfsLanceStore 单例解析
// ============================================================

/// 解析 app 托管的 `Arc<VfsLanceStore>` 单例（lib.rs 启动时 `app.manage` 注入）。
///
/// 复用单例可以保留实例级 Lance 连接缓存与 `ensured_tables` 缓存，
/// 避免热路径上每次调用都重建连接、重发索引确认请求。
///
/// 仅当传入的 `vfs_db` 与托管的 `Arc<VfsDatabase>` 是同一实例时才返回单例，
/// 避免测试或数据治理等场景下把单例误绑到另一个数据库。
///
/// 返回 `None` 的情况（调用方应自行降级，例如按需新建实例）：
/// - 无全局 AppHandle（集成测试 / headless 环境）
/// - 启动时 VfsLanceStore 初始化失败（lib.rs 已降级，不 manage）
/// - `vfs_db` 与托管实例不一致
pub(crate) fn managed_vfs_lance_store_for(vfs_db: &Arc<VfsDatabase>) -> Option<Arc<VfsLanceStore>> {
    use tauri::Manager;
    let app_handle = crate::get_global_app_handle()?;
    let managed_db = app_handle.try_state::<Arc<VfsDatabase>>()?;
    if !Arc::ptr_eq(managed_db.inner(), vfs_db) {
        return None;
    }
    app_handle
        .try_state::<Arc<VfsLanceStore>>()
        .map(|state| state.inner().clone())
}

// ============================================================
// 流水线主结构
// ============================================================

/// Chat V2 编排引擎
///
/// 协调整个消息发送流程，包括：
/// - 消息创建
/// - 检索执行
/// - LLM 调用
/// - 工具处理
/// - 数据持久化
#[derive(Clone)]
pub struct ChatV2Pipeline {
    db: Arc<ChatV2Database>,
    /// 主数据库（用于工具调用读取用户配置）
    main_db: Option<Arc<MainDatabase>>,
    /// Anki 数据库（用于 Anki 制卡工具进度查询）
    anki_db: Option<Arc<MainDatabase>>,
    /// VFS 数据库（用于统一资源存储）
    /// 🆕 VFS 统一存储（2025-12-07）：所有资源操作使用此数据库
    vfs_db: Option<Arc<VfsDatabase>>,
    llm_manager: Arc<LLMManager>,
    tool_registry: Arc<ToolRegistry>,
    /// 笔记管理器（用于 Canvas 工具调用）
    notes_manager: Option<Arc<crate::notes_manager::NotesManager>>,
    /// 🆕 工具执行器注册表（文档 29 P0-1）
    executor_registry: Arc<ToolExecutorRegistry>,
    /// 🆕 工具审批管理器（文档 29 P1-3）
    approval_manager: Option<Arc<ApprovalManager>>,
    /// 🆕 全局一键断电（与 ChatV2State 共享；工具执行前强制拦截）
    kill_switch: Option<Arc<super::kill_switch::AgentKillSwitch>>,
    workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
    /// 🆕 智能题目集服务（用于 qbank_* MCP 工具，2026-01）
    question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    /// 🆕 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pdf_processing_service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
    /// 🆕 P1 / R2-MED 修复：session 级 compaction 互斥，防止多个 execute_internal
    /// 同时触发 compaction 产生重复 LLM 调用 + 孤儿记录
    compaction_locks: Arc<Mutex<HashSet<String>>>,
    /// 🆕 microcompact 锚点（会话级状态）：session_id → 锚点。
    /// 锚点只随 compaction 事件（活跃 compaction id 变化）批量推进，两次
    /// compaction 之间冻结，保证历史头部字节逐轮稳定（prompt cache 友好）。
    /// 所有 Pipeline clone 共享；这里是热路径读缓存，真身持久化在
    /// session.metadata（`microcompactAnchor`）：桌面 App 重启后 provider
    /// 侧 prompt cache 仍可能存活，内存 miss 时从 metadata 恢复同一
    /// `eligible_user_turns`（load/store 见 helpers.rs），不再按当前历史
    /// 跳变到 `U - K`。
    microcompact_anchors: Arc<Mutex<HashMap<String, MicrocompactAnchor>>>,
    /// 🆕 P0 tools 会话冻结（会话级状态）：session_id → 权威工具面基线
    /// `ToolFaceBaseline { generation, order, schema_digest }`（P1 代际
    /// 升级：值型从裸 `Vec<String>` 扩为带代号的快照，单锁不变）。
    /// 同一 session 内已发出的 tools 相对顺序（`order`，append-only
    /// 首见序）跨轮（跨 execute_with_tools 调用）保持，新工具只追加末尾
    /// —— 禁止下一稳定窗口重建字母序（Anthropic/OpenAI 的 tools 前缀会
    /// 从第 0 字节变化，整段 prompt cache 失效）。`generation` 仅在多变体
    /// fan-out 收敛点检出真分叉时 +1（converge 见 helpers.rs），单变体
    /// 纯扩展与 miss 回填永不 bump。所有 Pipeline clone 共享；这里是热
    /// 路径读缓存，真身持久化在 session.metadata（`frozenToolSchemaOrder`
    /// + `toolFacePrefixGeneration` + 可选 `toolSchemaDigest` 三键）：
    /// 桌面 App 重启后 provider 侧 prompt cache 仍可能存活，内存 miss 时
    /// 从 metadata 恢复同一前缀序与代号（load/store/converge 见
    /// helpers.rs），不再按字母序冷重建。
    frozen_tool_schema_orders: Arc<Mutex<HashMap<String, helpers::ToolFaceBaseline>>>,
    /// 全局 memory-flush 恢复单 worker 门闩。所有 Pipeline clone 共享状态。
    memory_flush_recovery_running: Arc<AtomicBool>,
    /// 恢复失败后的下次允许尝试时间，避免每条消息都重试故障依赖。
    memory_flush_next_retry_at_ms: Arc<AtomicI64>,
    /// WI-13: 流水线钩子链（默认注册 ApprovalGateHook + TaskAuditHook）。
    hooks: Arc<Vec<Arc<dyn PipelineHook>>>,
}

impl ChatV2Pipeline {
    /// 创建新的流水线实例
    ///
    /// ## 参数
    /// - `db`: Chat V2 独立数据库
    /// - `main_db`: 主数据库（可选，用于工具调用读取用户配置）
    /// - `vfs_db`: VFS 数据库（可选，用于统一资源存储）
    /// - `llm_manager`: LLM 管理器
    /// - `tool_registry`: 工具注册表
    /// - `notes_manager`: 笔记管理器（可选，用于 Canvas 工具调用）
    ///
    pub fn new(
        db: Arc<ChatV2Database>,
        main_db: Option<Arc<MainDatabase>>,
        anki_db: Option<Arc<MainDatabase>>,
        vfs_db: Option<Arc<VfsDatabase>>,
        llm_manager: Arc<LLMManager>,
        tool_registry: Arc<ToolRegistry>,
        notes_manager: Option<Arc<crate::notes_manager::NotesManager>>,
    ) -> Self {
        // 🆕 初始化工具执行器注册表（文档 29 P0-1）
        let executor_registry = Self::create_executor_registry();

        Self {
            db,
            main_db,
            anki_db,
            vfs_db,
            llm_manager,
            tool_registry,
            notes_manager,
            executor_registry,
            approval_manager: None,
            kill_switch: None,
            workspace_coordinator: None,
            question_bank_service: None,
            pdf_processing_service: None,
            compaction_locks: Arc::new(Mutex::new(HashSet::new())),
            microcompact_anchors: Arc::new(Mutex::new(HashMap::new())),
            frozen_tool_schema_orders: Arc::new(Mutex::new(HashMap::new())),
            memory_flush_recovery_running: Arc::new(AtomicBool::new(false)),
            memory_flush_next_retry_at_ms: Arc::new(AtomicI64::new(0)),
            hooks: hooks::default_pipeline_hooks(),
        }
    }

    /// WI-13: 追加自定义流水线钩子（内置审批/审计钩子始终保留在链首，
    /// 追加钩子按注册顺序在其后执行）。
    pub(crate) fn with_pipeline_hook(mut self, hook: Arc<dyn PipelineHook>) -> Self {
        let mut hooks = self.hooks.as_ref().clone();
        hooks.push(hook);
        self.hooks = Arc::new(hooks);
        self
    }

    /// 设置审批管理器
    ///
    /// 🆕 文档 29 P1-3：敏感工具需要用户审批
    pub fn with_approval_manager(mut self, approval_manager: Arc<ApprovalManager>) -> Self {
        self.approval_manager = Some(approval_manager);
        self
    }

    /// 绑定全局 Kill Switch（与 `ChatV2State.kill_switch` 共用同一 `Arc`）。
    ///
    /// 工具环在 AuthorityGate / ApprovalManager 之前检查；断电优先于会话档位。
    pub fn with_kill_switch(
        mut self,
        kill_switch: Arc<super::kill_switch::AgentKillSwitch>,
    ) -> Self {
        self.kill_switch = Some(kill_switch);
        self
    }

    pub fn with_workspace_coordinator(mut self, coordinator: Arc<WorkspaceCoordinator>) -> Self {
        self.workspace_coordinator = Some(coordinator.clone());
        self.executor_registry = Self::create_executor_registry_with_workspace(Some(coordinator));
        self
    }

    /// 🆕 设置智能题目集服务（用于 qbank_* MCP 工具，2026-01）
    pub fn with_question_bank_service(
        mut self,
        service: Arc<crate::question_bank_service::QuestionBankService>,
    ) -> Self {
        self.question_bank_service = Some(service);
        self
    }

    /// 🆕 设置 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pub fn with_pdf_processing_service(
        mut self,
        service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
    ) -> Self {
        self.pdf_processing_service = service;
        self
    }

    fn create_executor_registry() -> Arc<ToolExecutorRegistry> {
        Self::create_executor_registry_with_workspace(None)
    }

    fn create_executor_registry_with_workspace(
        workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
    ) -> Arc<ToolExecutorRegistry> {
        let mut executors: Vec<Arc<dyn super::tools::ToolExecutor>> = Vec::new();

        executors.push(Arc::new(AttemptCompletionExecutor::new()));
        executors.push(Arc::new(CanvasToolExecutor::new()));
        // AnkiToolExecutor 已移除 — 旧 CardForge 2.0 管线由 ChatAnki 完全接管
        executors.push(Arc::new(ChatAnkiToolExecutor::new()));
        executors.push(Arc::new(BuiltinRetrievalExecutor::new()));
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
        executors.push(Arc::new(super::tools::qbank_executor::QBankExecutor::new()));
        executors.push(Arc::new(TranslationToolExecutor::new()));
        executors.push(Arc::new(SettingsModelsToolExecutor::new()));
        executors.push(Arc::new(LlmUsageToolExecutor::new()));
        executors.push(Arc::new(LearningOverviewExecutor::new()));
        executors.push(Arc::new(DataGovernanceToolExecutor::new()));
        executors.push(Arc::new(MemoryToolExecutor::new()));
        executors.push(Arc::new(UserTodoExecutor::new()));
        executors.push(Arc::new(SkillsExecutor::new())); // 🆕 Skills 工具执行器（渐进披露架构）
        executors.push(Arc::new(TemplateDesignerExecutor::new())); // 🆕 模板设计师工具执行器
        executors.push(Arc::new(TextbookPdfToolExecutor::new()));
        executors.push(Arc::new(IndexWebpageToolExecutor::new()));
        executors.push(Arc::new(super::tools::AskUserExecutor::new())); // 🆕 用户提问工具执行器
        executors.push(Arc::new(super::tools::SessionToolExecutor::new())); // 🆕 会话管理工具执行器
        executors.push(Arc::new(super::tools::DocxToolExecutor::new())); // 🆕 DOCX 文档读写工具执行器
        executors.push(Arc::new(super::tools::PptxToolExecutor::new())); // 🆕 PPTX 演示文稿读写工具执行器
        executors.push(Arc::new(super::tools::XlsxToolExecutor::new())); // 🆕 XLSX 电子表格读写工具执行器
        executors.push(Arc::new(ImageGenerationExecutor::new())); // 🆕 内置图片生成工具执行器
        executors.push(Arc::new(super::tools::GenerativeUiExecutor::new())); // 🆕 生成式 UI 工具执行器
        executors.push(Arc::new(WorkspaceFsExecutor::new()));
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

        // Use Arc::new_cyclic so ToolPackExecutor can hold Weak<ToolExecutorRegistry>
        let registry = Arc::new_cyclic(|weak: &std::sync::Weak<ToolExecutorRegistry>| {
            // ToolPackExecutor must be registered before GeneralToolExecutor
            executors.push(Arc::new(super::tools::ToolPackExecutor::new(weak.clone())));
            // GeneralToolExecutor must be last (catch-all)
            executors.push(Arc::new(GeneralToolExecutor::new()));
            ToolExecutorRegistry::from_vec(executors)
        });

        log::info!(
            "[ChatV2::pipeline] ToolExecutorRegistry initialized with {} executors: {:?}",
            registry.len(),
            registry.executor_names()
        );

        registry
    }

    /// 根据工具名称判断正确的 block_type
    ///
    /// 检索工具使用对应的检索块类型，其他工具使用 mcp_tool 类型。
    /// 这确保前端渲染时使用正确的块渲染器。
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称（可能带有 builtin- 前缀）
    ///
    /// ## 返回
    /// 对应的 block_type 字符串
    fn tool_name_to_block_type(tool_name: &str) -> String {
        let stripped = Self::normalize_tool_name_for_skill_match(tool_name);

        // ACR R2-05 / R3-01：与 context::get_block_type_for_tool_static / 前端 remap 对齐
        if stripped.starts_with("workbench_")
            || matches!(
                stripped,
                "note_append" | "note_replace" | "note_set" | "mindmap_edit_nodes"
            )
        {
            return block_types::WORKBENCH_OPS.to_string();
        }

        match stripped {
            "rag_search" | "multimodal_search" | "unified_search" => block_types::RAG.to_string(),
            "memory_search" => block_types::MEMORY.to_string(),
            "web_search" => block_types::WEB_SEARCH.to_string(),
            "graph_search" => block_types::GRAPH.to_string(),
            "image_generate" => block_types::IMAGE_GEN.to_string(),
            "render_generative_ui" => block_types::GENERATIVE_UI.to_string(),
            "ask_user" => block_types::ASK_USER.to_string(),
            _ => block_types::MCP_TOOL.to_string(),
        }
    }

    pub(crate) fn normalize_tool_name_for_skill_match(tool_name: &str) -> &str {
        tool_name
            .strip_prefix("builtin-")
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    pub(crate) fn skill_allows_tool(tool_name: &str, allowed: &str) -> bool {
        let tool_raw = tool_name.to_lowercase();
        let allowed_raw = allowed.to_lowercase();

        let tool_normalized = Self::normalize_tool_name_for_skill_match(&tool_raw);
        let allowed_normalized = Self::normalize_tool_name_for_skill_match(&allowed_raw);

        tool_raw == allowed_raw
            || tool_normalized == allowed_normalized
            || tool_normalized.starts_with(&format!("{}_", allowed_normalized))
            || tool_normalized.starts_with(allowed_normalized)
    }

    pub(crate) fn skill_allows_tool_on_server(
        tool_name: &str,
        server_id: Option<&str>,
        allowed: &str,
    ) -> bool {
        let Some(server_id) = server_id
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        else {
            return Self::skill_allows_tool(tool_name, allowed);
        };

        let allowed_lower = allowed.to_lowercase();
        let server_lower = server_id.to_lowercase();

        if let Some((allowed_server, allowed_tool)) = allowed_lower.split_once("::") {
            return allowed_server == server_lower
                && Self::skill_allows_tool(tool_name, allowed_tool);
        }
        if let Some((allowed_server, allowed_tool)) = allowed_lower.split_once('/') {
            return allowed_server == server_lower
                && Self::skill_allows_tool(tool_name, allowed_tool);
        }

        Self::skill_allows_tool(tool_name, allowed)
    }

    /// 执行消息发送流水线
    ///
    /// ## 流程
    /// 1. 创建用户消息和助手消息
    /// 2. 执行检索（RAG/图谱/记忆/网络搜索）
    /// 3. 构建 system prompt
    /// 4. 调用 LLM（流式）
    /// 5. 处理工具调用
    /// 6. 保存结果
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口，用于事件发射
    /// - `request`: 发送消息请求
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 助手消息 ID
    /// 🔧 P1修复：添加 chat_v2_state 参数，用于注册每个变体的 cancel token
    pub async fn execute(
        &self,
        window: Window,
        mut request: SendMessageRequest,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::state::ChatV2State>>,
    ) -> ChatV2Result<String> {
        // 启动时 VFS/Lance 可能尚未就绪。正常请求入口做带退避的异步兜底，
        // 不让 compaction 已提交的 memory-flush ledger 永久滞留。
        self.schedule_memory_flush_recovery();

        // === Feature Flag 检查 ===
        let multi_variant_enabled = feature_flags::is_multi_variant_enabled();
        log::info!(
            "[ChatV2::pipeline] Feature flags: {}",
            feature_flags::get_flags_summary()
        );

        // === 多变体模式检查 ===
        // 如果 parallel_model_ids 有 2+ 个模型，走多变体执行路径
        // 🔧 调试日志：打印收到的 options
        log::info!(
            "[ChatV2::pipeline] execute() received options: {:?}",
            request.options.as_ref().map(|o| format!(
                "parallelModelIds={:?}, modelId={:?}",
                o.parallel_model_ids, o.model_id
            ))
        );

        // 注意：先提取 model_ids 避免借用问题
        let multi_variant_model_ids = request
            .options
            .as_ref()
            .and_then(|opts| opts.parallel_model_ids.as_ref())
            .filter(|ids| ids.len() >= 2)
            .cloned();

        // === Feature Flag 拦截：如果多变体功能关闭，强制走单变体路径 ===
        if let Some(ref model_ids) = multi_variant_model_ids {
            if !multi_variant_enabled {
                log::warn!(
                    "[ChatV2::pipeline] Multi-variant DISABLED by feature flag. \
                     Received {} models, forcing single-variant mode with first model: {:?}",
                    model_ids.len(),
                    model_ids.first()
                );

                // 强制使用第一个模型走单变体路径
                if let Some(first_model) = model_ids.first() {
                    // 修改 request.options.model_id 为第一个模型
                    if let Some(ref mut opts) = request.options {
                        opts.model_id = Some(first_model.clone());
                        // 清除 parallel_model_ids 防止后续逻辑误判
                        opts.parallel_model_ids = None;
                    }
                }
                // 继续执行下面的单变体路径，不进入多变体分支
            } else {
                // Feature flag 启用，正常走多变体路径
                log::info!(
                    "[ChatV2::pipeline] Multi-variant mode detected: {} models",
                    model_ids.len()
                );
                return self
                    .execute_multi_variant(
                        window,
                        request,
                        model_ids.clone(),
                        cancel_token,
                        chat_v2_state,
                    )
                    .await;
            }
        }

        // === 单变体模式（原有逻辑）===
        let mut ctx = PipelineContext::new(request);
        // Freeze the active model and capability route before emitting/saving anything. The
        // options stored in this context are owned by this request, so later UI switches only
        // affect the next turn.
        ctx.init_context_snapshot();
        ctx.set_cancellation_token(cancel_token.clone());
        self.freeze_execution_context(&mut ctx).await?;
        // 🆕 设置取消令牌：传递给工具执行器，支持工具执行取消
        let session_id = ctx.session_id.clone();
        let assistant_message_id = ctx.assistant_message_id.clone();

        // 创建事件发射器
        let emitter = Arc::new(
            ChatV2EventEmitter::new(window.clone(), session_id.clone())
                .with_stream_generation(ctx.options.stream_generation),
        );

        // 获取模型名称用于前端显示
        // 从 API 配置中解析 model_id 到真正的模型名称（如 "Qwen/Qwen3-8B"）
        log::info!(
            "[ChatV2::pipeline] Single variant: options.model_id = {:?}",
            ctx.options.model_id
        );

        let model_name: Option<String> = if let Some(config_id) =
            ctx.options.model_id.as_ref().filter(|s| !s.is_empty())
        {
            // 有指定模型 ID，从 API 配置中查找
            match self.llm_manager.get_api_configs().await {
                Ok(configs) => {
                    log::info!(
                        "[ChatV2::pipeline] Found {} API configs, looking for config_id: {}",
                        configs.len(),
                        config_id
                    );
                    // 🔧 Bug修复：优先通过 c.id 匹配，如果找不到再通过 c.model 匹配
                    // 这样无论前端传递的是 API 配置 ID（UUID）还是模型显示名称，都能正确解析
                    let found = configs
                            .iter()
                            .find(|c| &c.id == config_id)
                            .map(|c| c.model.clone())
                            .or_else(|| {
                                // 如果通过 id 找不到，尝试通过 model 名称匹配
                                // 这处理了 config_id 本身就是模型显示名称的情况
                                configs
                                    .iter()
                                    .find(|c| &c.model == config_id)
                                    .map(|c| c.model.clone())
                            })
                            .or_else(|| {
                                // 🔧 最后的回退：判断 config_id 是否是 API 配置 ID（不可作为显示名称）
                                // 配置 ID 有两种已知格式：
                                //   1. builtin-* （内置模型，如 "builtin-deepseek-chat"）
                                //   2. UUID 格式 （用户自建模型，如 "a1b2c3d4-e5f6-7890-abcd-ef1234567890"）
                                // 如果 config_id 不属于这两种格式，则认为它本身就是模型显示名称
                                // （例如删除了配置后重试旧消息，config_id 中保存的可能是旧的模型名）
                                if is_config_id_format(config_id) {
                                    log::warn!(
                                        "[ChatV2::pipeline] config_id is a config UUID/builtin ID, not usable as display name: {}",
                                        config_id
                                    );
                                    None
                                } else {
                                    log::info!(
                                        "[ChatV2::pipeline] Using config_id as model_name directly (not a config ID pattern): {}",
                                        config_id
                                    );
                                    Some(config_id.clone())
                                }
                            });
                    log::info!("[ChatV2::pipeline] Resolved model_name: {:?}", found);
                    found
                }
                Err(e) => {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to get API configs for model name: {}",
                        e
                    );
                    None
                }
            }
        } else {
            // 没有指定模型 ID（使用默认模型），从默认配置获取模型名称
            log::info!(
                "[ChatV2::pipeline] options.model_id is None/empty, getting default model name"
            );
            match self
                .llm_manager
                .select_model_for("default", None, None, None, None, None, None)
                .await
            {
                Ok((config, _)) => {
                    log::info!(
                        "[ChatV2::pipeline] Default model resolved: {}",
                        config.model
                    );
                    Some(config.model)
                }
                Err(e) => {
                    log::warn!("[ChatV2::pipeline] Failed to get default model: {}", e);
                    None
                }
            }
        };

        // 🔧 Bug修复：将模型显示名称存储到 ctx，用于消息保存
        ctx.model_display_name = model_name.clone();

        // 发射流式开始事件（带模型名称）
        log::info!(
            "[ChatV2::pipeline] Emitting stream_start with model_name: {:?}",
            model_name
        );
        emitter.emit_stream_start(&assistant_message_id, model_name.as_deref());

        log::info!(
            "[ChatV2::pipeline] Starting pipeline for session={}, assistant_msg={}",
            session_id,
            assistant_message_id
        );

        // 🆕 P0防闪退：用户消息即时保存
        // 在 Pipeline 执行前立即保存用户消息，确保用户输入不会因闪退丢失
        // 注意：skip_user_message_save 为 true 时跳过（编辑重发场景）
        if !ctx.options.skip_user_message_save.unwrap_or(false) {
            if let Err(e) = self.save_user_message_immediately(&ctx).await {
                // 🔧 升级为 error：此时用户输入仅存在于内存，若后续 save_results
                // 也失败则输入彻底丢失，必须在日志中醒目可见
                log::error!(
                    "[ChatV2::pipeline] Failed to save user message immediately (will rely on save_results as fallback): {}",
                    e
                );
                // 不阻塞流程，继续执行（save_results 会再次保存）
            } else {
                log::info!(
                    "[ChatV2::pipeline] User message saved immediately: id={}",
                    ctx.user_message_id
                );
            }
        }

        // 执行流水线
        let result = self
            .execute_internal(&mut ctx, emitter.clone(), cancel_token)
            .await;

        match result {
            Ok(_) => {
                // 发射流式完成事件（带 token 统计）
                let usage = if ctx.token_usage.has_tokens() {
                    Some(&ctx.token_usage)
                } else {
                    None
                };
                emitter.emit_stream_complete_with_usage(
                    &assistant_message_id,
                    ctx.elapsed_ms(),
                    usage,
                );

                // 注意：不再单独更新 assistant_meta
                // save_results() 已经保存了完整的 MessageMeta（包含 model_id, usage, sources, tool_results, chat_params, context_snapshot）
                // 这里如果再次调用 update_message_meta_with_conn 会覆盖这些字段，导致数据丢失

                log::info!(
                    "[ChatV2::pipeline] Pipeline completed for session={}, duration={}ms",
                    session_id,
                    ctx.elapsed_ms()
                );

                // 🔧 自动生成会话元数据（首轮唯一）
                // 业界最佳实践：只在首轮对话后生成一次 title + description + tags，
                // 用户改名后 title_locked 会阻止覆盖。
                let user_content_for_summary = ctx.user_content.clone();
                let assistant_content_for_summary = ctx.final_content.clone();
                if self
                    .should_generate_session_metadata(
                        &session_id,
                        &user_content_for_summary,
                        &assistant_content_for_summary,
                    )
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();

                    // 异步执行元数据生成，不阻塞返回
                    let summary_future = async move {
                        pipeline
                            .generate_session_metadata(
                                &sid,
                                &user_content_for_summary,
                                &assistant_content_for_summary,
                                emitter_clone,
                            )
                            .await;
                    };

                    // 优先使用 spawn_tracked 追踪元数据任务
                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for metadata task");
                        tokio::spawn(summary_future);
                    }
                }

                Ok(assistant_message_id)
            }
            Err(ChatV2Error::Cancelled) => {
                // 🔧 修复：取消时也保存已累积的内容，避免用户消息丢失
                log::info!(
                    "[ChatV2::pipeline] Pipeline cancelled for session={}, attempting to save partial results...",
                    session_id
                );

                // 🔧 关键修复：从 adapter 获取已累积内容（tokio::select! 取消时不会执行 ctx 更新）
                if let Some(adapter) = &ctx.current_adapter {
                    if ctx.final_content.is_empty() {
                        ctx.final_content = adapter.get_accumulated_content();
                    }
                    if ctx.final_reasoning.is_none() {
                        ctx.final_reasoning = adapter.get_accumulated_reasoning();
                    }
                    if ctx.streaming_thinking_block_id.is_none() {
                        ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                    }
                    if ctx.streaming_content_block_id.is_none() {
                        ctx.streaming_content_block_id = adapter.get_content_block_id();
                    }
                    log::info!(
                        "[ChatV2::pipeline] Retrieved partial content from adapter on cancel: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 尝试保存已累积的内容（即使为空也会保存用户消息）
                if let Err(save_err) = self.save_results(&ctx).await {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to save partial results on cancel: {}",
                        save_err
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Partial results saved on cancel: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 发射取消事件
                emitter.emit_stream_cancelled(&assistant_message_id);
                Err(ChatV2Error::Cancelled)
            }
            Err(e) => {
                // 🔧 修复：错误时也保存已累积的内容，避免用户消息丢失
                log::error!(
                    "[ChatV2::pipeline] Pipeline error for session={}: {}, attempting to save partial results...",
                    session_id,
                    e
                );

                // 🔧 关键修复：从 adapter 获取已累积内容
                if let Some(adapter) = &ctx.current_adapter {
                    if ctx.final_content.is_empty() {
                        ctx.final_content = adapter.get_accumulated_content();
                    }
                    if ctx.final_reasoning.is_none() {
                        ctx.final_reasoning = adapter.get_accumulated_reasoning();
                    }
                    if ctx.streaming_thinking_block_id.is_none() {
                        ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                    }
                    if ctx.streaming_content_block_id.is_none() {
                        ctx.streaming_content_block_id = adapter.get_content_block_id();
                    }
                    log::info!(
                        "[ChatV2::pipeline] Retrieved partial content from adapter on error: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 尝试保存已累积的内容（即使为空也会保存用户消息）
                if let Err(save_err) = self.save_results(&ctx).await {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to save partial results on error: {}",
                        save_err
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Partial results saved on error: content_len={}, reasoning_len={:?}",
                        ctx.final_content.len(),
                        ctx.final_reasoning.as_ref().map(|r| r.len())
                    );
                }

                // 发射错误事件
                emitter.emit_stream_error(&assistant_message_id, &e.to_string());
                Err(e)
            }
        }
    }

    /// 内部执行流程
    async fn execute_internal(
        &self,
        ctx: &mut PipelineContext,
        emitter: Arc<ChatV2EventEmitter>,
        cancel_token: CancellationToken,
    ) -> ChatV2Result<()> {
        // 阶段 0：初始化上下文快照（统一上下文注入系统）
        ctx.init_context_snapshot();

        // 阶段 1：检查取消
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        // 阶段 1.5：🆕 P0 预算口径对齐（FIFO 仅 compaction 不够时兜底）。
        // 用户未配置 context_limit 时，历史裁剪预算不得回退到固定 32K ——
        // 大窗口模型（如 200K）的 compaction 触发阈值（usable × 0.85）远高于
        // 32K，固定回退会让 FIFO/强制压缩先于 compaction 自然阈值启动。
        // 这里把本轮口径填充为 provider 真实 usable（context_window −
        // max_output），恒大于 compaction 阈值，保证 compaction 恒先行；
        // 对 compaction 自身无影响（effective_usable_tokens 取 min，
        // min(usable, usable) = usable，与未配置时等价）。解析不到配置时
        // 保持 None，由 constants::effective_history_token_budget 回退 32K
        // （仍高于 compaction 默认口径阈值，有测试钳制）。
        if ctx.options.context_limit.map_or(true, |v| v == 0) {
            if let Some(config) = self.resolve_active_api_config(ctx).await {
                let provider_usable = usable_tokens(Some(&config));
                if provider_usable > 0 {
                    log::debug!(
                        "[ChatV2::pipeline] context_limit not configured; adopting provider usable budget {} for session={}",
                        provider_usable,
                        ctx.session_id
                    );
                    ctx.options.context_limit = Some(provider_usable);
                }
            }
        }

        // 阶段 2：加载聊天历史
        self.load_chat_history(ctx).await?;
        // 🆕 FIFO 截断可见化：实际丢弃了消息时向前端发 context_trimmed 事件
        self.notify_context_trimmed(ctx, &emitter);

        // 阶段 3：并行执行检索
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        // 使用 tokio::select! 支持取消
        let retrieval_result = tokio::select! {
            result = self.execute_retrievals(ctx, emitter.clone()) => result,
            _ = cancel_token.cancelled() => return Err(ChatV2Error::Cancelled),
        };
        retrieval_result?;

        // 阶段 3.5：创建检索资源并添加到上下文快照（统一上下文注入系统）
        let retrieval_refs = self
            .create_retrieval_resources(&ctx.retrieved_sources)
            .await;
        ctx.add_retrieval_refs_to_snapshot(retrieval_refs);

        // 阶段 4：构建系统提示（P1-10 拆分：稳定 system 返回，
        // turn-volatile 块写入 ctx.turn_volatile_context 供编译注入 injected_context）
        let system_prompt = self.build_system_prompt(ctx).await;

        // 阶段 4.5：编译冻结上下文（原阶段 2 尾；P1-10 后移到检索与
        // 系统提示拆分之后，使 turn-volatile 块随当前 user 消息一起编译冻结）。
        // Recompile canonical history/current content for this turn's frozen TM/MM capability.
        // This is where transient image base64 is resolved and where auxiliary-MM/OCR fallback
        // happens for text-only active models.
        tokio::select! {
            result = self.compile_frozen_context(ctx) => result?,
            _ = cancel_token.cancelled() => return Err(ChatV2Error::Cancelled),
        }

        // 阶段 4.6：R3-#1 llm_content 前移 —— 编译已冻结、用户块行已 INSERT
        // （阶段 5 execute_with_tools 发起首个 provider 请求之前），轻量补写
        // user CONTENT 块 llm_content sidecar，消除「已发 provider、sidecar
        // 未保存」的崩溃窗口。失败只 warn 不阻断发送。
        if let Err(e) = self.persist_user_llm_content_early(ctx).await {
            log::warn!(
                "[ChatV2::pipeline] persist_user_llm_content_early failed (non-fatal, later save points may retry when the target block exists): session={}, err={}",
                ctx.session_id,
                e
            );
        }

        // 阶段 5：调用 LLM（带工具递归）
        if cancel_token.is_cancelled() {
            return Err(ChatV2Error::Cancelled);
        }

        let llm_result = tokio::select! {
            result = self.execute_with_tools(ctx, emitter.clone(), &system_prompt, 0) => result,
            _ = cancel_token.cancelled() => {
                log::info!("[ChatV2::pipeline] LLM call cancelled");
                return Err(ChatV2Error::Cancelled);
            }
        };
        llm_result?;

        // 阶段 5.5：空闲期检测 - 检查工作区 inbox 是否有待处理消息
        // 设计文档 30：在 stream_complete 前检查 inbox
        if let Some(workspace_id) = ctx.get_workspace_id() {
            if let Some(ref coordinator) = self.workspace_coordinator {
                use super::workspace::injector::InjectionThrottle;
                use super::workspace::WorkspaceInjector;

                let injector = WorkspaceInjector::new(coordinator.clone());
                // 节流状态在本次执行的空闲期检查点内持有（函数局部，不跨 await 共享）
                let mut throttle = InjectionThrottle::new();
                let max_injections = 3u32; // 单次空闲期最多处理 3 批消息

                match injector.check_and_inject(
                    &mut throttle,
                    workspace_id,
                    &ctx.session_id,
                    max_injections,
                ) {
                    Ok(injection_result) => {
                        if !injection_result.messages.is_empty() {
                            let formatted = WorkspaceInjector::format_injected_messages(
                                &injection_result.messages,
                            );
                            // 🆕 契约 C11：内存注入照旧，持久化 + 事件发射为附加动作
                            // （借用冲突规避：workspace_id 借自 ctx，先克隆再传 &mut ctx）
                            let workspace_id_owned = workspace_id.to_string();
                            ctx.inject_workspace_messages(formatted.clone());
                            self.persist_and_emit_workspace_injection(
                                ctx,
                                &emitter,
                                &workspace_id_owned,
                                &injection_result.messages,
                                &formatted,
                                None,
                            );

                            log::info!(
                                "[ChatV2::pipeline] Workspace idle injection: {} messages injected, should_continue={}",
                                injection_result.messages.len(),
                                injection_result.should_continue
                            );

                            // 如果注入了消息且需要继续，递归调用 LLM 处理
                            if injection_result.should_continue
                                || ctx.should_continue_for_workspace()
                            {
                                let continue_result = tokio::select! {
                                    result = self.execute_with_tools(ctx, emitter.clone(), &system_prompt, 0) => result,
                                    _ = cancel_token.cancelled() => {
                                        log::info!("[ChatV2::pipeline] Workspace continuation cancelled");
                                        return Err(ChatV2Error::Cancelled);
                                    }
                                };
                                continue_result?;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[ChatV2::pipeline] Workspace injection check failed: {}", e);
                    }
                }
            }
        }

        // 阶段 6：保存结果
        self.save_results(ctx).await?;

        // 阶段 7：🆕 P1 压缩 — 本轮 LLM 若命中阈值，现在落盘 compaction 记录，
        // 下一次 load_chat_history 就会应用视图（隐藏旧消息 + 注入摘要）。
        // 🔧 P1-4 后本阶段是兜底路径：工具环内（tool_loop）已在下一轮 LLM 调用前
        // 主动执行压缩，只有「最后一轮 LLM 回复才命中阈值」的情况会走到这里。
        if ctx.needs_compaction {
            match self.run_compaction(ctx).await {
                Ok(outcome) => {
                    // 🆕 自动压缩失败可见化：向前端发 compaction_failed 事件
                    if outcome.is_failed() {
                        if let Some(reason) = outcome.reason_code() {
                            emitter.emit_compaction_failed(reason);
                        }
                    }
                }
                Err(e) => {
                    // 🔧 升级为 error：压缩失败意味着长会话只能靠 FIFO 截断兜底，
                    // 上下文质量将悬崖式下降，不能只留一条 warn
                    log::error!(
                        "[ChatV2::pipeline] run_compaction failed for session={} (non-fatal, falling back to FIFO trim next round): {}",
                        ctx.session_id,
                        e
                    );
                    ctx.needs_compaction = false;
                    emitter.emit_compaction_failed(CompactionSkipReason::InternalError.as_code());
                }
            }
        }

        Ok(())
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 跨进程一致性测试 harness：迁移完备的临时 ChatV2 库 + 真实 Pipeline
    /// + 一个已落库的 session。返回 TempDir 保持数据库文件存活。
    fn cross_process_test_pipeline() -> (tempfile::TempDir, ChatV2Pipeline, String) {
        use crate::chat_v2::types::ChatSession;
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;
        use crate::database::Database;
        use crate::file_manager::FileManager;

        let chat_dir = tempfile::TempDir::new().expect("chat temp");
        let mut coordinator =
            MigrationCoordinator::new(chat_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat_v2 migrate");
        let chat_db = Arc::new(ChatV2Database::new(chat_dir.path()).expect("chat db"));

        let main_dir = tempfile::TempDir::new().expect("main temp");
        let mut main_coordinator =
            MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
        main_coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("main migrate");
        let main_db =
            Arc::new(Database::new(&main_dir.path().join("mistakes.db")).expect("main db"));
        let file_manager =
            Arc::new(FileManager::new(main_dir.path().join("app-data")).expect("file manager"));
        let llm_manager =
            Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("llm manager"));

        let session_id = ChatSession::generate_id();
        let session = ChatSession::new(session_id.clone(), "chat".to_string());
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("create session");

        let pipeline = ChatV2Pipeline::new(
            chat_db,
            Some(main_db),
            None,
            None,
            llm_manager,
            Arc::new(ToolRegistry::new()),
            None,
        );
        // Keep main temp dir alive for the duration of the test.
        std::mem::forget(main_dir);
        (chat_dir, pipeline, session_id)
    }

    /// 🆕 P0 跨进程回归（写库 → 清内存 → load 一致）：tools 冻结基线
    /// 经 store 持久化后，清空进程内存 HashMap（模拟桌面 App 重启），
    /// load 必须恢复同一首见序 —— 禁止字母序冷重建。
    #[tokio::test]
    async fn frozen_tool_schema_order_survives_memory_clear() {
        let (_dir, pipeline, session_id) = cross_process_test_pipeline();

        // 首见序（非字母序）基线写入：内存 + DB
        let baseline: Vec<String> = vec!["zeta_tool".into(), "alpha_tool".into()];
        pipeline.store_session_frozen_tool_schema_order(&session_id, &baseline);

        // 模拟进程重启：清空共享内存基线，只剩 DB
        pipeline.frozen_tool_schema_orders.lock().unwrap().clear();

        let restored = pipeline.load_session_frozen_tool_schema_order(&session_id);
        assert_eq!(
            restored, baseline,
            "重启后 load 的基线必须与写库的首见序逐字一致"
        );

        // append-only：重启后继续推进不得打乱已持久化前缀
        let advanced: Vec<String> =
            vec!["zeta_tool".into(), "alpha_tool".into(), "new_tool".into()];
        pipeline.store_session_frozen_tool_schema_order(&session_id, &advanced);
        pipeline.frozen_tool_schema_orders.lock().unwrap().clear();
        assert_eq!(
            pipeline.load_session_frozen_tool_schema_order(&session_id),
            advanced
        );
    }

    /// 🆕 P0 跨进程回归（写库 → 清内存 → load 一致）：microcompact 锚点
    /// 建锚后清空进程内存（模拟重启），同 lineage 下即使历史继续增长，
    /// eligible_user_turns 必须沿用持久化锚点、不得跳到当前 U-K；
    /// 只有 lineage 变化（compaction 事件）才批量推进。
    #[tokio::test]
    async fn microcompact_anchor_survives_memory_clear_without_jump() {
        let (_dir, pipeline, session_id) = cross_process_test_pipeline();

        let make_history = |user_turns: usize| -> Vec<LegacyChatMessage> {
            let mut history = Vec::new();
            for i in 0..user_turns {
                history.push(make_empty_message("user", format!("question {}", i)));
                history.push(make_empty_message("assistant", format!("answer {}", i)));
            }
            history
        };

        // 5 个 user 轮，K=3 → 建锚 eligible = 2（写库）
        let eligible_first = pipeline.resolve_microcompact_eligible_turns(
            &session_id,
            Some("comp_evt_1"),
            &make_history(5),
        );
        assert_eq!(eligible_first, 2);

        // 模拟进程重启：清空共享内存锚点，只剩 DB
        pipeline.microcompact_anchors.lock().unwrap().clear();

        // 同 lineage、历史增长到 7 个 user 轮（批量值 4）：必须沿用持久化
        // 锚点 2，不得跳变 —— 否则中间轮工具输出突然占位符化、头部字节变
        let eligible_after_restart = pipeline.resolve_microcompact_eligible_turns(
            &session_id,
            Some("comp_evt_1"),
            &make_history(7),
        );
        assert_eq!(
            eligible_after_restart, 2,
            "重启后同 lineage 必须沿用持久化锚点，eligible 不得跳到当前 U-K"
        );

        // compaction 事件（lineage 变化）→ 批量推进到 7-3=4 并持久化
        let eligible_after_compaction = pipeline.resolve_microcompact_eligible_turns(
            &session_id,
            Some("comp_evt_2"),
            &make_history(7),
        );
        assert_eq!(
            eligible_after_compaction, 4,
            "锚点只随 compaction 事件（lineage 变化）批量推进"
        );

        // 再次清内存：新锚点也已持久化（写库→清内存→load 一致）
        pipeline.microcompact_anchors.lock().unwrap().clear();
        assert_eq!(
            pipeline.resolve_microcompact_eligible_turns(
                &session_id,
                Some("comp_evt_2"),
                &make_history(8),
            ),
            4,
            "compaction 事件推进后的锚点同样必须跨进程恢复一致"
        );
    }

    #[test]
    fn test_tool_pack_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        // Directly verify that the executor matched for tool_pack is ToolPackExecutor
        let executor = registry
            .get_executor("builtin-tool_pack")
            .expect("builtin-tool_pack must have a registered executor");
        assert_eq!(
            executor.name(),
            "ToolPackExecutor",
            "ToolPackExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_workspace_fs_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-workspace_file_read")
            .expect("builtin-workspace_file_read must have a registered executor");
        assert_eq!(
            executor.name(),
            "WorkspaceFsExecutor",
            "WorkspaceFsExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_external_mcp_workspace_name_bypasses_builtin_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        for tool_name in ["mcp_workspace_file_read", "mcp.tools.workspace_file_read"] {
            let executor = registry
                .get_executor(tool_name)
                .expect("external MCP tools must route through the general bridge");
            assert_eq!(
                executor.name(),
                "GeneralToolExecutor",
                "external MCP tools must not collide with WorkspaceFsExecutor"
            );
        }
    }

    #[test]
    fn test_attachment_stage_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-attachment_stage")
            .expect("builtin-attachment_stage must have a registered executor");
        assert_eq!(
            executor.name(),
            "AttachmentStageExecutor",
            "AttachmentStageExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_local_shell_preflight_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-local_shell_preflight")
            .expect("builtin-local_shell_preflight must have a registered executor");
        assert_eq!(
            executor.name(),
            "LocalShellPreflightExecutor",
            "LocalShellPreflightExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_self_inspect_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-self_inspect")
            .expect("builtin-self_inspect must have a registered executor");
        assert_eq!(
            executor.name(),
            "SelfInspectExecutor",
            "SelfInspectExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_skill_install_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-skill_scan")
            .expect("builtin-skill_scan must have a registered executor");
        assert_eq!(
            executor.name(),
            "SkillInstallExecutor",
            "SkillInstallExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_skill_market_tools_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let search = registry
            .get_executor("builtin-skill_market_search")
            .expect("builtin-skill_market_search must have a registered executor");
        assert_eq!(search.name(), "SkillMarketReadToolExecutor");
        let detail = registry
            .get_executor("builtin-skill_market_skill_detail")
            .expect("builtin-skill_market_skill_detail must have a registered executor");
        assert_eq!(detail.name(), "SkillMarketReadToolExecutor");
        // 写操作不得由只读执行器承接
        let download = registry
            .get_executor("builtin-skill_market_download_and_scan")
            .expect("builtin-skill_market_download_and_scan must have a registered executor");
        assert_eq!(download.name(), "SkillMarketInstallToolExecutor");
        let verify = registry
            .get_executor("builtin-skill_market_verify")
            .expect("builtin-skill_market_verify must have a registered executor");
        assert_eq!(verify.name(), "SkillMarketInstallToolExecutor");
    }

    #[test]
    fn test_skill_workshop_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-skill_workshop_propose")
            .expect("builtin-skill_workshop_propose must have a registered executor");
        assert_eq!(
            executor.name(),
            "SkillWorkshopExecutor",
            "SkillWorkshopExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_skill_lifecycle_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        for tool in [
            "builtin-skill_set_enabled",
            "builtin-skill_remove",
            "builtin-skill_trust_request",
        ] {
            let executor = registry
                .get_executor(tool)
                .unwrap_or_else(|| panic!("{tool} must have a registered executor"));
            assert_eq!(
                executor.name(),
                "SkillLifecycleExecutor",
                "SkillLifecycleExecutor must be matched before GeneralToolExecutor for {tool}"
            );
        }
    }

    #[test]
    fn test_mcp_propose_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-mcp_server_propose")
            .expect("builtin-mcp_server_propose must have a registered executor");
        assert_eq!(
            executor.name(),
            "McpProposeExecutor",
            "McpProposeExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_mcp_manage_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        // 裸名 mcp_server_* 若落到 GeneralToolExecutor 会被误当外部 MCP 工具转发，
        // 因此带前缀与裸名两种形态都必须命中 McpManageExecutor
        for tool in [
            "builtin-mcp_server_update",
            "mcp_server_update",
            "builtin-mcp_server_set_enabled",
            "mcp_server_set_enabled",
            "builtin-mcp_server_remove",
            "mcp_server_remove",
        ] {
            let executor = registry
                .get_executor(tool)
                .unwrap_or_else(|| panic!("{tool} must have a registered executor"));
            assert_eq!(
                executor.name(),
                "McpManageExecutor",
                "McpManageExecutor must be matched before GeneralToolExecutor for {tool}"
            );
        }
    }

    #[test]
    fn test_automation_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-automation_propose")
            .expect("builtin-automation_propose must have a registered executor");
        assert_eq!(
            executor.name(),
            "AutomationExecutor",
            "AutomationExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_runtime_root_request_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-runtime_root_request")
            .expect("builtin-runtime_root_request must have a registered executor");
        assert_eq!(
            executor.name(),
            "RuntimeRootRequestExecutor",
            "RuntimeRootRequestExecutor must be matched before GeneralToolExecutor"
        );
    }

    #[test]
    fn test_local_shell_execute_registered_before_general_executor() {
        let registry = ChatV2Pipeline::create_executor_registry();
        let executor = registry
            .get_executor("builtin-local_shell_execute")
            .expect("builtin-local_shell_execute must have a registered executor");
        assert_eq!(
            executor.name(),
            "LocalShellExecuteExecutor",
            "LocalShellExecuteExecutor must be matched before GeneralToolExecutor"
        );
    }
}
