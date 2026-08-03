//! ToolExecutor Trait 定义
//!
//! 统一工具执行接口，将工具执行逻辑从 Pipeline 中解耦。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 2 节
//!
//! ## 核心概念
//! - `ToolExecutor`: 工具执行器 trait，定义统一的执行接口
//! - `ExecutionContext`: 执行上下文，包含会话、消息、事件发射器等
//! - `ToolSensitivity`: 工具敏感等级，用于审批机制
//!
//! ## 类型复用
//! `ToolCall` 和 `ToolResultInfo` 复用 `crate::chat_v2::types` 中的定义

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Window;
use tokio_util::sync::CancellationToken;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::event_types;
use crate::chat_v2::events::ChatV2EventEmitter;
use crate::chat_v2::types::{
    block_status, AuthorityMode, McpToolSchema, MessageBlock, PermissionPreset, ToolCall,
    ToolResultInfo,
};
use crate::database::Database;
use crate::notes_manager::NotesManager;
use crate::tools::ToolRegistry;
use crate::vfs::database::VfsDatabase;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::pdf_processing_service::PdfProcessingService;

// ============================================================================
// 工具敏感等级
// ============================================================================

/// 工具敏感等级
///
/// 用于审批机制判断是否需要用户确认。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ToolSensitivity {
    /// 低敏感 - 直接执行
    #[default]
    Low,
    /// 中敏感 - 根据用户配置决定
    Medium,
    /// 高敏感 - 必须审批
    High,
}

// ============================================================================
// 工具结果预算（统一截断出口，2026-07）
// ============================================================================

/// 默认工具结果字符预算（按序列化 JSON 字符数计）。
///
/// `ToolExecutorRegistry::execute` 在结果返回路径统一应用该预算，避免单个
/// 工具输出把 LLM 上下文与事件通道撑爆。执行器可通过覆写
/// [`ToolExecutor::result_char_budget`] 调整或关闭（返回 `None`）。
pub const DEFAULT_TOOL_RESULT_CHAR_BUDGET: usize = 30_000;

/// 预算下限：防止元数据覆写把预算配置到不可用的极小值。
const MIN_TOOL_RESULT_CHAR_BUDGET: usize = 1_024;

/// 单个字符串叶子的截断标记。
const TRUNCATION_MARKER: &str = "…[truncated]";

fn serialized_char_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.chars().count())
        .unwrap_or(0)
}

/// 递归收缩过长的字符串叶子（保留对象结构与短标量字段，如 id / 状态标志）。
fn truncate_string_leaves(value: &mut Value, max_leaf_chars: usize) -> bool {
    match value {
        Value::String(s) => {
            if s.chars().count() > max_leaf_chars {
                let mut shortened: String = s.chars().take(max_leaf_chars).collect();
                shortened.push_str(TRUNCATION_MARKER);
                *s = shortened;
                true
            } else {
                false
            }
        }
        Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                changed |= truncate_string_leaves(item, max_leaf_chars);
            }
            changed
        }
        Value::Object(map) => {
            let mut changed = false;
            for item in map.values_mut() {
                changed |= truncate_string_leaves(item, max_leaf_chars);
            }
            changed
        }
        _ => false,
    }
}

/// 统一结果预算包装：超限时截断输出并附 `truncated: true` 与原始大小说明。
///
/// 截断策略（保守，保护结构化消费方）：
/// 1. 未超预算：原样返回（绝大多数调用走这条路径，零开销拷贝语义）。
/// 2. 超预算且为对象/数组：先收缩长字符串叶子，保留 id / 标志等短标量字段；
///    收缩后达标则在顶层附加 `truncated` / `original_chars` 元数据。
/// 3. 仍超预算（如超大数组）：降级为 JSON 预览包装对象。
///
/// 注意：执行器在自身 `save_tool_block` 中已持久化原始输出；预算包装只影响
/// 注册表返回给 Pipeline（进而回喂 LLM / 末轮持久化）的副本。
pub fn apply_tool_result_budget(output: Value, budget: usize) -> Value {
    let budget = budget.max(MIN_TOOL_RESULT_CHAR_BUDGET);
    let original_chars = serialized_char_len(&output);
    if original_chars <= budget {
        return output;
    }

    let mut working = output;
    let leaf_cap = (budget / 8).max(256);
    let changed = truncate_string_leaves(&mut working, leaf_cap);
    if changed && serialized_char_len(&working) <= budget {
        return match working {
            Value::Object(mut map) => {
                map.insert("truncated".to_string(), Value::Bool(true));
                map.insert(
                    "original_chars".to_string(),
                    Value::Number(serde_json::Number::from(original_chars as u64)),
                );
                map.insert(
                    "truncation_note".to_string(),
                    Value::String(format!(
                        "Tool output exceeded the {budget}-char result budget; long string fields were shortened. The full output was persisted before truncation."
                    )),
                );
                Value::Object(map)
            }
            other => serde_json::json!({
                "truncated": true,
                "original_chars": original_chars,
                "truncation_note": format!(
                    "Tool output exceeded the {budget}-char result budget; long string content was shortened. The full output was persisted before truncation."
                ),
                "result": other,
            }),
        };
    }

    // 硬兜底：结构性收缩不足（如超大数组），退化为 JSON 预览。
    let serialized = serde_json::to_string(&working).unwrap_or_default();
    let preview: String = serialized.chars().take(budget).collect();
    serde_json::json!({
        "truncated": true,
        "original_chars": original_chars,
        "budget_chars": budget,
        "truncation_note": "Tool output exceeded the result budget; showing a JSON preview. The full output was persisted before truncation.",
        "preview": preview,
    })
}

