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

pub(crate) use std::collections::HashMap;
pub(crate) use std::sync::Arc;
pub(crate) use std::time::Instant;

pub(crate) use serde_json::{json, Value};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use tauri::{Emitter, Window};
pub(crate) use tokio::time::{timeout, Duration};
pub(crate) use tokio_util::sync::CancellationToken;
pub(crate) use uuid::Uuid;

pub(crate) use crate::llm_manager::{LLMManager, LLMStreamHooks};

pub(crate) use super::approval_manager::{ApprovalManager, ApprovalRequest};
pub(crate) use super::database::ChatV2Database;
pub(crate) use super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE;
pub(crate) use super::tools::{
    AcademicSearchExecutor, AttemptCompletionExecutor, BuiltinResourceExecutor,
    BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, ExecutionContext,
    FetchExecutor, GeneralToolExecutor, KnowledgeExecutor, MemoryToolExecutor,
    SkillsExecutor, TemplateDesignerExecutor, ToolExecutor, ToolExecutorRegistry,
    ToolSensitivity, WorkspaceToolExecutor,
};
pub(crate) use crate::database::Database as MainDatabase;
pub(crate) use crate::models::{ChatMessage as LegacyChatMessage, MultimodalContentPart, RagSourceInfo};
pub(crate) use crate::tools::web_search::{do_search, SearchInput, ToolConfig as WebSearchConfig};
pub(crate) use crate::tools::ToolRegistry;

pub(crate) use super::error::{ChatV2Error, ChatV2Result};
pub(crate) use super::events::{event_types, ChatV2EventEmitter};
pub(crate) use super::prompt_builder;
pub(crate) use super::repo::ChatV2Repo;
// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db 的 VfsResourceRepo
pub(crate) use crate::vfs::database::VfsDatabase;
pub(crate) use crate::vfs::error::VfsError;
pub(crate) use crate::vfs::repos::VfsResourceRepo;
// 🆕 VFS RAG 统一知识管理（2025-01）：使用 VFS 向量检索
pub(crate) use crate::vfs::indexing::{VfsFullSearchService, VfsSearchParams};
pub(crate) use crate::vfs::lance_store::VfsLanceStore;
pub(crate) use crate::vfs::repos::MODALITY_TEXT;
pub(crate) use crate::vfs::multimodal_service::VfsMultimodalService;
// 🆕 MCP 工具注入支持：现在使用前端传递的 mcp_tool_schemas，无需后端 MCP Client
pub(crate) use super::context::PipelineContext;
pub(crate) use super::resource_types::{ContentBlock, ContextRef, ContextSnapshot};
pub(crate) use super::types::{
    block_status, block_types, feature_flags, variant_status, AttachmentInput, ChatMessage,
    MessageBlock, MessageMeta, MessageRole, MessageSources, SendMessageRequest, SendOptions,
    SharedContext, SourceInfo, TokenUsage, ToolCall, ToolResultInfo, Variant,
};
pub(crate) use super::user_message_builder::{build_user_message, UserMessageParams};
pub(crate) use super::workspace::WorkspaceCoordinator;
pub(crate) use std::sync::Mutex;

pub mod constants;
pub mod helpers;
pub mod history;
pub mod llm_adapter;
pub mod multi_variant;
pub mod persistence;
pub mod prompt;
pub mod retrieval;
pub mod summary;
pub mod token_resources;
pub mod tool_loop;
pub mod variant_adapter;

