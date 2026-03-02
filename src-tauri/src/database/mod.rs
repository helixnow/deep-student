mod manager;

pub use manager::DatabaseManager;

use crate::models::{
    AnkiCard, AnkiLibraryCard, CreateSubLibraryRequest, DocumentTask, ExamSheetPreviewResult,
    ExamSheetSessionDetail, ExamSheetSessionMetadata, ExamSheetSessionSummary, StreamContext,
    SubLibrary, TaskStatus, TempStreamState, UpdateSubLibraryRequest,
};
use crate::secure_store::{SecureStore, SecureStoreConfig};
use anyhow::{Context, Result};
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, types::Value, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

fn parse_datetime_flexible(datetime_str: &str) -> Result<DateTime<Utc>> {
    if datetime_str.is_empty() {
        return Ok(Utc::now());
    }

    if let Ok(naive_dt) = NaiveDateTime::parse_from_str(datetime_str, "%Y-%m-%d %H:%M:%S") {
        return Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive_dt, Utc));
    }

    if let Ok(dt) = DateTime::parse_from_rfc3339(datetime_str) {
        return Ok(dt.with_timezone(&Utc));
    }

    Err(anyhow::anyhow!(
        "Failed to parse datetime from '{}'",
        datetime_str
    ))
}

pub(crate) fn ensure_chat_messages_extended_columns(conn: &Connection) -> Result<()> {
    let mut existing = HashSet::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info('chat_messages')")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            existing.insert(name);
        }
    }

    let required_columns: [(&str, &str); 13] = [
        ("rag_sources", "TEXT"),
        ("memory_sources", "TEXT"),
        ("graph_sources", "TEXT"),
        ("web_search_sources", "TEXT"),
        ("image_paths", "TEXT"),
        ("image_base64", "TEXT"),
        ("doc_attachments", "TEXT"),
        ("tool_call", "TEXT"),
        ("tool_result", "TEXT"),
        ("overrides", "TEXT"),
        ("relations", "TEXT"),
        ("stable_id", "TEXT"),
        ("metadata", "TEXT"),
    ];

    for (name, ty) in required_columns.iter() {
        if !existing.contains(*name) {
            let sql = format!("ALTER TABLE chat_messages ADD COLUMN {} {}", name, ty);
            conn.execute(&sql, [])?;
        }
    }

    Ok(())
}

// Re-export for external use
// pub use std::sync::MutexGuard; // Removed unused import

/// 旧迁移系统的当前数据库版本号。
///
/// # ⚠️ 废弃通知 — 旧迁移系统
///
/// 此常量是旧版顺序迁移系统（`DatabaseManager::handle_migration`）的一部分，
/// 通过递增版本号执行 `migrate_to_version(N)` 来变更 schema。
///
/// ## 新系统
/// 新的 schema 变更应通过 **数据治理系统** 的 Refinery 迁移脚本实现：
/// - 迁移协调器：`data_governance/migration/coordinator.rs`
/// - 迁移脚本目录：`migrations/{vfs,chat_v2,mistakes,llm_usage}/`
/// - 版本格式：`V{YYYYMMDD}__{description}.sql`（如 `V20260130__init.sql`）
///
/// ## 过渡期说明
/// - **禁止**再递增此版本号添加新迁移
/// - 旧迁移逻辑（`handle_migration`、`ensure_compatibility`、`ensure_post_migration_patches`）
///   仅为兼容尚未升级的用户保留
/// - 当所有用户均已升级到包含 Refinery 迁移的版本后，旧系统将被移除
///
/// ## 不冲突的保障
/// 旧系统操作**主数据库**的 `schema_version` 表，
/// 新系统使用独立的 `refinery_schema_history` 表，两者互不干扰。
pub(crate) const CURRENT_DB_VERSION: u32 = 41;

// 新的类型别名
pub type SqlitePool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
pub type SqlitePooledConnection = r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>;

pub struct Database {
    conn: Mutex<Connection>,
    db_path: RwLock<PathBuf>,
    secure_store: Option<SecureStore>,
    /// 维护模式标志：当备份/恢复等数据治理操作进行时设为 true，
    /// 用于阻止同步命令等并发操作绕过维护模式直接访问数据库文件。
    maintenance_mode: std::sync::atomic::AtomicBool,
}

#[derive(Debug, Clone)]
pub struct AppendMessagesChangeSet {
    pub updated_user_message_ids: Vec<i64>,
    pub inserted_user_message_ids: Vec<i64>,
    pub assistant_message_count: usize,
    pub tool_message_count: usize,
    pub other_message_count: usize,
    pub missing_stable_id_count: usize,
    pub total_processed: usize, // 所有处理的消息数（包含无变更跳过的）
}

// 简化：只保留 stable_id -> message_id 的映射
// 消息一旦创建就不变，不需要存储完整快照来比较
type ExistingMessageMap = std::collections::HashMap<String, i64>;

fn build_existing_message_map(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, i64)> {
    let id: i64 = row.get(0)?;
    let stable_id: String = row.get(1)?;
    Ok((stable_id, id))
}

fn parse_image_list(raw_json: Option<String>) -> Option<Vec<String>> {
    raw_json.and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
}

fn canonicalize_doc_attachments_summary(raw_json: Option<String>) -> Option<String> {
    let docs: Vec<crate::models::DocumentAttachment> = raw_json
        .as_ref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    if docs.is_empty() {
        return None;
    }
    let mut entries: Vec<String> = docs
        .iter()
        .map(|att| {
            let mut payload_hasher = Sha256::new();
            if let Some(text) = &att.text_content {
                payload_hasher.update(text.as_bytes());
            }
            if let Some(b64) = &att.base64_content {
                payload_hasher.update(b64.as_bytes());
            }
            let digest = format!("{:x}", payload_hasher.finalize());
            format!(
                "{}|{}|{}|{}",
                att.name.trim(),
                att.mime_type.trim(),
                att.size_bytes,
                digest
            )
        })
        .collect();
    if entries.is_empty() {
        None
    } else {
        entries.sort();
        Some(entries.join(";"))
    }
}

fn fingerprint_user_row(content: &str, images: Option<&[String]>, doc_fp: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"user");
    hasher.update(content.as_bytes());
    if let Some(list) = images {
        for img in list {
            hasher.update(img.as_bytes());
        }
    }
    if let Some(doc) = doc_fp {
        hasher.update(doc.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone)]