// ============================================================================
// 工具并发等级
// ============================================================================

/// 工具并发等级（2026-07 并行工具调用改造）
///
/// 声明工具在同一批 tool_calls 内的并发安全性，由 Pipeline 的
/// `execute_tool_calls` 用于决定是否将连续的并行安全工具分段并行执行。
///
/// ## 语义
/// - `ReadOnly`: 纯只读、无副作用（检索/读取/查询类）。可并行执行，
///   且瞬时失败（超时/网络/429/5xx）允许自动重试。
/// - `SafeParallel`: 有副作用但相互隔离、可安全并行（如各自写独立资源）。
///   可并行执行，但**不**自动重试（避免副作用重复）。
/// - `Serial`: 默认值。顺序执行，绝不自动重试。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ToolConcurrency {
    /// 只读工具 - 可并行 + 瞬时错误可自动重试
    ReadOnly,
    /// 并行安全（有隔离副作用）- 可并行，不自动重试
    SafeParallel,
    /// 串行（默认，保守）
    #[default]
    Serial,
}

// ============================================================================
// 类型复用说明
// ============================================================================
// `ToolCall` 和 `ToolResultInfo` 从 `crate::chat_v2::types` 导入
// 避免重复定义，保持类型一致性

// ============================================================================
// 执行上下文
// ============================================================================

