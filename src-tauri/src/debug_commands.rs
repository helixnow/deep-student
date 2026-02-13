// ================================================
// 调试专用命令 - 直接数据库访问层
// ================================================
// 本模块提供绕过业务逻辑的原始数据访问接口，
// 专门用于调试插件验证数据完整性和流转正确性。
//
// ⚠️ 警告：这些命令仅供调试使用，不应在生产环境的正常业务流程中调用。
// ================================================

use crate::commands::AppState;
use crate::models::AppError;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[debug_commands] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 调试专用：原始聊天消息（从数据库直接反序列化）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugRawChatMessage {
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub thinking_content: Option<String>,
    pub rag_sources: Option<serde_json::Value>,
    pub memory_sources: Option<serde_json::Value>,
    pub graph_sources: Option<serde_json::Value>,
    pub web_search_sources: Option<serde_json::Value>,
    pub image_paths: Option<Vec<String>>,
    pub image_base64: Option<Vec<String>>,
    pub doc_attachments: Option<serde_json::Value>,
    pub tool_call: Option<serde_json::Value>,
    pub tool_result: Option<serde_json::Value>,
    pub overrides: Option<serde_json::Value>,
    pub relations: Option<serde_json::Value>,
    pub persistent_stable_id: Option<String>,
    // P0 修复：添加缺失的关键字段
    pub textbook_pages: Option<serde_json::Value>,
    pub unified_sources: Option<serde_json::Value>,
    #[serde(rename = "_meta")]
    pub meta: Option<serde_json::Value>,
}

/// 调试专用：错题的原始数据库记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugRawMistakeRecord {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_accessed_at: String,
    pub user_question: String,
    pub ocr_text: String,
    pub ocr_note: Option<String>,
    pub tags: Vec<String>,
    pub mistake_type: String,
    pub status: String,
    pub chat_category: String,
    pub question_images: Vec<String>,
    pub analysis_images: Vec<String>,
    pub mistake_summary: Option<String>,
    pub user_error_analysis: Option<String>,
    pub chat_metadata: Option<serde_json::Value>,

    // 核心：原始聊天历史（JSON 字符串）
    pub chat_history_raw_json: String,

    // 反序列化后的聊天历史
    pub chat_history: Vec<DebugRawChatMessage>,
}

/// 调试专用：数据库统计信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugDatabaseStats {
    pub total_mistakes: usize,
    pub mistakes_with_chat: usize,
    pub total_messages: usize,
    pub messages_with_images: usize,
    pub messages_with_thinking: usize,
    pub messages_with_rag_sources: usize,
    pub messages_with_memory_sources: usize,
    pub messages_with_web_sources: usize,
    pub messages_with_persistent_id: usize,
}

