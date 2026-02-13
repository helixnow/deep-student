//! Chat V2 数据迁移 Tauri 命令

use std::sync::Arc;

use tauri::{State, Window};

use crate::chat_v2::migration::{
    check_migration_status, migrate_legacy_chat, rollback_migration, MigrationCheckResult,
    MigrationReport,
};
use crate::chat_v2::ChatV2Database;
use crate::database::Database;

/// 检查迁移状态
///
/// 返回是否需要迁移、待迁移消息数等信息
#[tauri::command]
pub async fn chat_v2_check_migration_status(
    database: State<'_, Arc<Database>>,
    chat_v2_db: State<'_, Arc<ChatV2Database>>,
) -> Result<MigrationCheckResult, String> {
    let data_conn = database.get_conn_safe().map_err(|e| e.to_string())?;
    let chat_v2_conn = chat_v2_db.get_conn_safe().map_err(|e| e.to_string())?;

    check_migration_status(&data_conn, &chat_v2_conn).map_err(|e| e.to_string())
}

/// 执行迁移
///
/// 将旧版 chat_messages 迁移到 Chat V2
/// 迁移过程中会通过 `chat_v2_migration` 事件通道发送进度
#[tauri::command]
pub async fn chat_v2_migrate_legacy_chat(
    window: Window,
    database: State<'_, Arc<Database>>,
    chat_v2_db: State<'_, Arc<ChatV2Database>>,
) -> Result<MigrationReport, String> {
    let data_conn = database.get_conn_safe().map_err(|e| e.to_string())?;
    let chat_v2_conn = chat_v2_db.get_conn_safe().map_err(|e| e.to_string())?;

    migrate_legacy_chat(&data_conn, &chat_v2_conn, Some(window)).map_err(|e| e.to_string())
}

/// 回滚迁移
///
/// 删除 Chat V2 中迁移的会话，重置旧表的迁移标记
#[tauri::command]
pub async fn chat_v2_rollback_migration(
    window: Window,
    database: State<'_, Arc<Database>>,
    chat_v2_db: State<'_, Arc<ChatV2Database>>,
) -> Result<MigrationReport, String> {
    let data_conn = database.get_conn_safe().map_err(|e| e.to_string())?;
    let chat_v2_conn = chat_v2_db.get_conn_safe().map_err(|e| e.to_string())?;

    rollback_migration(&data_conn, &chat_v2_conn, Some(window)).map_err(|e| e.to_string())
}