pub struct UserMessageSummary {
    pub stable_id: Option<String>,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct ChatHistorySummary {
    pub assistant_count: usize,
    pub user_messages: Vec<UserMessageSummary>,
}

impl Database {
    fn backfill_turn_metadata(
        &self,
        tx: &rusqlite::Transaction<'_>,
        mistake_id: &str,
    ) -> Result<()> {
        // 第一步：为所有未配对的 user 分配 turn_id（若缺失）
        let mut users_stmt = tx.prepare(
            "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND role = 'user' AND (turn_id IS NULL OR turn_id = '') ORDER BY timestamp ASC",
        )?;
        let user_rows = users_stmt
            .query_map(rusqlite::params![mistake_id], |row| {
                Ok(row.get::<_, i64>(0)?)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for user_row_id in user_rows {
            let turn_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "UPDATE chat_messages SET turn_id = ?1, turn_seq = 0, reply_to_msg_id = NULL, message_kind = COALESCE(message_kind, 'user.input'), lifecycle = NULL WHERE id = ?2",
                rusqlite::params![turn_id, user_row_id],
            )?;
        }

        // 第二步：为所有未配对的 assistant 绑定到最近的用户回合
        let mut assistants_stmt = tx.prepare(
            "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND role = 'assistant' AND (turn_id IS NULL OR turn_id = '') ORDER BY timestamp ASC",
        )?;
        let assistant_rows = assistants_stmt
            .query_map(rusqlite::params![mistake_id], |row| {
                Ok(row.get::<_, i64>(0)?)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for assistant_row_id in assistant_rows {
            let candidate: Option<(i64, String)> = tx
                .query_row(
                    "SELECT u.id, u.turn_id \
                     FROM chat_messages u \
                     WHERE u.mistake_id = ?1 AND u.role = 'user' AND u.turn_id IS NOT NULL AND u.turn_id <> '' \
                       AND NOT EXISTS (SELECT 1 FROM chat_messages a WHERE a.mistake_id = ?1 AND a.role = 'assistant' AND a.turn_id = u.turn_id) \
                     ORDER BY u.timestamp DESC LIMIT 1",
                    rusqlite::params![mistake_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((user_row_id, turn_id)) = candidate {
                tx.execute(
                    "UPDATE chat_messages SET turn_id = ?1, turn_seq = 1, reply_to_msg_id = ?2, message_kind = COALESCE(message_kind, 'assistant.answer'), lifecycle = COALESCE(lifecycle, 'complete') WHERE id = ?3",
                    rusqlite::params![turn_id, user_row_id, assistant_row_id],
                )?;
            } else {
                log::warn!(
                    "[回合配对] 发现孤儿助手消息（无可配对的用户消息），mistake_id={}, assistant_row_id={}",
                    mistake_id, assistant_row_id
                );
            }
        }

        Ok(())
    }
    // 这些方法已被弃用，请使用DatabaseManager，但为兼容保留

    /// 安全获取数据库连接的辅助方法
    /// 如果 Mutex 被中毒（由于 panic），会恢复并返回连接
    pub fn get_conn_safe(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        match self.conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                log::error!(
                    "[Database] Mutex poisoned! Attempting recovery with transaction rollback"
                );
                self.log_mutex_poison_once();
                let guard = poisoned.into_inner();
                // Attempt to rollback any partial transaction left by the panicking thread
                let _ = guard.execute("ROLLBACK", []);
                Ok(guard)
            }
        }
    }

    fn log_mutex_poison_once(&self) {
        use std::sync::atomic::{AtomicBool, Ordering};

        static HAS_WARNED: AtomicBool = AtomicBool::new(false);
        if !HAS_WARNED.swap(true, Ordering::SeqCst) {
            log::warn!("数据库 Mutex 被中毒，正在恢复...");
        }
    }

    /// Get a reference to the underlying connection for batch operations
    pub fn conn(&self) -> &Mutex<Connection> {
        &self.conn
    }

    /// 获取底层 SQLite 路径（用于派生 LanceDB 目录）
    pub fn db_path(&self) -> Option<std::path::PathBuf> {
        self.db_path.read().ok().map(|path| path.clone())
    }

    /// 进入维护模式：将底层连接切换为内存数据库，从而释放对磁盘文件的占用
    /// 用于导入/恢复流程中替换实际数据库文件，避免 Windows 上文件映射锁
    pub fn enter_maintenance_mode(&self) -> Result<()> {
        // 先尝试做一次 checkpoint 以合并 WAL（若存在）
        if let Ok(guard) = self.get_conn_safe() {
            let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        // 将连接替换为内存数据库，释放文件句柄
        let mut guard = self.get_conn_safe()?;
        let mem_conn = Connection::open_in_memory().with_context(|| "创建内存数据库连接失败")?;
        // 用内存连接替换原连接，旧连接在离开作用域时被丢弃（关闭）
        *guard = mem_conn;
        // 设置维护模式标志
        self.maintenance_mode
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// 退出维护模式：重新打开磁盘数据库文件
    /// 注意：导入完成后通常会重启应用；该方法提供在无需重启时的恢复手段
    pub fn exit_maintenance_mode(&self) -> Result<()> {
        let mut guard = self.get_conn_safe()?;
        let path = {
            self.db_path
                .read()
                .ok()
                .map(|p| p.clone())
                .ok_or_else(|| anyhow::anyhow!("无法读取数据库路径"))?
        };
        let new_conn = Connection::open(&path)
            .with_context(|| format!("重新打开数据库连接失败: {:?}", path))?;
        // 恢复基础 PRAGMA
        new_conn.pragma_update(None, "journal_mode", &"WAL")?;
        new_conn.pragma_update(None, "synchronous", &"NORMAL")?;
        // 🔒 审计修复: 恢复外键约束（SQLite 每次新连接默认关闭，必须显式启用）
        new_conn.pragma_update(None, "foreign_keys", &"ON")?;
        new_conn.pragma_update(None, "busy_timeout", &3000i64)?;
        *guard = new_conn;
        // 清除维护模式标志
        self.maintenance_mode
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// 检查数据库是否处于维护模式
    ///
    /// 当备份/恢复/数据迁移等数据治理操作正在进行时返回 true。
    /// 同步命令等并发操作应在开始前检查此标志，避免绕过维护模式直接操作数据库文件。
    pub fn is_in_maintenance_mode(&self) -> bool {
        self.maintenance_mode
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 切换数据库文件并重新初始化连接
    pub fn switch_to_path(&self, new_path: &Path) -> Result<()> {
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let new_conn = Connection::open(new_path)
            .with_context(|| format!("打开数据库连接失败: {:?}", new_path))?;
        new_conn.pragma_update(None, "journal_mode", &"WAL")?;
        new_conn.pragma_update(None, "synchronous", &"NORMAL")?;
        new_conn.pragma_update(None, "busy_timeout", &3000i64)?;

        {
            let mut guard = self.get_conn_safe()?;
            *guard = new_conn;
        }

        {
            let mut path_guard = self
                .db_path
                .write()
                .map_err(|_| anyhow::anyhow!("获取数据库路径写锁失败"))?;
            *path_guard = new_path.to_path_buf();
        }

        Ok(())
    }

    /// 插入或更新题目集识别会话
    pub fn upsert_exam_sheet_session(&self, detail: &ExamSheetSessionDetail) -> Result<()> {
        let conn = self.get_conn_safe()?;

        let metadata_json = serde_json::to_string(&detail.summary.metadata)
            .map_err(|e| anyhow::anyhow!("序列化 exam_sheet metadata 失败: {}", e))?;
        let preview_json = serde_json::to_string(&detail.preview)
            .map_err(|e| anyhow::anyhow!("序列化 exam_sheet preview 失败: {}", e))?;
        let linked_ids_json = if let Some(ids) = &detail.summary.linked_mistake_ids {
            Some(
                serde_json::to_string(ids)
                    .map_err(|e| anyhow::anyhow!("序列化 linked_mistake_ids 失败: {}", e))?,
            )
        } else {
            None
        };

        conn.execute(
            "INSERT OR REPLACE INTO exam_sheet_sessions
                (id, exam_name, created_at, updated_at, temp_id, status, metadata_json, preview_json, linked_mistake_ids)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                detail.summary.id,
                detail.summary.exam_name,
                detail.summary.created_at.to_rfc3339(),
                detail.summary.updated_at.to_rfc3339(),
                detail.summary.temp_id,
                detail.summary.status,
                metadata_json,
                preview_json,
                linked_ids_json,
            ],
        )?;

        Ok(())
    }

    /// 查询题目集识别会话列表
    pub fn list_exam_sheet_sessions(&self, limit: usize) -> Result<Vec<ExamSheetSessionSummary>> {
        let conn = self.get_conn_safe()?;

        let sql = "SELECT id, exam_name, created_at, updated_at, temp_id, status, metadata_json, linked_mistake_ids
             FROM exam_sheet_sessions ORDER BY datetime(created_at) DESC LIMIT ?";

        let mut stmt = conn.prepare(sql)?;

        let mut summaries = Vec::new();
        let rows = stmt.query_map(params![limit as i64], |row| {
            self.map_exam_sheet_summary(row)
        })?;
        for row in rows {
            summaries.push(row?);
        }

        Ok(summaries)
    }

    /// 获取题目集识别会话详情
    pub fn get_exam_sheet_session(
        &self,
        session_id: &str,
    ) -> Result<Option<ExamSheetSessionDetail>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, exam_name, created_at, updated_at, temp_id, status, metadata_json, preview_json
             FROM exam_sheet_sessions WHERE id = ?1",
        )?;

        let detail = stmt
            .query_row(params![session_id], |row| {
                let summary = self.map_exam_sheet_summary(row)?;
                let preview_json: String = row.get(7)?;
                let preview: ExamSheetPreviewResult =
                    serde_json::from_str(&preview_json).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            preview_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                Ok(ExamSheetSessionDetail { summary, preview })
            })
            .optional()?;

        Ok(detail)
    }

    fn fetch_link_state(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
    ) -> Result<(ExamSheetSessionMetadata, Vec<String>)> {
        let existing_meta: Option<(Option<String>, Option<String>)> = conn
            .prepare(
                "SELECT metadata_json, linked_mistake_ids FROM exam_sheet_sessions WHERE id = ?1",
            )?
            .query_row(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;

        let (metadata_raw, linked_raw) = existing_meta.unwrap_or((None, None));
        let metadata: ExamSheetSessionMetadata = metadata_raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let existing_ids: Vec<String> = linked_raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();

        Ok((metadata, existing_ids))
    }

    fn compute_merged_link_state(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
        new_linked: Option<&[String]>,
    ) -> Result<(ExamSheetSessionMetadata, Vec<String>)> {
        let (metadata, existing_ids) = self.fetch_link_state(conn, session_id)?;
        if let Some(ids) = new_linked {
            let mut uniq: std::collections::BTreeSet<String> = existing_ids.into_iter().collect();
            uniq.extend(ids.iter().cloned());
            Ok((metadata, uniq.into_iter().collect()))
        } else {
            Ok((metadata, existing_ids))
        }
    }

    /// 更新题目集识别会话状态与关联错题
    pub fn update_exam_sheet_session_status(
        &self,
        session_id: &str,
        status: &str,
        linked_mistake_ids: Option<&[String]>,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;

        let now = Utc::now().to_rfc3339();

        if let Some(ids) = linked_mistake_ids {
            let (mut metadata, merged_ids) =
                self.compute_merged_link_state(&conn, session_id, Some(ids))?;
            let mut tag_set: std::collections::BTreeSet<String> =
                metadata.tags.unwrap_or_default().into_iter().collect();
            tag_set.insert("linked".to_string());
            metadata.tags = Some(tag_set.into_iter().collect());

            let metadata_json = serde_json::to_string(&metadata)
                .map_err(|e| anyhow::anyhow!("序列化 metadata 失败: {}", e))?;
            let linked_json = serde_json::to_string(&merged_ids)
                .map_err(|e| anyhow::anyhow!("序列化 linked ids 失败: {}", e))?;

            conn.execute(
                "UPDATE exam_sheet_sessions
                 SET status = ?1, metadata_json = ?2, linked_mistake_ids = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![status, metadata_json, linked_json, now, session_id],
            )?;
        } else {
            conn.execute(
                "UPDATE exam_sheet_sessions
                 SET status = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![status, now, session_id],
            )?;
        }

        Ok(())
    }

    pub fn detach_exam_sheet_session_link(
        &self,
        session_id: &str,
        mistake_id: &str,
        card_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        // 更新 mistakes 表中的 exam_sheet 字段，移除特定错题的链接信息
        // 直接查询 exam_sheet 字段，避免调用 get_mistake_by_id 造成死锁
        let exam_sheet_json: Option<String> = conn
            .query_row(
                "SELECT exam_sheet FROM mistakes WHERE id = ?1",
                params![mistake_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(json_str) = exam_sheet_json {
            if let Some(mut link) =
                serde_json::from_str::<crate::models::MistakeExamSheetLink>(&json_str).ok()
            {
                let session_match = link.session_id.as_deref() == Some(session_id);
                let card_match = card_id
                    .map(|cid| link.card_id.as_deref() == Some(cid))
                    .unwrap_or(true);
                if session_match && card_match {
                    link.linked_mistake_id = None;
                    link.card_id = None;
                    let updated_json = serde_json::to_string(&link)
                        .map_err(|e| anyhow::anyhow!("序列化 exam_sheet 失败: {}", e))?;
                    conn.execute(
                        "UPDATE mistakes SET exam_sheet = ?1, updated_at = ?2 WHERE id = ?3",
                        params![updated_json, now, mistake_id],
                    )?;
                }
            }
        }

        // 更新 exam_sheet_sessions 的 linked_mistake_ids
        let (mut metadata, mut merged_ids) =
            self.compute_merged_link_state(&conn, session_id, None)?;
        merged_ids.retain(|id| id != mistake_id);

        if merged_ids.is_empty() {
            metadata.tags = metadata.tags.map(|mut tags| {
                tags.retain(|tag| tag != "linked");
                tags
            });
        }

        let metadata_json = serde_json::to_string(&metadata)
            .map_err(|e| anyhow::anyhow!("序列化 metadata 失败: {}", e))?;

        let linked_json = if merged_ids.is_empty() {
            Option::<String>::None
        } else {
            Some(
                serde_json::to_string(&merged_ids)
                    .map_err(|e| anyhow::anyhow!("序列化 linked ids 失败: {}", e))?,
            )
        };

        conn.execute(
            "UPDATE exam_sheet_sessions
             SET status = CASE WHEN ?2 IS NULL THEN 'prepared' ELSE status END,
                 metadata_json = ?1,
                 linked_mistake_ids = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![metadata_json, linked_json, now, session_id],
        )?;

        Ok(())
    }

    fn map_exam_sheet_summary(
        &self,
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<ExamSheetSessionSummary> {
        let metadata_json: Option<String> = row.get(6)?;
        let metadata = metadata_json.and_then(|raw| serde_json::from_str(&raw).ok());

        let linked_ids_json: Option<String> = row.get(7)?;
        let linked_ids = linked_ids_json.and_then(|raw| serde_json::from_str(&raw).ok());

        let created_at_str: String = row.get(2)?;
        let updated_at_str: String = row.get(3)?;
        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!(
                    "[Database] Failed to parse created_at '{}': {}, using epoch fallback",
                    created_at_str,
                    e
                );
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });
        let updated_at = DateTime::parse_from_rfc3339(&updated_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|e| {
                log::warn!(
                    "[Database] Failed to parse updated_at '{}': {}, using epoch fallback",
                    updated_at_str,
                    e
                );
                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
            });

        Ok(ExamSheetSessionSummary {
            id: row.get(0)?,
            exam_name: row.get(1)?,
            temp_id: row.get(4)?,
            created_at,
            updated_at,
            status: row.get(5)?,
            metadata,
            linked_mistake_ids: linked_ids,
        })
    }

    /// 创建新的数据库连接并初始化/迁移数据库
    pub fn new(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let conn = Connection::open(db_path)
            .with_context(|| format!("打开数据库连接失败: {:?}", db_path))?;

        // 初始化安全存储（使用 db_path 的父目录作为 app_data_dir，确保路径稳定）
        let secure_store_config = SecureStoreConfig::default();
        let secure_store = if let Some(app_data_dir) = db_path.parent() {
            Some(SecureStore::new_with_dir(
                secure_store_config,
                app_data_dir.to_path_buf(),
            ))
        } else {
            Some(SecureStore::new(secure_store_config))
        };

        let db = Database {
            conn: Mutex::new(conn),
            db_path: RwLock::new(db_path.to_path_buf()),
            secure_store,
            maintenance_mode: std::sync::atomic::AtomicBool::new(false),
        };
        Ok(db)
    }

    fn initialize_schema(&self) -> Result<()> {
        let conn = self.get_conn_safe()?;

        // 启用WAL模式提高并发性能
        conn.pragma_update(None, "journal_mode", &"WAL")?;
        conn.pragma_update(None, "synchronous", &"NORMAL")?;
        // 🔒 审计修复: 启用外键约束（SQLite 默认关闭，导致 FOREIGN KEY 和 ON DELETE CASCADE 不生效）
        conn.pragma_update(None, "foreign_keys", &"ON")?;

        conn.execute_batch(
            "BEGIN;
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mistake_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT,
                rag_sources TEXT,
                memory_sources TEXT,
                web_search_sources TEXT,
                image_paths TEXT,
                image_base64 TEXT,
                doc_attachments TEXT,
                tool_call TEXT,
                tool_result TEXT,
                overrides TEXT,
                relations TEXT,
                stable_id TEXT,
                FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS temp_sessions (
                temp_id TEXT PRIMARY KEY,
                session_data TEXT NOT NULL,
                stream_state TEXT NOT NULL DEFAULT 'in_progress',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS review_analyses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mistake_ids TEXT NOT NULL, -- JSON数组，关联的错题ID
                consolidated_input TEXT NOT NULL, -- 合并后的输入内容
                user_question TEXT NOT NULL,
                status TEXT NOT NULL,
                tags TEXT NOT NULL, -- JSON数组
                analysis_type TEXT NOT NULL DEFAULT 'consolidated_review',
                temp_session_data TEXT, -- 临时会话数据(JSON格式)
                session_sequence INTEGER DEFAULT 0 -- 会话序列号，用于消息排序
            );
            CREATE TABLE IF NOT EXISTS review_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT, -- 思维链内容
                rag_sources TEXT, -- RAG来源信息，JSON格式
                memory_sources TEXT, -- 智能记忆来源信息，JSON格式
                image_paths TEXT, -- 图片路径数组(JSON)
                image_base64 TEXT, -- 图片Base64数组(JSON)
                doc_attachments TEXT, -- 文档附件信息，JSON格式
                FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS document_tasks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                original_document_name TEXT NOT NULL,
                segment_index INTEGER NOT NULL,
                content_segment TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                error_message TEXT,
                anki_generation_options_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                tags_json TEXT DEFAULT '[]',
                images_json TEXT DEFAULT '[]',
                is_error_card INTEGER NOT NULL DEFAULT 0,
                error_content TEXT,
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                extra_fields_json TEXT DEFAULT '{}',
                template_id TEXT,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                text TEXT
            );
            CREATE TABLE IF NOT EXISTS document_control_states (
                document_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                pending_tasks_json TEXT NOT NULL DEFAULT '[]',
                running_tasks_json TEXT NOT NULL DEFAULT '{}',
                completed_tasks_json TEXT NOT NULL DEFAULT '[]',
                failed_tasks_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id);
            CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_document_tasks_updated_at ON document_tasks(updated_at);
            CREATE INDEX IF NOT EXISTS idx_document_tasks_document_segment ON document_tasks(document_id, segment_index);
            CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id);
            CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card);
            CREATE INDEX IF NOT EXISTS idx_anki_cards_created_at ON anki_cards(created_at);
            CREATE INDEX IF NOT EXISTS idx_anki_cards_template_id ON anki_cards(template_id);
            CREATE INDEX IF NOT EXISTS idx_anki_cards_task_order ON anki_cards(task_id, card_order_in_task, created_at);
            CREATE INDEX IF NOT EXISTS idx_document_control_states_state ON document_control_states (state);
            CREATE INDEX IF NOT EXISTS idx_document_control_states_updated_at ON document_control_states (updated_at);
            CREATE TRIGGER IF NOT EXISTS update_document_control_states_timestamp
                AFTER UPDATE ON document_control_states
                BEGIN
                    UPDATE document_control_states SET updated_at = CURRENT_TIMESTAMP WHERE document_id = NEW.document_id;
                END;
            CREATE TABLE IF NOT EXISTS migration_progress (
                category TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                last_cursor TEXT,
                total_processed INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            COMMIT;"
        )?;

        // 兼容性补丁：为 anki_cards 表补充缺失列与索引（新建库或旧结构）
        {
            // extra_fields_json / template_id（若缺失）
            let _ = conn.execute(
                "ALTER TABLE anki_cards ADD COLUMN extra_fields_json TEXT DEFAULT '{}'",
                [],
            );
            let _ = conn.execute("ALTER TABLE anki_cards ADD COLUMN template_id TEXT", []);
            // source_type / source_id（若缺失）
            let _ = conn.execute(
                "ALTER TABLE anki_cards ADD COLUMN source_type TEXT NOT NULL DEFAULT ''",
                [],
            );
            let _ = conn.execute(
                "ALTER TABLE anki_cards ADD COLUMN source_id TEXT NOT NULL DEFAULT ''",
                [],
            );
            let _ = conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_anki_cards_source ON anki_cards(source_type, source_id)",
                [],
            );

            // 🔧 Phase 1: document_tasks 增加 source_session_id 字段（用于跳转到聊天上下文）
            let _ = conn.execute(
                "ALTER TABLE document_tasks ADD COLUMN source_session_id TEXT",
                [],
            );
        }

        let _current_version: u32 = conn
            .query_row(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);

        // ============================================
        // 已废弃：旧迁移系统
        // 新系统使用 data_governance::migration
        // 保留代码供参考，待完全验证后删除
        // ============================================
        /*
        if current_version < CURRENT_DB_VERSION {
            // 外层事务：确保多段迁移的原子性；内部使用 SAVEPOINT 分段，失败可回滚到失败前一步
            conn.execute_batch("BEGIN IMMEDIATE;")?;
            let migrate_result: Result<()> = (|| {
                if current_version < 2 {
                    conn.execute_batch("SAVEPOINT sp_v2;")?;
                    if let Err(e) = self.migrate_v1_to_v2(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v2; RELEASE sp_v2;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v2;")?;
                }
                if current_version < 3 {
                    conn.execute_batch("SAVEPOINT sp_v3;")?;
                    if let Err(e) = self.migrate_v2_to_v3(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v3; RELEASE sp_v3;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v3;")?;
                }
                if current_version < 4 {
                    conn.execute_batch("SAVEPOINT sp_v4;")?;
                    if let Err(e) = self.migrate_v3_to_v4(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v4; RELEASE sp_v4;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v4;")?;
                }
                if current_version < 5 {
                    conn.execute_batch("SAVEPOINT sp_v5;")?;
                    if let Err(e) = self.migrate_v4_to_v5(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v5; RELEASE sp_v5;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v5;")?;
                }
                if current_version < 6 {
                    conn.execute_batch("SAVEPOINT sp_v6;")?;
                    if let Err(e) = self.migrate_v5_to_v6(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v6; RELEASE sp_v6;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v6;")?;
                }
                if current_version < 7 {
                    conn.execute_batch("SAVEPOINT sp_v7;")?;
                    if let Err(e) = self.migrate_v6_to_v7(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v7; RELEASE sp_v7;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v7;")?;
                }
                if current_version < 8 {
                    conn.execute_batch("SAVEPOINT sp_v8;")?;
                    if let Err(e) = self.migrate_v7_to_v8(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v8; RELEASE sp_v8;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v8;")?;
                }
                if current_version < 9 {
                    conn.execute_batch("SAVEPOINT sp_v9;")?;
                    if let Err(e) = self.migrate_v8_to_v9(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v9; RELEASE sp_v9;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v9;")?;
                }
                if current_version < 10 {
                    conn.execute_batch("SAVEPOINT sp_v10;")?;
                    if let Err(e) = self.migrate_v9_to_v10(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v10; RELEASE sp_v10;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v10;")?;
                }
                if current_version < 11 {
                    conn.execute_batch("SAVEPOINT sp_v11;")?;
                    if let Err(e) = self.migrate_v10_to_v11(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v11; RELEASE sp_v11;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v11;")?;
                }
                if current_version < 12 {
                    conn.execute_batch("SAVEPOINT sp_v12;")?;
                    if let Err(e) = self.migrate_v11_to_v12(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v12; RELEASE sp_v12;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v12;")?;
                }
                if current_version < 13 {
                    conn.execute_batch("SAVEPOINT sp_v13;")?;
                    if let Err(e) = self.migrate_v12_to_v13(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v13; RELEASE sp_v13;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v13;")?;
                }
                if current_version < 14 {
                    conn.execute_batch("SAVEPOINT sp_v14;")?;
                    if let Err(e) = self.migrate_v13_to_v14(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v14; RELEASE sp_v14;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v14;")?;
                }
                if current_version < 15 {
                    conn.execute_batch("SAVEPOINT sp_v15;")?;
                    if let Err(e) = self.migrate_v14_to_v15(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v15; RELEASE sp_v15;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v15;")?;
                }
                if current_version < 16 {
                    conn.execute_batch("SAVEPOINT sp_v16;")?;
                    if let Err(e) = self.migrate_v15_to_v16(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v16; RELEASE sp_v16;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v16;")?;
                }
                if current_version < 17 {
                    conn.execute_batch("SAVEPOINT sp_v17;")?;
                    if let Err(e) = self.migrate_v16_to_v17(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v17; RELEASE sp_v17;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v17;")?;
                }
                if current_version < 18 {
                    conn.execute_batch("SAVEPOINT sp_v18;")?;
                    if let Err(e) = self.migrate_v17_to_v18(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v18; RELEASE sp_v18;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v18;")?;
                }
                if current_version < 19 {
                    conn.execute_batch("SAVEPOINT sp_v19;")?;
                    if let Err(e) = self.migrate_v18_to_v19(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v19; RELEASE sp_v19;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v19;")?;
                }
                if current_version < 20 {
                    conn.execute_batch("SAVEPOINT sp_v20;")?;
                    if let Err(e) = self.migrate_v19_to_v20(&conn) {
                        conn.execute_batch("ROLLBACK TO sp_v20; RELEASE sp_v20;")?;
                        return Err(e);
                    }
                    conn.execute_batch("RELEASE sp_v20;")?;
                }
                // 成功后设置最终版本
                conn.execute(
                    "INSERT OR REPLACE INTO schema_version (version) VALUES (?1)",
                    params![CURRENT_DB_VERSION],
                )?;
                Ok(())
            })();

            if let Err(e) = migrate_result {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            } else {
                conn.execute_batch("COMMIT;")?;
            }
        }

        let needs_exam_sheet: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='exam_sheet'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            == 0;
        if needs_exam_sheet {
            if let Err(e) = self.migrate_v26_to_v27(&conn) {
                log::error!("v27 迁移后检查失败: {}", e);
            }
        }

        let needs_last_accessed: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='last_accessed_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            == 0;
        if needs_last_accessed {
            if let Err(e) = self.migrate_v27_to_v28(&conn) {
                log::error!("v28 迁移后检查失败: {}", e);
            }
        }

        let needs_autosave_signature: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='autosave_signature'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            == 0;
        if needs_autosave_signature {
            log::info!("检测到缺少 autosave_signature 列，尝试补齐...");
            if let Err(e) = conn.execute(
                "ALTER TABLE mistakes ADD COLUMN autosave_signature TEXT",
                [],
            ) {
                log::error!("自动补齐 autosave_signature 失败: {}", e);
            }
        }

        let exam_sheet_table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='exam_sheet_sessions'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !exam_sheet_table_exists {
            if let Err(e) = self.migrate_v28_to_v29(&conn) {
                log::error!("v29 迁移后检查失败: {}", e);
            }
        }

        let needs_linked_ids: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('exam_sheet_sessions') WHERE name='linked_mistake_ids'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            == 0;
        if needs_linked_ids {
            if let Err(e) = self.migrate_v29_to_v30(&conn) {
                log::error!("v30 迁移后检查失败: {}", e);
            }
        }

        // 兼容性修复：确保 document_tasks.status 支持 'Paused'
        // 注意：这部分代码应该在正式版本中删除，因为迁移应该通过版本号管理
        {
            // 首先清理可能存在的残留旧表
            conn.execute("DROP TABLE IF EXISTS document_tasks_old", [])
                .unwrap_or_else(|e| {
                    log::warn!("清理旧表时出现警告（可忽略）: {}", e);
                    0
                });

            let sql: Option<String> = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='document_tasks'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let needs_rebuild = match sql {
                Some(def) => !def.contains("'Paused'"),
                None => false, // 如果表不存在，将在后续的初始化中创建
            };

            if needs_rebuild {
                log::info!("兼容性修复：重建 document_tasks 表以支持 'Paused' 状态...");

                // 使用事务确保原子性
                let tx = conn.transaction()?;

                tx.execute(
                    "ALTER TABLE document_tasks RENAME TO document_tasks_old",
                    [],
                )?;
                tx.execute(
                    "CREATE TABLE document_tasks (
                         id TEXT PRIMARY KEY,
                         document_id TEXT NOT NULL,
                         original_document_name TEXT NOT NULL,
                         segment_index INTEGER NOT NULL,
                         content_segment TEXT NOT NULL,
                         status TEXT NOT NULL CHECK(status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')),
                         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                         updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                         error_message TEXT,
                         anki_generation_options_json TEXT NOT NULL
                     )",
                    [],
                )?;

                // 迁移数据，处理可能的无效状态值
                tx.execute(
                    "INSERT INTO document_tasks(id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, error_message, anki_generation_options_json)
                     SELECT id, document_id, original_document_name, segment_index, content_segment,
                            CASE WHEN status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')
                                 THEN status
                                 ELSE 'Pending' END,
                            created_at, updated_at, error_message, anki_generation_options_json
                     FROM document_tasks_old",
                    [],
                )?;

                tx.execute("DROP TABLE document_tasks_old", [])?;
                tx.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id)", [])?;
                tx.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status)", [])?;

                tx.commit()?;

                log::info!("兼容性修复完成：document_tasks 已支持 'Paused'");
            }
        }

        // 兼容性修复：部分环境在重命名 document_tasks -> document_tasks_old 过程中，
        // anki_cards 表的外键可能被SQLite随同更新为引用 document_tasks_old，
        // 随后旧表被删除会导致插入 anki_cards 时触发 “no such table: main.document_tasks_old”。
        // 这里幂等检查 anki_cards 定义，若包含 document_tasks_old 则重建以修复外键。
        {
            let anki_cards_needs_fix: bool = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='anki_cards'",
                    [],
                    |row| {
                        let sql: String = row.get(0)?;
                        Ok(sql.contains("document_tasks_old"))
                    },
                )
                .unwrap_or(false);

            if anki_cards_needs_fix {
                log::info!(
                    "兼容性修复：检测到 anki_cards 外键引用 document_tasks_old，开始重建..."
                );
                let tx = conn.transaction()?;

                // 重命名旧表
                tx.execute("ALTER TABLE anki_cards RENAME TO anki_cards_old", [])?;

                // 使用最新结构重建 anki_cards，确保外键正确引用 document_tasks(id)
                tx.execute(
                    "CREATE TABLE anki_cards (
                        id TEXT PRIMARY KEY,
                        task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
                        front TEXT NOT NULL,
                        back TEXT NOT NULL,
                        tags_json TEXT DEFAULT '[]',
                        images_json TEXT DEFAULT '[]',
                        is_error_card INTEGER NOT NULL DEFAULT 0,
                        error_content TEXT,
                        card_order_in_task INTEGER DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        extra_fields_json TEXT DEFAULT '{}',
                        template_id TEXT,
                        text TEXT
                    )",
                    [],
                )?;

                // 迁移数据（按列名顺序一一对应；对可能缺失的新列使用默认值）
                tx.execute(
                    "INSERT INTO anki_cards (
                        id, task_id, front, back, tags_json, images_json, is_error_card,
                        error_content, card_order_in_task, created_at, updated_at
                    )
                    SELECT
                        id, task_id, front, back,
                        COALESCE(tags_json, '[]'), COALESCE(images_json, '[]'),
                        COALESCE(is_error_card, 0), error_content,
                        COALESCE(card_order_in_task, 0),
                        COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    FROM anki_cards_old",
                    [],
                )?;

                // 重建索引
                tx.execute(
                    "CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id)",
                    [],
                )?;
                tx.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card)", [])?;
                tx.execute(
                    "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)",
                    [],
                )?;

                // 删除旧表
                tx.execute("DROP TABLE anki_cards_old", [])?;
                tx.commit()?;
                log::info!("兼容性修复完成：anki_cards 外键已指向 document_tasks");
            }
        }

        // 调用思维链列迁移函数
        self.migrate_add_thinking_column(&conn)?;

        // 调用RAG来源信息列迁移函数
        self.migrate_add_rag_sources_column(&conn)?;
        // 调用多模态附件列迁移函数
        self.migrate_add_attachment_columns(&conn)?;
        // 调用工具列迁移函数（保存工具调用与结果）
        self.migrate_add_tool_columns(&conn)?;
        // 新增：为错题/回顾消息表添加 memory_sources 列
        self.migrate_add_memory_sources_columns(&conn)?;
        // 新增：为错题/回顾消息表添加 web_search_sources 列
        self.migrate_add_web_search_sources_columns(&conn)?;
        // 新增：为错题消息表添加回合相关列（turn_id/turn_seq/reply_to_msg_id/message_kind/lifecycle）
        self.migrate_add_turn_columns(&conn)?;
        // 新增：为错题/回顾消息表添加 overrides/relations 列（消息级覆盖与关系）
        self.migrate_add_overrides_relations_columns(&conn)?;
        */
        // ============================================
        // 旧迁移调度代码结束
        // ============================================

        Ok(())
    }

    // ============================================
    // 已废弃：旧迁移辅助函数
    // 新系统使用 data_governance::migration
    // 保留代码供参考，待完全验证后删除
    // ============================================
    /*
    /// 为消息表补齐回合相关列并创建索引
    fn migrate_add_turn_columns(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        // 检查并添加各列
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let existing: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();

        if !existing.iter().any(|c| c == "turn_id") {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN turn_id TEXT;", [])?;
            println!("SQLite: chat_messages.turn_id 列已添加");
        }
        if !existing.iter().any(|c| c == "turn_seq") {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN turn_seq SMALLINT;",
                [],
            )?;
            println!("SQLite: chat_messages.turn_seq 列已添加");
        }
        if !existing.iter().any(|c| c == "reply_to_msg_id") {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN reply_to_msg_id INTEGER;",
                [],
            )?;
            println!("SQLite: chat_messages.reply_to_msg_id 列已添加");
        }
        if !existing.iter().any(|c| c == "message_kind") {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN message_kind TEXT;",
                [],
            )?;
            println!("SQLite: chat_messages.message_kind 列已添加");
        }
        if !existing.iter().any(|c| c == "lifecycle") {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN lifecycle TEXT;", [])?;
            println!("SQLite: chat_messages.lifecycle 列已添加");
        }

        // 幂等创建索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_turn_id ON chat_messages(turn_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_turn_pair ON chat_messages(mistake_id, turn_id)",
            [],
        )?;

        Ok(())
    }

    /// 为消息表补齐 overrides/relations 列（消息级覆盖与版本关系）
    fn migrate_add_overrides_relations_columns(
        &self,
        conn: &rusqlite::Connection,
    ) -> anyhow::Result<()> {
        // chat_messages.overrides
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_overrides = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "overrides");
        if !has_overrides {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN overrides TEXT;", [])?;
            println!("SQLite: chat_messages.overrides 列已添加");
        }

        // chat_messages.relations
        let mut stmt2 = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_relations = stmt2
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "relations");
        if !has_relations {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN relations TEXT;", [])?;
            println!("SQLite: chat_messages.relations 列已添加");
        }

        // review_chat_messages.overrides
        let mut stmt3 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_overrides = stmt3
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "overrides");
        if !has_r_overrides {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN overrides TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.overrides 列已添加");
        }

        // review_chat_messages.relations
        let mut stmt4 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_relations = stmt4
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "relations");
        if !has_r_relations {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN relations TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.relations 列已添加");
        }
        Ok(())
    }

    fn migrate_add_thinking_column(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let column_exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "thinking_content");

        if !column_exists {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN thinking_content TEXT;",
                [],
            )?;
            println!("SQLite: thinking_content 列已添加");
        }
        Ok(())
    }

    fn migrate_add_rag_sources_column(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let column_exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "rag_sources");

        if !column_exists {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN rag_sources TEXT;", [])?;
            println!("SQLite: rag_sources 列已添加");
        }
        Ok(())
    }

    fn migrate_add_memory_sources_columns(
        &self,
        conn: &rusqlite::Connection,
    ) -> anyhow::Result<()> {
        // chat_messages.memory_sources
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_mem = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "memory_sources");
        if !has_mem {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN memory_sources TEXT;",
                [],
            )?;
            println!("SQLite: chat_messages.memory_sources 列已添加");
        }

        // review_chat_messages.memory_sources
        let mut stmt2 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_mem = stmt2
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "memory_sources");
        if !has_r_mem {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN memory_sources TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.memory_sources 列已添加");
        }
        Ok(())
    }

    fn migrate_add_web_search_sources_columns(
        &self,
        conn: &rusqlite::Connection,
    ) -> anyhow::Result<()> {
        // chat_messages.web_search_sources
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_web_search = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "web_search_sources");
        if !has_web_search {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN web_search_sources TEXT;",
                [],
            )?;
            println!("SQLite: chat_messages.web_search_sources 列已添加");
        }

        // review_chat_messages.web_search_sources
        let mut stmt2 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_web_search = stmt2
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "web_search_sources");
        if !has_r_web_search {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN web_search_sources TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.web_search_sources 列已添加");
        }
        Ok(())
    }

    fn migrate_add_attachment_columns(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        // 添加 image_paths 列
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_image_paths = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "image_paths");

        if !has_image_paths {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN image_paths TEXT;", [])?;
            println!("SQLite: image_paths 列已添加");
        }

        // 添加 image_base64 列
        let mut stmt2 = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_image_base64 = stmt2
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "image_base64");

        if !has_image_base64 {
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN image_base64 TEXT;",
                [],
            )?;
            println!("SQLite: image_base64 列已添加");
        }

        Ok(())
    }

    fn migrate_add_tool_columns(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        // chat_messages.tool_call
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_tool_call = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "tool_call");
        if !has_tool_call {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN tool_call TEXT;", [])?;
            println!("SQLite: chat_messages.tool_call 列已添加");
        }

        // chat_messages.tool_result
        let mut stmt2 = conn.prepare("PRAGMA table_info(chat_messages);")?;
        let has_tool_result = stmt2
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "tool_result");
        if !has_tool_result {
            conn.execute("ALTER TABLE chat_messages ADD COLUMN tool_result TEXT;", [])?;
            println!("SQLite: chat_messages.tool_result 列已添加");
        }

        // review_chat_messages.tool_call
        let mut stmt3 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_tool_call = stmt3
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "tool_call");
        if !has_r_tool_call {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN tool_call TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.tool_call 列已添加");
        }

        // review_chat_messages.tool_result
        let mut stmt4 = conn.prepare("PRAGMA table_info(review_chat_messages);")?;
        let has_r_tool_result = stmt4
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "tool_result");
        if !has_r_tool_result {
            conn.execute(
                "ALTER TABLE review_chat_messages ADD COLUMN tool_result TEXT;",
                [],
            )?;
            println!("SQLite: review_chat_messages.tool_result 列已添加");
        }
        Ok(())
    }
    */
    // ============================================
    // 旧迁移辅助函数结束
    // ============================================

    // ============================================
    // 已废弃：旧版本迁移函数 (v1-v8)
    // 新系统使用 data_governance::migration
    // 保留代码供参考，待完全验证后删除
    // ============================================
    /*
    fn migrate_v1_to_v2(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("数据库迁移: v1 -> v2 (添加Anki增强功能表)");

        // 检查document_tasks表是否已存在
        let document_tasks_exists = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='document_tasks';",
            )?
            .query_map([], |_| Ok(()))?
            .any(|_| true);

        if !document_tasks_exists {
            conn.execute(
                "CREATE TABLE document_tasks (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    original_document_name TEXT NOT NULL,
                    segment_index INTEGER NOT NULL,
                    content_segment TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')),
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    error_message TEXT,
                    anki_generation_options_json TEXT NOT NULL
                );",
                [],
            )?;
            println!("创建document_tasks表");
        }

        // 检查anki_cards表是否已存在
        let anki_cards_exists = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anki_cards';")?
            .query_map([], |_| Ok(()))?
            .any(|_| true);

        if !anki_cards_exists {
            conn.execute(
                "CREATE TABLE anki_cards (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
                    front TEXT NOT NULL,
                    back TEXT NOT NULL,
                    tags_json TEXT DEFAULT '[]',
                    images_json TEXT DEFAULT '[]',
                    is_error_card INTEGER NOT NULL DEFAULT 0,
                    error_content TEXT,
                    card_order_in_task INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );",
                [],
            )?;
            println!("创建anki_cards表");
        }

        // 创建索引
        conn.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id);", [])?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status);",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id);",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card);",
            [],
        )?;

        println!("数据库迁移完成: v1 -> v2");
        Ok(())
    }

    fn migrate_v2_to_v3(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("数据库迁移: v2 -> v3 (添加RAG配置表)");

        // 检查rag_configurations表是否已存在
        let rag_config_exists = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='rag_configurations';",
            )?
            .query_map([], |_| Ok(()))?
            .any(|_| true);

        if !rag_config_exists {
            conn.execute(
                "CREATE TABLE rag_configurations (
                    id TEXT PRIMARY KEY,
                    chunk_size INTEGER NOT NULL DEFAULT 512,
                    chunk_overlap INTEGER NOT NULL DEFAULT 50,
                    chunking_strategy TEXT NOT NULL DEFAULT 'fixed_size',
                    min_chunk_size INTEGER NOT NULL DEFAULT 20,
                    default_top_k INTEGER NOT NULL DEFAULT 5,
                    default_rerank_enabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
                [],
            )?;
            println!("创建rag_configurations表");

            // 插入默认配置
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO rag_configurations (id, chunk_size, chunk_overlap, chunking_strategy, min_chunk_size, default_top_k, default_rerank_enabled, created_at, updated_at)
                 VALUES ('default', 512, 50, 'fixed_size', 20, 5, 1, ?1, ?2)",
                params![now, now],
            )?;
            println!("插入默认RAG配置");
        }

        println!("数据库迁移完成: v2 -> v3");
        Ok(())
    }

    fn migrate_v3_to_v4(&self, _conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("📦 开始数据库迁移 v3 -> v4: 添加RAG来源信息支持");

        // v3到v4的迁移主要通过migrate_add_rag_sources_column处理
        // 这里可以添加其他v4特有的迁移逻辑

        println!("数据库迁移 v3 -> v4 完成");
        Ok(())
    }

    fn migrate_v4_to_v5(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("📦 开始数据库迁移 v4 -> v5: 升级回顾分析表结构");

        // 强制创建review_analyses和review_chat_messages表（如果不存在）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_analyses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mistake_ids TEXT NOT NULL,
                consolidated_input TEXT NOT NULL,
                user_question TEXT NOT NULL,
                status TEXT NOT NULL,
                tags TEXT NOT NULL,
                analysis_type TEXT NOT NULL DEFAULT 'consolidated_review'
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT,
                rag_sources TEXT,
                FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
            )",
            [],
        )?;

        println!("强制创建了review_analyses和review_chat_messages表");

        // 迁移旧的review_sessions到新的review_analyses
        self.migrate_review_sessions_to_review_analyses(conn)?;

        println!("数据库迁移 v4 -> v5 完成");
        Ok(())
    }

    fn migrate_v5_to_v6(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("📦 开始数据库迁移 v5 -> v6: 修复回顾分析表结构");

        // 强制重新创建review_analyses和review_chat_messages表，确保schema正确
        conn.execute("DROP TABLE IF EXISTS review_chat_messages", [])?;
        conn.execute("DROP TABLE IF EXISTS review_analyses", [])?;

        conn.execute(
            "CREATE TABLE review_analyses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mistake_ids TEXT NOT NULL,
                consolidated_input TEXT NOT NULL,
                user_question TEXT NOT NULL,
                status TEXT NOT NULL,
                tags TEXT NOT NULL,
                analysis_type TEXT NOT NULL DEFAULT 'consolidated_review'
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE review_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT,
                rag_sources TEXT,
                FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
            )",
            [],
        )?;

        println!("重新创建了review_analyses和review_chat_messages表");
        println!("数据库迁移 v5 -> v6 完成");
        Ok(())
    }

    fn migrate_v6_to_v7(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("📦 开始数据库迁移 v6 -> v7: 添加错题总结字段");

        // 为mistakes表添加新的总结字段
        let mut stmt = conn.prepare("PRAGMA table_info(mistakes);")?;
        let column_exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "mistake_summary");

        if !column_exists {
            conn.execute("ALTER TABLE mistakes ADD COLUMN mistake_summary TEXT", [])?;
        }

        let mut stmt = conn.prepare("PRAGMA table_info(mistakes);")?;
        let column_exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "user_error_analysis");

        if !column_exists {
            conn.execute(
                "ALTER TABLE mistakes ADD COLUMN user_error_analysis TEXT",
                [],
            )?;
        }

        println!("已为mistakes表添加mistake_summary和user_error_analysis字段");
        println!("数据库迁移 v6 -> v7 完成");
        Ok(())
    }

    fn migrate_v7_to_v8(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("📦 开始数据库迁移 v7 -> v8: 添加模板支持字段");

        // 为anki_cards表添加扩展字段和模板ID字段
        let add_extra_fields = conn.execute(
            "ALTER TABLE anki_cards ADD COLUMN extra_fields_json TEXT DEFAULT '{}'",
            [],
        );

        let add_template_id =
            conn.execute("ALTER TABLE anki_cards ADD COLUMN template_id TEXT", []);

        match (add_extra_fields, add_template_id) {
            (Ok(_), Ok(_)) => {
                println!("已为anki_cards表添加extra_fields_json和template_id字段");
            }
            (Err(e1), Err(e2)) => {
                println!("添加字段时遇到错误，可能字段已存在: {} / {}", e1, e2);
            }
            (Ok(_), Err(e)) => {
                println!("添加template_id字段时遇到错误，可能字段已存在: {}", e);
            }
            (Err(e), Ok(_)) => {
                println!(
                    "添加extra_fields_json字段时遇到错误，可能字段已存在: {}",
                    e
                );
            }
        }

        // 创建自定义模板表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS custom_anki_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                author TEXT,
                version TEXT NOT NULL DEFAULT '1.0.0',
                preview_front TEXT NOT NULL,
                preview_back TEXT NOT NULL,
                note_type TEXT NOT NULL DEFAULT 'Basic',
                fields_json TEXT NOT NULL DEFAULT '[]',
                generation_prompt TEXT NOT NULL,
                front_template TEXT NOT NULL,
                back_template TEXT NOT NULL,
                css_style TEXT NOT NULL,
                field_extraction_rules_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                is_active INTEGER NOT NULL DEFAULT 1,
                is_built_in INTEGER NOT NULL DEFAULT 0
            );",
            [],
        )?;

        // 仅确保表存在；内置模板的导入统一由 JSON 文件驱动
        println!("v11->v12: 跳过硬编码内置模板插入，改用 JSON 导入");

        // 创建模板表索引
        conn.execute("CREATE INDEX IF NOT EXISTS idx_custom_anki_templates_is_active ON custom_anki_templates(is_active);", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_custom_anki_templates_is_built_in ON custom_anki_templates(is_built_in);", [])?;

        println!("已创建custom_anki_templates表");
        println!("数据库迁移 v7 -> v8 完成");
        Ok(())
    }
    */
    // ============================================
    // 旧版本迁移函数 (v1-v8) 结束
    // ============================================

    // 自定义模板管理方法

    /// 创建自定义模板
    pub fn create_custom_template(
        &self,
        request: &crate::models::CreateTemplateRequest,
    ) -> Result<String> {
        let conn = self.get_conn_safe()?;
        let template_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        let version = request.version.as_deref().unwrap_or("1.0.0").to_string();
        let is_active = request.is_active.unwrap_or(true);
        let is_built_in = request.is_built_in.unwrap_or(false);

        conn.execute(
            "INSERT INTO custom_anki_templates
             (id, name, description, author, version, preview_front, preview_back, note_type,
              fields_json, generation_prompt, front_template, back_template, css_style,
              field_extraction_rules_json, created_at, updated_at, is_active, is_built_in, preview_data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                template_id,
                request.name,
                request.description,
                request.author,
                version,
                request.preview_front,
                request.preview_back,
                request.note_type,
                serde_json::to_string(&request.fields)?,
                request.generation_prompt,
                request.front_template,
                request.back_template,
                request.css_style,
                serde_json::to_string(&request.field_extraction_rules)?,
                now.clone(),
                now,
                if is_active { 1 } else { 0 },
                if is_built_in { 1 } else { 0 },
                request.preview_data_json
            ]
        )?;

        Ok(template_id)
    }

    /// 使用指定 ID 创建自定义模板（用于导入内置模板）
    pub fn create_custom_template_with_id(
        &self,
        template_id: &str,
        request: &crate::models::CreateTemplateRequest,
    ) -> Result<String> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        let version = request.version.as_deref().unwrap_or("1.0.0").to_string();
        let is_active = request.is_active.unwrap_or(true);
        let is_built_in = request.is_built_in.unwrap_or(false);

        conn.execute(
            "INSERT INTO custom_anki_templates
             (id, name, description, author, version, preview_front, preview_back, note_type,
              fields_json, generation_prompt, front_template, back_template, css_style,
              field_extraction_rules_json, created_at, updated_at, is_active, is_built_in, preview_data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                template_id,
                request.name,
                request.description,
                request.author,
                version,
                request.preview_front,
                request.preview_back,
                request.note_type,
                serde_json::to_string(&request.fields)?,
                request.generation_prompt,
                request.front_template,
                request.back_template,
                request.css_style,
                serde_json::to_string(&request.field_extraction_rules)?,
                now.clone(),
                now,
                if is_active { 1 } else { 0 },
                if is_built_in { 1 } else { 0 },
                request.preview_data_json
            ]
        )?;

        Ok(template_id.to_string())
    }

    /// 获取所有自定义模板
    pub fn get_all_custom_templates(&self) -> Result<Vec<crate::models::CustomAnkiTemplate>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, author, version, preview_front, preview_back, note_type,
                    fields_json, generation_prompt, front_template, back_template, css_style,
                    field_extraction_rules_json, created_at, updated_at, is_active, is_built_in,
                    preview_data_json
             FROM custom_anki_templates ORDER BY created_at DESC",
        )?;

        let template_iter = stmt.query_map([], |row| {
            let fields_json: String = row.get(8)?;
            let fields: Vec<String> = serde_json::from_str(&fields_json).unwrap_or_default();

            let rules_json: String = row.get(13)?;
            let field_extraction_rules: std::collections::HashMap<
                String,
                crate::models::FieldExtractionRule,
            > = serde_json::from_str(&rules_json).unwrap_or_default();

            let created_at_str: String = row.get(14)?;
            let updated_at_str: String = row.get(15)?;

            Ok(crate::models::CustomAnkiTemplate {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                author: row.get(3)?,
                version: row.get(4)?,
                preview_front: row.get(5)?,
                preview_back: row.get(6)?,
                note_type: row.get(7)?,
                fields,
                generation_prompt: row.get(9)?,
                front_template: row.get(10)?,
                back_template: row.get(11)?,
                css_style: row.get(12)?,
                field_extraction_rules,
                created_at: DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_else(|_| {
                        log::warn!(
                            "无法解析 created_at 日期: '{}', 使用当前时间",
                            created_at_str
                        );
                        Utc::now().fixed_offset()
                    })
                    .with_timezone(&Utc),
                updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                    .unwrap_or_else(|_| {
                        log::warn!(
                            "无法解析 updated_at 日期: '{}', 使用当前时间",
                            updated_at_str
                        );
                        Utc::now().fixed_offset()
                    })
                    .with_timezone(&Utc),
                is_active: row.get::<_, i32>(16)? != 0,
                is_built_in: row.get::<_, i32>(17)? != 0,
                preview_data_json: row.get(18)?,
            })
        })?;

        let mut templates = Vec::new();
        for template in template_iter {
            templates.push(template?);
        }

        Ok(templates)
    }