/// 调试专用：获取错题的原始数据库记录（绕过业务逻辑）
///
/// 与 `get_mistake_details` 的区别：
/// - 不经过任何业务逻辑处理或数据转换
/// - 直接返回数据库中的 JSON 原文
/// - 包含原始的 chat_history JSON 字符串
/// - 用于验证数据库存储是否正确
#[tauri::command]
pub async fn debug_get_raw_mistake(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<DebugRawMistakeRecord>, AppError> {
    println!("🔍 [DEBUG] 直接读取数据库原始记录: {}", id);

    let conn = state
        .database
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

    let result = conn
        .query_row(
            "SELECT
                id, created_at, updated_at, last_accessed_at,
                user_question, ocr_text, ocr_note, tags, mistake_type,
                status, chat_category, question_images, analysis_images,
                mistake_summary, user_error_analysis,
                chat_metadata, chat_history
            FROM mistakes
            WHERE id = ?1",
            params![&id],
            |row| {
                let tags_json: String = row.get(7)?;
                let question_images_json: String = row.get(11)?;
                let analysis_images_json: String = row.get(12)?;
                let chat_history_raw: String = row.get(16)?;
                let mistake_id: String = row.get(0)?;

                // P1 修复：不静默隐藏解析错误
                let tags: Vec<String> = match serde_json::from_str(&tags_json) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("⚠️ [DEBUG] 解析 tags JSON 失败 ({}): {}", mistake_id, e);
                        Vec::new()
                    }
                };

                let question_images: Vec<String> = match serde_json::from_str(&question_images_json)
                {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!(
                            "⚠️ [DEBUG] 解析 question_images JSON 失败 ({}): {}",
                            mistake_id, e
                        );
                        Vec::new()
                    }
                };

                let analysis_images: Vec<String> = match serde_json::from_str(&analysis_images_json)
                {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!(
                            "⚠️ [DEBUG] 解析 analysis_images JSON 失败 ({}): {}",
                            mistake_id, e
                        );
                        Vec::new()
                    }
                };

                // 反序列化聊天历史
                let chat_history: Vec<DebugRawChatMessage> =
                    match serde_json::from_str(&chat_history_raw) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!(
                                "⚠️ [DEBUG] 解析 chat_history JSON 失败 ({}): {}",
                                mistake_id, e
                            );
                            Vec::new()
                        }
                    };

                let chat_metadata_str: Option<String> = row.get(15)?;
                let chat_metadata: Option<serde_json::Value> =
                    chat_metadata_str.and_then(|s| serde_json::from_str(&s).ok());

                Ok(DebugRawMistakeRecord {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    updated_at: row.get(2)?,
                    last_accessed_at: row.get(3)?,
                    user_question: row.get(4)?,
                    ocr_text: row.get(5)?,
                    ocr_note: row.get(6)?,
                    tags,
                    mistake_type: row.get(8)?,
                    status: row.get(9)?,
                    chat_category: row.get(10)?,
                    question_images,
                    analysis_images,
                    mistake_summary: row.get(13)?,
                    user_error_analysis: row.get(14)?,
                    chat_metadata,
                    chat_history_raw_json: chat_history_raw,
                    chat_history,
                })
            },
        )
        .optional()
        .map_err(|e| AppError::database(format!("查询错题失败: {}", e)))?;

    Ok(result)
}

/// 调试专用：批量获取多个错题的原始记录
/// P1 修复：使用 IN 子句优化性能，避免 N+1 查询问题
#[tauri::command]
pub async fn debug_get_raw_mistakes_batch(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DebugRawMistakeRecord>, AppError> {
    println!("🔍 [DEBUG] 批量读取 {} 个错题的原始记录", ids.len());

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let conn = state
        .database
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

    // 构建 IN 子句的占位符
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT
            id, created_at, updated_at, last_accessed_at,
            user_question, ocr_text, ocr_note, tags, mistake_type,
            status, chat_category, question_images, analysis_images,
            mistake_summary, user_error_analysis,
            chat_metadata, chat_history
        FROM mistakes
        WHERE id IN ({})",
        placeholders
    );

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| AppError::database(format!("准备批量查询失败: {}", e)))?;

    // 将 String 引用转换为 rusqlite 可接受的参数
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            let tags_json: String = row.get(7)?;
            let question_images_json: String = row.get(11)?;
            let analysis_images_json: String = row.get(12)?;
            let chat_history_raw: String = row.get(16)?;

            // P1 修复：不静默隐藏解析错误
            let tags: Vec<String> = match serde_json::from_str(&tags_json) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("⚠️ [DEBUG] 解析 tags JSON 失败: {}", e);
                    Vec::new()
                }
            };

            let question_images: Vec<String> = match serde_json::from_str(&question_images_json) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("⚠️ [DEBUG] 解析 question_images JSON 失败: {}", e);
                    Vec::new()
                }
            };

            let analysis_images: Vec<String> = match serde_json::from_str(&analysis_images_json) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("⚠️ [DEBUG] 解析 analysis_images JSON 失败: {}", e);
                    Vec::new()
                }
            };

            let chat_history: Vec<DebugRawChatMessage> =
                match serde_json::from_str(&chat_history_raw) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("⚠️ [DEBUG] 解析 chat_history JSON 失败: {}", e);
                        Vec::new()
                    }
                };

            let chat_metadata_str: Option<String> = row.get(15)?;
            let chat_metadata: Option<serde_json::Value> = chat_metadata_str.and_then(|s| {
                serde_json::from_str(&s)
                    .map_err(|e| {
                        eprintln!("⚠️ [DEBUG] 解析 chat_metadata JSON 失败: {}", e);
                        e
                    })
                    .ok()
            });

            Ok(DebugRawMistakeRecord {
                id: row.get(0)?,
                created_at: row.get(1)?,
                updated_at: row.get(2)?,
                last_accessed_at: row.get(3)?,
                user_question: row.get(4)?,
                ocr_text: row.get(5)?,
                ocr_note: row.get(6)?,
                tags,
                mistake_type: row.get(8)?,
                status: row.get(9)?,
                chat_category: row.get(10)?,
                question_images,
                analysis_images,
                mistake_summary: row.get(13)?,
                user_error_analysis: row.get(14)?,
                chat_metadata,
                chat_history_raw_json: chat_history_raw,
                chat_history,
            })
        })
        .map_err(|e| AppError::database(format!("批量查询失败: {}", e)))?;

    let mut results = Vec::new();
    for row_result in rows {
        match row_result {
            Ok(record) => results.push(record),
            Err(e) => {
                eprintln!("⚠️ [DEBUG] 处理批量查询结果失败: {}", e);
            }
        }
    }

    println!(
        "🔍 [DEBUG] 批量读取完成: 成功 {}/{} 条记录",
        results.len(),
        ids.len()
    );

    Ok(results)
}