pub use constants::*;
pub use helpers::*;
pub use history::*;
pub use llm_adapter::*;
pub use multi_variant::*;
pub use persistence::*;
pub use prompt::*;
pub use retrieval::*;
pub use summary::*;
pub use token_resources::*;
pub use tool_loop::*;
pub use variant_adapter::*;

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
    workspace_coordinator: Option<Arc<WorkspaceCoordinator>>,
    /// 🆕 智能题目集服务（用于 qbank_* MCP 工具，2026-01）
    question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    /// 🆕 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pdf_processing_service: Option<Arc<crate::vfs::pdf_processing_service::PdfProcessingService>>,
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
            workspace_coordinator: None,
            question_bank_service: None,
            pdf_processing_service: None,
        }
    }

    /// 设置审批管理器
    ///
    /// 🆕 文档 29 P1-3：敏感工具需要用户审批
    pub fn with_approval_manager(mut self, approval_manager: Arc<ApprovalManager>) -> Self {
        self.approval_manager = Some(approval_manager);
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
        let mut registry = ToolExecutorRegistry::new();

        registry.register(Arc::new(AttemptCompletionExecutor::new()));
        registry.register(Arc::new(CanvasToolExecutor::new()));
        // AnkiToolExecutor 已移除 — 旧 CardForge 2.0 管线由 ChatAnki 完全接管
        registry.register(Arc::new(ChatAnkiToolExecutor::new()));
        registry.register(Arc::new(BuiltinRetrievalExecutor::new()));
        registry.register(Arc::new(BuiltinResourceExecutor::new()));
        registry.register(Arc::new(super::tools::AttachmentToolExecutor::new())); // 🆕 附件工具执行器（解决 P0 断裂点）
        registry.register(Arc::new(FetchExecutor::new())); // 🆕 内置 Web Fetch 工具
        registry.register(Arc::new(AcademicSearchExecutor::new())); // 🆕 学术论文搜索工具（arXiv + OpenAlex）
        registry.register(Arc::new(super::tools::PaperSaveExecutor::new())); // 🆕 论文保存+引用格式化工具
        registry.register(Arc::new(KnowledgeExecutor::new()));
        registry.register(Arc::new(super::tools::TodoListExecutor::new()));
        registry.register(Arc::new(super::tools::qbank_executor::QBankExecutor::new()));
        registry.register(Arc::new(MemoryToolExecutor::new()));
        registry.register(Arc::new(super::tools::SkillsExecutor::new())); // 🆕 Skills 工具执行器（渐进披露架构）
        registry.register(Arc::new(TemplateDesignerExecutor::new())); // 🆕 模板设计师工具执行器
        registry.register(Arc::new(super::tools::AskUserExecutor::new())); // 🆕 用户提问工具执行器
        registry.register(Arc::new(super::tools::DocxToolExecutor::new())); // 🆕 DOCX 文档读写工具执行器
        registry.register(Arc::new(super::tools::PptxToolExecutor::new())); // 🆕 PPTX 演示文稿读写工具执行器
        registry.register(Arc::new(super::tools::XlsxToolExecutor::new())); // 🆕 XLSX 电子表格读写工具执行器

        if let Some(coordinator) = workspace_coordinator {
            registry.register(Arc::new(WorkspaceToolExecutor::new(coordinator.clone())));
            // 注册 SubagentExecutor（subagent_call 语法糖）
            registry.register(Arc::new(super::tools::SubagentExecutor::new(
                coordinator.clone(),
            )));
            // 🆕 注册 CoordinatorSleepExecutor（主代理睡眠/唤醒机制）
            registry.register(Arc::new(super::tools::CoordinatorSleepExecutor::new(
                coordinator,
            )));
        }

        registry.register(Arc::new(GeneralToolExecutor::new()));

        log::info!(
            "[ChatV2::pipeline] ToolExecutorRegistry initialized with {} executors: {:?}",
            registry.len(),
            registry.executor_names()
        );

        Arc::new(registry)
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

        match stripped {
            "rag_search" | "multimodal_search" | "unified_search" => block_types::RAG.to_string(),
            "memory_search" => block_types::MEMORY.to_string(),
            "web_search" => block_types::WEB_SEARCH.to_string(),
            "graph_search" => block_types::GRAPH.to_string(),
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
        // 🆕 设置取消令牌：传递给工具执行器，支持工具执行取消
        ctx.set_cancellation_token(cancel_token.clone());
        let session_id = ctx.session_id.clone();
        let assistant_message_id = ctx.assistant_message_id.clone();

        // 创建事件发射器
        let emitter = Arc::new(ChatV2EventEmitter::new(window.clone(), session_id.clone()));

        // 获取模型名称用于前端显示
        // 从 API 配置中解析 model_id 到真正的模型名称（如 "Qwen/Qwen3-8B"）
        log::info!(
            "[ChatV2::pipeline] Single variant: options.model_id = {:?}",
            ctx.options.model_id
        );

        let model_name: Option<String> =
            if let Some(config_id) = ctx.options.model_id.as_ref().filter(|s| !s.is_empty()) {
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
                log::warn!(
                    "[ChatV2::pipeline] Failed to save user message immediately: {}",
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

                // 🔧 自动生成会话摘要（每轮对话后）
                // 通过内容哈希防止重复生成
                let user_content_for_summary = ctx.user_content.clone();
                let assistant_content_for_summary = ctx.final_content.clone();
                if self
                    .should_generate_summary(
                        &session_id,
                        &user_content_for_summary,
                        &assistant_content_for_summary,
                    )
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();

                    // 🆕 P1修复：使用 TaskTracker 追踪异步任务，确保优雅关闭
                    // 异步执行摘要生成，不阻塞返回
                    let summary_future = async move {
                        pipeline
                            .generate_summary(
                                &sid,
                                &user_content_for_summary,
                                &assistant_content_for_summary,
                                emitter_clone,
                            )
                            .await;
                    };

                    // 🔧 P1修复：优先使用 spawn_tracked 追踪摘要任务
                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for summary task");
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

        // 阶段 2：加载聊天历史
        self.load_chat_history(ctx).await?;

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

        // 阶段 4：构建系统提示
        let system_prompt = self.build_system_prompt(ctx).await;

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
                use super::workspace::WorkspaceInjector;

                let injector = WorkspaceInjector::new(coordinator.clone());
                let max_injections = 3u32; // 单次空闲期最多处理 3 批消息

                match injector.check_and_inject(workspace_id, &ctx.session_id, max_injections) {
                    Ok(injection_result) => {
                        if !injection_result.messages.is_empty() {
                            let formatted = WorkspaceInjector::format_injected_messages(
                                &injection_result.messages,
                            );
                            ctx.inject_workspace_messages(formatted);

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

        Ok(())
    }
}