    /// 获取指定ID的自定义模板
    pub fn get_custom_template_by_id(
        &self,
        template_id: &str,
    ) -> Result<Option<crate::models::CustomAnkiTemplate>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, author, version, preview_front, preview_back, note_type,
                    fields_json, generation_prompt, front_template, back_template, css_style,
                    field_extraction_rules_json, created_at, updated_at, is_active, is_built_in,
                    preview_data_json
             FROM custom_anki_templates WHERE id = ?1",
        )?;

        let result = stmt
            .query_row(params![template_id], |row| {
                let fields_json: String = row.get(8)?;
                let fields: Vec<String> = serde_json::from_str(&fields_json).unwrap_or_default();

                let rules_json: String = row.get(13)?;
                let field_extraction_rules: std::collections::HashMap<
                    String,
                    crate::models::FieldExtractionRule,
                > = serde_json::from_str(&rules_json).unwrap_or_default();

                let created_at_str: String = row.get(14)?;
                let updated_at_str: String = row.get(15)?;

                Ok(crate::models::CustomAnkiTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    author: row.get(3)?,
                    version: row.get(4)?,
                    preview_front: row.get(5)?,
                    preview_back: row.get(6)?,
                    note_type: row.get(7)?,
                    fields,
                    generation_prompt: row.get(9)?,
                    front_template: row.get(10)?,
                    back_template: row.get(11)?,
                    css_style: row.get(12)?,
                    field_extraction_rules,
                    created_at: DateTime::parse_from_rfc3339(&created_at_str)
                        .unwrap_or_else(|_| {
                            log::warn!(
                                "无法解析 created_at 日期: '{}', 使用当前时间",
                                created_at_str
                            );
                            Utc::now().fixed_offset()
                        })
                        .with_timezone(&Utc),
                    updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                        .unwrap_or_else(|_| {
                            log::warn!(
                                "无法解析 updated_at 日期: '{}', 使用当前时间",
                                updated_at_str
                            );
                            Utc::now().fixed_offset()
                        })
                        .with_timezone(&Utc),
                    is_active: row.get::<_, i32>(16)? != 0,
                    is_built_in: row.get::<_, i32>(17)? != 0,
                    preview_data_json: row.get(18)?,
                })
            })
            .optional()?;

        Ok(result)
    }

    /// 递增版本号（补丁版本）
    fn increment_version(version: &str) -> String {
        let parts: Vec<&str> = version.split('.').collect();
        if parts.len() == 3 {
            if let (Ok(major), Ok(minor), Ok(patch)) = (
                parts[0].parse::<u32>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<u32>(),
            ) {
                return format!("{}.{}.{}", major, minor, patch + 1);
            }
        }
        // 如果解析失败，返回默认版本
        "1.0.1".to_string()
    }

    /// 更新自定义模板
    pub fn update_custom_template(
        &self,
        template_id: &str,
        request: &crate::models::UpdateTemplateRequest,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        let mut query_parts = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // 如果请求中指定了版本号，使用指定的版本号（用于内置模板导入）
        // 否则自动递增版本号
        let version_to_use = if let Some(version) = &request.version {
            version.clone()
        } else {
            let current_version = conn
                .query_row(
                    "SELECT version FROM custom_anki_templates WHERE id = ?1",
                    params![template_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "1.0.0".to_string());
            Self::increment_version(&current_version)
        };

        // 更新版本号
        query_parts.push("version = ?".to_string());
        params.push(Box::new(version_to_use));

        if let Some(name) = &request.name {
            query_parts.push("name = ?".to_string());
            params.push(Box::new(name.clone()));
        }
        if let Some(description) = &request.description {
            query_parts.push("description = ?".to_string());
            params.push(Box::new(description.clone()));
        }
        if let Some(author) = &request.author {
            query_parts.push("author = ?".to_string());
            params.push(Box::new(author.clone()));
        }
        if let Some(preview_front) = &request.preview_front {
            query_parts.push("preview_front = ?".to_string());
            params.push(Box::new(preview_front.clone()));
        }
        if let Some(preview_back) = &request.preview_back {
            query_parts.push("preview_back = ?".to_string());
            params.push(Box::new(preview_back.clone()));
        }
        if let Some(note_type) = &request.note_type {
            query_parts.push("note_type = ?".to_string());
            params.push(Box::new(note_type.clone()));
        }
        if let Some(fields) = &request.fields {
            query_parts.push("fields_json = ?".to_string());
            let fields_json = serde_json::to_string(fields)?;
            params.push(Box::new(fields_json));
        }
        if let Some(generation_prompt) = &request.generation_prompt {
            query_parts.push("generation_prompt = ?".to_string());
            params.push(Box::new(generation_prompt.clone()));
        }
        if let Some(front_template) = &request.front_template {
            query_parts.push("front_template = ?".to_string());
            params.push(Box::new(front_template.clone()));
        }
        if let Some(back_template) = &request.back_template {
            query_parts.push("back_template = ?".to_string());
            params.push(Box::new(back_template.clone()));
        }
        if let Some(css_style) = &request.css_style {
            query_parts.push("css_style = ?".to_string());
            params.push(Box::new(css_style.clone()));
        }
        if let Some(field_extraction_rules) = &request.field_extraction_rules {
            query_parts.push("field_extraction_rules_json = ?".to_string());
            let rules_json = serde_json::to_string(field_extraction_rules)?;
            params.push(Box::new(rules_json));
        }
        if let Some(is_active) = &request.is_active {
            query_parts.push("is_active = ?".to_string());
            let active_val = if *is_active { 1 } else { 0 };
            params.push(Box::new(active_val));
        }
        if let Some(preview_data_json) = &request.preview_data_json {
            query_parts.push("preview_data_json = ?".to_string());
            params.push(Box::new(preview_data_json.clone()));
        }
        if let Some(is_built_in) = &request.is_built_in {
            query_parts.push("is_built_in = ?".to_string());
            let builtin_val = if *is_built_in { 1 } else { 0 };
            params.push(Box::new(builtin_val));
        }

        if query_parts.is_empty() {
            return Ok(());
        }

        query_parts.push("updated_at = ?".to_string());
        params.push(Box::new(now));

        let mut where_clause = "id = ?".to_string();
        params.push(Box::new(template_id.to_string()));
        if let Some(expected_version) = &request.expected_version {
            where_clause = "id = ? AND version = ?".to_string();
            params.push(Box::new(expected_version.clone()));
        }

        let query = format!(
            "UPDATE custom_anki_templates SET {} WHERE {}",
            query_parts.join(", "),
            where_clause
        );

        let affected = conn.execute(
            &query,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        )?;
        if request.expected_version.is_some() && affected == 0 {
            return Err(anyhow::anyhow!("optimistic_lock_failed"));
        }
        Ok(())
    }

    /// 删除自定义模板
    pub fn delete_custom_template(&self, template_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        conn.execute(
            "DELETE FROM custom_anki_templates WHERE id = ?1",
            params![template_id],
        )?;
        Ok(())
    }

    // ============================================
    // 已废弃：旧迁移辅助函数 (review_sessions)
    // 新系统使用 data_governance::migration
    // 保留代码供参考，待完全验证后删除
    // ============================================
    /*
    fn migrate_review_sessions_to_review_analyses(
        &self,
        conn: &rusqlite::Connection,
    ) -> anyhow::Result<()> {
        // 检查旧表是否存在
        let old_table_exists = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='review_sessions';",
            )?
            .query_map([], |_| Ok(()))?
            .any(|_| true);

        if !old_table_exists {
            println!("旧的review_sessions表不存在，跳过迁移");
            return Ok(());
        }

        println!("检查review_sessions表结构");

        // 🔧 关键修复：检查表结构是否匹配
        let columns = conn
            .prepare("PRAGMA table_info(review_sessions)")?
            .query_map([], |row| {
                Ok(row.get::<_, String>(1)?) // 获取列名
            })?
            .collect::<rusqlite::Result<Vec<String>>>()?;

        // 检查必需的字段是否存在
        let has_mistake_ids = columns.contains(&"mistake_ids".to_string());
        let has_analysis_summary = columns.contains(&"analysis_summary".to_string());

        if !has_mistake_ids || !has_analysis_summary {
            println!("review_sessions表结构不匹配，跳过数据迁移");
            println!("   - 当前字段: {:?}", columns);
            println!(
                "   - 需要字段: mistake_ids={}, analysis_summary={}",
                has_mistake_ids, has_analysis_summary
            );

            // 🔧 直接删除不兼容的旧表，避免后续冲突
            conn.execute("DROP TABLE IF EXISTS review_sessions", [])?;
            println!("已删除不兼容的review_sessions表");
            return Ok(());
        }

        println!("迁移review_sessions数据到review_analyses");

        // 创建新表（如果不存在）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_analyses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mistake_ids TEXT NOT NULL,
                consolidated_input TEXT NOT NULL,
                user_question TEXT NOT NULL,
                status TEXT NOT NULL,
                tags TEXT NOT NULL,
                analysis_type TEXT NOT NULL DEFAULT 'consolidated_review'
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT,
                rag_sources TEXT,
                FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // 迁移数据
        let mut stmt = conn.prepare(
            "SELECT id, mistake_ids, analysis_summary, created_at FROM review_sessions",
        )?;
        let old_sessions: Vec<(String, String, String, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?, // id
                    row.get::<_, String>(1)?, // mistake_ids
                    row.get::<_, String>(2)?, // analysis_summary
                    row.get::<_, String>(3)?, // created_at
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let migration_count = old_sessions.len();

        for (id, mistake_ids, analysis_summary, created_at) in old_sessions {
            // 插入到新表
            conn.execute(
                "INSERT OR IGNORE INTO review_analyses
                 (id, name, created_at, updated_at, mistake_ids, consolidated_input, user_question, status, tags, analysis_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    format!("回顾分析-{}", chrono::Utc::now().format("%Y%m%d")), // 默认名称
                    created_at,
                    chrono::Utc::now().to_rfc3339(), // updated_at
                    mistake_ids,
                    analysis_summary, // 作为consolidated_input
                    "统一回顾分析", // 默认用户问题
                    "completed", // 默认状态
                    "[]", // 空标签数组
                    "consolidated_review"
                ]
            )?;

            // 迁移聊天记录
            let mut chat_stmt = conn.prepare(
                "SELECT role, content, timestamp FROM review_chat_messages WHERE session_id = ?1",
            )?;
            let chat_messages: Vec<(String, String, String)> = chat_stmt
                .query_map([&id], |row| {
                    Ok((
                        row.get::<_, String>(0)?, // role
                        row.get::<_, String>(1)?, // content
                        row.get::<_, String>(2)?, // timestamp
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            for (role, content, timestamp) in chat_messages {
                conn.execute(
                    "INSERT INTO review_chat_messages
                     (review_analysis_id, role, content, timestamp, thinking_content, rag_sources)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, role, content, timestamp, None::<String>, None::<String>],
                )?;
            }
        }

        // 删除旧表（可选，为了保险起见先保留）
        // conn.execute("DROP TABLE IF EXISTS review_sessions", [])?;
        // conn.execute("DROP TABLE IF EXISTS review_chat_messages", [])?;

        println!(
            "review_sessions迁移完成，迁移了{}条记录",
            migration_count
        );
        Ok(())
    }
    */
    // ============================================
    // 旧迁移辅助函数 (review_sessions) 结束
    // ============================================

    /// 合并并过滤聊天消息
    /// 1. 合并工具调用的碎片消息（assistant+tool+assistant）
    /// 2. 过滤掉包含[SUMMARY_REQUEST]的用户消息
    /// 3. 将总结消息附加到最后一条助手消息而非创建新消息
    fn merge_and_filter_messages(
        messages: &[crate::models::ChatMessage],
    ) -> Vec<crate::models::ChatMessage> {
        let mut merged: Vec<crate::models::ChatMessage> = Vec::new();
        let mut i = 0;

        while i < messages.len() {
            let msg = &messages[i];

            // 过滤掉包含[SUMMARY_REQUEST]的用户消息
            if msg.role == "user" && msg.content.contains("[SUMMARY_REQUEST]") {
                log::debug!("过滤掉总结请求消息");
                i += 1;
                continue;
            }

            // 检测是否为总结消息（通过metadata而非内容）
            let is_summary = if let Some(overrides) = &msg.overrides {
                overrides
                    .get("is_summary")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || overrides
                        .get("phase")
                        .and_then(|v| v.as_str())
                        .map_or(false, |p| p == "SUMMARY")
            } else {
                false
            };

            // 如果是总结消息且有最后一条助手消息，附加到最后一条助手消息
            if is_summary && msg.role == "assistant" && !merged.is_empty() {
                if let Some(last) = merged.last_mut() {
                    if last.role == "assistant" {
                        log::debug!("将总结内容附加到最后一条助手消息");
                        // 将总结内容附加到最后一条助手消息的metadata中
                        let mut overrides_value = last
                            .overrides
                            .clone()
                            .unwrap_or_else(|| serde_json::json!({}));
                        if let Some(obj) = overrides_value.as_object_mut() {
                            obj.insert(
                                "summary_content".to_string(),
                                serde_json::Value::String(msg.content.clone()),
                            );
                            obj.insert("has_summary".to_string(), serde_json::Value::Bool(true));
                        }
                        last.overrides = Some(overrides_value);
                        i += 1;
                        continue;
                    }
                }
            }

            // 检测并合并工具调用碎片
            // 模式：assistant(空或有内容) + tool + assistant(续写)
            if msg.role == "assistant" && i + 2 < messages.len() {
                let next = &messages[i + 1];
                let continuation = &messages[i + 2];

                if next.role == "tool" && continuation.role == "assistant" {
                    log::debug!("检测到工具调用碎片，正在合并...");

                    // 创建合并后的消息
                    let mut merged_msg = msg.clone();

                    // 合并内容
                    if !msg.content.is_empty() && !continuation.content.is_empty() {
                        merged_msg.content = format!("{}\n\n{}", msg.content, continuation.content);
                    } else if continuation.content.is_empty() {
                        merged_msg.content = msg.content.clone();
                    } else {
                        merged_msg.content = continuation.content.clone();
                    }

                    // 保留工具调用信息（如果有）
                    if msg.tool_call.is_some() {
                        merged_msg.tool_call = msg.tool_call.clone();
                    }

                    // 保留工具结果（从tool消息）
                    if next.tool_result.is_some() {
                        merged_msg.tool_result = next.tool_result.clone();
                    }

                    // 合并来源信息
                    merged_msg.rag_sources = Self::merge_sources(
                        msg.rag_sources.as_ref(),
                        continuation.rag_sources.as_ref(),
                    );
                    merged_msg.memory_sources = Self::merge_sources(
                        msg.memory_sources.as_ref(),
                        continuation.memory_sources.as_ref(),
                    );
                    merged_msg.web_search_sources = Self::merge_sources(
                        msg.web_search_sources.as_ref(),
                        continuation.web_search_sources.as_ref(),
                    );

                    // 使用续写消息的时间戳
                    merged_msg.timestamp = continuation.timestamp;

                    merged.push(merged_msg);
                    i += 3; // 跳过这三条消息
                    continue;
                }
            }

            // 过滤掉role为"tool"的独立消息（已合并到assistant消息）
            if msg.role == "tool" {
                log::debug!("跳过独立的tool消息");
                i += 1;
                continue;
            }

            // 其他消息直接保留
            merged.push(msg.clone());
            i += 1;
        }

        merged
    }

    /// 合并来源信息的辅助函数
    fn merge_sources(
        sources1: Option<&Vec<crate::models::RagSourceInfo>>,
        sources2: Option<&Vec<crate::models::RagSourceInfo>>,
    ) -> Option<Vec<crate::models::RagSourceInfo>> {
        match (sources1, sources2) {
            (Some(s1), Some(s2)) => {
                let mut merged = s1.clone();
                merged.extend(s2.clone());
                Some(merged)
            }
            (Some(s), None) | (None, Some(s)) => Some(s.clone()),
            (None, None) => None,
        }
    }

    pub fn fetch_chat_history_summary(&self, mistake_id: &str) -> Result<ChatHistorySummary> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT role, stable_id, content, image_base64, doc_attachments \
             FROM chat_messages WHERE mistake_id = ?1",
        )?;
        let mut assistant_count = 0usize;
        let mut user_messages: Vec<UserMessageSummary> = Vec::new();
        let mut rows = stmt.query(params![mistake_id])?;
        while let Some(row) = rows.next()? {
            let role: String = row.get(0)?;
            let stable_id: Option<String> = row.get(1)?;
            let content: String = row.get(2)?;
            let image_json: Option<String> = row.get(3)?;
            let doc_json: Option<String> = row.get(4)?;
            if role == "assistant" {
                assistant_count += 1;
                continue;
            }
            if role != "user" {
                continue;
            }
            let images = parse_image_list(image_json).unwrap_or_default();
            let doc_fp = canonicalize_doc_attachments_summary(doc_json);
            let fingerprint = fingerprint_user_row(
                &content,
                if images.is_empty() {
                    None
                } else {
                    Some(&images)
                },
                doc_fp.as_deref(),
            );
            user_messages.push(UserMessageSummary {
                stable_id,
                fingerprint,
            });
        }
        Ok(ChatHistorySummary {
            assistant_count,
            user_messages,
        })
    }

    pub fn get_chat_message_ids(&self, mistake_id: &str) -> Result<Vec<i64>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare("SELECT id FROM chat_messages WHERE mistake_id = ?1")?;
        let rows = stmt
            .query_map(params![mistake_id], |row| Ok(row.get::<_, i64>(0)?))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 增量追加错题聊天消息（不删除历史） - 零过滤：不做角色/字段拦截
    /// SOTA增量保存：基于 stable_id 进行 UPSERT，避免重复插入
    /// 新架构兼容：当 mistake 不存在时自动创建空记录
    pub fn append_mistake_chat_messages(
        &self,
        mistake_id: &str,
        messages: &[crate::models::ChatMessage],
    ) -> Result<AppendMessagesChangeSet> {
        self.append_mistake_chat_messages_with_context(mistake_id, messages, None, None)
    }

    /// 增量追加错题聊天消息（带上下文）
    ///
    /// 当 mistake 记录不存在时，使用传入的 subject 和 chat_category 自动创建空记录。
    /// 这是为了兼容新架构（前端生成 UUID 作为 sessionId，但不预先创建记录）。
    pub fn append_mistake_chat_messages_with_context(
        &self,
        mistake_id: &str,
        messages: &[crate::models::ChatMessage],
        _subject: Option<&str>,
        chat_category: Option<&str>,
    ) -> Result<AppendMessagesChangeSet> {
        let mut conn = self.get_conn_safe()?;
        let tx = conn.transaction()?;

        // 检查错题是否存在，不存在则自动创建
        {
            let mut stmt = tx.prepare("SELECT COUNT(1) FROM mistakes WHERE id = ?1")?;
            let exists: i64 = stmt.query_row(rusqlite::params![mistake_id], |row| row.get(0))?;
            if exists == 0 {
                // 新架构兼容：自动创建空 mistake 记录
                let now = chrono::Utc::now().to_rfc3339();
                let category_val = chat_category.unwrap_or("analysis");
                tx.execute(
                    "INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text, tags, mistake_type, status, chat_category, updated_at, last_accessed_at)
                     VALUES (?1, ?2, '[]', '[]', '', '', '[]', 'analysis', 'active', ?3, ?2, ?2)",
                    params![mistake_id, now, category_val],
                )?;
                log::info!(
                    "[新架构兼容] 自动创建 mistake 记录: id={}, category={}",
                    mistake_id,
                    category_val
                );
            }
        }

        // 检查 stable_id 列是否存在
        let has_stable_id_column: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name='stable_id'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        // 读取现有消息的 stable_id -> id 映射
        let existing_messages: ExistingMessageMap = if has_stable_id_column {
            let mut stmt = tx.prepare(
                    "SELECT id, stable_id FROM chat_messages WHERE mistake_id = ?1 AND stable_id IS NOT NULL AND stable_id <> ''"
                )?;
            let rows: Vec<(String, i64)> = stmt
                .query_map(params![mistake_id], |row| build_existing_message_map(row))?
                .collect::<rusqlite::Result<_>>()?;
            rows.into_iter().collect()
        } else {
            std::collections::HashMap::new()
        };

        // 逐条 UPSERT 消息
        let mut matched_ids = std::collections::HashSet::new();
        let mut updated_ids: Vec<i64> = Vec::new();
        let mut inserted_ids: Vec<i64> = Vec::new();
        let mut latest_ts = None;

        // 统计信息
        let mut assistant_count = 0usize;
        let mut tool_count = 0usize;
        let mut other_count = 0usize;
        let mut missing_stable_id_count = 0usize;

        for message in messages {
            // 基础字段序列化
            let image_paths_json = message
                .image_paths
                .as_ref()
                .map(|paths| serde_json::to_string(paths))
                .transpose()?;
            let image_base64_json = message
                .image_base64
                .as_ref()
                .map(|imgs| serde_json::to_string(imgs))
                .transpose()?;
            let doc_attachments_json = message
                .doc_attachments
                .as_ref()
                .map(|docs| serde_json::to_string(docs))
                .transpose()?;

            // sources 字段：对所有角色保留
            let (
                rag_sources_json,
                memory_sources_json,
                graph_sources_json,
                web_search_sources_json,
            ) = (
                message
                    .rag_sources
                    .as_ref()
                    .map(|sources| serde_json::to_string(sources))
                    .transpose()?,
                message
                    .memory_sources
                    .as_ref()
                    .map(|sources| serde_json::to_string(sources))
                    .transpose()?,
                message
                    .graph_sources
                    .as_ref()
                    .map(|sources| serde_json::to_string(sources))
                    .transpose()?,
                message
                    .web_search_sources
                    .as_ref()
                    .map(|sources| serde_json::to_string(sources))
                    .transpose()?,
            );

            // 工具字段：对所有角色保留
            let (tool_call_json, tool_result_json) = (
                message
                    .tool_call
                    .as_ref()
                    .map(|tc| serde_json::to_string(tc))
                    .transpose()?,
                message
                    .tool_result
                    .as_ref()
                    .map(|tr| serde_json::to_string(tr))
                    .transpose()?,
            );

            // overrides：对所有角色保留
            let overrides_json = message.overrides.as_ref().map(|v| v.to_string());
            let (relations_json_value, relations_update_flag) = match message.relations.as_ref() {
                Some(val) if val.is_null() => (None, true),
                Some(val) => (Some(val.to_string()), true),
                None => (None, false),
            };
            let relations_obj = message.relations.as_ref().and_then(|val| val.as_object());

            let mut turn_id_update_flag = false;
            let mut turn_id_value: Option<String> = None;
            if let Some(obj) = relations_obj {
                if let Some(val) = obj.get("turn_id") {
                    turn_id_update_flag = true;
                    if val.is_null() {
                        turn_id_value = None;
                    } else if let Some(s) = val.as_str() {
                        turn_id_value = Some(s.to_string());
                    } else {
                        turn_id_value = Some(val.to_string());
                    }
                }
            }

            let mut turn_seq_update_flag = false;
            let mut turn_seq_value: Option<i64> = None;
            if let Some(obj) = relations_obj {
                if let Some(val) = obj.get("turn_seq") {
                    turn_seq_update_flag = true;
                    if val.is_null() {
                        turn_seq_value = None;
                    } else if let Some(n) = val.as_i64() {
                        turn_seq_value = Some(n);
                    } else if let Some(n) = val.as_u64() {
                        turn_seq_value = Some(n as i64);
                    } else if let Some(s) = val.as_str() {
                        if let Ok(parsed) = s.parse::<i64>() {
                            turn_seq_value = Some(parsed);
                        }
                    }
                }
            }

            let mut reply_to_update_flag = false;
            let mut reply_to_value: Option<i64> = None;
            if let Some(obj) = relations_obj {
                if let Some(val) = obj.get("reply_to_msg_id") {
                    reply_to_update_flag = true;
                    if val.is_null() {
                        reply_to_value = None;
                    } else if let Some(n) = val.as_i64() {
                        reply_to_value = Some(n);
                    } else if let Some(n) = val.as_u64() {
                        reply_to_value = Some(n as i64);
                    } else if let Some(s) = val.as_str() {
                        if let Ok(parsed) = s.parse::<i64>() {
                            reply_to_value = Some(parsed);
                        }
                    }
                }
            }

            let mut message_kind_update_flag = false;
            let mut message_kind_value: Option<String> = None;
            if let Some(obj) = relations_obj {
                if let Some(val) = obj.get("message_kind") {
                    message_kind_update_flag = true;
                    if val.is_null() {
                        message_kind_value = None;
                    } else if let Some(s) = val.as_str() {
                        message_kind_value = Some(s.to_string());
                    } else {
                        message_kind_value = Some(val.to_string());
                    }
                }
            }

            let mut lifecycle_update_flag = false;
            let mut lifecycle_value: Option<String> = None;
            if let Some(obj) = relations_obj {
                if let Some(val) = obj.get("lifecycle") {
                    lifecycle_update_flag = true;
                    if val.is_null() {
                        lifecycle_value = None;
                    } else if let Some(s) = val.as_str() {
                        lifecycle_value = Some(s.to_string());
                    } else {
                        lifecycle_value = Some(val.to_string());
                    }
                }
            }

            let relations_json_for_update = relations_json_value.clone();
            let relations_json_for_insert = relations_json_value.clone();
            let turn_id_value_for_update = turn_id_value.clone();
            let turn_id_value_for_insert = turn_id_value.clone();
            let message_kind_value_for_update = message_kind_value.clone();
            let message_kind_value_for_insert = message_kind_value.clone();
            let lifecycle_value_for_update = lifecycle_value.clone();
            let lifecycle_value_for_insert = lifecycle_value.clone();

            // SOTA: 获取稳定ID（与save_mistake保持一致）
            let stable_id = message.persistent_stable_id.clone();

            let metadata_json = message
                .metadata
                .as_ref()
                .and_then(|m| serde_json::to_string(m).ok());

            // 有stable_id时：已存在则UPDATE，否则INSERT
            if let Some(stable_id_ref) = stable_id.as_ref().filter(|_| has_stable_id_column) {
                if let Some(&existing_id) = existing_messages.get(stable_id_ref) {
                    // 已存在：执行 UPDATE（包含 thinking_content 等所有字段）
                    matched_ids.insert(existing_id);
                    tx.execute(
                        "UPDATE chat_messages SET role = ?1, content = ?2, timestamp = ?3, thinking_content = ?4, rag_sources = ?5, memory_sources = ?6, graph_sources = ?7, web_search_sources = ?8, image_paths = ?9, image_base64 = ?10, doc_attachments = ?11, tool_call = ?12, tool_result = ?13, overrides = ?14, metadata = ?15, relations = CASE WHEN ?16 THEN ?17 ELSE relations END, turn_id = CASE WHEN ?18 THEN ?19 ELSE turn_id END, turn_seq = CASE WHEN ?20 THEN ?21 ELSE turn_seq END, reply_to_msg_id = CASE WHEN ?22 THEN ?23 ELSE reply_to_msg_id END, message_kind = CASE WHEN ?24 THEN ?25 ELSE message_kind END, lifecycle = CASE WHEN ?26 THEN ?27 ELSE lifecycle END WHERE id = ?28",
                        rusqlite::params![
                            message.role,
                            message.content,
                            message.timestamp.to_rfc3339(),
                            message.thinking_content,
                            rag_sources_json,
                            memory_sources_json,
                            graph_sources_json,
                            web_search_sources_json,
                            image_paths_json,
                            image_base64_json,
                            doc_attachments_json,
                            tool_call_json,
                            tool_result_json,
                            overrides_json,
                            metadata_json.clone(),
                            if relations_update_flag { 1_i64 } else { 0_i64 },
                            relations_json_for_update.clone(),
                            if turn_id_update_flag { 1_i64 } else { 0_i64 },
                            turn_id_value_for_update.clone(),
                            if turn_seq_update_flag { 1_i64 } else { 0_i64 },
                            turn_seq_value,
                            if reply_to_update_flag { 1_i64 } else { 0_i64 },
                            reply_to_value,
                            if message_kind_update_flag { 1_i64 } else { 0_i64 },
                            message_kind_value_for_update.clone(),
                            if lifecycle_update_flag { 1_i64 } else { 0_i64 },
                            lifecycle_value_for_update.clone(),
                            existing_id,
                        ],
                    )?;
                    if message.role == "user" {
                        updated_ids.push(existing_id);
                    }
                    continue;
                } else {
                    tx.execute(
                        "INSERT INTO chat_messages \
                         (mistake_id, role, content, timestamp, thinking_content, rag_sources, memory_sources, graph_sources, web_search_sources, image_paths, image_base64, doc_attachments, tool_call, tool_result, overrides, relations, turn_id, turn_seq, reply_to_msg_id, message_kind, lifecycle, stable_id, metadata) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
                        rusqlite::params![
                            mistake_id,
                            message.role,
                            message.content,
                            message.timestamp.to_rfc3339(),
                            message.thinking_content,
                            rag_sources_json,
                            memory_sources_json,
                            graph_sources_json,
                            web_search_sources_json,
                            image_paths_json,
                            image_base64_json,
                            doc_attachments_json,
                            tool_call_json,
                            tool_result_json,
                            overrides_json,
                            relations_json_for_insert.clone(),
                            turn_id_value_for_insert.clone(),
                            turn_seq_value,
                            reply_to_value,
                            message_kind_value_for_insert.clone(),
                            lifecycle_value_for_insert.clone(),
                            stable_id_ref,
                            metadata_json.clone(),
                        ],
                    )?;
                    let new_id = tx.last_insert_rowid();
                    if message.role == "user" {
                        inserted_ids.push(new_id);
                    }
                }
            } else {
                if message.role == "assistant" {
                    assistant_count += 1;
                } else if message.role == "tool" {
                    tool_count += 1;
                } else {
                    other_count += 1;
                }

                if stable_id.is_none() {
                    missing_stable_id_count += 1;
                }

                // 兼容模式：列不存在或没有 stable_id，直接 INSERT
                if has_stable_id_column {
                    tx.execute(
                    "INSERT INTO chat_messages \
                     (mistake_id, role, content, timestamp, thinking_content, rag_sources, memory_sources, graph_sources, web_search_sources, image_paths, image_base64, doc_attachments, tool_call, tool_result, overrides, relations, turn_id, turn_seq, reply_to_msg_id, message_kind, lifecycle, stable_id, metadata) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, NULL, ?22)",
                        rusqlite::params![
                            mistake_id,
                            message.role,
                            message.content,
                            message.timestamp.to_rfc3339(),
                            message.thinking_content,
                            rag_sources_json,
                            memory_sources_json,
                            graph_sources_json,
                            web_search_sources_json,
                            image_paths_json,
                            image_base64_json,
                            doc_attachments_json,
                            tool_call_json,
                            tool_result_json,
                            overrides_json,
                            relations_json_for_insert,
                            turn_id_value_for_insert,
                            turn_seq_value,
                            reply_to_value,
                            message_kind_value_for_insert,
                            lifecycle_value_for_insert,
                            metadata_json.clone(),
                        ],
                    )?;
                } else {
                    tx.execute(
                    "INSERT INTO chat_messages \
                     (mistake_id, role, content, timestamp, thinking_content, rag_sources, memory_sources, graph_sources, web_search_sources, image_paths, image_base64, doc_attachments, tool_call, tool_result, overrides, relations, turn_id, turn_seq, reply_to_msg_id, message_kind, lifecycle, metadata) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                    rusqlite::params![
                        mistake_id,
                        message.role,
                        message.content,
                        message.timestamp.to_rfc3339(),
                        message.thinking_content,
                        rag_sources_json,
                        memory_sources_json,
                        graph_sources_json,
                        web_search_sources_json,
                        image_paths_json,
                        image_base64_json,
                        doc_attachments_json,
                        tool_call_json,
                        tool_result_json,
                        overrides_json,
                        relations_json_for_insert,
                        turn_id_value_for_insert,
                        turn_seq_value,
                        reply_to_value,
                        message_kind_value_for_insert,
                        lifecycle_value_for_insert,
                            metadata_json.clone(),
                    ],
                )?;
                }
                if message.role == "user" {
                    inserted_ids.push(tx.last_insert_rowid());
                }
            }
            if latest_ts.map_or(true, |t: DateTime<Utc>| message.timestamp > t) {
                latest_ts = Some(message.timestamp);
            }
        }

        if let Some(ts) = latest_ts {
            tx.execute(
                "UPDATE mistakes SET updated_at = ?1, last_accessed_at = ?1 WHERE id = ?2",
                rusqlite::params![ts.to_rfc3339(), mistake_id],
            )?;
        }

        self.backfill_turn_metadata(&tx, mistake_id)?;

        // 更新 updated_at（不改变其他字段）
        tx.execute(
            "UPDATE mistakes SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), mistake_id],
        )?;

        // 若无新的消息，保持最近访问时间
        if latest_ts.is_none() {
            tx.execute(
                "UPDATE mistakes SET updated_at = CURRENT_TIMESTAMP, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?1",
                rusqlite::params![mistake_id],
            )?;
        }

        tx.commit()?;

        let skipped_count = messages.len() - (updated_ids.len() + inserted_ids.len());
        if skipped_count > 0 {
            log::debug!(
                "[Append-NoChange] 跳过 {} 条无变更消息 (mistake_id={})",
                skipped_count,
                mistake_id
            );
        }
        if !updated_ids.is_empty() {
            log::debug!(
                "[Append-Updated] 更新 {} 条已变更消息 (mistake_id={})",
                updated_ids.len(),
                mistake_id
            );
        }
        if !inserted_ids.is_empty() {
            log::debug!(
                "[Append-Inserted] 插入 {} 条新消息 (mistake_id={})",
                inserted_ids.len(),
                mistake_id
            );
        }

        Ok(AppendMessagesChangeSet {
            updated_user_message_ids: updated_ids,
            inserted_user_message_ids: inserted_ids,
            assistant_message_count: assistant_count,
            tool_message_count: tool_count,
            other_message_count: other_count,
            missing_stable_id_count,
            total_processed: messages.len(),
        })
    }

    pub fn mark_chat_embedding_retry(&self, ids: &[i64], pending: bool) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let value = if pending { 1 } else { 0 };
        let conn = self.get_conn_safe()?;
        for id in ids {
            let _ = conn.execute(
                "UPDATE chat_messages SET embedding_retry = ?1 WHERE id = ?2",
                rusqlite::params![value, id],
            );
        }
        Ok(())
    }

    pub fn delete_chat_embeddings_by_ids(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.get_conn_safe()?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "DELETE FROM chat_user_embeddings WHERE message_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(ids.iter());
        conn.execute(&sql, params)?;
        Ok(())
    }

    pub fn list_turn_message_ids(
        &self,
        mistake_id: &str,
        turn_id: &str,
        include_user: bool,
    ) -> Result<Vec<i64>> {
        let conn = self.get_conn_safe()?;
        let sql = if include_user {
            "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2"
        } else {
            "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2 \
             AND (turn_seq = 1 OR (turn_seq IS NULL AND role != 'user'))"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(rusqlite::params![mistake_id, turn_id], |row| {
                Ok(row.get::<_, i64>(0)?)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 按回合删除：根据 turn_id 删除消息
    /// - delete_user=true 删除整回合（user+assistant）
    /// - 否则仅删 assistant（turn_seq=1）
    pub fn delete_chat_turn(
        &self,
        mistake_id: &str,
        turn_id: &str,
        delete_user: bool,
    ) -> Result<usize> {
        let mut conn = self.get_conn_safe()?;
        let tx = conn.transaction()?;
        let affected = if delete_user {
            tx.execute(
                "DELETE FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2",
                rusqlite::params![mistake_id, turn_id],
            )?
        } else {
            tx.execute(
                "DELETE FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2 AND turn_seq = 1",
                rusqlite::params![mistake_id, turn_id],
            )?
        };
        tx.execute(
            "UPDATE mistakes SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), mistake_id],
        )?;
        tx.commit()?;
        Ok(affected)
    }

    /// 按回合删除（详细返回）
    pub fn delete_chat_turn_detail(
        &self,
        mistake_id: &str,
        turn_id: &str,
        delete_user: bool,
    ) -> Result<crate::models::DeleteChatTurnResult> {
        let mut conn = self.get_conn_safe()?;
        let tx = conn.transaction()?;

        // 统计当前回合的 user/assistant 存在性
        let user_exists: i64 = tx.query_row(
            "SELECT COUNT(1) FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2 AND turn_seq = 0",
            rusqlite::params![mistake_id, turn_id],
            |r| r.get(0),
        )?;
        let assistant_exists: i64 = tx.query_row(
            "SELECT COUNT(1) FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2 AND turn_seq = 1",
            rusqlite::params![mistake_id, turn_id],
            |r| r.get(0),
        )?;

        let affected = if delete_user {
            tx.execute(
                "DELETE FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2",
                rusqlite::params![mistake_id, turn_id],
            )?
        } else {
            tx.execute(
                "DELETE FROM chat_messages WHERE mistake_id = ?1 AND turn_id = ?2 AND turn_seq = 1",
                rusqlite::params![mistake_id, turn_id],
            )?
        };

        tx.execute(
            "UPDATE mistakes SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), mistake_id],
        )?;
        tx.commit()?;

        let mut note: Option<String> = None;
        if delete_user && user_exists > 0 && assistant_exists == 0 {
            note = Some("无助手侧".to_string());
        }
        log::debug!(
            "[删除回合] mistake_id={}, turn_id={}, delete_user={}, deleted_count={}, note={:?}",
            mistake_id,
            turn_id,
            delete_user,
            affected,
            note
        );

        Ok(crate::models::DeleteChatTurnResult {
            mistake_id: mistake_id.to_string(),
            turn_id: turn_id.to_string(),
            deleted_count: affected as usize,
            full_turn_deleted: delete_user,
            note,
        })
    }

    /// 修复未配对的回合（根据时间顺序重新分配 turn_id 并配对）
    pub fn repair_unpaired_turns(&self, mistake_id: &str) -> Result<usize> {
        let mut conn = self.get_conn_safe()?;
        let tx = conn.transaction()?;

        let mut fixed = 0usize;

        // 为所有未配对的 user 分配 turn_id（若缺失）
        {
            let mut users_stmt = tx.prepare(
                "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND role = 'user' AND (turn_id IS NULL OR turn_id = '') ORDER BY timestamp ASC",
            )?;
            let user_rows: Vec<i64> = users_stmt
                .query_map(rusqlite::params![mistake_id], |row| {
                    Ok(row.get::<_, i64>(0)?)
                })?
                .collect::<std::result::Result<_, _>>()?;
            drop(users_stmt);
            for user_row_id in user_rows {
                let turn_id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "UPDATE chat_messages SET turn_id = ?1, turn_seq = 0, reply_to_msg_id = NULL, message_kind = COALESCE(message_kind, 'user.input') WHERE id = ?2",
                    rusqlite::params![turn_id, user_row_id],
                )?;
                fixed += 1;
            }
        }

        // 为所有未配对的 assistant 绑定到最近一个尚未有助手的 user 回合
        {
            let mut assistants_stmt = tx.prepare(
                "SELECT id FROM chat_messages WHERE mistake_id = ?1 AND role = 'assistant' AND (turn_id IS NULL OR turn_id = '') ORDER BY timestamp ASC",
            )?;
            let assistant_rows: Vec<i64> = assistants_stmt
                .query_map(rusqlite::params![mistake_id], |row| {
                    Ok(row.get::<_, i64>(0)?)
                })?
                .collect::<std::result::Result<_, _>>()?;
            drop(assistants_stmt);
            for assistant_row_id in assistant_rows {
                let candidate: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT u.id, u.turn_id \
                         FROM chat_messages u \
                         WHERE u.mistake_id = ?1 AND u.role = 'user' AND u.turn_id IS NOT NULL AND u.turn_id <> '' \
                           AND NOT EXISTS (SELECT 1 FROM chat_messages a WHERE a.mistake_id = ?1 AND a.role = 'assistant' AND a.turn_id = u.turn_id) \
                         ORDER BY u.timestamp DESC LIMIT 1",
                        rusqlite::params![mistake_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((user_row_id, turn_id)) = candidate {
                    tx.execute(
                        "UPDATE chat_messages SET turn_id = ?1, turn_seq = 1, reply_to_msg_id = ?2, message_kind = COALESCE(message_kind, 'assistant.answer'), lifecycle = COALESCE(lifecycle, 'complete') WHERE id = ?3",
                        rusqlite::params![turn_id, user_row_id, assistant_row_id],
                    )?;
                    fixed += 1;
                } else {
                    log::warn!(
                        "[回合修复] 仍有孤儿助手消息，mistake_id={}, assistant_row_id={}",
                        mistake_id,
                        assistant_row_id
                    );
                }
            }
        }

        tx.execute(
            "UPDATE mistakes SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), mistake_id],
        )?;

        tx.commit()?;
        log::debug!(
            "[repair_unpaired_turns] mistake_id={}, 修复条目数={}",
            mistake_id,
            fixed
        );
        Ok(fixed)
    }

    /// 管理工具：列出孤儿助手行（无 reply_to_msg_id）
    pub fn list_orphan_assistants(
        &self,
        limit: usize,
    ) -> Result<Vec<crate::models::OrphanAssistantRow>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, mistake_id, timestamp, content FROM chat_messages WHERE role = 'assistant' AND (reply_to_msg_id IS NULL) ORDER BY timestamp DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
            let ts: String = row.get(2)?;
            let ts_parsed = chrono::DateTime::parse_from_rfc3339(&ts)
                .map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        2,
                        "timestamp".to_string(),
                        rusqlite::types::Type::Text,
                    )
                })?
                .with_timezone(&Utc);
            let content: String = row.get(3)?;
            let preview = content.chars().take(80).collect::<String>();
            Ok(crate::models::OrphanAssistantRow {
                id: row.get(0)?,
                mistake_id: row.get(1)?,
                timestamp: ts_parsed,
                content_preview: preview,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 管理工具：列出遗留 tool 行样本
    pub fn list_tool_rows_for_review(
        &self,
        limit: usize,
    ) -> Result<Vec<crate::models::ToolRowSample>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, mistake_id, timestamp, role, content FROM chat_messages WHERE role = 'tool' ORDER BY timestamp DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
            let ts: String = row.get(2)?;
            let ts_parsed = chrono::DateTime::parse_from_rfc3339(&ts)
                .map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        2,
                        "timestamp".to_string(),
                        rusqlite::types::Type::Text,
                    )
                })?
                .with_timezone(&Utc);
            let content: String = row.get(4)?;
            let preview = content.chars().take(80).collect::<String>();
            Ok(crate::models::ToolRowSample {
                id: row.get(0)?,
                mistake_id: row.get(1)?,
                timestamp: ts_parsed,
                role: row.get(3)?,
                content_preview: preview,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 保存设置
    pub fn save_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// 获取设置
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.get_conn_safe()?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    /// 删除设置
    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.get_conn_safe()?;
        let changes = conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(changes > 0)
    }

    /// 按前缀查询设置（用于工具权限管理等批量查询场景）
    pub fn get_settings_by_prefix(&self, prefix: &str) -> Result<Vec<(String, String, String)>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT key, value, updated_at FROM settings WHERE key LIKE ?1 ORDER BY updated_at DESC",
        )?;
        let pattern = format!("{}%", prefix);
        let rows = stmt.query_map(params![pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 按前缀批量删除设置
    pub fn delete_settings_by_prefix(&self, prefix: &str) -> Result<usize> {
        let conn = self.get_conn_safe()?;
        let pattern = format!("{}%", prefix);
        let changes = conn.execute("DELETE FROM settings WHERE key LIKE ?1", params![pattern])?;
        Ok(changes)
    }

    /// 新增：持久化流式上下文（首轮分析的缓存数据）
    pub fn upsert_temp_session(&self, session: &StreamContext) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let session_json =
            serde_json::to_string(session).context("Failed to serialize stream context")?;
        let now = Utc::now().to_rfc3339();
        let last_error = session.last_error.as_deref();
        conn.execute(
            "INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(temp_id) DO UPDATE SET
                session_data=excluded.session_data,
                stream_state=excluded.stream_state,
                updated_at=excluded.updated_at,
                last_error=excluded.last_error",
            params![
                &session.temp_id,
                session_json,
                session.stream_state.as_str(),
                session.created_at.to_rfc3339(),
                now,
                last_error,
            ],
        )?;
        Ok(())
    }

    /// 读取流式上下文（首轮分析的缓存数据）
    pub fn get_temp_session_record(&self, temp_id: &str) -> Result<Option<StreamContext>> {
        let conn = self.get_conn_safe()?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT session_data FROM temp_sessions WHERE temp_id = ?1",
                params![temp_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(json) = raw {
            let session: StreamContext =
                serde_json::from_str(&json).context("Failed to deserialize stream context")?;
            // 兼容旧数据：默认状态为 in_progress
            if matches!(session.stream_state, TempStreamState::InProgress) {
                // no-op, exists for clarity
            }
            Ok(Some(session))
        } else {
            Ok(None)
        }
    }

    /// 删除临时会话记录
    pub fn delete_temp_session_record(&self, temp_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let _ = conn.execute(
            "DELETE FROM temp_sessions WHERE temp_id = ?1",
            params![temp_id],
        )?;
        Ok(())
    }

    /// 保存敏感设置（优先使用安全存储）
    pub fn save_secret(&self, key: &str, value: &str) -> Result<()> {
        // 检查是否为敏感键
        if SecureStore::is_sensitive_key(key) {
            if let Some(ref secure_store) = self.secure_store {
                match secure_store.save_secret(key, value) {
                    Ok(_) => {
                        // 成功保存到安全存储，从数据库删除明文（如果存在）
                        let _ = self.delete_setting(key);
                        return Ok(());
                    }
                    Err(e) => {
                        // 安全存储失败，记录警告并回退到数据库
                        if secure_store.get_config().warn_on_fallback {
                            log::warn!("安全存储失败，回退到明文存储: {} - {}", key, e);
                        }
                    }
                }
            }
        }

        // 回退到普通数据库存储
        self.save_setting(key, value)
    }

    /// 获取敏感设置（优先从安全存储获取）
    pub fn get_secret(&self, key: &str) -> Result<Option<String>> {
        // 检查是否为敏感键且安全存储可用
        if SecureStore::is_sensitive_key(key) {
            if let Some(ref secure_store) = self.secure_store {
                match secure_store.get_secret(key) {
                    Ok(Some(value)) => {
                        // 从安全存储成功获取
                        return Ok(Some(value));
                    }
                    Ok(None) => {
                        // 安全存储中没有，继续尝试数据库
                    }
                    Err(e) => {
                        // 安全存储访问失败，记录警告并回退
                        log::warn!("安全存储读取失败，回退到数据库: {} - {}", key, e);
                    }
                }
            }
        }

        // 回退到普通数据库存储
        self.get_setting(key)
    }

    /// 删除敏感设置（同时从安全存储和数据库删除）
    pub fn delete_secret(&self, key: &str) -> Result<bool> {
        let mut deleted = false;

        // 从安全存储删除
        if SecureStore::is_sensitive_key(key) {
            if let Some(ref secure_store) = self.secure_store {
                if let Err(e) = secure_store.delete_secret(key) {
                    log::warn!("从安全存储删除失败: {} - {}", key, e);
                } else {
                    deleted = true;
                }
            }
        }

        // 从数据库删除
        let db_deleted = self.delete_setting(key)?;

        Ok(deleted || db_deleted)
    }

    // ================= Research reports =================

    pub fn insert_research_report(
        &self,
        subject: &str,
        segments: i32,
        context_window: i32,
        report: &str,
        metadata_json: Option<&str>,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.get_conn_safe()?;
        conn.execute(
            "INSERT INTO research_reports (id, subject, created_at, segments, context_window, report, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, subject, chrono::Utc::now().to_rfc3339(), segments, context_window, report, metadata_json]
        )?;
        Ok(id)
    }

    pub fn list_research_reports(
        &self,
        limit: Option<u32>,
    ) -> Result<Vec<crate::models::ResearchReportSummary>> {
        let conn = self.get_conn_safe()?;
        let mut sql = String::from(
            "SELECT id, subject, created_at, segments, context_window FROM research_reports ORDER BY created_at DESC",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if let Some(l) = limit {
            sql.push_str(" LIMIT ?");
            params.push(Box::new(l as i64));
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| {
                let created_at_str: String = row.get(2)?;
                let created_at = parse_datetime_flexible(&created_at_str)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(crate::models::ResearchReportSummary {
                    id: row.get(0)?,
                    created_at,
                    segments: row.get(3)?,
                    context_window: row.get(4)?,
                })
            },
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_research_report(&self, id: &str) -> Result<Option<crate::models::ResearchReport>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare("SELECT id, subject, created_at, segments, context_window, report, metadata FROM research_reports WHERE id = ?1")?;
        let opt = stmt
            .query_row(params![id], |row| {
                let created_at_str: String = row.get(2)?;
                let created_at = parse_datetime_flexible(&created_at_str)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let metadata_str: Option<String> = row.get(6).ok();
                Ok(crate::models::ResearchReport {
                    id: row.get(0)?,
                    created_at,
                    segments: row.get(3)?,
                    context_window: row.get(4)?,
                    report: row.get(5)?,
                    metadata: metadata_str.and_then(|s| serde_json::from_str(&s).ok()),
                })
            })
            .optional()?;
        Ok(opt)
    }

    pub fn delete_research_report(&self, id: &str) -> Result<bool> {
        let conn = self.get_conn_safe()?;
        let n = conn.execute("DELETE FROM research_reports WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // 文档31清理：所有 get_*_prompts 函数已删除，SubjectPrompts 类型已废弃

    /// 保存模型分配配置
    pub fn save_model_assignments(
        &self,
        assignments: &crate::models::ModelAssignments,
    ) -> Result<()> {
        let assignments_json = serde_json::to_string(assignments)?;
        self.save_setting("model_assignments", &assignments_json)
    }

    /// 获取模型分配配置
    pub fn get_model_assignments(&self) -> Result<Option<crate::models::ModelAssignments>> {
        match self.get_setting("model_assignments")? {
            Some(json_str) => {
                let assignments: crate::models::ModelAssignments = serde_json::from_str(&json_str)?;
                Ok(Some(assignments))
            }
            None => Ok(None),
        }
    }

    /// 保存API配置列表
    pub fn save_api_configs(&self, configs: &[crate::llm_manager::ApiConfig]) -> Result<()> {
        let configs_json = serde_json::to_string(configs)?;
        self.save_setting("api_configs", &configs_json)
    }

    /// 获取API配置列表
    pub fn get_api_configs(&self) -> Result<Vec<crate::llm_manager::ApiConfig>> {
        match self.get_setting("api_configs")? {
            Some(json_str) => {
                let configs: Vec<crate::llm_manager::ApiConfig> = serde_json::from_str(&json_str)?;
                // 兼容旧字段（supports_tools）已在反序列化时通过别名处理，这里无需额外转换。
                Ok(configs)
            }
            None => Ok(Vec::new()),
        }
    }

    // =================== Anki Enhancement Functions ===================

    /// 插入文档任务
    /// 🔧 兼容性处理：支持新旧两种表结构（有/无 subject_name 字段）
    pub fn insert_document_task(&self, task: &DocumentTask) -> Result<()> {
        tracing::info!(
            "[insert_document_task] task_id={}, document_id={}, doc_name={}, db_path={:?}",
            task.id,
            task.document_id,
            task.original_document_name,
            self.db_path()
        );
        let conn = self.get_conn_safe()?;

        // 检查表是否还有旧的 subject_name 字段
        let has_subject_name: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='subject_name'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if has_subject_name {
            // 旧表结构：包含 subject_name 字段，使用默认值 "通用"
            conn.execute(
                "INSERT INTO document_tasks
                 (id, document_id, original_document_name, subject_name, segment_index, content_segment,
                  status, created_at, updated_at, error_message, anki_generation_options_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    task.id,
                    task.document_id,
                    task.original_document_name,
                    "通用", // 默认值，兼容旧表结构
                    task.segment_index,
                    task.content_segment,
                    task.status.to_db_string(),
                    task.created_at,
                    task.updated_at,
                    task.error_message,
                    task.anki_generation_options_json
                ]
            )?;
        } else {
            // 新表结构：不包含 subject_name 字段
            conn.execute(
                "INSERT INTO document_tasks
                 (id, document_id, original_document_name, segment_index, content_segment,
                  status, created_at, updated_at, error_message, anki_generation_options_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    task.id,
                    task.document_id,
                    task.original_document_name,
                    task.segment_index,
                    task.content_segment,
                    task.status.to_db_string(),
                    task.created_at,
                    task.updated_at,
                    task.error_message,
                    task.anki_generation_options_json
                ],
            )?;
        }
        Ok(())
    }

    /// 🔧 Phase 1: 为指定 document_id 的所有任务设置 source_session_id
    pub fn set_document_session_source(&self, document_id: &str, session_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        // 确保列存在
        let _ = conn.execute(
            "ALTER TABLE document_tasks ADD COLUMN source_session_id TEXT",
            [],
        );
        conn.execute(
            "UPDATE document_tasks SET source_session_id = ?1 WHERE document_id = ?2 AND source_session_id IS NULL",
            params![session_id, document_id],
        )?;
        Ok(())
    }

    /// 读取 document_id 对应的 source_session_id（如果有）
    pub fn get_document_session_source(&self, document_id: &str) -> Result<Option<String>> {
        let conn = self.get_conn_safe()?;
        // 兼容旧库：列不存在时先补齐
        let _ = conn.execute(
            "ALTER TABLE document_tasks ADD COLUMN source_session_id TEXT",
            [],
        );
        let source = conn
            .query_row(
                "SELECT source_session_id FROM document_tasks WHERE document_id = ?1 AND source_session_id IS NOT NULL LIMIT 1",
                params![document_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(source)
    }

    /// 原子保存一个文档任务及其卡片，避免出现“任务已完成但卡片部分写入”的不一致状态
    pub fn save_document_task_with_cards_atomic(
        &self,
        task: &DocumentTask,
        cards: &[AnkiCard],
    ) -> Result<Vec<String>> {
        let mut conn = self.get_conn_safe()?;
        let tx = conn.transaction()?;

        let has_subject_name: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='subject_name'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if has_subject_name {
            tx.execute(
                "INSERT INTO document_tasks
                 (id, document_id, original_document_name, subject_name, segment_index, content_segment,
                  status, created_at, updated_at, error_message, anki_generation_options_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    task.id,
                    task.document_id,
                    task.original_document_name,
                    "通用",
                    task.segment_index,
                    task.content_segment,
                    task.status.to_db_string(),
                    task.created_at,
                    task.updated_at,
                    task.error_message,
                    task.anki_generation_options_json
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO document_tasks
                 (id, document_id, original_document_name, segment_index, content_segment,
                  status, created_at, updated_at, error_message, anki_generation_options_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    task.id,
                    task.document_id,
                    task.original_document_name,
                    task.segment_index,
                    task.content_segment,
                    task.status.to_db_string(),
                    task.created_at,
                    task.updated_at,
                    task.error_message,
                    task.anki_generation_options_json
                ],
            )?;
        }

        let mut saved_ids = Vec::with_capacity(cards.len());
        for card in cards {
            let rows_affected = tx.execute(
                "INSERT OR IGNORE INTO anki_cards
                 (id, task_id, front, back, text, tags_json, images_json,
                  is_error_card, error_content, card_order_in_task, created_at, updated_at,
                  extra_fields_json, template_id, source_type, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    card.id,
                    card.task_id,
                    card.front,
                    card.back,
                    card.text,
                    serde_json::to_string(&card.tags)?,
                    serde_json::to_string(&card.images)?,
                    if card.is_error_card { 1 } else { 0 },
                    card.error_content,
                    0,
                    card.created_at,
                    card.updated_at,
                    serde_json::to_string(&card.extra_fields)?,
                    card.template_id,
                    "document",
                    task.document_id
                ],
            )?;
            if rows_affected > 0 {
                saved_ids.push(card.id.clone());
            }
        }

        if !cards.is_empty() && saved_ids.is_empty() {
            return Err(anyhow::anyhow!(
                "no_cards_saved_in_atomic_insert: all cards were ignored"
            ));
        }

        tx.commit()?;
        Ok(saved_ids)
    }

    /// 更新文档任务状态
    pub fn update_document_task_status(
        &self,
        task_id: &str,
        status: TaskStatus,
        error_message: Option<String>,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE document_tasks SET status = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                status.to_db_string(),
                error_message,
                updated_at,
                task_id
            ]
        )?;
        Ok(())
    }

    /// 获取单个文档任务
    pub fn get_document_task(&self, task_id: &str) -> Result<DocumentTask> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, document_id, original_document_name, segment_index, content_segment,
                    status, created_at, updated_at, error_message, anki_generation_options_json
             FROM document_tasks WHERE id = ?1",
        )?;

        let task = stmt.query_row(params![task_id], |row| {
            let status_str: String = row.get(5)?;
            let status: TaskStatus = TaskStatus::from_str(&status_str);
            Ok(DocumentTask {
                id: row.get(0)?,
                document_id: row.get(1)?,
                original_document_name: row.get(2)?,
                segment_index: row.get(3)?,
                content_segment: row.get(4)?,
                status,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                error_message: row.get(8)?,
                anki_generation_options_json: row.get(9)?,
            })
        })?;

        Ok(task)
    }

    /// 获取指定文档的所有任务
    pub fn get_tasks_for_document(&self, document_id: &str) -> Result<Vec<DocumentTask>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, document_id, original_document_name, segment_index, content_segment,
                    status, created_at, updated_at, error_message, anki_generation_options_json
             FROM document_tasks WHERE document_id = ?1 ORDER BY segment_index",
        )?;

        let task_iter = stmt.query_map(params![document_id], |row| {
            let status_str: String = row.get(5)?;
            let status: TaskStatus = TaskStatus::from_str(&status_str);
            Ok(DocumentTask {
                id: row.get(0)?,
                document_id: row.get(1)?,
                original_document_name: row.get(2)?,
                segment_index: row.get(3)?,
                content_segment: row.get(4)?,
                status,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                error_message: row.get(8)?,
                anki_generation_options_json: row.get(9)?,
            })
        })?;

        let mut tasks = Vec::new();
        for task in task_iter {
            tasks.push(task?);
        }

        Ok(tasks)
    }

    /// 插入Anki卡片（返回是否成功插入）
    pub fn insert_anki_card(&self, card: &AnkiCard) -> Result<bool> {
        let conn = self.get_conn_safe()?;
        let document_id: Option<String> = conn
            .query_row(
                "SELECT document_id FROM document_tasks WHERE id = ?1",
                params![card.task_id],
                |row| row.get(0),
            )
            .optional()?;
        let (source_type, source_id) = if let Some(document_id) = document_id {
            ("document".to_string(), document_id)
        } else {
            ("task".to_string(), card.task_id.clone())
        };

        let rows_affected = conn.execute(
            "INSERT OR IGNORE INTO anki_cards
             (id, task_id, front, back, text, tags_json, images_json,
              is_error_card, error_content, card_order_in_task, created_at, updated_at,
              extra_fields_json, template_id, source_type, source_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                card.id,
                card.task_id,
                card.front,
                card.back,
                card.text,
                serde_json::to_string(&card.tags)?,
                serde_json::to_string(&card.images)?,
                if card.is_error_card { 1 } else { 0 },
                card.error_content,
                0, // card_order_in_task will be calculated
                card.created_at,
                card.updated_at,
                serde_json::to_string(&card.extra_fields)?,
                card.template_id,
                source_type,
                source_id
            ],
        )?;
        Ok(rows_affected > 0)
    }

    /// 获取指定任务的所有卡片
    pub fn get_cards_for_task(&self, task_id: &str) -> Result<Vec<AnkiCard>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, task_id, front, back, text, tags_json, images_json,
                    is_error_card, error_content, created_at, updated_at,
                    COALESCE(extra_fields_json, '{}') as extra_fields_json,
                    template_id
             FROM anki_cards WHERE task_id = ?1 ORDER BY card_order_in_task, created_at",
        )?;

        let card_iter = stmt.query_map(params![task_id], |row| {
            let tags_json: String = row.get(5)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

            let images_json: String = row.get(6)?;
            let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();

            let extra_fields_json: String = row.get(11)?;
            let extra_fields: std::collections::HashMap<String, String> =
                serde_json::from_str(&extra_fields_json).unwrap_or_default();

            Ok(AnkiCard {
                id: row.get(0)?,
                task_id: row.get(1)?,
                front: row.get(2)?,
                back: row.get(3)?,
                text: row.get(4)?,
                tags,
                images,
                is_error_card: row.get::<_, i32>(7)? != 0,
                error_content: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                extra_fields,
                template_id: row.get(12)?,
            })
        })?;

        let mut cards = Vec::new();
        for card in card_iter {
            cards.push(card?);
        }

        Ok(cards)
    }

    /// 获取指定文档的所有卡片
    pub fn get_cards_for_document(&self, document_id: &str) -> Result<Vec<AnkiCard>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT ac.id, ac.task_id, ac.front, ac.back, ac.text, ac.tags_json, ac.images_json,
                    ac.is_error_card, ac.error_content, ac.created_at, ac.updated_at,
                    COALESCE(ac.extra_fields_json, '{}') as extra_fields_json,
                    ac.template_id
             FROM anki_cards ac
             JOIN document_tasks dt ON ac.task_id = dt.id
             WHERE dt.document_id = ?1
             ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at",
        )?;

        let card_iter = stmt.query_map(params![document_id], |row| {
            let tags_json: String = row.get(5)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

            let images_json: String = row.get(6)?;
            let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();

            let extra_fields_json: String = row.get(11)?;
            let extra_fields: std::collections::HashMap<String, String> =
                serde_json::from_str(&extra_fields_json).unwrap_or_default();

            Ok(AnkiCard {
                id: row.get(0)?,
                task_id: row.get(1)?,
                front: row.get(2)?,
                back: row.get(3)?,
                text: row.get(4)?,
                tags,
                images,
                is_error_card: row.get::<_, i32>(7)? != 0,
                error_content: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                extra_fields,
                template_id: row.get(12)?,
            })
        })?;

        let mut cards = Vec::new();
        for card in card_iter {
            cards.push(card?);
        }

        Ok(cards)
    }

    /// 根据ID列表获取卡片
    pub fn get_cards_by_ids(&self, card_ids: &[String]) -> Result<Vec<AnkiCard>> {
        if card_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.get_conn_safe()?;
        let placeholders: Vec<&str> = card_ids.iter().map(|_| "?").collect();
        let sql = format!(
            "SELECT id, task_id, front, back, text, tags_json, images_json,
                    is_error_card, error_content, created_at, updated_at,
                    COALESCE(extra_fields_json, '{{}}') as extra_fields_json,
                    template_id
             FROM anki_cards WHERE id IN ({}) ORDER BY created_at",
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let card_iter = stmt.query_map(rusqlite::params_from_iter(card_ids), |row| {
            let tags_json: String = row.get(5)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

            let images_json: String = row.get(6)?;
            let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();

            let extra_fields_json: String = row.get(11)?;
            let extra_fields: std::collections::HashMap<String, String> =
                serde_json::from_str(&extra_fields_json).unwrap_or_default();

            Ok(AnkiCard {
                id: row.get(0)?,
                task_id: row.get(1)?,
                front: row.get(2)?,
                back: row.get(3)?,
                text: row.get(4)?,
                tags,
                images,
                is_error_card: row.get::<_, i32>(7)? != 0,
                error_content: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                extra_fields,
                template_id: row.get(12)?,
            })
        })?;

        let mut cards = Vec::new();
        for card in card_iter {
            cards.push(card?);
        }

        Ok(cards)
    }

    /// 更新Anki卡片
    pub fn update_anki_card(&self, card: &AnkiCard) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE anki_cards SET
             front = ?1, back = ?2, text = ?3, tags_json = ?4, images_json = ?5,
             is_error_card = ?6, error_content = ?7, updated_at = ?8,
             extra_fields_json = ?9, template_id = ?10
             WHERE id = ?11",
            params![
                card.front,
                card.back,
                card.text,
                serde_json::to_string(&card.tags)?,
                serde_json::to_string(&card.images)?,
                if card.is_error_card { 1 } else { 0 },
                card.error_content,
                updated_at,
                serde_json::to_string(&card.extra_fields)?,
                card.template_id,
                card.id
            ],
        )?;
        Ok(())
    }

    /// 删除Anki卡片
    pub fn delete_anki_card(&self, card_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        conn.execute("DELETE FROM anki_cards WHERE id = ?1", params![card_id])?;
        Ok(())
    }

    /// 删除文档任务及其所有卡片
    pub fn delete_document_task(&self, task_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        // 由于设置了ON DELETE CASCADE，删除任务会自动删除关联的卡片
        conn.execute("DELETE FROM document_tasks WHERE id = ?1", params![task_id])?;
        Ok(())
    }

    /// 删除整个文档会话（所有任务和卡片）
    pub fn delete_document_session(&self, document_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        // 由于设置了ON DELETE CASCADE，删除任务会自动删除关联的卡片
        conn.execute(
            "DELETE FROM document_tasks WHERE document_id = ?1",
            params![document_id],
        )?;
        Ok(())
    }

    // ==================== RAG配置管理 ====================

    /// 获取RAG配置
    pub fn get_rag_configuration(&self) -> Result<Option<crate::models::RagConfiguration>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, chunk_size, chunk_overlap, chunking_strategy, min_chunk_size,
                    default_top_k, default_rerank_enabled, created_at, updated_at
             FROM rag_configurations WHERE id = 'default'",
        )?;

        let result = stmt
            .query_row([], |row| {
                let created_at_str: String = row.get(7)?;
                let updated_at_str: String = row.get(8)?;

                let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                    .map_err(|_| {
                        rusqlite::Error::InvalidColumnType(
                            7,
                            "created_at".to_string(),
                            rusqlite::types::Type::Text,
                        )
                    })?
                    .with_timezone(&Utc);
                let updated_at = DateTime::parse_from_rfc3339(&updated_at_str)
                    .map_err(|_| {
                        rusqlite::Error::InvalidColumnType(
                            8,
                            "updated_at".to_string(),
                            rusqlite::types::Type::Text,
                        )
                    })?
                    .with_timezone(&Utc);

                Ok(crate::models::RagConfiguration {
                    id: row.get(0)?,
                    chunk_size: row.get(1)?,
                    chunk_overlap: row.get(2)?,
                    chunking_strategy: row.get(3)?,
                    min_chunk_size: row.get(4)?,
                    default_top_k: row.get(5)?,
                    default_rerank_enabled: row.get::<_, i32>(6)? != 0,
                    created_at,
                    updated_at,
                })
            })
            .optional()?;

        Ok(result)
    }

    /// 更新RAG配置
    pub fn update_rag_configuration(&self, config: &crate::models::RagConfigRequest) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE rag_configurations
             SET chunk_size = ?1, chunk_overlap = ?2, chunking_strategy = ?3,
                 min_chunk_size = ?4, default_top_k = ?5, default_rerank_enabled = ?6,
                 updated_at = ?7
             WHERE id = 'default'",
            params![
                config.chunk_size,
                config.chunk_overlap,
                config.chunking_strategy,
                config.min_chunk_size,
                config.default_top_k,
                if config.default_rerank_enabled { 1 } else { 0 },
                now
            ],
        )?;

        Ok(())
    }

    /// 重置RAG配置为默认值
    pub fn reset_rag_configuration(&self) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE rag_configurations
             SET chunk_size = 512, chunk_overlap = 50, chunking_strategy = 'fixed_size',
                 min_chunk_size = 20, default_top_k = 5, default_rerank_enabled = 1,
                 updated_at = ?1
             WHERE id = 'default'",
            params![now],
        )?;

        Ok(())
    }

    // ==================== RAG分库管理CRUD操作 ====================

    /// 创建新的分库
    pub fn create_sub_library(&self, request: &CreateSubLibraryRequest) -> Result<SubLibrary> {
        let conn = self.get_conn_safe()?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        // 检查名称是否已存在
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE name = ?1)",
            params![request.name],
            |row| row.get(0),
        )?;

        if exists {
            return Err(anyhow::anyhow!("分库名称 '{}' 已存在", request.name));
        }

        conn.execute(
            "INSERT INTO rag_sub_libraries (id, name, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, request.name, request.description, now_str, now_str],
        )?;

        Ok(SubLibrary {
            id,
            name: request.name.clone(),
            description: request.description.clone(),
            created_at: now,
            updated_at: now,
            document_count: 0,
            chunk_count: 0,
        })
    }

    /// 获取所有分库列表
    pub fn list_sub_libraries(&self) -> Result<Vec<SubLibrary>> {
        let conn = self.get_conn_safe()?;

        let mut stmt = conn.prepare(
            "SELECT sl.id, sl.name, sl.description, sl.created_at, sl.updated_at,
                    COUNT(DISTINCT rd.id) as document_count,
                    COUNT(DISTINCT rdc.id) as chunk_count
             FROM rag_sub_libraries sl
             LEFT JOIN rag_documents rd ON sl.id = rd.sub_library_id
             LEFT JOIN rag_document_chunks rdc ON rd.id = rdc.document_id
             GROUP BY sl.id, sl.name, sl.description, sl.created_at, sl.updated_at
             ORDER BY sl.name",
        )?;

        let library_iter = stmt.query_map([], |row| {
            let created_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(3)?)
                .map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        3,
                        "created_at".to_string(),
                        rusqlite::types::Type::Text,
                    )
                })?
                .with_timezone(&Utc);
            let updated_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                .map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        4,
                        "updated_at".to_string(),
                        rusqlite::types::Type::Text,
                    )
                })?
                .with_timezone(&Utc);

            Ok(SubLibrary {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at,
                updated_at,
                document_count: row.get::<_, i64>(5)? as usize,
                chunk_count: row.get::<_, i64>(6)? as usize,
            })
        })?;

        let mut libraries = Vec::new();
        for library in library_iter {
            libraries.push(library?);
        }

        Ok(libraries)
    }

    /// 根据ID获取分库详情
    pub fn get_sub_library_by_id(&self, id: &str) -> Result<Option<SubLibrary>> {
        let conn = self.get_conn_safe()?;

        let result = conn
            .query_row(
                "SELECT sl.id, sl.name, sl.description, sl.created_at, sl.updated_at,
                    COUNT(DISTINCT rd.id) as document_count,
                    COUNT(DISTINCT rdc.id) as chunk_count
             FROM rag_sub_libraries sl
             LEFT JOIN rag_documents rd ON sl.id = rd.sub_library_id
             LEFT JOIN rag_document_chunks rdc ON rd.id = rdc.document_id
             WHERE sl.id = ?1
             GROUP BY sl.id, sl.name, sl.description, sl.created_at, sl.updated_at",
                params![id],
                |row| {
                    let created_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(3)?)
                        .map_err(|_| {
                            rusqlite::Error::InvalidColumnType(
                                3,
                                "created_at".to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?
                        .with_timezone(&Utc);
                    let updated_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map_err(|_| {
                            rusqlite::Error::InvalidColumnType(
                                4,
                                "updated_at".to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?
                        .with_timezone(&Utc);

                    Ok(SubLibrary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        created_at,
                        updated_at,
                        document_count: row.get::<_, i64>(5)? as usize,
                        chunk_count: row.get::<_, i64>(6)? as usize,
                    })
                },
            )
            .optional()?;

        Ok(result)
    }

    /// 根据名称获取分库详情
    pub fn get_sub_library_by_name(&self, name: &str) -> Result<Option<SubLibrary>> {
        let conn = self.get_conn_safe()?;

        let result = conn
            .query_row(
                "SELECT sl.id, sl.name, sl.description, sl.created_at, sl.updated_at,
                    COUNT(DISTINCT rd.id) as document_count,
                    COUNT(DISTINCT rdc.id) as chunk_count
             FROM rag_sub_libraries sl
             LEFT JOIN rag_documents rd ON sl.id = rd.sub_library_id
             LEFT JOIN rag_document_chunks rdc ON rd.id = rdc.document_id
             WHERE sl.name = ?1
             GROUP BY sl.id, sl.name, sl.description, sl.created_at, sl.updated_at",
                params![name],
                |row| {
                    let created_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(3)?)
                        .map_err(|_| {
                            rusqlite::Error::InvalidColumnType(
                                3,
                                "created_at".to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?
                        .with_timezone(&Utc);
                    let updated_at = DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map_err(|_| {
                            rusqlite::Error::InvalidColumnType(
                                4,
                                "updated_at".to_string(),
                                rusqlite::types::Type::Text,
                            )
                        })?
                        .with_timezone(&Utc);

                    Ok(SubLibrary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        created_at,
                        updated_at,
                        document_count: row.get::<_, i64>(5)? as usize,
                        chunk_count: row.get::<_, i64>(6)? as usize,
                    })
                },
            )
            .optional()?;

        Ok(result)
    }

    /// 更新分库信息
    pub fn update_sub_library(
        &self,
        id: &str,
        request: &UpdateSubLibraryRequest,
    ) -> Result<SubLibrary> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        // 检查分库是否存在
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )?;

        if !exists {
            return Err(anyhow::anyhow!("分库ID '{}' 不存在", id));
        }

        // 如果更新名称，检查新名称是否已存在
        if let Some(new_name) = &request.name {
            let name_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE name = ?1 AND id != ?2)",
                params![new_name, id],
                |row| row.get(0),
            )?;

            if name_exists {
                return Err(anyhow::anyhow!("分库名称 '{}' 已存在", new_name));
            }
        }

        // 构建动态更新SQL
        let mut updates = Vec::new();
        let mut params_vec = Vec::new();

        if let Some(name) = &request.name {
            updates.push("name = ?");
            params_vec.push(name.as_str());
        }

        if let Some(description) = &request.description {
            updates.push("description = ?");
            params_vec.push(description.as_str());
        }

        updates.push("updated_at = ?");
        params_vec.push(&now);
        params_vec.push(id);

        let sql = format!(
            "UPDATE rag_sub_libraries SET {} WHERE id = ?",
            updates.join(", ")
        );

        conn.execute(&sql, rusqlite::params_from_iter(params_vec))?;

        // 释放锁，避免递归锁导致死锁
        drop(conn);

        // 使用单独的只读查询获取更新后的分库信息
        self.get_sub_library_by_id(id)?
            .ok_or_else(|| anyhow::anyhow!("无法获取更新后的分库信息"))
    }

    /// 删除分库
    pub fn delete_sub_library(&self, id: &str, delete_contained_documents: bool) -> Result<()> {
        let conn = self.get_conn_safe()?;

        // 检查是否为默认分库
        if id == "default" {
            return Err(anyhow::anyhow!("不能删除默认分库"));
        }

        // 检查分库是否存在
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )?;

        if !exists {
            return Err(anyhow::anyhow!("分库ID '{}' 不存在", id));
        }

        let transaction = conn.unchecked_transaction()?;

        if delete_contained_documents {
            // 删除分库中的所有文档及其相关数据
            // 首先获取分库中的所有文档ID
            let mut stmt =
                transaction.prepare("SELECT id FROM rag_documents WHERE sub_library_id = ?1")?;

            let document_ids: Vec<String> = stmt
                .query_map(params![id], |row| Ok(row.get::<_, String>(0)?))?
                .collect::<Result<Vec<_>, _>>()?;

            // 删除文档关联的向量和块
            for doc_id in document_ids {
                transaction.execute(
                    "DELETE FROM rag_document_chunks WHERE document_id = ?1",
                    params![doc_id],
                )?;
            }

            // 删除分库中的所有文档
            transaction.execute(
                "DELETE FROM rag_documents WHERE sub_library_id = ?1",
                params![id],
            )?;
        } else {
            // 将分库中的文档移动到默认分库
            transaction.execute(
                "UPDATE rag_documents SET sub_library_id = 'default' WHERE sub_library_id = ?1",
                params![id],
            )?;
        }

        // 删除分库本身
        transaction.execute("DELETE FROM rag_sub_libraries WHERE id = ?1", params![id])?;

        transaction.commit()?;

        log::info!("成功删除分库: {}", id);
        Ok(())
    }

    /// 获取指定分库中的文档列表
    pub fn get_documents_by_sub_library(
        &self,
        sub_library_id: &str,
        page: Option<usize>,
        page_size: Option<usize>,
    ) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn_safe()?;

        let page = page.unwrap_or(1);
        let page_size = page_size.unwrap_or(50);
        let offset = (page - 1) * page_size;

        let mut stmt = conn.prepare(
            "SELECT id, file_name, file_path, file_size, total_chunks, sub_library_id, update_state, update_retry, created_at, updated_at
             FROM rag_documents
             WHERE sub_library_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2 OFFSET ?3"
        )?;

        let rows = stmt.query_map(params![sub_library_id, page_size, offset], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "file_name": row.get::<_, String>(1)?,
                "file_path": row.get::<_, Option<String>>(2)?,
                "file_size": row.get::<_, Option<i64>>(3)?,
                "total_chunks": row.get::<_, i32>(4)?,
                "sub_library_id": row.get::<_, String>(5)?,
                "update_state": row.get::<_, String>(6)?,
                "update_retry": row.get::<_, i64>(7)?,
                "created_at": row.get::<_, String>(8)?,
                "updated_at": row.get::<_, String>(9)?
            }))
        })?;

        let mut documents = Vec::new();
        for row in rows {
            documents.push(row?);
        }

        Ok(documents)
    }

    /// 将文档移动到指定分库
    pub fn move_document_to_sub_library(
        &self,
        document_id: &str,
        target_sub_library_id: &str,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;

        // 检查目标分库是否存在
        let library_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE id = ?1)",
            params![target_sub_library_id],
            |row| row.get(0),
        )?;

        if !library_exists {
            return Err(anyhow::anyhow!(
                "目标分库ID '{}' 不存在",
                target_sub_library_id
            ));
        }

        // 检查文档是否存在
        let document_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rag_documents WHERE id = ?1)",
            params![document_id],
            |row| row.get(0),
        )?;

        if !document_exists {
            return Err(anyhow::anyhow!("文档ID '{}' 不存在", document_id));
        }

        // 更新文档的分库归属
        let updated_at = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE rag_documents SET sub_library_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![target_sub_library_id, updated_at, document_id],
        )?;

        log::info!(
            "成功将文档 {} 移动到分库 {}",
            document_id,
            target_sub_library_id
        );
        Ok(())
    }

    // =================== Migration Functions ===================
    // ============================================
    // 已废弃：旧版本迁移函数 (v8-v30)
    // 新系统使用 data_governance::migration
    // 保留代码供参考，待完全验证后删除
    // ============================================
    /*
    /// 版本8到版本9的数据库迁移：过去用于添加图片遮罩卡表，现在改为清理遗留结构
    fn migrate_v8_to_v9(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("正在迁移数据库版本8到版本9：清理图片遮罩卡遗留表...");

        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_image_occlusion_cards_task_id;
            DROP INDEX IF EXISTS idx_image_occlusion_cards_subject;
            DROP INDEX IF EXISTS idx_image_occlusion_cards_created_at;
            DROP TABLE IF EXISTS image_occlusion_cards;",
        )?;

        println!("数据库版本8到版本9迁移完成（已移除图片遮罩卡表）");
        Ok(())
    }

    fn migrate_v9_to_v10(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("正在迁移数据库版本9到版本10：为anki_cards表添加text字段支持Cloze模板...");

        // 🔧 检查text字段是否已存在
        let text_column_exists = conn
            .prepare("PRAGMA table_info(anki_cards)")?
            .query_map([], |row| {
                Ok(row.get::<_, String>(1)?) // 获取列名
            })?
            .filter_map(Result::ok)
            .any(|name| name == "text");

        if !text_column_exists {
            // 添加text字段到anki_cards表
            conn.execute("ALTER TABLE anki_cards ADD COLUMN text TEXT;", [])?;
            println!("已为anki_cards表添加text字段");
        } else {
            println!("text字段已存在，跳过添加");
        }

        // 添加索引以优化查询性能
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text);",
            [],
        )?;

        println!("数据库版本9到版本10迁移完成");
        Ok(())
    }

    fn migrate_v10_to_v11(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("正在迁移数据库版本10到版本11：为review_analyses表添加会话管理字段...");

        // 为review_analyses表添加temp_session_data字段
        let add_temp_session = conn.execute(
            "ALTER TABLE review_analyses ADD COLUMN temp_session_data TEXT DEFAULT '{}'",
            [],
        );

        // 为review_analyses表添加session_sequence字段
        let add_session_sequence = conn.execute(
            "ALTER TABLE review_analyses ADD COLUMN session_sequence INTEGER DEFAULT 0",
            [],
        );

        match (add_temp_session, add_session_sequence) {
            (Ok(_), Ok(_)) => {
                println!("已为review_analyses表添加temp_session_data和session_sequence字段");
            }
            (Err(e), _) | (_, Err(e)) => {
                // 如果字段已存在，这是正常的
                if e.to_string().contains("duplicate column name") {
                    println!("字段已存在，跳过添加");
                } else {
                    return Err(e.into());
                }
            }
        }

        println!("数据库版本10到版本11迁移完成");
        Ok(())
    }

    fn migrate_v11_to_v12(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("开始数据库迁移 v11 -> v12: 插入内置模板...");




        // 确保custom_anki_templates表存在
        conn.execute(
            "CREATE TABLE IF NOT EXISTS custom_anki_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                author TEXT,
                version TEXT NOT NULL DEFAULT '1.0.0',
                preview_front TEXT NOT NULL,
                preview_back TEXT NOT NULL,
                note_type TEXT NOT NULL DEFAULT 'Basic',
                fields_json TEXT NOT NULL DEFAULT '[]',
                generation_prompt TEXT NOT NULL,
                front_template TEXT NOT NULL,
                back_template TEXT NOT NULL,
                css_style TEXT NOT NULL,
                field_extraction_rules_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                is_active INTEGER NOT NULL DEFAULT 1,
                is_built_in INTEGER NOT NULL DEFAULT 0
            );",
            [],
        )?;

        // 检查表中是否已有内置模板
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM custom_anki_templates WHERE is_built_in = 1",
            [],
            |row| row.get(0),
        )?;

        println!("当前内置模板数量: {}", count);

        // 如果已有内置模板，跳过迁移
        if count > 0 {
            println!("内置模板已存在，跳过迁移");
            return Ok(());
        }

        println!("v11->v12: 跳过硬编码模板插入，改用 JSON 导入");
        Ok(())
    }

    fn migrate_v12_to_v13(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("开始数据库迁移 v12 -> v13: 添加预览数据字段...");

        // 检查是否已有 preview_data_json 列
        let has_preview_data_json: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('custom_anki_templates') WHERE name='preview_data_json'",
            [],
            |row| row.get::<_, i32>(0).map(|count| count > 0),
        )?;

        if !has_preview_data_json {
            conn.execute(
                "ALTER TABLE custom_anki_templates ADD COLUMN preview_data_json TEXT",
                [],
            )?;
            println!("已添加 preview_data_json 字段");
        } else {
            println!("preview_data_json 字段已存在");
        }

        // 注意：内置模板导入将通过前端的导入按钮或应用启动时自动处理
        println!("内置模板将通过独立的导入机制处理");

        println!("数据库迁移 v12 -> v13 完成");
        Ok(())
    }

    fn migrate_v13_to_v14(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("开始数据库迁移 v13 -> v14: 添加向量化表、子库表和错题笔记整理会话表...");

        // 创建向量化数据表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS vectorized_data (
                id TEXT PRIMARY KEY,
                mistake_id TEXT NOT NULL,
                text_content TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // 创建分库表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS rag_sub_libraries (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 创建整理会话表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 创建会话错题关联表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS review_session_mistakes (
                session_id TEXT NOT NULL,
                mistake_id TEXT NOT NULL,
                added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (session_id, mistake_id),
                FOREIGN KEY (session_id) REFERENCES review_sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // 创建索引以提高查询性能
        conn.execute("CREATE INDEX IF NOT EXISTS idx_vectorized_data_mistake_id ON vectorized_data(mistake_id)", [])?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_session_id ON review_session_mistakes(session_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_mistake_id ON review_session_mistakes(mistake_id)",
            [],
        )?;

        println!("数据库迁移 v13 -> v14 完成");
        Ok(())
    }

    fn migrate_v14_to_v15(&self, conn: &rusqlite::Connection) -> Result<()> {
        println!("开始数据库迁移 v14 -> v15: 添加搜索日志表...");

        // 创建搜索日志表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS search_logs (
                id TEXT PRIMARY KEY,
                search_type TEXT NOT NULL,
                query TEXT NOT NULL,
                result_count INTEGER NOT NULL,
                execution_time_ms INTEGER NOT NULL,
                mistake_ids_json TEXT,
                error_message TEXT,
                user_feedback TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 创建索引以提高查询性能
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs (created_at)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_search_logs_search_type ON search_logs (search_type)",
            [],
        )?;

        println!("搜索日志表创建成功");
        println!("数据库迁移 v14 -> v15 完成");
        Ok(())
    }

    fn migrate_v15_to_v16(&self, conn: &rusqlite::Connection) -> Result<()> {
        // 添加文档控制状态表
        println!("开始数据库迁移 v15 -> v16: 添加文档控制状态持久化...");

        // 创建文档控制状态表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS document_control_states (
                document_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                pending_tasks_json TEXT NOT NULL DEFAULT '[]',
                running_tasks_json TEXT NOT NULL DEFAULT '{}',
                completed_tasks_json TEXT NOT NULL DEFAULT '[]',
                failed_tasks_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 创建索引以提高查询性能
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_document_control_states_state ON document_control_states (state)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_document_control_states_updated_at ON document_control_states (updated_at)",
            [],
        )?;

        // 创建触发器自动更新 updated_at
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS update_document_control_states_timestamp
             AFTER UPDATE ON document_control_states
             BEGIN
                 UPDATE document_control_states SET updated_at = CURRENT_TIMESTAMP WHERE document_id = NEW.document_id;
             END",
            [],
        )?;

        println!("文档控制状态表创建成功");
        println!("数据库迁移 v15 -> v16 完成");
        Ok(())
    }


    fn migrate_v17_to_v18(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v17 -> v18: 添加数学工作流图片存储...");

        // 🔧 检查 kg_problem_cards 表是否存在（它属于irec数据库，在主数据库中可能不存在）
        let kg_table_exists = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_problem_cards';",
            )?
            .query_map([], |_| Ok(()))?
            .any(|_| true);

        if kg_table_exists {
            // 为 kg_problem_cards 表添加原始图片路径字段
            match conn.execute(
                "ALTER TABLE kg_problem_cards ADD COLUMN original_image_path TEXT NULL",
                [],
            ) {
                Ok(_) => println!("kg_problem_cards.original_image_path 字段添加成功"),
                Err(e) => {
                    if e.to_string().contains("duplicate column name") {
                        println!("kg_problem_cards.original_image_path 字段已存在");
                    } else {
                        println!("添加 original_image_path 字段失败: {}", e);
                    }
                }
            }
        } else {
            println!("kg_problem_cards表不存在（属于irec数据库），跳过相关字段添加");
        }

        println!("数学工作流图片路径字段添加成功");
        println!("数据库迁移 v17 -> v18 完成");
        Ok(())
    }

    fn migrate_v18_to_v19(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v18 -> v19: 添加文档附件支持...");

        // 为 chat_messages 表添加文档附件字段
        match conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN doc_attachments TEXT",
            [],
        ) {
            Ok(_) => println!("chat_messages.doc_attachments 字段添加成功"),
            Err(e) => {
                if e.to_string().contains("duplicate column name") {
                    println!("chat_messages.doc_attachments 字段已存在");
                } else {
                    println!("添加 doc_attachments 字段失败: {}", e);
                }
            }
        }

        // 为 review_chat_messages 表添加文档附件字段
        match conn.execute(
            "ALTER TABLE review_chat_messages ADD COLUMN doc_attachments TEXT",
            [],
        ) {
            Ok(_) => println!("review_chat_messages.doc_attachments 字段添加成功"),
            Err(e) => {
                if e.to_string().contains("duplicate column name") {
                    println!("review_chat_messages.doc_attachments 字段已存在");
                } else {
                    println!(
                        "添加 doc_attachments 字段到 review_chat_messages 失败: {}",
                        e
                    );
                }
            }
        }

        println!("数据库迁移 v18 -> v19 完成");
        Ok(())
    }

    fn migrate_v19_to_v20(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v19 -> v20: 为review_chat_messages表添加多模态支持...");

        // 为 review_chat_messages 表添加 image_paths 字段
        match conn.execute(
            "ALTER TABLE review_chat_messages ADD COLUMN image_paths TEXT",
            [],
        ) {
            Ok(_) => println!("review_chat_messages.image_paths 字段添加成功"),
            Err(e) => {
                if e.to_string().contains("duplicate column name") {
                    println!("review_chat_messages.image_paths 字段已存在");
                } else {
                    println!(
                        "添加 image_paths 字段到 review_chat_messages 失败: {}",
                        e
                    );
                }
            }
        }

        // 为 review_chat_messages 表添加 image_base64 字段
        match conn.execute(
            "ALTER TABLE review_chat_messages ADD COLUMN image_base64 TEXT",
            [],
        ) {
            Ok(_) => println!("review_chat_messages.image_base64 字段添加成功"),
            Err(e) => {
                if e.to_string().contains("duplicate column name") {
                    println!("review_chat_messages.image_base64 字段已存在");
                } else {
                    println!(
                        "添加 image_base64 字段到 review_chat_messages 失败: {}",
                        e
                    );
                }
            }
        }

        println!("数据库迁移 v19 -> v20 完成");
        Ok(())
    }

    fn migrate_v26_to_v27(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v26 -> v27: 添加题目集识别关联字段...");

        let has_column: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='exam_sheet'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_column {
            conn.execute("ALTER TABLE mistakes ADD COLUMN exam_sheet TEXT", [])?;
            println!("已为 mistakes 表添加 exam_sheet 列");
        } else {
            println!("mistakes 表已包含 exam_sheet 列，跳过添加");
        }

        println!("数据库迁移 v26 -> v27 完成");
        Ok(())
    }

    fn migrate_v27_to_v28(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v27 -> v28: 为 mistakes 表添加 last_accessed_at 字段...");

        let has_column: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='last_accessed_at'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_column {
            conn.execute(
                "ALTER TABLE mistakes ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
                [],
            )?;
            conn.execute(
                "UPDATE mistakes SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL OR last_accessed_at = '1970-01-01T00:00:00Z'",
                [],
            )?;
            println!("已为 mistakes 表添加 last_accessed_at 列");
        } else {
            println!("mistakes 表已包含 last_accessed_at 列，跳过添加");
        }

        println!("数据库迁移 v27 -> v28 完成");
        Ok(())
    }

    fn migrate_v28_to_v29(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v28 -> v29: 创建 exam_sheet_sessions 表...");

        conn.execute(
            "CREATE TABLE IF NOT EXISTS exam_sheet_sessions (
                id TEXT PRIMARY KEY,
                exam_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                temp_id TEXT NOT NULL,
                status TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                preview_json TEXT NOT NULL,
                linked_mistake_ids TEXT
            )",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_exam_sheet_sessions_status
                ON exam_sheet_sessions (status)",
            [],
        )?;

        println!("数据库迁移 v28 -> v29 完成");
        Ok(())
    }

    fn migrate_v29_to_v30(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!(
            "开始数据库迁移 v29 -> v30: 校验 exam_sheet_sessions 表的 linked_mistake_ids 列..."
        );

        let has_column: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('exam_sheet_sessions') WHERE name='linked_mistake_ids'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_column {
            conn.execute(
                "ALTER TABLE exam_sheet_sessions ADD COLUMN linked_mistake_ids TEXT",
                [],
            )?;
            println!("已为 exam_sheet_sessions 表添加 linked_mistake_ids 列");
        } else {
            println!("exam_sheet_sessions 表已包含 linked_mistake_ids 列，跳过添加");
        }

        println!("数据库迁移 v29 -> v30 完成");
        Ok(())
    }
    */
    // ============================================
    // 旧版本迁移函数 (v8-v30) 结束
    // ============================================
}