/// 调试专用：获取数据库统计信息
#[tauri::command]
pub async fn debug_get_database_stats(
    state: State<'_, AppState>,
) -> Result<DebugDatabaseStats, AppError> {
    println!("📊 [DEBUG] 收集数据库统计信息");

    let conn = state
        .database
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

    // 总错题数
    let total_mistakes: usize = conn
        .query_row("SELECT COUNT(*) FROM mistakes", [], |row| row.get(0))
        .unwrap_or(0);

    // 有聊天记录的错题数
    let mistakes_with_chat: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM mistakes WHERE json_array_length(chat_history) > 0",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // 统计所有消息
    let mut total_messages = 0;
    let mut messages_with_images = 0;
    let mut messages_with_thinking = 0;
    let mut messages_with_rag_sources = 0;
    let mut messages_with_memory_sources = 0;
    let mut messages_with_web_sources = 0;
    let mut messages_with_persistent_id = 0;

    let mut stmt = conn
        .prepare("SELECT chat_history FROM mistakes WHERE json_array_length(chat_history) > 0")
        .map_err(|e| AppError::database(format!("准备查询失败: {}", e)))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::database(format!("查询失败: {}", e)))?;

    for row_result in rows {
        if let Ok(chat_history_str) = row_result {
            if let Ok(messages) =
                serde_json::from_str::<Vec<DebugRawChatMessage>>(&chat_history_str)
            {
                total_messages += messages.len();

                for msg in messages {
                    if msg.image_base64.as_ref().map_or(false, |v| !v.is_empty())
                        || msg.image_paths.as_ref().map_or(false, |v| !v.is_empty())
                    {
                        messages_with_images += 1;
                    }
                    if msg.thinking_content.is_some() {
                        messages_with_thinking += 1;
                    }
                    if msg.rag_sources.is_some() {
                        messages_with_rag_sources += 1;
                    }
                    if msg.memory_sources.is_some() {
                        messages_with_memory_sources += 1;
                    }
                    if msg.web_search_sources.is_some() {
                        messages_with_web_sources += 1;
                    }
                    if msg.persistent_stable_id.is_some() {
                        messages_with_persistent_id += 1;
                    }
                }
            }
        }
    }

    Ok(DebugDatabaseStats {
        total_mistakes,
        mistakes_with_chat,
        total_messages,
        messages_with_images,
        messages_with_thinking,
        messages_with_rag_sources,
        messages_with_memory_sources,
        messages_with_web_sources,
        messages_with_persistent_id,
    })
}