/// 工具执行上下文
///
/// 包含工具执行所需的所有依赖和状态。
pub struct ExecutionContext {
    /// 会话 ID
    pub session_id: String,
    /// 消息 ID
    pub message_id: String,
    /// 变体 ID（多变体路径下的 branch-local skill 作用域）
    pub variant_id: Option<String>,
    /// 当前 skill state 版本
    pub skill_state_version: Option<u64>,
    /// 当前工具轮次 ID
    pub round_id: Option<String>,
    /// 块 ID（由调用方生成）
    pub block_id: String,
    /// ACR R2-01：工具调用 ID（= LLM tool_call.id）。
    /// 桥 `runId` / presence / 账本权威来源；缺省时回退 `block_id`。
    pub tool_call_id: Option<String>,
    /// 事件发射器
    pub emitter: Arc<ChatV2EventEmitter>,
    /// Canvas 笔记 ID（Canvas 工具需要）
    pub canvas_note_id: Option<String>,
    /// 笔记管理器（Canvas 工具需要）
    pub notes_manager: Option<Arc<NotesManager>>,
    /// 通用工具注册表
    pub tool_registry: Arc<ToolRegistry>,
    /// 主数据库（用于读取用户配置）
    pub main_db: Option<Arc<Database>>,
    /// Anki 数据库（用于 Anki 制卡进度查询）
    pub anki_db: Option<Arc<Database>>,
    /// Tauri 窗口（用于 MCP 工具桥接）。
    ///
    /// Windowless integration tests may leave this `None`; tools that need a
    /// real window must call [`Self::window_ref`].
    pub tauri_window: Option<Window>,
    /// VFS 数据库（用于学习资源工具访问 DSTU 数据）
    pub vfs_db: Option<Arc<VfsDatabase>>,
    /// VFS Lance 向量存储（用于 Memory-as-VFS 搜索）
    pub vfs_lance_store: Option<Arc<VfsLanceStore>>,
    /// 🆕 LLM 管理器（用于 VFS RAG 嵌入生成，2025-01）
    pub llm_manager: Option<Arc<crate::llm_manager::LLMManager>>,
    /// 🆕 Chat V2 数据库（用于工具块防闪退保存）
    pub chat_v2_db: Option<Arc<ChatV2Database>>,
    /// 🆕 智能题目集服务（用于 qbank_* 工具，2026-01）
    pub question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    /// 🆕 渐进披露：技能内容映射（skillId -> content）
    /// 用于 load_skills 验证技能是否可加载；技能正文由 transient message 注入给 LLM
    pub skill_contents: Option<std::collections::HashMap<String, String>>,
    /// 技能嵌入工具映射（skillId -> embedded tools）
    pub skill_embedded_tools: Option<std::collections::HashMap<String, Vec<McpToolSchema>>>,
    /// 技能运行时准入拒绝原因（skillId -> reason）
    pub skill_admission_errors: Option<std::collections::HashMap<String, String>>,
    /// Skill package roots exposed as read-only `skill:<skillId>` runtime roots.
    pub skill_package_roots: Option<std::collections::HashMap<String, String>>,
    /// 后端受限运行时的工具执行白名单；普通对话为 None。
    pub execution_allowed_tools: Option<Vec<String>>,
    /// 🆕 取消令牌：用于工具执行取消机制
    /// 工具执行器可以检查此令牌以响应取消请求
    pub cancellation_token: Option<CancellationToken>,
    /// Backend-only evidence for a single-use immutable shell-guard approval.
    /// This is never populated from model-controlled tool arguments.
    pub shell_guard_approved: bool,
    /// Authority/preset admitted by tool_loop immediately before executor
    /// dispatch. Local shell compares these with a fresh metadata read.
    pub shell_authority_admission: Option<(AuthorityMode, PermissionPreset)>,
    /// 🆕 RAG Top-K 设置（从 UI chatParams 传递）
    pub rag_top_k: Option<u32>,
    /// 🆕 RAG 启用重排序设置（从 UI chatParams 传递）
    pub rag_enable_reranking: Option<bool>,
    /// 🆕 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pub pdf_processing_service: Option<Arc<PdfProcessingService>>,
    /// 🆕 Feature flags for sub-tool security preflight (ToolPack)
    pub memory_enabled: bool,
    /// 🆕 Whether RAG search is enabled
    pub rag_enabled: bool,
    /// 🆕 Whether web search is enabled
    pub web_search_enabled: bool,
}

impl ExecutionContext {
    /// 创建新的执行上下文
    pub fn new(
        session_id: String,
        message_id: String,
        block_id: String,
        emitter: Arc<ChatV2EventEmitter>,
        tool_registry: Arc<ToolRegistry>,
        window: Option<Window>,
    ) -> Self {
        Self {
            session_id,
            message_id,
            variant_id: None,
            skill_state_version: None,
            round_id: None,
            block_id,
            tool_call_id: None,
            emitter,
            canvas_note_id: None,
            notes_manager: None,
            tool_registry,
            main_db: None,
            anki_db: None,
            // rag_manager 已移除
            tauri_window: window,
            vfs_db: None,
            vfs_lance_store: None,
            llm_manager: None,
            chat_v2_db: None,
            question_bank_service: None,
            skill_contents: None,
            skill_embedded_tools: None,
            skill_admission_errors: None,
            skill_package_roots: None,
            execution_allowed_tools: None,
            cancellation_token: None,
            shell_guard_approved: false,
            shell_authority_admission: None,
            rag_top_k: None,
            rag_enable_reranking: None,
            pdf_processing_service: None,
            memory_enabled: true,
            rag_enabled: true,
            web_search_enabled: true,
        }
    }

    /// Borrow the Tauri window (panics if constructed windowless).
    pub fn window_ref(&self) -> &Window {
        self.tauri_window
            .as_ref()
            .expect("ExecutionContext.window_ref() called without a Tauri window")
    }

    pub fn with_variant_id(mut self, variant_id: Option<String>) -> Self {
        self.variant_id = variant_id;
        self
    }

    pub fn with_event_meta(
        mut self,
        skill_state_version: Option<u64>,
        round_id: Option<String>,
    ) -> Self {
        self.skill_state_version = skill_state_version;
        self.round_id = round_id;
        self
    }

    /// 🆕 设置取消令牌
    pub fn with_cancellation_token(mut self, token: CancellationToken) -> Self {
        self.cancellation_token = Some(token);
        self
    }

    pub fn with_shell_guard_approved(mut self, approved: bool) -> Self {
        self.shell_guard_approved = approved;
        self
    }

    pub fn with_shell_authority_admission(
        mut self,
        authority_mode: AuthorityMode,
        permission_preset: PermissionPreset,
    ) -> Self {
        self.shell_authority_admission = Some((authority_mode, permission_preset));
        self
    }

