//! Canvas 工具执行器（完全前端模式）
//!
//! 处理 Canvas 智能笔记工具的执行。
//! - 读取操作：通过 NotesManager 直接读取
//! - 写入操作：发送编辑指令到前端，由前端编辑器执行，用户可立即看到变化
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 2.3.5 节
//!
//! ## 处理的工具
//! - `note_read`: 读取笔记内容（后端直接读取）
//! - `note_append`: 追加内容到笔记（前端执行）
//! - `note_replace`: 替换笔记内容（前端执行）
//! - `note_set`: 设置笔记完整内容（前端执行）
//!
//! ## 完全前端模式
//! 写入操作流程：
//! 1. 后端发送 `canvas:ai-edit-request` 事件到前端
//! 2. 前端编辑器执行编辑操作（用户立即可见，支持撤销）
//! 3. 前端发送 `canvas:ai-edit-result` 事件回后端
//! 4. 后端返回工具执行结果给 AI

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;
use tokio::sync::oneshot;

use super::canvas_tool_names;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::{is_canvas_tool, strip_canvas_builtin_prefix};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 类型定义
// ============================================================================

/// AI 编辑请求操作类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasEditOperation {
    /// 追加内容
    Append,
    /// 替换内容
    Replace,
    /// 设置完整内容
    Set,
}

/// AI 编辑请求（发送到前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasAIEditRequest {
    /// 请求 ID（用于匹配响应）
    pub request_id: String,
    /// 笔记 ID
    pub note_id: String,
    /// 操作类型
    pub operation: CanvasEditOperation,
    /// 追加/设置的内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 替换操作的搜索模式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    /// 替换操作的替换内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
    /// 是否使用正则表达式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_regex: Option<bool>,
    /// 追加/替换的章节（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

/// AI 编辑结果（从前端返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasAIEditResult {
    /// 请求 ID
    pub request_id: String,
    /// 是否成功
    pub success: bool,
    /// 错误消息（如果失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 受影响的字符数（追加/设置）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_count: Option<usize>,
    /// 替换次数（替换操作）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace_count: Option<usize>,
    /// 🆕 操作前内容预览（用于 diff 显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_preview: Option<String>,
    /// 🆕 操作后内容预览（用于 diff 显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_preview: Option<String>,
    /// 🆕 追加的内容（用于高亮显示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_content: Option<String>,
}

// ============================================================================
// 回调管理器（全局静态，用于接收前端响应）
// ============================================================================

type EditResultSender = oneshot::Sender<CanvasAIEditResult>;

use std::sync::LazyLock;

/// 等待前端响应的回调映射
static PENDING_CALLBACKS: LazyLock<Arc<Mutex<HashMap<String, EditResultSender>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 注册等待回调
fn register_callback(request_id: &str, sender: EditResultSender) {
    // 使用 unwrap_or_else 处理锁污染，避免 panic
    let mut callbacks = PENDING_CALLBACKS.lock().unwrap_or_else(|poisoned| {
        log::error!("[CanvasToolExecutor] PENDING_CALLBACKS mutex poisoned! Attempting recovery");
        poisoned.into_inner()
    });
    callbacks.insert(request_id.to_string(), sender);
}

/// 处理前端返回的编辑结果（由 Tauri 命令调用）
pub fn handle_edit_result(result: CanvasAIEditResult) {
    // 使用 unwrap_or_else 处理锁污染，避免 panic
    let mut callbacks = PENDING_CALLBACKS.lock().unwrap_or_else(|poisoned| {
        log::error!("[CanvasToolExecutor] PENDING_CALLBACKS mutex poisoned! Attempting recovery");
        poisoned.into_inner()
    });
    if let Some(sender) = callbacks.remove(&result.request_id) {
        let _ = sender.send(result);
    } else {
        log::warn!(
            "[CanvasToolExecutor] No pending callback for request_id: {}",
            result.request_id
        );
    }
}

/// 前端编辑超时时间（毫秒）
const FRONTEND_EDIT_TIMEOUT_MS: u64 = 30000;

/// 安全截断字符串（按字符数而非字节数），避免多字节 UTF-8 字符导致 panic
fn safe_truncate(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}...", truncated)
    } else {
        truncated
    }
}

// ============================================================================
// Canvas 工具执行器
// ============================================================================