/// 调试专用：验证特定错题的数据完整性
#[tauri::command]
pub async fn debug_verify_mistake_integrity(
    id: String,
    state: State<'_, AppState>,
) -> Result<DebugIntegrityReport, AppError> {
    println!("🔬 [DEBUG] 验证错题数据完整性: {}", id);

    let raw = debug_get_raw_mistake(id.clone(), state.clone())
        .await?
        .ok_or_else(|| AppError::not_found(format!("错题不存在: {}", id)))?;

    let mut issues = Vec::new();
    let mut warnings = Vec::new();

    // 检查1: chat_history JSON 是否可解析
    if raw.chat_history_raw_json.is_empty() {
        warnings.push("chat_history 为空数组".to_string());
    } else if raw.chat_history.is_empty() {
        issues.push("chat_history JSON 解析失败或为空".to_string());
    }

    // 检查2: 每条消息的字段完整性
    for (idx, msg) in raw.chat_history.iter().enumerate() {
        // P2 新增：role 有效性检查
        if !["user", "assistant", "system", "tool"].contains(&msg.role.as_str()) {
            issues.push(format!("消息 #{} 的 role 无效: {}", idx, msg.role));
        }

        if msg.content.is_empty() && msg.tool_call.is_none() {
            warnings.push(format!("消息 #{} 的 content 为空且无工具调用", idx));
        }

        // P2 新增：content 类型验证（检查是否为有效的 JSON 数组）
        if msg.content.starts_with('[') {
            match serde_json::from_str::<Vec<serde_json::Value>>(&msg.content) {
                Ok(parts) => {
                    for (part_idx, part) in parts.iter().enumerate() {
                        let part_type = part.get("type").and_then(|t| t.as_str());
                        if !matches!(part_type, Some("text") | Some("image_url")) {
                            warnings.push(format!(
                                "消息 #{} 的 content part[{}] 类型无效: {:?}",
                                idx, part_idx, part_type
                            ));
                        }
                    }
                }
                Err(_) => {
                    warnings.push(format!("消息 #{} 的 content 像是数组但解析失败", idx));
                }
            }
        }

        // 检查图片字段的一致性
        let has_image_base64 = msg.image_base64.as_ref().map_or(false, |v| !v.is_empty());
        let has_image_paths = msg.image_paths.as_ref().map_or(false, |v| !v.is_empty());

        if has_image_base64 || has_image_paths {
            // 检查 content 是否包含 image_url
            if !msg.content.contains("image_url") {
                warnings.push(format!(
                    "消息 #{} 有图片字段但 content 中无 image_url 引用",
                    idx
                ));
            }
        }

        // 检查 persistent_stable_id 的唯一性
        if let Some(stable_id) = &msg.persistent_stable_id {
            let duplicates = raw
                .chat_history
                .iter()
                .filter(|m| m.persistent_stable_id.as_ref() == Some(stable_id))
                .count();

            if duplicates > 1 {
                issues.push(format!(
                    "消息 #{} 的 persistent_stable_id 重复 ({} 次): {}",
                    idx, duplicates, stable_id
                ));
            }
        }
    }

    // 检查3: 时间戳顺序
    let mut prev_timestamp: Option<String> = None;
    for (idx, msg) in raw.chat_history.iter().enumerate() {
        if let Some(prev) = &prev_timestamp {
            if msg.timestamp < *prev {
                warnings.push(format!("消息 #{} 的时间戳早于前一条消息", idx));
            }
        }
        prev_timestamp = Some(msg.timestamp.clone());
    }

    // 检查4: textbook_pages 字段一致性（P0 新增）
    for (idx, msg) in raw.chat_history.iter().enumerate() {
        if let Some(textbook_pages) = &msg.textbook_pages {
            if !textbook_pages.is_null() {
                // 检查 content 是否引用了教材页
                if msg.role == "user" && !msg.content.contains("image_url") {
                    warnings.push(format!(
                        "消息 #{} 有 textbook_pages 但 content 中无 image_url 引用",
                        idx
                    ));
                }
            }
        }
    }

    // 检查5: _meta 字段泄漏检查（P0 新增）
    for (idx, msg) in raw.chat_history.iter().enumerate() {
        if let Some(meta) = &msg.meta {
            if !meta.is_null() {
                // _meta 不应该持久化到数据库，如果存在说明有清理问题
                issues.push(format!(
                    "消息 #{} 包含 _meta 字段，这不应该被持久化到数据库",
                    idx
                ));
            }
        }
    }

    // 检查6: 工具调用配对检查（P2 新增）
    let mut tool_call_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tool_result_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (idx, msg) in raw.chat_history.iter().enumerate() {
        if let Some(tool_call) = &msg.tool_call {
            if let Some(id) = tool_call.get("id").and_then(|v| v.as_str()) {
                tool_call_ids.insert(id.to_string());
            } else {
                warnings.push(format!("消息 #{} 的 tool_call 缺少 id 字段", idx));
            }
        }

        if let Some(tool_result) = &msg.tool_result {
            if let Some(call_id) = tool_result.get("call_id").and_then(|v| v.as_str()) {
                tool_result_ids.insert(call_id.to_string());

                // 检查对应的 tool_call 是否存在
                if !tool_call_ids.contains(call_id) {
                    warnings.push(format!(
                        "消息 #{} 的 tool_result 引用了不存在的 tool_call: {}",
                        idx, call_id
                    ));
                }
            } else {
                warnings.push(format!("消息 #{} 的 tool_result 缺少 call_id 字段", idx));
            }
        }
    }

    // 检查是否有未配对的 tool_call
    for call_id in tool_call_ids.iter() {
        if !tool_result_ids.contains(call_id) {
            warnings.push(format!(
                "发现未配对的 tool_call (id: {})，缺少对应的 tool_result",
                call_id
            ));
        }
    }

    let is_valid = issues.is_empty();
    let summary = if is_valid {
        if warnings.is_empty() {
            "✅ 数据完整性验证通过，无问题".to_string()
        } else {
            format!("⚠️ 数据完整性验证通过，但有 {} 个警告", warnings.len())
        }
    } else {
        format!("❌ 数据完整性验证失败，发现 {} 个问题", issues.len())
    };

    Ok(DebugIntegrityReport {
        mistake_id: id,
        is_valid,
        message_count: raw.chat_history.len(),
        issues,
        warnings,
        summary,
    })
}