impl DatabaseManager {
    // ============================================
    // 已废弃：重复的迁移函数
    // 新系统使用 data_governance::migration
    // 保留代码供参考，待完全验证后删除
    // ============================================
    /*
    fn migrate_v26_to_v27(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        println!("开始数据库迁移 v26 -> v27: 添加题目集识别关联字段...");

        let has_column: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='exam_sheet'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_column {
            conn.execute("ALTER TABLE mistakes ADD COLUMN exam_sheet TEXT", [])?;
            println!("已为 mistakes 表添加 exam_sheet 列");
        } else {
            println!("mistakes 表已包含 exam_sheet 列，跳过添加");
        }

        println!("数据库迁移 v26 -> v27 完成");
        Ok(())
    }
    /// 导入包含预览数据的内置模板
    fn import_builtin_templates_with_preview_data(
        &self,
        conn: &SqlitePooledConnection,
    ) -> Result<()> {
        println!("跳过硬编码内置模板（含预览数据）的导入，改用 JSON 导入");
        return Ok(());

    }
    */
    // ============================================
    // 重复的迁移函数结束
    // ============================================
}

impl Database {
    /// 设置默认模板ID
    pub fn set_default_template(&self, template_id: &str) -> Result<()> {
        let conn = self.get_conn_safe()?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('default_template_id', ?1, ?2)",
            params![template_id, now]
        )?;