    /// 🆕 派生一个替换了取消令牌的上下文副本（其余字段全部共享/克隆）。
    ///
    /// 供 `ToolExecutorRegistry::execute` 为每次执行绑定 scoped child token：
    /// 注册表 watchdog 超时或流取消返回错误前，先 cancel 该 token，让执行器
    /// 内部 spawn 的后台任务（tool_pack 子任务、桥接调用、子进程等）观察到
    /// 取消并停止发射事件/落库，收敛「调用方已记录超时结果后仍产生可见
    /// 副作用」的窗口。
    pub fn scoped_with_cancellation_token(&self, token: CancellationToken) -> ExecutionContext {
        ExecutionContext {
            session_id: self.session_id.clone(),
            message_id: self.message_id.clone(),
            variant_id: self.variant_id.clone(),
            skill_state_version: self.skill_state_version,
            round_id: self.round_id.clone(),
            block_id: self.block_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            emitter: self.emitter.clone(),
            canvas_note_id: self.canvas_note_id.clone(),
            notes_manager: self.notes_manager.clone(),
            tool_registry: self.tool_registry.clone(),
            main_db: self.main_db.clone(),
            anki_db: self.anki_db.clone(),
            tauri_window: self.tauri_window.clone(),
            vfs_db: self.vfs_db.clone(),
            vfs_lance_store: self.vfs_lance_store.clone(),
            llm_manager: self.llm_manager.clone(),
            chat_v2_db: self.chat_v2_db.clone(),
            question_bank_service: self.question_bank_service.clone(),
            skill_contents: self.skill_contents.clone(),
            skill_embedded_tools: self.skill_embedded_tools.clone(),
            skill_admission_errors: self.skill_admission_errors.clone(),
            skill_package_roots: self.skill_package_roots.clone(),
            execution_allowed_tools: self.execution_allowed_tools.clone(),
            cancellation_token: Some(token),
            shell_guard_approved: self.shell_guard_approved,
            shell_authority_admission: self.shell_authority_admission,
            rag_top_k: self.rag_top_k,
            rag_enable_reranking: self.rag_enable_reranking,
            pdf_processing_service: self.pdf_processing_service.clone(),
            memory_enabled: self.memory_enabled,
            rag_enabled: self.rag_enabled,
            web_search_enabled: self.web_search_enabled,
        }
    }

    /// ACR R2-01：注入 toolCallId（与桥 runId 对齐）
    pub fn with_tool_call_id(mut self, tool_call_id: impl Into<String>) -> Self {
        self.tool_call_id = Some(tool_call_id.into());
        self
    }

    /// ACR R2-01：权威 runId = toolCallId，缺省回退 block_id
    pub fn run_id(&self) -> &str {
        self.tool_call_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(self.block_id.as_str())
    }

    /// 🆕 检查是否已取消
    ///
    /// 工具执行器可以在长时间操作中调用此方法检查是否应该终止执行。
    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token
            .as_ref()
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    /// 🆕 获取取消令牌的引用
    ///
    /// 用于在 async 操作中使用 `tokio::select!` 监听取消信号。
    pub fn cancellation_token(&self) -> Option<&CancellationToken> {
        self.cancellation_token.as_ref()
    }

    /// 设置 Canvas 上下文
    pub fn with_canvas(
        mut self,
        note_id: Option<String>,
        notes_manager: Option<Arc<NotesManager>>,
    ) -> Self {
        self.canvas_note_id = note_id;
        self.notes_manager = notes_manager;
        self
    }

    /// 设置主数据库
    pub fn with_main_db(mut self, db: Option<Arc<Database>>) -> Self {
        self.main_db = db;
        self
    }

    /// 设置 Anki 数据库
    pub fn with_anki_db(mut self, db: Option<Arc<Database>>) -> Self {
        self.anki_db = db;
        self
    }

    /// 设置 VFS 数据库（用于学习资源工具）
    pub fn with_vfs_db(mut self, vfs_db: Option<Arc<VfsDatabase>>) -> Self {
        self.vfs_db = vfs_db;
        self
    }

    pub fn with_vfs_lance_store(mut self, lance_store: Option<Arc<VfsLanceStore>>) -> Self {
        self.vfs_lance_store = lance_store;
        self
    }

    /// 🆕 设置 LLM 管理器（用于 VFS RAG 嵌入生成，2025-01）
    pub fn with_llm_manager(
        mut self,
        llm_manager: Option<Arc<crate::llm_manager::LLMManager>>,
    ) -> Self {
        self.llm_manager = llm_manager;
        self
    }