/// 数据完整性报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugIntegrityReport {
    pub mistake_id: String,
    pub is_valid: bool,
    pub message_count: usize,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: String,
}

/// 记录前端调试消息
#[tauri::command]
pub async fn log_debug_message(message: String) -> Result<(), String> {
    use tracing::info;
    info!(target: "frontend_debug", "{}", message);
    println!("🔍 [FRONTEND] {}", message);
    Ok(())
}

/// VFS 迁移诊断报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VfsMigrationDiagnostic {
    /// 记录的最高版本号
    pub recorded_version: u32,
    /// 预期版本号
    pub expected_version: u32,
    /// 迁移历史记录
    pub migration_history: Vec<MigrationRecord>,
    /// resources 表的列信息
    pub resources_columns: Vec<String>,
    /// 缺失的索引状态列
    pub missing_index_columns: Vec<String>,
    /// vfs_index_units 表是否存在（统一索引架构）
    pub vfs_index_units_exists: bool,
    /// vfs_index_segments 表是否存在
    pub vfs_index_segments_exists: bool,
    /// vfs_indexing_config 表是否存在
    pub vfs_indexing_config_exists: bool,
    /// 诊断结论
    pub diagnosis: String,
    /// 建议的修复操作
    pub suggested_fix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationRecord {
    pub version: u32,
    pub name: String,
    pub applied_at: String,
    pub success: bool,
}

