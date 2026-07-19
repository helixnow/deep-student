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
    let total_mistakes = conn
        .query_row("SELECT COUNT(*) FROM mistakes", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize;

    // 有聊天记录的错题数
    let mistakes_with_chat = conn
        .query_row(
            "SELECT COUNT(*) FROM mistakes WHERE json_array_length(chat_history) > 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

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

    for chat_history_str in rows.flatten() {
        if let Ok(messages) = serde_json::from_str::<Vec<DebugRawChatMessage>>(&chat_history_str) {
            total_messages += messages.len();

            for msg in messages {
                if msg.image_base64.as_ref().is_some_and(|v| !v.is_empty())
                    || msg.image_paths.as_ref().is_some_and(|v| !v.is_empty())
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

/// 记录前端调试消息
#[tauri::command]
pub async fn log_debug_message(message: String) -> Result<(), String> {
    use tracing::info;
    info!(target: "frontend_debug", "{}", message);
    println!("🔍 [FRONTEND] {}", message);
    Ok(())
}

/// tauri-lab 专用前端日志桥。普通运行时没有 TAURI_LAB_* 环境变量会直接 no-op。
#[tauri::command]
pub async fn tauri_lab_frontend_log(
    level: String,
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use tracing::{debug, error, info, warn};

    let instance_id = std::env::var("TAURI_LAB_INSTANCE_ID").ok();
    let log_path = std::env::var("TAURI_LAB_FRONTEND_LOG").ok();
    if instance_id.is_none() && log_path.is_none() {
        return Ok(());
    }

    let entry = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "instance_id": instance_id,
        "level": level,
        "message": message,
        "stack": stack,
    });
    let line = format!("{}\n", entry);

    if let Some(path) = log_path {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }

    match level.as_str() {
        "error" => error!(target: "tauri_lab_frontend", "{}", message),
        "warn" => warn!(target: "tauri_lab_frontend", "{}", message),
        "info" => info!(target: "tauri_lab_frontend", "{}", message),
        _ => debug!(target: "tauri_lab_frontend", "{}", message),
    }

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
    let index_columns = [
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
