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
use tauri::Window;
use tokio_util::sync::CancellationToken;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::events::ChatV2EventEmitter;
use crate::chat_v2::types::{block_status, block_types, MessageBlock, ToolCall, ToolResultInfo};
use crate::database::Database;
use crate::notes_manager::NotesManager;
// ★ rag_manager 已移除（2026-01 清理：VFS RAG 完全替代）
use crate::tools::ToolRegistry;
use crate::vfs::pdf_processing_service::PdfProcessingService;
// ★ UserMemoryDatabase 已移除（2026-01），改用 Memory-as-VFS
use crate::vfs::database::VfsDatabase;
use crate::vfs::lance_store::VfsLanceStore;

// ============================================================================
// 工具敏感等级
// ============================================================================

/// 工具敏感等级
///
/// 用于审批机制判断是否需要用户确认。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSensitivity {
    /// 低敏感 - 直接执行
    Low,
    /// 中敏感 - 根据用户配置决定
    Medium,
    /// 高敏感 - 必须审批
    High,
}

impl Default for ToolSensitivity {
    fn default() -> Self {
        Self::Low
    }
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
    /// 块 ID（由调用方生成）
    pub block_id: String,
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
    // ★ rag_manager 已移除（2026-01 清理：VFS RAG 完全替代）
    /// Tauri 窗口（用于 MCP 工具桥接）
    pub window: Window,
    /// VFS 数据库（用于学习资源工具访问 DSTU 数据）
    pub vfs_db: Option<Arc<VfsDatabase>>,
    /// VFS Lance 向量存储（用于 Memory-as-VFS 搜索）
    pub vfs_lance_store: Option<Arc<VfsLanceStore>>,
    /// 🆕 LLM 管理器（用于 VFS RAG 嵌入生成，2025-01）
    pub llm_manager: Option<Arc<crate::llm_manager::LLMManager>>,
    // ★ user_memory_db 已移除（2026-01），改用 Memory-as-VFS
    /// 🆕 Chat V2 数据库（用于工具块防闪退保存）
    pub chat_v2_db: Option<Arc<ChatV2Database>>,
    /// 🆕 智能题目集服务（用于 qbank_* 工具，2026-01）
    pub question_bank_service: Option<Arc<crate::question_bank_service::QuestionBankService>>,
    /// 🆕 渐进披露：技能内容映射（skillId -> content）
    /// 用于 load_skills 工具返回技能的完整内容给 LLM
    pub skill_contents: Option<std::collections::HashMap<String, String>>,
    /// 🆕 取消令牌：用于工具执行取消机制
    /// 工具执行器可以检查此令牌以响应取消请求
    pub cancellation_token: Option<CancellationToken>,
    /// 🆕 RAG Top-K 设置（从 UI chatParams 传递）
    pub rag_top_k: Option<u32>,
    /// 🆕 RAG 启用重排序设置（从 UI chatParams 传递）
    pub rag_enable_reranking: Option<bool>,
    /// 🆕 PDF 处理服务（用于论文保存后触发 OCR/压缩 Pipeline）
    pub pdf_processing_service: Option<Arc<PdfProcessingService>>,
}

impl ExecutionContext {
    /// 创建新的执行上下文
    ///
    /// ★ 2026-01 简化：rag_manager 已移除，VFS RAG 完全替代
    pub fn new(
        session_id: String,
        message_id: String,
        block_id: String,
        emitter: Arc<ChatV2EventEmitter>,
        tool_registry: Arc<ToolRegistry>,
        window: Window,
    ) -> Self {
        Self {
            session_id,
            message_id,
            block_id,
            emitter,
            canvas_note_id: None,
            notes_manager: None,
            tool_registry,
            main_db: None,
            anki_db: None,
            // rag_manager 已移除
            window,
            vfs_db: None,
            vfs_lance_store: None,
            llm_manager: None,
            chat_v2_db: None,
            question_bank_service: None,
            skill_contents: None,
            cancellation_token: None,
            rag_top_k: None,
            rag_enable_reranking: None,
            pdf_processing_service: None,
        }
    }

    /// 🆕 设置取消令牌
    pub fn with_cancellation_token(mut self, token: CancellationToken) -> Self {
        self.cancellation_token = Some(token);
        self
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

    // ★ with_user_memory_db 已移除（2026-01），改用 Memory-as-VFS

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
            block_index: 0,                   // 🔧 防闪退保存时暂用 0，save_results 会覆盖为正确值
        };

        // 使用 UPSERT 保存（临时禁用外键约束）
        let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

        let tool_input_json = block
            .tool_input
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()
            .map_err(|e| e.to_string())?;
        let tool_output_json = block
            .tool_output
            .as_ref()
            .map(|v| serde_json::to_string(v))
            .transpose()
            .map_err(|e| e.to_string())?;

        // 临时禁用外键约束（流式过程中消息可能还未保存）
        conn.execute("PRAGMA foreign_keys = OFF", [])
            .map_err(|e| e.to_string())?;

        // 🔧 与 repo.rs 标准 INSERT 保持一致，包含 block_index 和 first_chunk_at
        let result = conn.execute(
            r#"
            INSERT OR REPLACE INTO chat_v2_blocks
            (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
        );

        // 重新启用外键约束
        let _ = conn.execute("PRAGMA foreign_keys = ON", []);

        result.map_err(|e| e.to_string())?;

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
}