/// 诊断 VFS 迁移状态
#[tauri::command]
pub async fn debug_vfs_migration_status(
    vfs_db: State<'_, std::sync::Arc<crate::vfs::database::VfsDatabase>>,
) -> Result<VfsMigrationDiagnostic, String> {
    use tracing::info;

    info!("[DEBUG] Diagnosing VFS migration status...");

    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    // 1. 获取记录的版本号（从 Refinery 表读取）
    let recorded_version: u32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // 2. 获取迁移历史（从 Refinery 表读取）
    let mut stmt = conn.prepare(
        "SELECT version, name, applied_on, 1 as success FROM refinery_schema_history ORDER BY version"
    ).map_err(|e| e.to_string())?;

    let migration_history: Vec<MigrationRecord> = stmt
        .query_map([], |row| {
            Ok(MigrationRecord {
                version: row.get(0)?,
                name: row.get(1)?,
                applied_at: row.get(2)?,
                success: row.get::<_, i32>(3)? == 1,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(log_and_skip_err)
        .collect();

    // 3. 获取 resources 表的列
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('resources')")
        .map_err(|e| e.to_string())?;

    let resources_columns: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(log_and_skip_err)
        .collect();

    // 4. 检查索引状态相关列
    let index_columns = vec![
        "index_state",
        "index_hash",
        "index_error",
        "indexed_at",
        "index_retry_count",
    ];
    let missing_index_columns: Vec<String> = index_columns
        .iter()
        .filter(|col| !resources_columns.iter().any(|c| c == *col))
        .map(|s| s.to_string())
        .collect();

    // 5. 检查 vfs_index_units 表（统一索引架构）
    let vfs_index_units_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_units'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    // 5.1 检查 vfs_index_segments 表
    let vfs_index_segments_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_segments'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    // 6. 检查 vfs_indexing_config 表
    let vfs_indexing_config_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_indexing_config'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    // 7. 生成诊断结论
    let expected_version = 18u32; // CURRENT_SCHEMA_VERSION

    let (diagnosis, suggested_fix) = if recorded_version < expected_version {
        (
            format!(
                "迁移未完成：记录版本 {} < 预期版本 {}",
                recorded_version, expected_version
            ),
            "迁移器应该会自动执行待应用的迁移，请检查启动日志".to_string(),
        )
    } else if !missing_index_columns.is_empty() {
        (
            format!(
                "版本号正确但列缺失：迁移 {} 已记录但 resources 表缺少列 {:?}",
                recorded_version, missing_index_columns
            ),
            "迁移记录存在但实际列未添加，需要删除迁移记录并重新执行".to_string(),
        )
    } else if !vfs_index_units_exists || !vfs_index_segments_exists || !vfs_indexing_config_exists {
        (
            format!(
                "版本号正确但表缺失：vfs_index_units={}, vfs_index_segments={}, vfs_indexing_config={}",
                vfs_index_units_exists, vfs_index_segments_exists, vfs_indexing_config_exists
            ),
            "迁移记录存在但实际表未创建，需要删除迁移记录并重新执行".to_string()
        )
    } else {
        ("迁移状态正常".to_string(), "无需修复".to_string())
    };

    let result = VfsMigrationDiagnostic {
        recorded_version,
        expected_version,
        migration_history,
        resources_columns,
        missing_index_columns,
        vfs_index_units_exists,
        vfs_index_segments_exists,
        vfs_indexing_config_exists,
        diagnosis,
        suggested_fix,
    };

    info!("[DEBUG] VFS migration diagnosis: {:?}", result);
    println!(
        "🔍 [VFS MIGRATION DIAGNOSTIC]\n{}",
        serde_json::to_string_pretty(&result).unwrap_or_default()
    );

    Ok(result)
}

/// 调试专用：查询教材的页面数据状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugTextbookPageInfo {
    pub textbook_id: String,
    pub resource_id: Option<String>,
    pub file_name: Option<String>,
    pub page_count: Option<i32>,
    pub has_ocr_pages_json: bool,
    pub ocr_pages_json_len: Option<usize>,
    pub has_extracted_text: bool,
    pub extracted_text_len: Option<usize>,
}

#[tauri::command]
pub async fn debug_vfs_textbook_pages(
    state: State<'_, AppState>,
) -> Result<Vec<DebugTextbookPageInfo>, AppError> {
    // 使用 VFS 数据库（textbooks 表在 VFS 数据库中）
    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::database("VFS 数据库未初始化"))?;
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|e| AppError::database(format!("获取 VFS 数据库连接失败: {}", e)))?;

    let mut stmt = conn.prepare(
        "SELECT id, resource_id, file_name, page_count, ocr_pages_json, extracted_text FROM files"
    ).map_err(|e| AppError::database(format!("准备查询失败: {}", e)))?;

    let results: Vec<DebugTextbookPageInfo> = stmt
        .query_map([], |row| {
            let ocr_pages_json: Option<String> = row.get(4)?;
            let extracted_text: Option<String> = row.get(5)?;
            Ok(DebugTextbookPageInfo {
                textbook_id: row.get(0)?,
                resource_id: row.get(1)?,
                file_name: row.get(2)?,
                page_count: row.get(3)?,
                has_ocr_pages_json: ocr_pages_json.is_some(),
                ocr_pages_json_len: ocr_pages_json.as_ref().map(|s| s.len()),
                has_extracted_text: extracted_text.is_some(),
                extracted_text_len: extracted_text.as_ref().map(|s| s.len()),
            })
        })
        .map_err(|e| AppError::database(format!("查询失败: {}", e)))?
        .filter_map(log_and_skip_err)
        .collect();

    // 打印到控制台
    println!("\n📚 [DEBUG] Textbook Page Info:");
    for tb in &results {
        println!(
            "  - {} (res={}): page_count={:?}, ocr_pages_json={}, extracted_text={}",
            tb.textbook_id,
            tb.resource_id.as_deref().unwrap_or("(none)"),
            tb.page_count,
            if tb.has_ocr_pages_json {
                format!("{}chars", tb.ocr_pages_json_len.unwrap_or(0))
            } else {
                "null".to_string()
            },
            if tb.has_extracted_text {
                format!("{}chars", tb.extracted_text_len.unwrap_or(0))
            } else {
                "null".to_string()
            },
        );
    }

    Ok(results)
}