/// Canvas 工具执行器（完全前端模式）
///
/// 处理所有 Canvas 智能笔记工具。
///
/// ## 处理的工具
/// - `note_read`: 读取笔记内容（后端直接读取）
/// - `note_append`: 追加内容到笔记（前端执行）
/// - `note_replace`: 替换笔记内容（前端执行）
/// - `note_set`: 设置笔记完整内容（前端执行）
///
/// ## 执行步骤（写入操作）
/// 1. 发射 `tool_call` start 事件
/// 2. 解析参数，填充默认值（noteId）
/// 3. 发送 `canvas:ai-edit-request` 到前端
/// 4. 等待前端返回 `canvas:ai-edit-result`（超时 30s）
/// 5. 发射 end/error 事件
/// 6. 返回 `ToolResultInfo`
pub struct CanvasToolExecutor;

impl CanvasToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_read(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
        note_id: &str,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let notes_manager = ctx
            .notes_manager
            .as_ref()
            .ok_or_else(|| "Canvas 工具不可用：NotesManager 未初始化".to_string())?
            .clone();

        let note_id_owned = note_id.to_string();
        let section = args
            .get("section")
            .and_then(|v| v.as_str())
            .map(String::from);

        tokio::task::spawn_blocking(move || {
            match notes_manager.canvas_read_content(&note_id_owned, section.as_deref()) {
                Ok(content) => Ok(json!({
                    "noteId": note_id_owned,
                    "content": content,
                    "wordCount": content.chars().count(),
                    "isSection": section.is_some(),
                })),
                Err(e) => Err(e.to_string()),
            }
        })
        .await
        .map_err(|e| format!("读取笔记失败: {}", e))?
    }

    async fn execute_list(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let notes_manager = ctx
            .notes_manager
            .as_ref()
            .ok_or_else(|| "Canvas 工具不可用：NotesManager 未初始化".to_string())?
            .clone();

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(100) as usize)
            .unwrap_or(20);
        let tags: Option<Vec<String>> = args
            .get("tags")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let favorites_only = args
            .get("favoritesOnly")
            .or(args.get("favorites_only"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // ★ L-027: 读取 folder_id 参数（schema 已定义但此前未使用）
        let folder_id = args
            .get("folderId")
            .or(args.get("folder_id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let vfs_db = ctx.vfs_db.clone();

        tokio::task::spawn_blocking(move || {
            // ★ L-027: 当指定 folder_id 且 vfs_db 可用时，使用 VfsNoteRepo 按文件夹查询
            let filtered: Vec<serde_json::Value> =
                if let (Some(ref fid), Some(ref db)) = (&folder_id, &vfs_db) {
                    use crate::vfs::VfsNoteRepo;
                    let folder_arg = if fid == "root" {
                        None
                    } else {
                        Some(fid.as_str())
                    };
                    let notes = VfsNoteRepo::list_notes_by_folder(db, folder_arg, limit as u32, 0)
                        .map_err(|e| format!("列出笔记失败: {}", e))?;
                    notes
                        .into_iter()
                        .filter(|n| {
                            if favorites_only && !n.is_favorite {
                                return false;
                            }
                            if let Some(ref filter_tags) = tags {
                                if !filter_tags.iter().all(|t| n.tags.contains(t)) {
                                    return false;
                                }
                            }
                            true
                        })
                        .take(limit)
                        .map(|n| {
                            json!({
                                "id": n.id,
                                "title": n.title,
                                "tags": n.tags,
                                "isFavorite": n.is_favorite,
                                "updatedAt": n.updated_at,
                            })
                        })
                        .collect()
                } else {
                    let notes = notes_manager
                        .list_notes_meta()
                        .map_err(|e| format!("列出笔记失败: {}", e))?;
                    notes
                        .into_iter()
                        .filter(|n| {
                            if favorites_only && !n.is_favorite {
                                return false;
                            }
                            if let Some(ref filter_tags) = tags {
                                if !filter_tags.iter().all(|t| n.tags.contains(t)) {
                                    return false;
                                }
                            }
                            true
                        })
                        .take(limit)
                        .map(|n| {
                            json!({
                                "id": n.id,
                                "title": n.title,
                                "tags": n.tags,
                                "isFavorite": n.is_favorite,
                                "updatedAt": n.updated_at,
                            })
                        })
                        .collect()
                };

            let total = filtered.len();
            Ok(json!({
                "notes": filtered,
                "total": total,
            }))
        })
        .await
        .map_err(|e| format!("列出笔记失败: {}", e))?
    }

    async fn execute_search(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let notes_manager = ctx
            .notes_manager
            .as_ref()
            .ok_or_else(|| "Canvas 工具不可用：NotesManager 未初始化".to_string())?
            .clone();

        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "缺少必需参数: query".to_string())?
            .to_string();

        if query.trim().is_empty() {
            return Err("搜索关键词不能为空".to_string());
        }

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(50) as usize)
            .unwrap_or(10);

        tokio::task::spawn_blocking(move || {
            #[cfg(feature = "lance")]
            let results = notes_manager
                .search_notes_lance(&query, limit)
                .map_err(|e| format!("搜索笔记失败: {}", e))?;

            #[cfg(not(feature = "lance"))]
            return Ok(json!({
                "results": [],
                "count": 0,
                "warning": "语义搜索功能未启用（lance feature 未编译），搜索结果可能不完整"
            }));

            let items: Vec<_> = results
                .into_iter()
                .map(|(id, title, snippet)| {
                    json!({
                        "id": id,
                        "title": title,
                        "snippet": snippet,
                    })
                })
                .collect();

            let count = items.len();
            Ok(json!({
                "results": items,
                "count": count,
            }))
        })
        .await
        .map_err(|e| format!("搜索笔记失败: {}", e))?
    }

    /// 执行创建笔记操作（后端直接执行，不依赖前端）
    async fn execute_create(
        &self,
        _call: &ToolCall,
        ctx: &ExecutionContext,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        // 获取 VFS 数据库
        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or_else(|| "Canvas 工具不可用：VFS 数据库未初始化".to_string())?
            .clone();

        // 解析参数
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "缺少必需参数: title".to_string())?
            .to_string();

        if title.trim().is_empty() {
            return Err("笔记标题不能为空".to_string());
        }

        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        let tags: Vec<String> = args
            .get("tags")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        // 调用 VFS 创建笔记
        tokio::task::spawn_blocking(move || {
            use crate::vfs::{VfsCreateNoteParams, VfsNoteRepo};

            match VfsNoteRepo::create_note(
                &vfs_db,
                VfsCreateNoteParams {
                    title: title.clone(),
                    content: content.clone(),
                    tags,
                },
            ) {
                Ok(note) => {
                    log::info!(
                        "[CanvasToolExecutor] Created note: id={}, title={}",
                        note.id,
                        note.title
                    );
                    Ok(json!({
                        "noteId": note.id,
                        "title": note.title,
                        "wordCount": content.chars().count(),
                        "success": true,
                    }))
                }
                Err(e) => Err(format!("创建笔记失败: {}", e)),
            }
        })
        .await
        .map_err(|e| format!("创建笔记任务失败: {}", e))?
    }

    /// 执行写入操作（后端直接执行，不依赖前端编辑器）
    ///
    /// 这是完全独立于前端的后端写入实现，适用于：
    /// 1. AI 自主创建/编辑笔记（无需用户打开编辑器）
    /// 2. 后台批量处理
    async fn execute_write_backend(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        note_id: &str,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let notes_manager = ctx
            .notes_manager
            .as_ref()
            .ok_or_else(|| "Canvas 工具不可用：NotesManager 未初始化".to_string())?
            .clone();

        let note_id_owned = note_id.to_string();
        // 提前提取工具名称，避免生命周期问题
        let tool_name = strip_canvas_builtin_prefix(&call.name).to_string();
        let args_clone = args.clone();

        tokio::task::spawn_blocking(move || {
            match tool_name.as_str() {
                canvas_tool_names::NOTE_APPEND => {
                    let content = args_clone
                        .get("content")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "缺少必需参数: content".to_string())?;
                    let section = args_clone.get("section").and_then(|v| v.as_str());

                    // 读取操作前内容
                    let before_content = notes_manager
                        .canvas_read_content(&note_id_owned, section)
                        .unwrap_or_default();

                    // 执行追加
                    notes_manager
                        .canvas_append_content(&note_id_owned, content, section)
                        .map_err(|e| format!("追加内容失败: {}", e))?;

                    // 读取操作后内容
                    let after_content = notes_manager
                        .canvas_read_content(&note_id_owned, section)
                        .unwrap_or_default();

                    // 🔧 修复：添加 addedContent 用于前端高亮显示追加的内容
                    let added_content = content.to_string();

                    Ok(json!({
                        "noteId": note_id_owned,
                        "success": true,
                        "affectedCount": content.chars().count(),
                        "backendExecuted": true,
                        "beforePreview": safe_truncate(&before_content, 200),
                        "afterPreview": safe_truncate(&after_content, 200),
                        "addedContent": safe_truncate(&added_content, 300),
                    }))
                }
                canvas_tool_names::NOTE_SET => {
                    let content = args_clone
                        .get("content")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "缺少必需参数: content".to_string())?;

                    // 读取操作前内容
                    let before_content = notes_manager
                        .canvas_read_content(&note_id_owned, None)
                        .unwrap_or_default();

                    // 执行设置
                    notes_manager
                        .canvas_set_content(&note_id_owned, content)
                        .map_err(|e| format!("设置内容失败: {}", e))?;

                    // 🔧 修复：添加 afterPreview 用于前端 diff 显示
                    let after_content = content.to_string();

                    Ok(json!({
                        "noteId": note_id_owned,
                        "success": true,
                        "wordCount": content.chars().count(),
                        "backendExecuted": true,
                        "beforePreview": safe_truncate(&before_content, 200),
                        "afterPreview": safe_truncate(&after_content, 200),
                    }))
                }
                canvas_tool_names::NOTE_REPLACE => {
                    let search = args_clone
                        .get("search")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "缺少必需参数: search".to_string())?;
                    if search.is_empty() {
                        return Err("搜索模式不能为空".to_string());
                    }
                    let replace = args_clone
                        .get("replace")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "缺少必需参数: replace".to_string())?;
                    let is_regex = args_clone
                        .get("isRegex")
                        .or(args_clone.get("is_regex"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    // 读取当前内容（用于 beforePreview）
                    let current_content = notes_manager
                        .canvas_read_content(&note_id_owned, None)
                        .map_err(|e| format!("读取内容失败: {}", e))?;

                    // 执行替换
                    use super::canvas_tools::replace_content;
                    let (new_content, replace_count) =
                        replace_content(&current_content, search, replace, is_regex)?;

                    // 写入新内容
                    notes_manager
                        .canvas_set_content(&note_id_owned, &new_content)
                        .map_err(|e| format!("写入内容失败: {}", e))?;

                    // 🔧 修复：添加 beforePreview 和 afterPreview 用于前端 diff 显示
                    Ok(json!({
                        "noteId": note_id_owned,
                        "success": true,
                        "replaceCount": replace_count,
                        "backendExecuted": true,
                        "newWordCount": new_content.chars().count(),
                        "searchPattern": search,
                        "replaceWith": replace,
                        "beforePreview": safe_truncate(&current_content, 200),
                        "afterPreview": safe_truncate(&new_content, 200),
                    }))
                }
                _ => Err(format!("未知的写入操作: {}", tool_name)),
            }
        })
        .await
        .map_err(|e| format!("写入操作任务失败: {}", e))?
    }

    /// 执行写入操作（发送到前端执行）
    async fn execute_write_frontend(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        note_id: &str,
        args: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        // 1. 生成请求 ID
        let request_id = format!("canvas-edit-{}-{}", call.id, uuid::Uuid::new_v4());

        // 2. 构建编辑请求（去除 builtin: 前缀后匹配）
        let stripped_name = strip_canvas_builtin_prefix(&call.name);
        let request = match stripped_name {
            canvas_tool_names::NOTE_APPEND => CanvasAIEditRequest {
                request_id: request_id.clone(),
                note_id: note_id.to_string(),
                operation: CanvasEditOperation::Append,
                content: args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                search: None,
                replace: None,
                is_regex: None,
                section: args
                    .get("section")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            },
            canvas_tool_names::NOTE_REPLACE => CanvasAIEditRequest {
                request_id: request_id.clone(),
                note_id: note_id.to_string(),
                operation: CanvasEditOperation::Replace,
                content: None,
                search: args
                    .get("search")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                replace: args
                    .get("replace")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                is_regex: args
                    .get("is_regex")
                    .or(args.get("isRegex"))
                    .and_then(|v| v.as_bool()),
                section: None,
            },
            canvas_tool_names::NOTE_SET => CanvasAIEditRequest {
                request_id: request_id.clone(),
                note_id: note_id.to_string(),
                operation: CanvasEditOperation::Set,
                content: args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                search: None,
                replace: None,
                is_regex: None,
                section: None,
            },
            _ => return Err(format!("未知的 Canvas 写入工具: {}", call.name)),
        };

        // 2.1 验证必需参数
        match request.operation {
            CanvasEditOperation::Append | CanvasEditOperation::Set => {
                if request.content.as_ref().map_or(true, |c| c.is_empty()) {
                    return Err("缺少必需参数: content（内容不能为空）".to_string());
                }
            }
            CanvasEditOperation::Replace => {
                if request.search.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err("缺少必需参数: search（搜索模式不能为空）".to_string());
                }
                // replace 可以为空字符串（删除匹配内容）
                if request.replace.is_none() {
                    return Err("缺少必需参数: replace".to_string());
                }
            }
        }

        // 3. 创建响应通道
        let (tx, rx) = oneshot::channel();
        register_callback(&request_id, tx);

        // 4. 发送编辑请求到前端
        log::debug!(
            "[CanvasToolExecutor] Sending ai-edit-request to frontend: request_id={}, operation={:?}",
            request_id,
            request.operation
        );

        ctx.window
            .emit("canvas:ai-edit-request", &request)
            .map_err(|e| format!("发送编辑请求失败: {}", e))?;

        // 5. 等待前端响应（带超时）
        let timeout = tokio::time::timeout(
            std::time::Duration::from_millis(FRONTEND_EDIT_TIMEOUT_MS),
            rx,
        )
        .await;

        match timeout {
            Ok(Ok(result)) => {
                if result.success {
                    log::debug!(
                        "[CanvasToolExecutor] Frontend edit succeeded: request_id={}",
                        request_id
                    );
                    Ok(json!({
                        "noteId": note_id,
                        "success": true,
                        "affectedCount": result.affected_count,
                        "replaceCount": result.replace_count,
                        "frontendExecuted": true,
                        "beforePreview": result.before_preview,
                        "afterPreview": result.after_preview,
                        "addedContent": result.added_content,
                    }))
                } else {
                    let error_msg = result.error.unwrap_or_else(|| "前端编辑失败".to_string());
                    log::warn!(
                        "[CanvasToolExecutor] Frontend edit failed: request_id={}, error={}",
                        request_id,
                        error_msg
                    );
                    Err(error_msg)
                }
            }
            Ok(Err(_)) => {
                // 通道关闭（回调被清理）
                log::warn!(
                    "[CanvasToolExecutor] Edit callback channel closed: request_id={}",
                    request_id
                );
                Err("编辑请求被取消".to_string())
            }
            Err(_) => {
                // 超时
                log::warn!(
                    "[CanvasToolExecutor] Frontend edit timeout: request_id={} ({}ms)",
                    request_id,
                    FRONTEND_EDIT_TIMEOUT_MS
                );
                // 清理未完成的回调（使用 unwrap_or_else 处理锁污染）
                {
                    let mut callbacks = PENDING_CALLBACKS
                        .lock()
                        .unwrap_or_else(|poisoned| {
                            log::error!("[CanvasToolExecutor] PENDING_CALLBACKS mutex poisoned! Attempting recovery");
                            poisoned.into_inner()
                        });
                    callbacks.remove(&request_id);
                }
                Err(format!(
                    "编辑超时（{}秒），请确保笔记已打开",
                    FRONTEND_EDIT_TIMEOUT_MS / 1000
                ))
            }
        }
    }
}