        Ok(())
    }

    /// 获取默认模板ID
    pub fn get_default_template(&self) -> Result<Option<String>> {
        let conn = self.get_conn_safe()?;

        match conn.query_row(
            "SELECT value FROM settings WHERE key = 'default_template_id'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(template_id) => Ok(Some(template_id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// 记录搜索日志
    pub fn log_search(
        &self,
        query: &str,
        search_type: &str,
        results_count: u32,
        response_time_ms: Option<u64>,
    ) -> Result<()> {
        let conn = self.get_conn_safe()?;
        conn.execute(
            "INSERT INTO search_logs (query, search_type, results_count, response_time_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                query,
                search_type,
                results_count,
                response_time_ms,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// 获取搜索日志统计
    pub fn get_search_statistics(&self) -> Result<SearchStatistics> {
        let conn = self.get_conn_safe()?;

        // 获取总搜索次数
        let total_searches: i64 =
            conn.query_row("SELECT COUNT(*) FROM search_logs", [], |row| row.get(0))?;

        // 获取最近7天的搜索次数
        let recent_searches: i64 = conn.query_row(
            "SELECT COUNT(*) FROM search_logs
             WHERE created_at >= datetime('now', '-7 days')",
            [],
            |row| row.get(0),
        )?;

        // 获取平均响应时间
        let avg_response_time: Option<f64> = conn
            .query_row(
                "SELECT AVG(response_time_ms) FROM search_logs
             WHERE response_time_ms IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .optional()?;

        // 获取搜索类型分布
        let mut search_type_distribution = std::collections::HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT search_type, COUNT(*) as count
             FROM search_logs
             GROUP BY search_type",
        )?;
        let type_iter = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for type_result in type_iter {
            let (search_type, count) = type_result?;
            search_type_distribution.insert(search_type, count);
        }

        // 获取热门搜索查询
        let mut popular_queries = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT query, COUNT(*) as count
             FROM search_logs
             GROUP BY query
             ORDER BY count DESC
             LIMIT 10",
        )?;
        let query_iter = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for query_result in query_iter {
            popular_queries.push(query_result?);
        }

        Ok(SearchStatistics {
            total_searches,
            recent_searches,
            avg_response_time_ms: avg_response_time.unwrap_or(0.0),
            search_type_distribution,
            popular_queries,
        })
    }

    /// 获取最近的文档任务（用于状态恢复）
    pub fn get_recent_document_tasks(&self, limit: u32) -> Result<Vec<DocumentTask>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, document_id, original_document_name, segment_index, content_segment,
                    status, created_at, updated_at, error_message, anki_generation_options_json
             FROM document_tasks
             ORDER BY updated_at DESC
             LIMIT ?",
        )?;

        let tasks = stmt
            .query_map([limit], |row| {
                let status_str: String = row.get(5)?;
                Ok(DocumentTask {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    original_document_name: row.get(2)?,
                    segment_index: row.get(3)?,
                    content_segment: row.get(4)?,
                    status: TaskStatus::from_str(&status_str),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    error_message: row.get(8)?,
                    anki_generation_options_json: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<DocumentTask>>>()?;

        Ok(tasks)
    }

    /// 🔧 Phase 1: 恢复卡住的制卡任务
    /// 将 Processing/Streaming 状态超过 1 小时的任务重置为 Pending
    pub fn recover_stuck_document_tasks(&self) -> Result<u32> {
        let conn = self.get_conn_safe()?;
        let count = conn.execute(
            r#"UPDATE document_tasks
               SET status = 'Pending', error_message = 'Recovered after app restart', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE status IN ('Processing', 'Streaming')
               AND updated_at < datetime('now', '-1 hour')"#,
            [],
        )?;
        Ok(count as u32)
    }

    /// 🔧 Phase 1: 按 document_id 分组汇总任务信息（用于任务管理页面）
    pub fn list_document_sessions(&self, limit: u32) -> Result<Vec<serde_json::Value>> {
        let conn = self.get_conn_safe()?;
        // 确保 source_session_id 列存在（兼容旧数据库）
        let _ = conn.execute(
            "ALTER TABLE document_tasks ADD COLUMN source_session_id TEXT",
            [],
        );
        // 使用 LEFT JOIN + COUNT(DISTINCT) 代替关联子查询，提升大数据量下的性能
        let mut stmt = conn.prepare(
            r#"SELECT
                 dt.document_id,
                 dt.original_document_name,
                 dt.source_session_id,
                 COUNT(DISTINCT dt.id) AS total_tasks,
                 COUNT(DISTINCT CASE WHEN dt.status = 'Completed' THEN dt.id END) AS completed_tasks,
                 COUNT(DISTINCT CASE WHEN dt.status IN ('Failed', 'Truncated', 'Cancelled') THEN dt.id END) AS failed_tasks,
                 COUNT(DISTINCT CASE WHEN dt.status IN ('Processing', 'Streaming', 'Pending') THEN dt.id END) AS active_tasks,
                 COUNT(DISTINCT CASE WHEN dt.status = 'Paused' THEN dt.id END) AS paused_tasks,
                 MAX(dt.updated_at) AS last_updated,
                 MIN(dt.created_at) AS created_at,
                 COUNT(DISTINCT ac.id) AS total_cards
               FROM document_tasks dt
               LEFT JOIN anki_cards ac ON ac.task_id = dt.id
               GROUP BY dt.document_id
               ORDER BY MAX(dt.updated_at) DESC
               LIMIT ?1"#,
        )?;

        let rows = stmt
            .query_map([limit], |row| {
                Ok(serde_json::json!({
                    "documentId": row.get::<_, String>(0)?,
                    "documentName": row.get::<_, String>(1)?,
                    "sourceSessionId": row.get::<_, Option<String>>(2)?,
                    "totalTasks": row.get::<_, i64>(3)?,
                    "completedTasks": row.get::<_, i64>(4)?,
                    "failedTasks": row.get::<_, i64>(5)?,
                    "activeTasks": row.get::<_, i64>(6)?,
                    "pausedTasks": row.get::<_, i64>(7)?,
                    "lastUpdated": row.get::<_, String>(8)?,
                    "createdAt": row.get::<_, String>(9)?,
                    "totalCards": row.get::<_, i64>(10)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<serde_json::Value>>>()?;

        Ok(rows)
    }

    /// 🔧 Phase 2: 卡片库统计数据（用于任务管理页面统计卡片）
    pub fn get_anki_stats(&self) -> Result<serde_json::Value> {
        let conn = self.get_conn_safe()?;
        let total_cards: i64 =
            conn.query_row("SELECT COUNT(*) FROM anki_cards", [], |r| r.get(0))?;
        let total_tasks: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT document_id) FROM document_tasks",
            [],
            |r| r.get(0),
        )?;
        let error_cards: i64 = conn.query_row(
            "SELECT COUNT(*) FROM anki_cards WHERE is_error_card = 1",
            [],
            |r| r.get(0),
        )?;
        let template_count: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT template_id) FROM anki_cards WHERE template_id IS NOT NULL AND template_id != ''",
            [],
            |r| r.get(0),
        )?;
        Ok(serde_json::json!({
            "totalCards": total_cards,
            "totalDocuments": total_tasks,
            "errorCards": error_cards,
            "templateCount": template_count,
        }))
    }

    /// 获取最近生成的Anki卡片（用于状态恢复）
    pub fn get_recent_anki_cards(&self, limit: u32) -> Result<Vec<AnkiCard>> {
        let conn = self.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT id, task_id, front, back, text, tags_json, images_json,
                    is_error_card, error_content, created_at, updated_at,
                    COALESCE(extra_fields_json, '{}') as extra_fields_json, template_id
             FROM anki_cards
             ORDER BY created_at DESC
             LIMIT ?",
        )?;

        let cards = stmt
            .query_map([limit], |row| {
                let tags_json: String = row.get(5)?;
                let images_json: String = row.get(6)?;
                let extra_fields_json: String = row.get(12)?;

                Ok(AnkiCard {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    front: row.get(2)?,
                    back: row.get(3)?,
                    text: row.get(4)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    images: serde_json::from_str(&images_json).unwrap_or_default(),
                    is_error_card: row.get::<_, i32>(7)? != 0,
                    error_content: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    extra_fields: serde_json::from_str(&extra_fields_json).unwrap_or_default(),
                    template_id: row.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<AnkiCard>>>()?;

        Ok(cards)
    }

    pub fn list_anki_library_cards(
        &self,
        _subject: Option<&str>,
        template_id: Option<&str>,
        search: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<AnkiLibraryCard>, u64)> {
        let conn = self.get_conn_safe()?;
        let mut clauses: Vec<String> = Vec::new();
        let mut params: Vec<Value> = Vec::new();

        if let Some(template_value) = template_id
            .map(|s| s.trim())
            .filter(|value| !value.is_empty())
        {
            clauses.push("ac.template_id = ?".to_string());
            params.push(Value::from(template_value.to_string()));
        }

        if let Some(search_value) = search.map(|s| s.trim()).filter(|value| !value.is_empty()) {
            clauses.push("(ac.front LIKE ? OR ac.back LIKE ? OR ac.text LIKE ?)".to_string());
            let pattern = format!("%{}%", search_value);
            params.push(Value::from(pattern.clone()));
            params.push(Value::from(pattern.clone()));
            params.push(Value::from(pattern));
        }

        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };

        let count_sql = format!(
            "SELECT COUNT(*) FROM anki_cards ac
             LEFT JOIN document_tasks dt ON dt.id = ac.task_id
             {}",
            where_clause
        );
        let total: i64 = conn.query_row(
            &count_sql,
            rusqlite::params_from_iter(params.iter()),
            |row| row.get(0),
        )?;
        let total = if total < 0 { 0 } else { total as u64 };

        let safe_page = if page == 0 { 1 } else { page };
        let safe_page_size = page_size.clamp(1, 200);
        let offset = (safe_page.saturating_sub(1) as i64) * (safe_page_size as i64);

        let mut data_params = params.clone();
        data_params.push(Value::from(safe_page_size as i64));
        data_params.push(Value::from(offset));

        let data_sql = format!(
            "SELECT
                ac.id, ac.task_id, ac.front, ac.back, ac.text, ac.tags_json, ac.images_json,
                ac.is_error_card, ac.error_content, ac.created_at, ac.updated_at,
                COALESCE(ac.extra_fields_json, '{{}}') as extra_fields_json,
                ac.template_id, ac.source_type, ac.source_id
             FROM anki_cards ac
             LEFT JOIN document_tasks dt ON dt.id = ac.task_id
             {}
             ORDER BY ac.created_at DESC
             LIMIT ? OFFSET ?",
            where_clause
        );

        let mut stmt = conn.prepare(&data_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(data_params.iter()), |row| {
            let tags_json: String = row.get(5)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let images_json: String = row.get(6)?;
            let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();
            let extra_fields_json: String = row.get(11)?;
            let extra_fields: std::collections::HashMap<String, String> =
                serde_json::from_str(&extra_fields_json).unwrap_or_default();

            let card = AnkiCard {
                id: row.get(0)?,
                task_id: row.get(1)?,
                front: row.get(2)?,
                back: row.get(3)?,
                text: row.get(4)?,
                tags,
                images,
                is_error_card: row.get::<_, i32>(7)? != 0,
                error_content: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                extra_fields,
                template_id: row.get(12)?,
            };

            let raw_source_type: String = row.get(13)?;
            let source_type = if raw_source_type.trim().is_empty() {
                None
            } else {
                Some(raw_source_type)
            };
            let raw_source_id: String = row.get(14)?;
            let source_id = if raw_source_id.trim().is_empty() {
                None
            } else {
                Some(raw_source_id)
            };
            Ok(AnkiLibraryCard {
                card,
                source_type,
                source_id,
            })
        })?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }

        Ok((items, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AnkiCard, ChatMessage, DocumentTask, TaskStatus};
    use chrono::{Duration, Utc};
    use rusqlite::params;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn append_preserves_turn_metadata_and_scoped_deletion() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("chat_test.db");
        let db = Database::new(&db_path)?;

        let now = Utc::now().to_rfc3339();
        {
            let conn = db.get_conn_safe()?;
            conn.execute(
                "INSERT INTO mistakes (id, subject, created_at, question_images, analysis_images, user_question, ocr_text, tags, mistake_type, status, chat_category, updated_at, last_accessed_at)
                 VALUES (?1, ?2, ?3, '[]', '[]', ?4, ?5, '[]', 'analysis', 'completed', 'analysis', ?3, ?3)",
                params!["mistake-1", "math", now, "示例问题", ""],
            )?;
        }

        let base_ts = Utc::now();
        let turn_id = "turn-test-1";
        let user_message = ChatMessage {
            role: "user".to_string(),
            content: "原始提问".to_string(),
            timestamp: base_ts,
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: None,
            doc_attachments: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: Some(json!({
                "turn_id": turn_id,
                "turn_seq": 0,
                "message_kind": "user.input"
            })),
            persistent_stable_id: Some("user-stable".to_string()),
            metadata: None,
            multimodal_content: None,
        };
        let assistant_message = ChatMessage {
            role: "assistant".to_string(),
            content: "助手回答".to_string(),
            timestamp: base_ts + Duration::seconds(1),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: None,
            doc_attachments: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: Some(json!({
                "turn_id": turn_id,
                "turn_seq": 1,
                "message_kind": "assistant.answer",
                "lifecycle": "complete",
                "reply_to_msg_id": null
            })),
            persistent_stable_id: Some("assistant-stable".to_string()),
            metadata: None,
            multimodal_content: None,
        };

        db.append_mistake_chat_messages(
            "mistake-1",
            &[user_message.clone(), assistant_message.clone()],
        )?;

        let (user_id, stored_turn_id, relations_before, turn_seq_before): (
            i64,
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT id, turn_id, relations, turn_seq FROM chat_messages WHERE stable_id = ?1",
                params!["user-stable"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?
        };
        let stored_turn_id = stored_turn_id.expect("turn_id 应存在");
        assert_eq!(turn_seq_before, Some(0));

        let updated_user = ChatMessage {
            content: "更新后的提问".to_string(),
            timestamp: base_ts + Duration::seconds(5),
            persistent_stable_id: Some("user-stable".to_string()),
            relations: None,
            ..user_message.clone()
        };
        db.append_mistake_chat_messages("mistake-1", &[updated_user])?;

        let (turn_id_after, relations_after, turn_seq_after): (
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT turn_id, relations, turn_seq FROM chat_messages WHERE stable_id = ?1",
                params!["user-stable"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
        };
        assert_eq!(turn_id_after, Some(stored_turn_id.clone()));
        assert_eq!(relations_before, relations_after);
        assert_eq!(turn_seq_after, Some(0));

        let assistant_id: i64 = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT id FROM chat_messages WHERE stable_id = ?1",
                params!["assistant-stable"],
                |row| row.get(0),
            )?
        };

        let ids_without_user = db.list_turn_message_ids("mistake-1", &stored_turn_id, false)?;
        assert_eq!(ids_without_user, vec![assistant_id]);

        let mut ids_with_user = db.list_turn_message_ids("mistake-1", &stored_turn_id, true)?;
        ids_with_user.sort();
        let mut expected_ids = vec![assistant_id, user_id];
        expected_ids.sort();
        assert_eq!(ids_with_user, expected_ids);

        let deleted = db.delete_chat_turn("mistake-1", &stored_turn_id, false)?;
        assert_eq!(deleted, 1);

        let user_row_exists: i64 = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT COUNT(1) FROM chat_messages WHERE id = ?1",
                params![user_id],
                |row| row.get(0),
            )?
        };
        assert_eq!(user_row_exists, 1);

        let assistant_row_exists: i64 = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT COUNT(1) FROM chat_messages WHERE id = ?1",
                params![assistant_id],
                |row| row.get(0),
            )?
        };
        assert_eq!(assistant_row_exists, 0);

        Ok(())
    }

    #[test]
    fn save_document_task_with_cards_atomic_rolls_back_when_all_cards_ignored(
    ) -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("atomic_cards_test.db");
        let db = Database::new(&db_path)?;
        let now = Utc::now().to_rfc3339();

        let task_1 = DocumentTask {
            id: "task-1".to_string(),
            document_id: "doc-1".to_string(),
            original_document_name: "doc".to_string(),
            segment_index: 0,
            content_segment: "seg".to_string(),
            status: TaskStatus::Completed,
            created_at: now.clone(),
            updated_at: now.clone(),
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        };
        let card_1 = AnkiCard {
            id: "card-1".to_string(),
            task_id: "task-1".to_string(),
            front: "f".to_string(),
            back: "b".to_string(),
            text: None,
            tags: vec![],
            images: vec![],
            is_error_card: false,
            error_content: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            extra_fields: std::collections::HashMap::new(),
            template_id: None,
        };
        let inserted_ids = db.save_document_task_with_cards_atomic(&task_1, &[card_1])?;
        assert_eq!(inserted_ids, vec!["card-1".to_string()]);

        let task_2 = DocumentTask {
            id: "task-2".to_string(),
            document_id: "doc-1".to_string(),
            original_document_name: "doc".to_string(),
            segment_index: 1,
            content_segment: "seg2".to_string(),
            status: TaskStatus::Completed,
            created_at: now.clone(),
            updated_at: now,
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        };
        let duplicate_card = AnkiCard {
            id: "card-1".to_string(),
            task_id: "task-2".to_string(),
            front: "f2".to_string(),
            back: "b2".to_string(),
            text: None,
            tags: vec![],
            images: vec![],
            is_error_card: false,
            error_content: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            extra_fields: std::collections::HashMap::new(),
            template_id: None,
        };

        let err = db.save_document_task_with_cards_atomic(&task_2, &[duplicate_card]);
        assert!(err.is_err());

        let task_2_exists: i64 = {
            let conn = db.get_conn_safe()?;
            conn.query_row(
                "SELECT COUNT(1) FROM document_tasks WHERE id = ?1",
                params!["task-2"],
                |row| row.get(0),
            )?
        };
        assert_eq!(task_2_exists, 0);

        Ok(())
    }
}
/// 搜索统计结构体
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchStatistics {
    pub total_searches: i64,
    pub recent_searches: i64,
    pub avg_response_time_ms: f64,
    pub search_type_distribution: std::collections::HashMap<String, i64>,
    pub popular_queries: Vec<(String, i64)>,
}