    /// 🆕 设置 Chat V2 数据库（用于工具块防闪退保存）
    pub fn with_chat_v2_db(mut self, db: Option<Arc<ChatV2Database>>) -> Self {
        self.chat_v2_db = db;
        self
    }

    /// 🆕 设置智能题目集服务（用于 qbank_* 工具，2026-01）
    pub fn with_question_bank_service(
        mut self,
        service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    ) -> Self {
        self.question_bank_service = service;
        self
    }

    /// 🆕 设置 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pub fn with_pdf_processing_service(
        mut self,
        service: Option<Arc<PdfProcessingService>>,
    ) -> Self {
        self.pdf_processing_service = service;
        self
    }

    /// 🆕 设置功能开关（用于 ToolPack 子工具安全预检）
    pub fn with_feature_flags(
        mut self,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
    ) -> Self {
        self.memory_enabled = memory_enabled;
        self.rag_enabled = rag_enabled;
        self.web_search_enabled = web_search_enabled;
        self
    }

    pub fn with_execution_allowed_tools(
        mut self,
        execution_allowed_tools: Option<Vec<String>>,
    ) -> Self {
        self.execution_allowed_tools = execution_allowed_tools;
        self
    }

    pub fn with_skill_package_roots(
        mut self,
        skill_package_roots: Option<std::collections::HashMap<String, String>>,
    ) -> Self {
        self.skill_package_roots = skill_package_roots;
        self
    }

    /// 🆕 保存工具块到数据库（防闪退）
    ///
    /// 工具执行完成后立即调用，确保结果持久化。
    /// 使用 UPSERT 语义，与 save_results 兼容。
    ///
    /// ## 参数
    /// - `result`: 工具执行结果
    ///
    /// ## 返回
    /// - `Ok(())`: 保存成功
    /// - `Err`: 保存失败（不影响工具执行结果）
    pub fn save_tool_block(&self, result: &ToolResultInfo) -> Result<(), String> {
        let db = match &self.chat_v2_db {
            Some(db) => db,
            None => {
                log::warn!("[ExecutionContext] chat_v2_db not set, skipping tool block save");
                return Ok(());
            }
        };

        let block_id = match &result.block_id {
            Some(id) => id.clone(),
            None => {
                log::warn!(
                    "[ExecutionContext] block_id not set in result, skipping tool block save"
                );
                return Ok(());
            }
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        let status = if result.success {
            block_status::SUCCESS.to_string()
        } else {
            block_status::ERROR.to_string()
        };

        // 计算 started_at：使用 duration_ms 反推开始时间
        let duration_ms = result.duration_ms.unwrap_or(0) as i64;
        let started_at = now_ms - duration_ms;

        let block = MessageBlock {
            id: block_id.clone(),
            message_id: self.message_id.clone(),
            block_type: crate::chat_v2::context::PipelineContext::get_block_type_for_tool_static(
                &result.tool_name,
            ),
            status,
            content: None,
            tool_name: Some(result.tool_name.clone()),
            tool_input: Some(result.input.clone()),
            tool_output: Some(result.output.clone()),
            citations: None,
            error: result.error.clone(),
            started_at: Some(started_at),
            ended_at: Some(now_ms),
            first_chunk_at: Some(started_at), // 🔧 用于块排序
            // 🔧 防闪退保存时暂用 0：ExecutionContext 不携带消息内块序号
            // （同一轮并行工具无法在此处得知最终排序），依赖 Pipeline 末轮
            // save_results 以真实 block_index 覆盖本行的 UPSERT。
            block_index: 0,
        };

        // 使用 UPSERT 保存（通过消息占位行满足 FK 约束）
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let tool_input_json = block
            .tool_input
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        let tool_output_json = block
            .tool_output
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;

        // 确保消息占位行存在（避免 FK 违反，无需关闭 FK 约束）
        conn.execute(
            "INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) \
             VALUES (?1, ?2, 'assistant', '[]', ?3)",
            rusqlite::params![
                block.message_id,
                self.session_id,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            r#"
            INSERT INTO chat_v2_blocks
            (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(id) DO UPDATE SET
                message_id = excluded.message_id,
                block_type = excluded.block_type,
                status = excluded.status,
                block_index = excluded.block_index,
                content = excluded.content,
                tool_name = excluded.tool_name,
                tool_input_json = excluded.tool_input_json,
                tool_output_json = excluded.tool_output_json,
                citations_json = excluded.citations_json,
                error = excluded.error,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                first_chunk_at = excluded.first_chunk_at
            "#,
            rusqlite::params![
                block.id,
                block.message_id,
                block.block_type,
                block.status,
                block.block_index,
                block.content,
                block.tool_name,
                tool_input_json,
                tool_output_json,
                Option::<String>::None, // citations_json
                block.error,
                block.started_at,
                block.ended_at,
                block.first_chunk_at,
            ],
        )
        .map_err(|e| e.to_string())?;

        // 🆕 把块 ID 追加进消息的 block_ids_json（尚未引用时）：
        // 前端严格按消息 blockIds 渲染，运行中的会话快照（如子代理嵌入视图的
        // loadSession）若读到"孤儿工具块"将不可见。单条 UPDATE 原子完成
        // "不存在才追加"，并行工具不会互相覆盖；末轮 save_results 会以
        // 最终交替顺序整体覆盖本字段。
        conn.execute(
            r#"
            UPDATE chat_v2_messages
            SET block_ids_json = json_insert(block_ids_json, '$[#]', ?1)
            WHERE id = ?2
              AND ?1 NOT IN (SELECT value FROM json_each(block_ids_json))
            "#,
            rusqlite::params![block.id, block.message_id],
        )
        .map_err(|e| e.to_string())?;

        log::debug!(
            "[ExecutionContext] Tool block saved: block_id={}, tool={}",
            block_id,
            self.block_id
        );

        Ok(())
    }

    pub fn with_rag_config(mut self, top_k: Option<u32>, enable_reranking: Option<bool>) -> Self {
        self.rag_top_k = top_k;
        self.rag_enable_reranking = enable_reranking;
        self
    }

    pub fn emit_tool_call_start(
        &self,
        tool_name: &str,
        tool_input: Value,
        tool_call_id: Option<&str>,
    ) {
        let payload = serde_json::json!({
            "toolName": tool_name,
            "toolInput": tool_input,
            "toolCallId": tool_call_id,
        });
        self.emitter.emit_start_with_meta(
            event_types::TOOL_CALL,
            &self.message_id,
            Some(&self.block_id),
            Some(payload),
            self.variant_id.as_deref(),
            self.skill_state_version,
            self.round_id.as_deref(),
        );
    }

    pub fn emit_tool_call_end(&self, result: Option<Value>) {
        self.emitter.emit_end_with_meta(
            event_types::TOOL_CALL,
            &self.block_id,
            result,
            self.variant_id.as_deref(),
            self.skill_state_version,
            self.round_id.as_deref(),
        );
    }

    pub fn emit_tool_call_error(&self, error: &str) {
        self.emitter.emit_error_with_meta(
            event_types::TOOL_CALL,
            &self.block_id,
            error,
            self.variant_id.as_deref(),
            self.skill_state_version,
            self.round_id.as_deref(),
        );
    }

    /// 🆕 统一工具进度事件（2026-07）。
    ///
    /// 复用现有 TOOL_CALL 块级 chunk 事件通道（与 paper_save / ACR 桥进度
    /// 相同的传输形状：一行一条），以 NDJSON 行发射结构化进度：
    /// `{"progress": {"phase": ..., "percent": ..., "message": ...}}`。
    ///
    /// 这是新增的可选行格式，不改变任何现有事件形状；前端可按行 JSON 解析，
    /// 无法解析的消费方按普通文本行渲染即可。
    pub fn emit_tool_progress(&self, phase: &str, percent: Option<u8>, message: Option<&str>) {
        let mut progress = serde_json::Map::new();
        progress.insert("phase".to_string(), Value::String(phase.to_string()));
        if let Some(percent) = percent {
            progress.insert(
                "percent".to_string(),
                Value::Number(serde_json::Number::from(percent.min(100))),
            );
        }
        if let Some(message) = message {
            if !message.is_empty() {
                progress.insert("message".to_string(), Value::String(message.to_string()));
            }
        }
        self.emit_tool_progress_payload(&Value::Object(
            [("progress".to_string(), Value::Object(progress))]
                .into_iter()
                .collect(),
        ));
    }

    /// 🆕 结构化进度载荷出口：以 NDJSON 行发射任意 JSON 进度快照。
    ///
    /// 供既有工具（如 paper_save 的 `{"papers": [...]}` 快照）迁移到统一
    /// 出口而不改变各自已约定的载荷形状。
    pub fn emit_tool_progress_payload(&self, payload: &Value) {
        if let Ok(line) = serde_json::to_string(payload) {
            emit_tool_progress_line(&self.emitter, &self.block_id, &line);
        }
    }
}

/// 统一进度行发射（自由函数版本）。
///
/// 供无法持有 `ExecutionContext` 的 `'static` 事件闭包（如 workbench 桥的
/// AcrProgress 监听器）复用同一出口。保持与既有实现完全一致的事件形状：
/// TOOL_CALL 块级 chunk、行尾换行、variant_id = None（DESIGN §2.1）。
pub fn emit_tool_progress_line(emitter: &ChatV2EventEmitter, block_id: &str, line: &str) {
    if line.is_empty() {
        return;
    }
    emitter.emit_chunk(
        event_types::TOOL_CALL,
        block_id,
        &format!("{}\n", line),
        None,
    );
}

// ============================================================================
// ToolExecutor Trait
// ============================================================================

/// 工具执行器 Trait
///
/// 所有工具执行器必须实现此 trait。
///
/// ## 实现指南
/// 1. `can_handle`: 返回该执行器是否处理指定工具
/// 2. `execute`: 执行工具调用，返回结果
/// 3. `sensitivity_level`: 返回工具敏感等级（可选，默认 Low）
///
/// ## ⚠️ 事件发射要求（2026-01-16 强制）
/// 所有实现**必须**在 `execute()` 方法中发射以下事件，否则前端无法实时显示工具调用状态：
///
/// | 时机 | 方法 | 说明 |
/// |------|------|------|
/// | 执行开始 | `ctx.emitter.emit_tool_call_start()` | 让前端立即显示工具调用 UI |
/// | 执行成功 | `ctx.emitter.emit_end(event_types::TOOL_CALL, ...)` | 通知前端工具执行完成 |
/// | 执行失败 | `ctx.emitter.emit_error(event_types::TOOL_CALL, ...)` | 通知前端工具执行失败 |
///
/// **示例**：
/// ```rust,ignore
/// ctx.emitter.emit_tool_call_start(&ctx.message_id, &ctx.block_id, &call.name, call.arguments.clone(), None);
/// // ... 执行工具逻辑 ...
/// ctx.emitter.emit_end(event_types::TOOL_CALL, &ctx.block_id, Some(json!({"result": output, "durationMs": duration_ms})), None);
/// ```
///
/// ## 🆕 取消支持（2026-02 新增）
/// 工具执行器应该响应取消请求，特别是长时间运行的操作：
///
/// **方式 1：在操作前检查取消状态**
/// ```rust,ignore
/// if ctx.is_cancelled() {
///     return Err("Tool execution cancelled".to_string());
/// }
/// ```
///
/// **方式 2：使用 `tokio::select!` 监听取消信号（推荐用于异步操作）**
/// ```rust,ignore
/// if let Some(token) = ctx.cancellation_token() {
///     tokio::select! {
///         result = self.do_long_running_task() => result,
///         _ = token.cancelled() => {
///             log::info!("[Executor] Execution cancelled");
///             Err("Tool execution cancelled".to_string())
///         }
///     }
/// } else {
///     self.do_long_running_task().await
/// }
/// ```
///
/// ## 生命周期
/// 执行器由 `ToolExecutorRegistry` 管理，Pipeline 通过注册表调用。
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// 判断该执行器是否处理指定工具
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称
    ///
    /// ## 返回
    /// - `true`: 该执行器处理此工具
    /// - `false`: 该执行器不处理此工具
    fn can_handle(&self, tool_name: &str) -> bool;

    /// 执行工具调用
    ///
    /// ## 参数
    /// - `call`: 工具调用信息
    /// - `ctx`: 执行上下文
    ///
    /// ## 返回
    /// - `Ok(ToolResultInfo)`: 执行结果（成功或失败）
    /// - `Err`: 执行过程中的异常错误
    ///
    /// ## 注意
    /// - 执行器应该发射 start/end/error 事件
    /// - 即使工具执行失败，也应该返回 `Ok` 并设置 `success=false`
    /// - 只有执行器自身异常才应该返回 `Err`
    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String>;

    /// 获取工具敏感等级
    ///
    /// ## 参数
    /// - `tool_name`: 工具名称
    ///
    /// ## 返回
    /// 工具敏感等级，用于审批机制
    ///
    /// ## 默认实现
    /// 返回 `ToolSensitivity::Low`（直接执行，无需审批）
    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    /// Resolve sensitivity for a concrete call. Executors that multiplex read
    /// and write actions under one tool name can override this method; all
    /// existing executors retain their name-based behavior by default.
    fn sensitivity_level_for_call(&self, tool_name: &str, _arguments: &Value) -> ToolSensitivity {
        self.sensitivity_level(tool_name)
    }

    /// Whether this executor can change sensitivity based on call arguments.
    ///
    /// Risk-description consumers use this metadata to distinguish a stable
    /// name-level classification from one that must be resolved for each call.
    fn has_dynamic_sensitivity(&self, _tool_name: &str) -> bool {
        false
    }

    /// 获取工具并发等级（2026-07 并行工具调用改造）
    ///
    /// 接收 `tool_name` 是因为同一 executor 可能混合读写工具
    /// （如 memory_executor 同时处理 memory_search 和 memory_delete），
    /// 与 `sensitivity_level(&self, tool_name)` 的用法保持一致。
    ///
    /// ## 默认实现
    /// 返回 `ToolConcurrency::Serial`（保守：顺序执行、不自动重试）。
    /// 只有明确只读/并行安全的 executor 才应覆写此方法。
    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::Serial
    }

    /// 执行器是否自行处理取消终态。
    ///
    /// 默认 false：注册表在 cancellation token 触发时立即中断 future。
    /// ACR 桥调用需在发出 cancel 后有界 drain 前端权威回执，因此可按工具名覆写为 true。
    fn manages_cancellation(&self, _tool_name: &str) -> bool {
        false
    }

    /// 工具结果字符预算（统一截断出口，2026-07）。
    ///
    /// `ToolExecutorRegistry::execute` 在结果返回路径按该预算调用
    /// [`apply_tool_result_budget`]。默认 [`DEFAULT_TOOL_RESULT_CHAR_BUDGET`]。
    ///
    /// 覆写指南：
    /// - 自带有界输出控制的执行器（如 local_shell 的 `max_output_bytes`）
    ///   返回 `None` 关闭外层预算，避免行为回退；
    /// - 聚合器（如 tool_pack，其子结果已逐个过预算）返回 `None` 防止双重截断；
    /// - 其余执行器保持默认即可。
    fn result_char_budget(&self, _tool_name: &str) -> Option<usize> {
        Some(DEFAULT_TOOL_RESULT_CHAR_BUDGET)
    }

    /// 获取执行器名称（用于日志）
    fn name(&self) -> &'static str;
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_sensitivity_default() {
        assert_eq!(ToolSensitivity::default(), ToolSensitivity::Low);
    }

    #[test]
    fn test_tool_concurrency_default_is_serial() {
        assert_eq!(ToolConcurrency::default(), ToolConcurrency::Serial);
    }

    #[test]
    fn result_budget_is_noop_within_budget() {
        let output = serde_json::json!({"id": "abc", "content": "short"});
        let budgeted = apply_tool_result_budget(output.clone(), 30_000);
        assert_eq!(budgeted, output);
    }

    #[test]
    fn result_budget_shrinks_long_string_leaves_but_keeps_structure() {
        let long_text = "x".repeat(50_000);
        let output = serde_json::json!({
            "file_id": "file_123",
            "success": true,
            "content": long_text,
        });
        let budgeted = apply_tool_result_budget(output, 2_048);
        assert_eq!(
            budgeted.get("file_id").and_then(|v| v.as_str()),
            Some("file_123"),
            "short scalar fields must survive truncation"
        );
        assert_eq!(
            budgeted.get("success").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            budgeted.get("truncated").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(
            budgeted
                .get("original_chars")
                .and_then(|v| v.as_u64())
                .unwrap()
                > 2_048
        );
        let content = budgeted.get("content").and_then(|v| v.as_str()).unwrap();
        assert!(content.ends_with(TRUNCATION_MARKER));
        assert!(serialized_char_len(&budgeted) < 50_000);
    }

    #[test]
    fn result_budget_falls_back_to_preview_for_huge_arrays() {
        let output = serde_json::Value::Array(
            (0..20_000)
                .map(|i| serde_json::json!({"i": i}))
                .collect::<Vec<_>>(),
        );
        let original = serialized_char_len(&output);
        let budgeted = apply_tool_result_budget(output, 2_048);
        assert_eq!(
            budgeted.get("truncated").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            budgeted.get("original_chars").and_then(|v| v.as_u64()),
            Some(original as u64)
        );
        assert!(budgeted.get("preview").and_then(|v| v.as_str()).is_some());
    }

    #[test]
    fn result_budget_enforces_minimum_budget() {
        let long_text = "y".repeat(10_000);
        let output = serde_json::json!({"content": long_text});
        // 预算 0 会被抬升到 MIN_TOOL_RESULT_CHAR_BUDGET，而不是清空输出
        let budgeted = apply_tool_result_budget(output, 0);
        assert_eq!(
            budgeted.get("truncated").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(serialized_char_len(&budgeted) >= 256);
    }
}