impl Default for CanvasToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for CanvasToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        is_canvas_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        log::debug!(
            "[CanvasToolExecutor] Executing Canvas tool: name={}, id={}",
            call.name,
            call.id
        );

        // 1. 发射工具调用开始事件
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id), // 🆕 tool_call_id
            None,           // variant_id: 单变体模式
        );

        // 2. 解析参数：优先使用工具参数，否则使用 canvas_context 默认值
        let args = call.arguments.as_object().cloned().unwrap_or_default();
        let stripped_name = strip_canvas_builtin_prefix(&call.name);

        // note_list、note_search、note_create 不需要 noteId
        let no_note_id_required = matches!(
            stripped_name,
            canvas_tool_names::NOTE_LIST
                | canvas_tool_names::NOTE_SEARCH
                | canvas_tool_names::NOTE_CREATE
        );

        let note_id = if no_note_id_required {
            String::new()
        } else {
            args.get("noteId")
                .or(args.get("note_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| ctx.canvas_note_id.clone())
                .unwrap_or_default()
        };

        // 3. 检查 noteId 是否存在（仅对需要 noteId 的工具）
        if !no_note_id_required && note_id.is_empty() {
            let error_msg = "Canvas 工具缺少必需参数: noteId（请确保已选择笔记或在工具参数中指定）";
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg.to_string(),
                start_time.elapsed().as_millis() as u64,
            );

            // 🆕 SSOT: 后端立即保存工具块（防闪退）
            if let Err(e) = ctx.save_tool_block(&result) {
                log::warn!("[CanvasToolExecutor] Failed to save tool block: {}", e);
            }

            return Ok(result);
        }

        // 4. 根据工具类型选择执行路径
        let result: Result<serde_json::Value, String> = match stripped_name {
            canvas_tool_names::NOTE_READ => self.execute_read(call, ctx, &note_id, &args).await,
            canvas_tool_names::NOTE_LIST => self.execute_list(call, ctx, &args).await,
            canvas_tool_names::NOTE_SEARCH => self.execute_search(call, ctx, &args).await,
            canvas_tool_names::NOTE_CREATE => {
                // 创建笔记：后端直接执行（不需要 noteId）
                self.execute_create(call, ctx, &args).await
            }
            _ => {
                // 写入操作：优先使用后端直接写入（不依赖前端编辑器）
                // 这样 AI 可以完全自主地管理笔记，无需用户打开编辑器
                self.execute_write_backend(call, ctx, &note_id, &args).await
            }
        };

        let duration_ms = start_time.elapsed().as_millis() as u64;

        // 5. 处理结果
        match result {
            Ok(output) => {
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })),
                    None,
                );

                log::debug!(
                    "[CanvasToolExecutor] Tool {} completed successfully in {}ms",
                    call.name,
                    duration_ms
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[CanvasToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(error_msg) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);

                log::warn!(
                    "[CanvasToolExecutor] Tool {} failed: {} ({}ms)",
                    call.name,
                    error_msg,
                    duration_ms
                );

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    duration_ms,
                );

                // 🆕 SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[CanvasToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // ★ 2026-02-09: 全部降为 Low
        // 理由：用户主动让 AI 编辑笔记，note_set/note_replace 是预期行为，不应打断写作流
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "CanvasToolExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = CanvasToolExecutor::new();

        // 处理 Canvas 工具（原始格式）
        assert!(executor.can_handle("note_read"));
        assert!(executor.can_handle("note_append"));
        assert!(executor.can_handle("note_replace"));
        assert!(executor.can_handle("note_set"));
        assert!(executor.can_handle("note_list"));
        assert!(executor.can_handle("note_search"));

        // 处理 Canvas 工具（builtin- 前缀格式）
        assert!(executor.can_handle("builtin-note_read"));
        assert!(executor.can_handle("builtin-note_append"));
        assert!(executor.can_handle("builtin-note_replace"));
        assert!(executor.can_handle("builtin-note_set"));
        assert!(executor.can_handle("builtin-note_list"));
        assert!(executor.can_handle("builtin-note_search"));

        // 不处理其他工具
        assert!(!executor.can_handle("web_search"));
        assert!(!executor.can_handle("mcp_brave_search"));
        assert!(!executor.can_handle("builtin-rag_search"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = CanvasToolExecutor::new();

        // ★ 2026-02-09: 全部 Low
        assert_eq!(
            executor.sensitivity_level("note_read"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("note_append"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("note_list"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("note_search"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("note_create"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("note_replace"),
            ToolSensitivity::Low
        );
        assert_eq!(executor.sensitivity_level("note_set"), ToolSensitivity::Low);

        // builtin- 前缀格式
        assert_eq!(
            executor.sensitivity_level("builtin-note_read"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-note_set"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-note_list"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_name() {
        let executor = CanvasToolExecutor::new();
        assert_eq!(executor.name(), "CanvasToolExecutor");
    }
}
