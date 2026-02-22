//! DatabaseManager - 连接池管理器
//!
//! 从 database.rs 拆分，负责：
//! - r2d2 连接池管理
//! - Schema 初始化与迁移
//! - 数据库切换

use crate::models::AppError;
use anyhow::{Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use super::{
    ensure_chat_messages_extended_columns, SqlitePool, SqlitePooledConnection, CURRENT_DB_VERSION,
};

pub struct DatabaseManager {
    pool: RwLock<SqlitePool>,
    db_path: RwLock<PathBuf>,
}

impl DatabaseManager {
    /// 创建新的数据库管理器，使用 r2d2 连接池
    pub fn new(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let pool = Self::build_pool(db_path)?;

        let db_manager = DatabaseManager {
            pool: RwLock::new(pool),
            db_path: RwLock::new(db_path.to_path_buf()),
        };

        Ok(db_manager)
    }

    /// 获取数据库连接
    pub fn get_conn(&self) -> Result<SqlitePooledConnection> {
        let pool = self.pool.read().unwrap_or_else(|poisoned| {
            log::error!("[DatabaseManager] Pool RwLock poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        pool.get().with_context(|| "从连接池获取连接失败")
    }

    /// 获取连接池的克隆（用于传递给服务）
    pub fn get_pool(&self) -> SqlitePool {
        match self.pool.read() {
            Ok(pool) => pool.clone(),
            Err(_) => {
                log::error!("[DatabaseManager] Pool RwLock poisoned in get_pool! Rebuilding pool");
                let path = self.current_db_path();
                let new_pool = Self::build_pool(&path).expect("重建数据库连接池失败");
                match self.pool.write() {
                    Ok(mut guard) => {
                        *guard = new_pool.clone();
                    }
                    Err(poisoned) => {
                        log::error!(
                            "[DatabaseManager] Pool RwLock poisoned (write)! Forcing recovery"
                        );
                        let mut guard = poisoned.into_inner();
                        *guard = new_pool.clone();
                    }
                }
                new_pool
            }
        }
    }

    /// 当前使用的数据库路径
    pub fn current_db_path(&self) -> PathBuf {
        match self.db_path.read() {
            Ok(path) => path.clone(),
            Err(poisoned) => {
                log::error!("[DatabaseManager] db_path RwLock poisoned! Attempting recovery");
                poisoned.into_inner().clone()
            }
        }
    }

    fn build_pool(db_path: &Path) -> Result<SqlitePool> {
        let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
            // 基础 PRAGMA 设置
            c.pragma_update(None, "foreign_keys", &"ON")?;
            c.pragma_update(None, "journal_mode", &"WAL")?;
            c.pragma_update(None, "synchronous", &"NORMAL")?;
            // 防止写入互斥等待无界：设置 busy_timeout 以快速失败并交给上层重试/提示
            // 单位毫秒，3 秒足以让短事务释放写锁
            c.pragma_update(None, "busy_timeout", &3000i64)?;
            Ok(())
        });

        let pool = Pool::builder()
            .max_size(15)
            .min_idle(Some(2))
            .connection_timeout(Duration::from_secs(10))
            .build(manager)
            .with_context(|| format!("创建数据库连接池失败: {:?}", db_path))?;

        Ok(pool)
    }

    /// 切换数据库文件并刷新连接池
    pub fn switch_database(&self, new_path: &Path) -> Result<()> {
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录失败: {:?}", parent))?;
        }

        let new_pool = Self::build_pool(new_path)?;

        {
            let mut guard = match self.pool.write() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] Pool RwLock poisoned during switch_database! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *guard = new_pool;
        }

        {
            let mut path_guard = match self.db_path.write() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] db_path RwLock poisoned during switch_database! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *path_guard = new_path.to_path_buf();
        }

        Ok(())
    }

    /// 进入维护模式：将连接池切换为内存数据库，释放对磁盘文件的占用
    ///
    /// 用于恢复流程中替换实际数据库文件，避免 Windows 上文件锁定（os error 32）。
    /// 维护模式下，所有通过此 Manager 获取的连接都将指向内存数据库。
    pub fn enter_maintenance_mode(&self) -> Result<()> {
        // 先尝试 WAL checkpoint
        if let Ok(conn) = self.get_conn() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }

        // 构建指向 :memory: 的连接池，替换原有池
        let mem_manager = SqliteConnectionManager::memory();
        let mem_pool = Pool::builder()
            .max_size(1)
            .build(mem_manager)
            .with_context(|| "创建内存连接池失败")?;

        {
            let mut guard = match self.pool.write() {
                Ok(g) => g,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] Pool RwLock poisoned during enter_maintenance_mode! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            
            // 将旧连接池移出，替换为新连接池
            // r2d2 Pool 的 Drop 并不是立即关闭所有连接的，如果有线程正持有 PooledConnection，
            // 那个底层 SqliteConnection 将继续存活，直到 PooledConnection 被 drop。
            // 为了真正释放文件锁，我们在替换后建议调用方等待一小段时间或确保前置的所有后台任务已停止。
            *guard = mem_pool;
        }

        // 给正持有连接的后台任务（如向量化/索引）一点时间释放 PooledConnection，
        // 从而真正关闭文件句柄，避免 Windows 上 os error 32 权限被占用的问题。
        std::thread::sleep(Duration::from_millis(500));

        log::info!("[DatabaseManager] 已进入维护模式，文件连接已释放");
        Ok(())
    }

    /// 退出维护模式：重新打开磁盘数据库文件的连接池
    pub fn exit_maintenance_mode(&self) -> Result<()> {
        let path = self.current_db_path();
        let new_pool = Self::build_pool(&path)?;

        {
            let mut guard = match self.pool.write() {
                Ok(g) => g,
                Err(poisoned) => {
                    log::error!("[DatabaseManager] Pool RwLock poisoned during exit_maintenance_mode! Forcing recovery");
                    poisoned.into_inner()
                }
            };
            *guard = new_pool;
        }

        log::info!("[DatabaseManager] 已退出维护模式，文件连接已恢复");
        Ok(())
    }

    /// 从现有连接池创建 DatabaseManager（用于兼容性）
    pub fn from_pool(pool: SqlitePool, db_path: PathBuf) -> Self {
        DatabaseManager {
            pool: RwLock::new(pool),
            db_path: RwLock::new(db_path),
        }
    }

    /// [DEPRECATED] 初始化数据库 schema（旧版迁移系统入口）
    ///
    /// 此方法调用了 `handle_migration`、`ensure_post_migration_patches`
    /// 和 `ensure_compatibility`，均属于旧迁移系统。
    /// 新的 schema 变更应通过 `data_governance/migration/coordinator.rs` 的 Refinery 迁移脚本实现。
    fn initialize_schema(&self) -> Result<()> {
        let mut conn = self.get_conn()?;

        conn.execute_batch(
            r#"BEGIN;
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mistakes (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                question_images TEXT NOT NULL,
                analysis_images TEXT NOT NULL,
                user_question TEXT NOT NULL,
                ocr_text TEXT NOT NULL,
                ocr_note TEXT,
                tags TEXT NOT NULL,
                mistake_type TEXT NOT NULL,
                status TEXT NOT NULL,
                chat_category TEXT NOT NULL DEFAULT 'analysis',
                updated_at TEXT NOT NULL,
                last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
                chat_metadata TEXT,
                exam_sheet TEXT,
                autosave_signature TEXT,
                mistake_summary TEXT,
                user_error_analysis TEXT,
                irec_card_id TEXT,
                irec_status INTEGER DEFAULT 0
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
                graph_sources TEXT,
                web_search_sources TEXT,
                image_paths TEXT,
                image_base64 TEXT,
                doc_attachments TEXT,
                tool_call TEXT,
                tool_result TEXT,
                overrides TEXT,
                relations TEXT,
                stable_id TEXT,
                turn_id TEXT,
                turn_seq SMALLINT,
                reply_to_msg_id INTEGER,
                message_kind TEXT,
                lifecycle TEXT,
                metadata TEXT,
                FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS review_analyses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mistake_ids TEXT NOT NULL,
                consolidated_input TEXT NOT NULL,
                user_question TEXT NOT NULL,
                status TEXT NOT NULL,
                tags TEXT NOT NULL,
                analysis_type TEXT NOT NULL DEFAULT 'consolidated_review',
                temp_session_data TEXT,
                session_sequence INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS review_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking_content TEXT,
                rag_sources TEXT,
                memory_sources TEXT,
                graph_sources TEXT,
                web_search_sources TEXT,
                image_paths TEXT,
                image_base64 TEXT,
                doc_attachments TEXT,
                tool_call TEXT,
                tool_result TEXT,
                overrides TEXT,
                relations TEXT,
                metadata TEXT,
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
            CREATE TABLE IF NOT EXISTS rag_sub_libraries (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS custom_anki_templates (
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
            );
            CREATE TABLE IF NOT EXISTS migration_progress (
                category TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                last_cursor TEXT,
                total_processed INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE TABLE IF NOT EXISTS memory_intake_tasks (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('queued', 'analyzing', 'tag_mapping', 'creating_note', 'completed', 'failed', 'cancelled')),
                payload_json TEXT NOT NULL,
                result_json TEXT,
                error_message TEXT,
                content_hash TEXT,
                total_items INTEGER NOT NULL DEFAULT 0,
                processed_items INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_mem_intake_status ON memory_intake_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_mem_intake_conversation ON memory_intake_tasks(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_mem_intake_created ON memory_intake_tasks(created_at);
            CREATE TABLE IF NOT EXISTS memory_intake_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                log_level TEXT NOT NULL CHECK(log_level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
                stage TEXT NOT NULL,
                message TEXT NOT NULL,
                details_json TEXT,
                item_index INTEGER,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
                FOREIGN KEY(task_id) REFERENCES memory_intake_tasks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_mem_intake_logs_task ON memory_intake_logs(task_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_mem_intake_logs_level ON memory_intake_logs(log_level);
            CREATE TABLE IF NOT EXISTS translations (
                id TEXT PRIMARY KEY,
                source_text TEXT NOT NULL,
                translated_text TEXT NOT NULL,
                src_lang TEXT NOT NULL,
                tgt_lang TEXT NOT NULL,
                prompt_used TEXT,
                attachments_json TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                metadata_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_translations_created ON translations(created_at);
            CREATE INDEX IF NOT EXISTS idx_translations_langs ON translations(src_lang, tgt_lang);
            COMMIT;"#,
        )?;

        // 处理数据库迁移
        self.handle_migration(&mut conn)?;
        // 迁移后进行健壮性修复，确保历史数据库也具备最新列
        ensure_chat_messages_extended_columns(&conn)?;
        // NOTE: 以下两个方法已标记 deprecated，过渡期间仍需调用以兼容旧数据库。
        // 新的 schema 变更应通过 data_governance/migration 的 Refinery 迁移脚本实现。
        #[allow(deprecated)]
        {
            self.ensure_post_migration_patches(&conn)?;
            // 确保向后兼容性
            self.ensure_compatibility(&conn)?;
        }

        // 确保聊天检索相关的 Schema（FTS + 向量表）
        if let Err(e) = self.ensure_chat_search_schema() {
            log::error!("初始化聊天检索Schema失败: {}", e);
        }

        // 注意：Chat V2 Schema 已迁移到独立数据库 chat_v2.db
        // 不再在主数据库中初始化，由 ChatV2Database 独立管理

        Ok(())
    }

    /// [DEPRECATED] 迁移后健壮性补丁：为历史数据库补齐缺失列。
    ///
    /// # 废弃说明
    /// 此方法中的裸 `ALTER TABLE` 语句绕过了数据治理系统，应逐步迁移到
    /// `data_governance/migration/coordinator.rs` 的 Refinery 迁移脚本中。
    ///
    /// # 过渡计划
    /// 1. 新的 schema 变更**禁止**在此方法中添加，应通过 `migrations/` 目录的 Refinery SQL 脚本实现
    /// 2. 现有逻辑在所有用户升级到包含对应 Refinery 迁移的版本后移除
    /// 3. 参见各语句的 `MIGRATION_DEBT:` 注释了解具体迁移状态
    #[deprecated(note = "使用 data_governance/migration/coordinator.rs 的 Refinery 迁移脚本替代")]
    fn ensure_post_migration_patches(&self, conn: &SqlitePooledConnection) -> Result<()> {
        let has_ocr_note: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='ocr_note'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_ocr_note {
            log::info!("检测到 mistakes 表缺少 ocr_note 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 migrations/mistakes/ Refinery 脚本
            conn.execute("ALTER TABLE mistakes ADD COLUMN ocr_note TEXT", [])?;
            log::info!("已补齐 mistakes.ocr_note 列");
        }

        // 修复方案A：为 memory_intake_tasks 补齐缺失字段
        let has_total_items: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('memory_intake_tasks') WHERE name='total_items'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_total_items {
            log::info!(
                "检测到 memory_intake_tasks 表缺少 total_items/processed_items 列，正在自动补齐..."
            );
            // MIGRATION_DEBT: 迁移到 Refinery 脚本（memory_intake_tasks 表）
            conn.execute(
                "ALTER TABLE memory_intake_tasks ADD COLUMN total_items INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            // MIGRATION_DEBT: 迁移到 Refinery 脚本（memory_intake_tasks 表）
            conn.execute(
                "ALTER TABLE memory_intake_tasks ADD COLUMN processed_items INTEGER DEFAULT 0",
                [],
            )?;
            // 为现有任务填充默认值（从 payload_json 解析）
            conn.execute(
                "UPDATE memory_intake_tasks \
                 SET total_items = (SELECT json_array_length(json_extract(payload_json, '$.items'))) \
                 WHERE total_items = 0 AND json_extract(payload_json, '$.items') IS NOT NULL",
                []
            )?;
            log::info!("已补齐 memory_intake_tasks.total_items 和 processed_items 列");
        }

        // 新增 content_hash 列与索引，用于幂等判定
        let has_content_hash: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('memory_intake_tasks') WHERE name='content_hash'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_content_hash {
            log::info!("检测到 memory_intake_tasks 表缺少 content_hash 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 Refinery 脚本（memory_intake_tasks 表）
            conn.execute(
                "ALTER TABLE memory_intake_tasks ADD COLUMN content_hash TEXT",
                [],
            )?;
            // 最佳努力：从 payload_json 回填
            conn.execute(
                "UPDATE memory_intake_tasks \
                 SET content_hash = json_extract(payload_json, '$.content_hash') \
                 WHERE content_hash IS NULL",
                [],
            )?;
            // 延迟到此处创建索引，避免初始化阶段列尚未存在
            conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_intake_content_hash ON memory_intake_tasks(content_hash)", [])?;
            log::info!("已补齐 memory_intake_tasks.content_hash 列与索引");
        }

        let has_last_accessed: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='last_accessed_at'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_last_accessed {
            log::info!("检测到 mistakes 表缺少 last_accessed_at 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 migrations/mistakes/ Refinery 脚本
            conn.execute(
                "ALTER TABLE mistakes ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
                [],
            )?;
            conn.execute(
                "UPDATE mistakes SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL OR last_accessed_at = '1970-01-01T00:00:00Z'",
                [],
            )?;
            log::info!("已补齐 mistakes.last_accessed_at 列");
        }

        let has_exam_sheet: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='exam_sheet'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_exam_sheet {
            log::info!("检测到 mistakes 表缺少 exam_sheet 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 migrations/mistakes/ Refinery 脚本
            conn.execute("ALTER TABLE mistakes ADD COLUMN exam_sheet TEXT", [])?;
            log::info!("已补齐 mistakes.exam_sheet 列");
        }

        // 确保 translations 表有 is_favorite 和 quality_rating 列
        let has_is_favorite: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('translations') WHERE name='is_favorite'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_is_favorite {
            log::info!("检测到 translations 表缺少 is_favorite 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 Refinery 脚本（translations 表）
            conn.execute(
                "ALTER TABLE translations ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            log::info!("已补齐 translations.is_favorite 列");
        }

        let has_quality_rating: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('translations') WHERE name='quality_rating'",
                [],
                |row| row.get::<_, i32>(0).map(|count| count > 0),
            )
            .unwrap_or(false);

        if !has_quality_rating {
            log::info!("检测到 translations 表缺少 quality_rating 列，正在自动补齐...");
            // MIGRATION_DEBT: 迁移到 Refinery 脚本（translations 表）
            conn.execute(
                "ALTER TABLE translations ADD COLUMN quality_rating INTEGER DEFAULT NULL",
                [],
            )?;
            // 创建收藏索引
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_translations_favorite ON translations(is_favorite, created_at DESC)",
                [],
            )?;
            log::info!("已补齐 translations.quality_rating 列");
        }

        Ok(())
    }

    /// 清理遗留的 SQLite 聊天检索结构，迁移至 Lance 宽表
    fn ensure_chat_search_schema(&self) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute_batch(
            r#"
            DROP TRIGGER IF EXISTS chat_msgs_fts_ai;
            DROP TRIGGER IF EXISTS chat_msgs_fts_au;
            DROP TRIGGER IF EXISTS chat_msgs_fts_ad;
            DROP TABLE IF EXISTS chat_messages_fts;
            DROP TABLE IF EXISTS chat_user_vectors;
            "#,
        )
        .map_err(|e| AppError::database(format!("清理旧聊天索引失败: {}", e)))?;
        Ok(())
    }

    // 注意：ensure_chat_v2_schema 已移除
    // Chat V2 Schema 现在由独立数据库 ChatV2Database 管理

    /// [DEPRECATED] 确保数据库兼容性，添加新版本可能需要的字段。
    ///
    /// # 废弃说明
    /// 此方法中的裸 `ALTER TABLE` 语句和 `CREATE TABLE IF NOT EXISTS` 绕过了数据治理系统，
    /// 应逐步迁移到 `data_governance/migration/coordinator.rs` 的 Refinery 迁移脚本中。
    ///
    /// # 过渡计划
    /// 1. 新的 schema 变更**禁止**在此方法中添加，应通过 `migrations/` 目录的 Refinery SQL 脚本实现
    /// 2. 现有逻辑在所有用户升级到包含对应 Refinery 迁移的版本后移除
    /// 3. 参见各语句的 `MIGRATION_DEBT:` 注释了解具体迁移状态
    #[deprecated(note = "使用 data_governance/migration/coordinator.rs 的 Refinery 迁移脚本替代")]
    fn ensure_compatibility(&self, conn: &SqlitePooledConnection) -> Result<()> {
        // MIGRATION_DEBT: document_control_states 表创建应迁移到 Refinery 脚本
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

        // 创建索引
        conn.execute("CREATE INDEX IF NOT EXISTS idx_document_control_states_state ON document_control_states (state)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_document_control_states_updated_at ON document_control_states (updated_at)", [])?;

        // 创建触发器
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS update_document_control_states_timestamp
             AFTER UPDATE ON document_control_states
             BEGIN
                 UPDATE document_control_states SET updated_at = CURRENT_TIMESTAMP WHERE document_id = NEW.document_id;
             END",
            [],
        )?;

        // MIGRATION_DEBT: 以下所有 ALTER TABLE 语句应迁移到对应数据库的 Refinery 脚本
        // 这些ALTER TABLE语句是安全的，如果字段已存在会被忽略
        let compatibility_updates = vec![
            // MIGRATION_DEBT: mistakes 表字段 → migrations/mistakes/
            "ALTER TABLE mistakes ADD COLUMN review_count INTEGER DEFAULT 0",
            "ALTER TABLE mistakes ADD COLUMN difficulty INTEGER DEFAULT 0",
            "ALTER TABLE mistakes ADD COLUMN last_reviewed_at TEXT",
            "ALTER TABLE mistakes ADD COLUMN chat_category TEXT NOT NULL DEFAULT 'analysis'",
            "ALTER TABLE mistakes ADD COLUMN chat_metadata TEXT",
            // MIGRATION_DEBT: chat_messages 表字段 → 主数据库 Refinery 脚本
            "ALTER TABLE chat_messages ADD COLUMN rag_sources TEXT",
            "ALTER TABLE chat_messages ADD COLUMN memory_sources TEXT",
            "ALTER TABLE chat_messages ADD COLUMN graph_sources TEXT",
            "ALTER TABLE chat_messages ADD COLUMN web_search_sources TEXT",
            "ALTER TABLE chat_messages ADD COLUMN image_paths TEXT",
            "ALTER TABLE chat_messages ADD COLUMN doc_attachments TEXT",
            "ALTER TABLE chat_messages ADD COLUMN tool_call TEXT",
            "ALTER TABLE chat_messages ADD COLUMN tool_result TEXT",
            "ALTER TABLE chat_messages ADD COLUMN embedding_retry INTEGER NOT NULL DEFAULT 0",
            // MIGRATION_DEBT: review_analyses 表字段 → 主数据库 Refinery 脚本
            "ALTER TABLE review_analyses ADD COLUMN summary TEXT",
            "ALTER TABLE review_analyses ADD COLUMN knowledge_points TEXT",
            // MIGRATION_DEBT: anki_cards 表字段 → 主数据库 Refinery 脚本
            "ALTER TABLE anki_cards ADD COLUMN source_type TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE anki_cards ADD COLUMN source_id TEXT NOT NULL DEFAULT ''",
            // MIGRATION_DEBT: chat_messages/review_chat_messages overrides/relations → 主数据库 Refinery 脚本
            "ALTER TABLE chat_messages ADD COLUMN overrides TEXT",
            "ALTER TABLE chat_messages ADD COLUMN relations TEXT",
            "ALTER TABLE review_chat_messages ADD COLUMN overrides TEXT",
            "ALTER TABLE review_chat_messages ADD COLUMN relations TEXT",
            // MIGRATION_DEBT: review_chat_messages graph_sources → 主数据库 Refinery 脚本
            "ALTER TABLE review_chat_messages ADD COLUMN graph_sources TEXT",
            // MIGRATION_DEBT: chat_messages 回合化字段 → 主数据库 Refinery 脚本
            "ALTER TABLE chat_messages ADD COLUMN turn_id TEXT",
            "ALTER TABLE chat_messages ADD COLUMN turn_seq SMALLINT",
            "ALTER TABLE chat_messages ADD COLUMN reply_to_msg_id INTEGER",
            "ALTER TABLE chat_messages ADD COLUMN message_kind TEXT",
            "ALTER TABLE chat_messages ADD COLUMN lifecycle TEXT",
        ];

        for sql in compatibility_updates {
            // 忽略错误，因为字段可能已存在
            let _ = conn.execute(sql, []);
        }

        // MIGRATION_DEBT: research_reports 表创建应迁移到主数据库 Refinery 脚本
        conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS research_reports (
                   id TEXT PRIMARY KEY,
                   created_at TEXT NOT NULL,
                   segments INTEGER NOT NULL,
                   context_window INTEGER NOT NULL,
                   report TEXT NOT NULL,
                   metadata TEXT
               );
               CREATE INDEX IF NOT EXISTS idx_research_reports_created ON research_reports(created_at);
            "#
        )?;

        // MIGRATION_DEBT: rag_query_logs 表创建应迁移到主数据库 Refinery 脚本
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS rag_query_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query_text TEXT NOT NULL,
                sub_library_id TEXT,
                results_count INTEGER NOT NULL,
                processing_time_ms INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_rag_query_logs_created ON rag_query_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_rag_query_logs_sublib ON rag_query_logs(sub_library_id);
            "#,
        )?;

        // MIGRATION_DEBT: pending_memory_candidates 表创建应迁移到主数据库 Refinery 脚本
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS pending_memory_candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL,
                origin TEXT DEFAULT 'auto_extract',
                user_edited INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'saved', 'dismissed')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'))
            );
            CREATE INDEX IF NOT EXISTS idx_pending_mem_conversation ON pending_memory_candidates(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_pending_mem_status ON pending_memory_candidates(status);
            CREATE INDEX IF NOT EXISTS idx_pending_mem_expires ON pending_memory_candidates(expires_at);
            "#,
        )?;

        // MIGRATION_DEBT: embedding_dimension_registry 表创建应迁移到主数据库 Refinery 脚本
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS embedding_dimension_registry (
                dimension INTEGER PRIMARY KEY,
                model_config_id TEXT NOT NULL,
                model_name TEXT NOT NULL,
                table_prefix TEXT NOT NULL CHECK(table_prefix IN ('kb_chunks', 'mm_pages')),
                is_multimodal INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_emb_dim_reg_model ON embedding_dimension_registry(model_config_id);
            CREATE INDEX IF NOT EXISTS idx_emb_dim_reg_prefix ON embedding_dimension_registry(table_prefix);
            "#,
        )?;

        // 在所有字段添加完成后创建索引
        let index_updates = vec![
            // 原有的索引（从initialize_schema移过来）
            "CREATE INDEX IF NOT EXISTS idx_mistakes_created_at ON mistakes(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_mistake_id ON chat_messages(mistake_id)",
            "CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status)",
            "CREATE INDEX IF NOT EXISTS idx_document_tasks_updated_at ON document_tasks(updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_document_tasks_document_segment ON document_tasks(document_id, segment_index)",
            "CREATE INDEX IF NOT EXISTS idx_review_analyses_created_at ON review_analyses(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_review_chat_messages_review_id ON review_chat_messages(review_analysis_id)",
            // 新增的索引
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_source ON anki_cards(source_type, source_id)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_created_at ON anki_cards(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_template_id ON anki_cards(template_id)",
            "CREATE INDEX IF NOT EXISTS idx_anki_cards_task_order ON anki_cards(task_id, card_order_in_task, created_at)",
            // 回合化索引
            "CREATE INDEX IF NOT EXISTS idx_chat_turn_id ON chat_messages(turn_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_turn_pair ON chat_messages(mistake_id, turn_id)",
            "CREATE INDEX IF NOT EXISTS idx_temp_sessions_state ON temp_sessions(stream_state)",
            "CREATE INDEX IF NOT EXISTS idx_temp_sessions_updated_at ON temp_sessions(updated_at)",
        ];

        for sql in index_updates {
            // 忽略错误，因为索引可能已存在
            let _ = conn.execute(sql, []);
        }

        log::info!("数据库兼容性检查完成");
        Ok(())
    }

    /// [DEPRECATED] 处理数据库迁移（旧版顺序迁移系统）
    ///
    /// 每个版本的迁移（migrate_to_version + INSERT schema_version）都被
    /// SAVEPOINT 包裹，确保单个版本迁移的原子性：
    /// - 成功 → RELEASE（提交）
    /// - 失败 → ROLLBACK TO + RELEASE（回滚并清理）
    ///
    /// 使用 SAVEPOINT 而非 BEGIN IMMEDIATE，因为：
    /// 1. SAVEPOINT 支持嵌套（部分迁移版本内部也有子 SAVEPOINT）
    /// 2. SQLite 的 DDL（CREATE TABLE 等）在 SAVEPOINT 内可正常工作
    ///
    /// # 废弃说明
    /// 此方法是旧迁移系统的核心，依赖 `CURRENT_DB_VERSION` 递增。
    /// 新迁移应通过 `data_governance/migration/coordinator.rs` 的 Refinery 脚本实现。
    /// 禁止再递增 `CURRENT_DB_VERSION` 或在 `migrate_to_version` 中新增分支。
    fn handle_migration(&self, conn: &mut SqlitePooledConnection) -> Result<()> {
        let current_version = self.get_schema_version(conn)?;

        if current_version < CURRENT_DB_VERSION {
            // 执行迁移
            for version in (current_version + 1)..=CURRENT_DB_VERSION {
                let sp_name = format!("migration_v{}", version);
                conn.execute_batch(&format!("SAVEPOINT {}", sp_name))?;

                let migration_result = (|| -> Result<()> {
                    self.migrate_to_version(conn, version)?;
                    // 每次迁移后立即记录版本
                    conn.execute(
                        "INSERT INTO schema_version (version) VALUES (?1)",
                        params![version],
                    )?;
                    Ok(())
                })();

                match migration_result {
                    Ok(()) => {
                        conn.execute_batch(&format!("RELEASE SAVEPOINT {}", sp_name))?;
                        log::info!("已更新数据库版本到: {}", version);
                    }
                    Err(e) => {
                        log::error!("数据库迁移到版本 {} 失败: {}, 正在回滚...", version, e);
                        // ROLLBACK TO 撤销变更但保留 SAVEPOINT，需再 RELEASE 清理
                        if let Err(rb_err) =
                            conn.execute_batch(&format!("ROLLBACK TO SAVEPOINT {}", sp_name))
                        {
                            log::error!("回滚 SAVEPOINT {} 失败: {}", sp_name, rb_err);
                        }
                        let _ = conn.execute_batch(&format!("RELEASE SAVEPOINT {}", sp_name));
                        return Err(e);
                    }
                }
            }
        }

        Ok(())
    }

    fn get_schema_version(&self, conn: &SqlitePooledConnection) -> Result<u32> {
        let version: Option<u32> = conn
            .query_row(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        Ok(version.unwrap_or(0))
    }

    fn set_schema_version(&self, conn: &SqlitePooledConnection, version: u32) -> Result<()> {
        conn.execute(
            "INSERT OR REPLACE INTO schema_version (version) VALUES (?1)",
            params![version],
        )?;
        Ok(())
    }

    fn migrate_to_version(&self, conn: &mut SqlitePooledConnection, version: u32) -> Result<()> {
        log::info!("执行数据库迁移到版本: {}", version);

        match version {
            1 => {
                // 添加 review_analyses 表
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS review_analyses (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        mistake_ids TEXT NOT NULL,
                        consolidated_input TEXT NOT NULL,
                        user_question TEXT NOT NULL,
                        status TEXT NOT NULL,
                        tags TEXT NOT NULL
                    );",
                )?;
            }
            2 => {
                // 添加 review_chat_messages 表
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS review_chat_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        review_analysis_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        timestamp TEXT NOT NULL,
                        thinking_content TEXT,
                        rag_sources TEXT,
                        doc_attachments TEXT,
                        FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS idx_review_chat_messages_review_id
                    ON review_chat_messages(review_analysis_id);"
                )?;
            }
            3 => {
                // 添加 rag_sub_libraries 表和 rag_configurations 表
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS rag_sub_libraries (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        description TEXT,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE TABLE IF NOT EXISTS rag_configurations (
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
                )?;

                // 插入默认的 RAG 配置
                use chrono::Utc;
                let now = Utc::now().to_rfc3339();
                let _result = conn.execute(
                    "INSERT OR IGNORE INTO rag_configurations (id, chunk_size, chunk_overlap, chunking_strategy, min_chunk_size, default_top_k, default_rerank_enabled, created_at, updated_at)
                     VALUES ('default', 512, 50, 'fixed_size', 20, 5, 0, ?1, ?2)",
                    params![now, now],
                );
            }
            4 => {
                // 为 review_analyses 添加分析类型字段
                let has_column: bool = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('review_analyses') WHERE name='analysis_type'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                ).unwrap_or(false);

                if !has_column {
                    conn.execute(
                        "ALTER TABLE review_analyses ADD COLUMN analysis_type TEXT NOT NULL DEFAULT 'consolidated_review'",
                        [],
                        )?;
                }
            }
            5 => {
                // 为 review_analyses 添加临时会话数据字段
                let has_column: bool = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('review_analyses') WHERE name='temp_session_data'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                ).unwrap_or(false);

                if !has_column {
                    conn.execute(
                        "ALTER TABLE review_analyses ADD COLUMN temp_session_data TEXT",
                        [],
                    )?;
                }
            }
            6 => {
                // 为 review_analyses 添加会话序列号
                let has_column: bool = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('review_analyses') WHERE name='session_sequence'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                ).unwrap_or(false);

                if !has_column {
                    conn.execute(
                        "ALTER TABLE review_analyses ADD COLUMN session_sequence INTEGER DEFAULT 0",
                        [],
                    )?;
                }
            }
            7 => {
                // 添加自定义Anki模板表
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS custom_anki_templates (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        description TEXT,
                        fields TEXT NOT NULL,
                        front_template TEXT NOT NULL,
                        back_template TEXT NOT NULL,
                        styling TEXT NOT NULL,
                        template_type TEXT NOT NULL DEFAULT 'custom',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        UNIQUE(name)
                    );",
                )?;
            }
            8 => {
                // Version 8: Deprecated - subject_configs table removed
            }
            9 => {
                // 删除 subject_prompts 表，数据已整合到 subject_configs 文件
                conn.execute_batch("DROP TABLE IF EXISTS subject_prompts;")?;
            }
            10 => {
                // 添加 chat_messages 的思维链内容字段
                // 检查字段是否已存在
                let has_column: bool = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name='thinking_content'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                )?;

                if !has_column {
                    conn.execute(
                        "ALTER TABLE chat_messages ADD COLUMN thinking_content TEXT",
                        [],
                    )?;
                }
            }
            11 => {
                // 添加 review_chat_messages 的 thinking_content 字段
                // 检查字段是否已存在
                let has_column: bool = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('review_chat_messages') WHERE name='thinking_content'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                )?;

                if !has_column {
                    conn.execute(
                        "ALTER TABLE review_chat_messages ADD COLUMN thinking_content TEXT",
                        [],
                    )?;
                }
            }
            12 => {
                // 首先更新 custom_anki_templates 表结构
                // 检查并添加缺失的列
                let columns_to_add = vec![
                    ("author", "TEXT"),
                    ("version", "TEXT NOT NULL DEFAULT '1.0.0'"),
                    ("preview_front", "TEXT NOT NULL DEFAULT ''"),
                    ("preview_back", "TEXT NOT NULL DEFAULT ''"),
                    ("note_type", "TEXT NOT NULL DEFAULT 'Basic'"),
                    ("fields_json", "TEXT NOT NULL DEFAULT '[]'"),
                    ("generation_prompt", "TEXT NOT NULL DEFAULT ''"),
                    ("css_style", "TEXT NOT NULL DEFAULT ''"),
                    ("field_extraction_rules_json", "TEXT NOT NULL DEFAULT '{}'"),
                    ("is_active", "INTEGER NOT NULL DEFAULT 1"),
                    ("is_built_in", "INTEGER NOT NULL DEFAULT 0"),
                ];

                for (column_name, column_def) in columns_to_add {
                    let has_column: bool = conn.query_row(
                        &format!("SELECT COUNT(*) FROM pragma_table_info('custom_anki_templates') WHERE name='{}'", column_name),
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )?;

                    if !has_column {
                        // 重命名旧列
                        if column_name == "css_style" {
                            // 检查是否有 styling 列
                            let has_styling: bool = conn.query_row(
                                "SELECT COUNT(*) FROM pragma_table_info('custom_anki_templates') WHERE name='styling'",
                                [],
                                |row| row.get::<_, i32>(0).map(|count| count > 0),
                            )?;
                            if has_styling {
                                conn.execute("ALTER TABLE custom_anki_templates RENAME COLUMN styling TO css_style", [])?;
                                continue;
                            }
                        }
                        if column_name == "fields_json" {
                            // 检查是否有 fields 列
                            let has_fields: bool = conn.query_row(
                                "SELECT COUNT(*) FROM pragma_table_info('custom_anki_templates') WHERE name='fields'",
                                [],
                                |row| row.get::<_, i32>(0).map(|count| count > 0),
                            )?;
                            if has_fields {
                                conn.execute("ALTER TABLE custom_anki_templates RENAME COLUMN fields TO fields_json", [])?;
                                continue;
                            }
                        }

                        conn.execute(
                            &format!(
                                "ALTER TABLE custom_anki_templates ADD COLUMN {} {}",
                                column_name, column_def
                            ),
                            [],
                        )?;
                    }
                }

                // 移除硬编码模板导入，改为统一导入路径
                // self.migrate_builtin_templates_to_db(conn)?;
                log::info!("数据库迁移完成，模板将通过统一路径导入");
            }
            13 => {
                // 版本13迁移已移至独立函数 migrate_v12_to_v13
                log::debug!("版本13迁移应使用独立函数，跳过内联迁移");
            }
            14 => {
                // 启用现有用户的重排序功能
                log::info!("开始数据库迁移 v13 -> v14: 启用重排序功能...");

                // 更新现有的RAG配置，启用重排序
                let updated_rows = conn.execute(
                    "UPDATE rag_configurations
                     SET default_rerank_enabled = 1, updated_at = ?1
                     WHERE id = 'default' AND default_rerank_enabled = 0",
                    params![chrono::Utc::now().to_rfc3339()],
                )?;

                if updated_rows > 0 {
                    log::info!("已为现有用户启用重排序功能");
                } else {
                    log::debug!("重排序功能已启用或无需更新");
                }

                log::info!("数据库迁移 v13 -> v14 完成");
            }
            15 => {
                // 添加搜索日志表
                log::info!("开始数据库迁移 v14 -> v15: 添加搜索日志功能...");

                // 创建搜索日志表
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS search_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        query TEXT NOT NULL,
                        search_type TEXT NOT NULL,
                        results_count INTEGER NOT NULL DEFAULT 0,
                        response_time_ms INTEGER,
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

                log::info!("搜索日志表创建成功");
                log::info!("数据库迁移 v14 -> v15 完成");
            }
            16 => {
                // 添加文档控制状态表
                log::info!("开始数据库迁移 v15 -> v16: 添加文档控制状态持久化...");

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

                log::info!("文档控制状态表创建成功");
                log::info!("数据库迁移 v15 -> v16 完成");
            }
            17 => {
                // v16→v17: Irec 与错题双向联动（已废弃，保留空迁移以维持版本号连续性）
                log::info!("数据库迁移 v16 -> v17: 已废弃，跳过");
            }
            18 => {
                // 添加图片路径字段到 kg_problem_cards 表
                log::info!("开始数据库迁移 v17 -> v18: 添加数学工作流图片存储...");

                // 为 kg_problem_cards 表添加原始图片路径字段
                conn.execute(
                    "ALTER TABLE kg_problem_cards ADD COLUMN original_image_path TEXT NULL",
                    [],
                )
                .unwrap_or_else(|_| 0); // 如果列已存在则忽略错误

                println!("数学工作流图片路径字段添加成功");
                println!("数据库迁移 v17 -> v18 完成");
            }
            19 => {
                // 添加文档附件字段到聊天消息表
                println!("开始数据库迁移 v18 -> v19: 添加文档附件支持...");

                // 为 chat_messages 表添加文档附件字段
                conn.execute(
                    "ALTER TABLE chat_messages ADD COLUMN doc_attachments TEXT NULL",
                    [],
                )
                .unwrap_or_else(|e| {
                    println!(
                        "chat_messages 表添加 doc_attachments 字段时出现错误（可能已存在）: {}",
                        e
                    );
                    0
                });

                // 为 review_chat_messages 表添加文档附件字段
                conn.execute(
                    "ALTER TABLE review_chat_messages ADD COLUMN doc_attachments TEXT NULL",
                    [],
                ).unwrap_or_else(|e| {
                    println!("review_chat_messages 表添加 doc_attachments 字段时出现错误（可能已存在）: {}", e);
                    0
                });

                println!("文档附件字段添加成功");
                println!("数据库迁移 v18 -> v19 完成");
            }
            20 => {
                // 为 review_chat_messages 表添加图片字段，与 chat_messages 对齐
                println!("执行数据库迁移到版本20：为review_chat_messages表添加多模态支持");

                // 添加 image_paths 字段
                conn.execute(
                    "ALTER TABLE review_chat_messages ADD COLUMN image_paths TEXT NULL",
                    [],
                )
                .unwrap_or_else(|e| {
                    println!(
                        "review_chat_messages 表添加 image_paths 字段时出现错误（可能已存在）: {}",
                        e
                    );
                    0
                });

                // 添加 image_base64 字段
                conn.execute(
                    "ALTER TABLE review_chat_messages ADD COLUMN image_base64 TEXT NULL",
                    [],
                )
                .unwrap_or_else(|e| {
                    println!(
                        "review_chat_messages 表添加 image_base64 字段时出现错误（可能已存在）: {}",
                        e
                    );
                    0
                });

                println!("review_chat_messages表多模态字段添加成功");
                println!("数据库迁移 v19 -> v20 完成");
            }
            21 => {
                // 添加 web_search_sources 字段到消息表，与 rag_sources 和 memory_sources 对齐
                println!("开始数据库迁移 v20 -> v21: 添加外部搜索来源持久化支持...");

                // 添加 chat_messages.web_search_sources 字段
                conn.execute(
                    "ALTER TABLE chat_messages ADD COLUMN web_search_sources TEXT NULL",
                    [],
                )
                .unwrap_or_else(|e| {
                    println!(
                        "chat_messages 表添加 web_search_sources 字段时出现错误（可能已存在）: {}",
                        e
                    );
                    0
                });

                // 添加 review_chat_messages.web_search_sources 字段
                conn.execute(
                    "ALTER TABLE review_chat_messages ADD COLUMN web_search_sources TEXT NULL",
                    [],
                ).unwrap_or_else(|e| {
                    println!("review_chat_messages 表添加 web_search_sources 字段时出现错误（可能已存在）: {}", e);
                    0
                });

                println!("外部搜索来源字段添加成功");
                println!("数据库迁移 v20 -> v21 完成");
            }
            22 => {
                // 回合化：为缺失 turn 字段的历史消息进行最小配对回填
                println!(
                    "开始数据库迁移 v21 -> v22: 填充 turn_id/turn_seq/message_kind/lifecycle …"
                );
                // 仅处理 role in ('user','assistant') 且 turn_id 为空的记录
                let mut distinct_stmt = conn.prepare(
                    "SELECT DISTINCT mistake_id FROM chat_messages WHERE (turn_id IS NULL OR turn_id = '') AND role IN ('user','assistant')"
                )?;
                let mistake_ids = distinct_stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;

                for mid in mistake_ids {
                    let mut rows_stmt = conn.prepare(
                        "SELECT id, role, timestamp FROM chat_messages WHERE mistake_id = ?1 AND (turn_id IS NULL OR turn_id = '') AND role IN ('user','assistant') ORDER BY timestamp ASC"
                    )?;
                    let rows = rows_stmt
                        .query_map(rusqlite::params![mid], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })?
                        .collect::<std::result::Result<Vec<_>, _>>()?;

                    let mut pending_user: Option<(i64, String)> = None; // (user_row_id, turn_id)
                    for (row_id, role, _ts) in rows {
                        if role == "user" {
                            let turn_id = uuid::Uuid::new_v4().to_string();
                            conn.execute(
                            "UPDATE chat_messages SET turn_id = ?1, turn_seq = 0, reply_to_msg_id = NULL, message_kind = 'user.input', lifecycle = NULL WHERE id = ?2",
                            rusqlite::params![turn_id, row_id],
                        )?;
                            pending_user = Some((row_id, turn_id));
                        } else if role == "assistant" {
                            if let Some((user_row_id, turn_id)) = pending_user.take() {
                                conn.execute(
                                "UPDATE chat_messages SET turn_id = ?1, turn_seq = 1, reply_to_msg_id = ?2, message_kind = 'assistant.answer', lifecycle = 'complete' WHERE id = ?3",
                                rusqlite::params![turn_id, user_row_id, row_id],
                            )?;
                            } else {
                                // 不为孤立的 assistant 生成新 turn，保留其 turn_id 为空，读取层将忽略显示
                                println!(
                                    "v22迁移：检测到孤立assistant(id={})，已保留为未配对形态",
                                    row_id
                                );
                            }
                        }
                    }
                }

                // 幂等创建索引
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_chat_turn_id ON chat_messages(turn_id)",
                    [],
                )?;
                conn.execute("CREATE INDEX IF NOT EXISTS idx_chat_turn_pair ON chat_messages(mistake_id, turn_id)", [])?;
                println!("数据库迁移 v21 -> v22 完成");
            }
            23 => {
                // 历史工具行合并：把 role='tool' 行的调用/结果/引文合并回最近的 assistant
                println!("开始数据库迁移 v22 -> v23: 合并历史工具消息到 assistant …");
                // 收集所有存在工具行的 mistake_id
                let mut distinct_stmt = conn
                    .prepare("SELECT DISTINCT mistake_id FROM chat_messages WHERE role = 'tool'")?;
                let mistake_ids = distinct_stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;

                for mid in mistake_ids {
                    // 取所有工具行（按时间）
                    let mut tool_stmt = conn.prepare(
                        "SELECT id, timestamp, tool_call, tool_result FROM chat_messages WHERE mistake_id = ?1 AND role = 'tool' ORDER BY timestamp ASC"
                    )?;
                    let tool_rows = tool_stmt
                        .query_map(rusqlite::params![mid.clone()], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        })?
                        .collect::<std::result::Result<Vec<_>, _>>()?;

                    for (tool_id, ts_str, tool_call_json, tool_result_json) in tool_rows {
                        // 定位目标 assistant（优先后面的）
                        let mut target_stmt = conn.prepare(
                            "SELECT id, rag_sources, memory_sources, graph_sources, web_search_sources, overrides \
                             FROM chat_messages \
                             WHERE mistake_id = ?1 AND role = 'assistant' AND timestamp >= ?2 \
                             ORDER BY timestamp ASC LIMIT 1"
                        )?;
                        let mut target = target_stmt.query_map(
                            rusqlite::params![mid.clone(), ts_str.clone()],
                            |row| {
                                Ok((
                                    row.get::<_, i64>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                    row.get::<_, Option<String>>(2)?,
                                    row.get::<_, Option<String>>(3)?,
                                    row.get::<_, Option<String>>(4)?,
                                    row.get::<_, Option<String>>(5)?,
                                ))
                            },
                        )?;
                        let mut target_row = target.next().transpose()?;
                        if target_row.is_none() {
                            // 尝试取前面的 assistant
                            let mut prev_stmt = conn.prepare(
                                "SELECT id, rag_sources, memory_sources, graph_sources, web_search_sources, overrides \
                                 FROM chat_messages \
                                 WHERE mistake_id = ?1 AND role = 'assistant' AND timestamp < ?2 \
                                 ORDER BY timestamp DESC LIMIT 1"
                            )?;
                            let mut prev = prev_stmt.query_map(
                                rusqlite::params![mid.clone(), ts_str.clone()],
                                |row| {
                                    Ok((
                                        row.get::<_, i64>(0)?,
                                        row.get::<_, Option<String>>(1)?,
                                        row.get::<_, Option<String>>(2)?,
                                        row.get::<_, Option<String>>(3)?,
                                        row.get::<_, Option<String>>(4)?,
                                        row.get::<_, Option<String>>(5)?,
                                    ))
                                },
                            )?;
                            target_row = prev.next().transpose()?;
                        }
                        if let Some((
                            assistant_id,
                            rag_json,
                            mem_json,
                            graph_json,
                            web_json,
                            overrides_json,
                        )) = target_row
                        {
                            // 解析 overrides，并合并 multi_tool
                            let mut overrides: serde_json::Value = overrides_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok())
                                .unwrap_or(serde_json::json!({}));
                            let multi = overrides
                                .get_mut("multi_tool")
                                .and_then(|v| v.as_object_mut());
                            if multi.is_none() {
                                overrides["multi_tool"] =
                                    serde_json::json!({ "tool_calls": [], "tool_results": [] });
                            }
                            let multi_obj = overrides
                                .get_mut("multi_tool")
                                .unwrap()
                                .as_object_mut()
                                .unwrap();

                            // Push tool_call (separate mutable borrow scope)
                            if let Some(tc_str) = tool_call_json.as_deref() {
                                if let Ok(tc_val) =
                                    serde_json::from_str::<serde_json::Value>(tc_str)
                                {
                                    if let Some(calls_arr) = multi_obj
                                        .get_mut("tool_calls")
                                        .and_then(|v| v.as_array_mut())
                                    {
                                        calls_arr.push(tc_val);
                                    }
                                }
                            }
                            // 解析 tool_result，合并 citations
                            let mut tool_name_for_route: Option<String> = None;
                            if let Some(tc_str) = tool_call_json.as_deref() {
                                if let Ok(tc_val) =
                                    serde_json::from_str::<serde_json::Value>(tc_str)
                                {
                                    tool_name_for_route = tc_val
                                        .get("tool_name")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                }
                            }
                            let mut citations: Option<Vec<serde_json::Value>> = None;
                            if let Some(tr_str) = tool_result_json.as_deref() {
                                if let Ok(tr_val) =
                                    serde_json::from_str::<serde_json::Value>(tr_str)
                                {
                                    // 结果本体归档（separate mutable borrow scope）
                                    if let Some(results_arr) = multi_obj
                                        .get_mut("tool_results")
                                        .and_then(|v| v.as_array_mut())
                                    {
                                        results_arr.push(tr_val.clone());
                                    }
                                    // citations 提取
                                    citations = tr_val
                                        .get("citations")
                                        .and_then(|v| v.as_array())
                                        .map(|a| a.to_vec());
                                }
                            }

                            // 合并 citations 到对应来源集合
                            let mut rag_vec: Option<Vec<serde_json::Value>> = rag_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok());
                            let mut mem_vec: Option<Vec<serde_json::Value>> = mem_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok());
                            let mut graph_vec: Option<Vec<serde_json::Value>> = graph_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok());
                            let mut web_vec: Option<Vec<serde_json::Value>> = web_json
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok());
                            if let Some(cits) = citations {
                                let name = tool_name_for_route.unwrap_or_default();
                                if name == "web_search" {
                                    let v = web_vec.get_or_insert_with(|| vec![]);
                                    v.extend(cits);
                                } else if name == "graph" {
                                    let v = graph_vec.get_or_insert_with(|| vec![]);
                                    v.extend(cits);
                                } else if name == "memory" {
                                    let v = mem_vec.get_or_insert_with(|| vec![]);
                                    v.extend(cits);
                                } else {
                                    let v = rag_vec.get_or_insert_with(|| vec![]);
                                    v.extend(cits);
                                }
                            }

                            // 持久化更新 assistant 的 overrides 与 sources
                            let overrides_str =
                                serde_json::to_string(&overrides).unwrap_or("{}".to_string());
                            let rag_str = rag_vec
                                .as_ref()
                                .map(|v| serde_json::to_string(v).unwrap_or_default());
                            let mem_str = mem_vec
                                .as_ref()
                                .map(|v| serde_json::to_string(v).unwrap_or_default());
                            let graph_str = graph_vec
                                .as_ref()
                                .map(|v| serde_json::to_string(v).unwrap_or_default());
                            let web_str = web_vec
                                .as_ref()
                                .map(|v| serde_json::to_string(v).unwrap_or_default());
                            conn.execute(
                                "UPDATE chat_messages SET overrides = ?1, rag_sources = COALESCE(?2, rag_sources), memory_sources = COALESCE(?3, memory_sources), graph_sources = COALESCE(?4, graph_sources), web_search_sources = COALESCE(?5, web_search_sources) WHERE id = ?6",
                                rusqlite::params![overrides_str, rag_str, mem_str, graph_str, web_str, assistant_id],
                            )?;

                            // 删除工具行
                            conn.execute(
                                "DELETE FROM chat_messages WHERE id = ?1",
                                rusqlite::params![tool_id],
                            )?;
                        } else {
                            // 无法定位到 assistant，保留工具行供人工处理
                            println!(
                                "v23迁移：未找到可合并目标assistant，保留工具行: id={}",
                                tool_id
                            );
                        }
                    }
                }

                // 添加唯一（部分）索引：同一 turn 仅允许一个 seq 值
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_turn_seq ON chat_messages(turn_id, turn_seq) \
                     WHERE turn_id IS NOT NULL AND turn_id <> '' AND turn_seq IS NOT NULL",
                    [],
                )?;

                println!("数据库迁移 v22 -> v23 完成");
            }
            24 => {
                // 放宽 document_tasks.status 以支持 'Paused'
                println!("开始数据库迁移 v23 -> v24: 更新 document_tasks.status CHECK 约束加入 'Paused'...");

                // 首先清理可能存在的残留旧表（处理迁移中断的情况）
                let old_table_exists: bool = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='document_tasks_old'",
                    [],
                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                ).unwrap_or(false);

                if old_table_exists {
                    println!("检测到残留的 document_tasks_old 表，正在清理...");
                    // 尝试恢复数据
                    let has_document_tasks = conn.query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='document_tasks'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    ).unwrap_or(false);

                    if !has_document_tasks {
                        // 如果 document_tasks 不存在，从 old 表恢复
                        println!("🔧 恢复 document_tasks 表...");
                        conn.execute(
                            "ALTER TABLE document_tasks_old RENAME TO document_tasks",
                            [],
                        )?;
                    } else {
                        // 如果都存在，删除旧表
                        conn.execute("DROP TABLE IF EXISTS document_tasks_old", [])?;
                    }
                }

                // 检查是否需要重建表
                let sql: Option<String> = conn.query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='document_tasks'",
                    [],
                    |row| row.get(0),
                ).optional()?;

                let needs_rebuild = match sql {
                    Some(def) => !def.contains("'Paused'"),
                    None => {
                        // 表不存在，需要创建
                        println!("document_tasks 表不存在，将创建新表");
                        true
                    }
                };

                if needs_rebuild {
                    // 使用嵌套 SAVEPOINT 确保表重建的原子性
                    // 注意：不能使用 conn.transaction()，因为外层已有 SAVEPOINT 事务
                    conn.execute_batch("SAVEPOINT v24_rebuild")?;

                    // 检查表是否存在
                    let table_exists: bool = conn.query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='document_tasks'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    ).unwrap_or(false);

                    if table_exists {
                        // 表存在，重命名并迁移数据
                        conn.execute(
                            "ALTER TABLE document_tasks RENAME TO document_tasks_old",
                            [],
                        )?;
                    }

                    // 创建新表
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
                         )",
                        [],
                    )?;

                    // 如果旧表存在，迁移数据
                    if table_exists {
                        conn.execute(
                            "INSERT INTO document_tasks(id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, error_message, anki_generation_options_json)
                             SELECT id, document_id, original_document_name, segment_index, content_segment,
                                    CASE WHEN status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')
                                         THEN status
                                         ELSE 'Pending' END,
                                    created_at, updated_at, error_message, anki_generation_options_json
                             FROM document_tasks_old",
                            [],
                        )?;

                        // 删除旧表
                        conn.execute("DROP TABLE document_tasks_old", [])?;
                    }

                    // 创建索引
                    conn.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id)", [])?;
                    conn.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status)", [])?;

                    // 提交嵌套 SAVEPOINT
                    conn.execute_batch("RELEASE SAVEPOINT v24_rebuild")?;

                    // 修复 anki_cards 表的外键引用（如果表存在）
                    let anki_cards_needs_fix: bool = conn.query_row(
                        "SELECT sql FROM sqlite_master WHERE type='table' AND name='anki_cards'",
                        [],
                        |row| {
                            let sql: String = row.get(0)?;
                            Ok(sql.contains("document_tasks_old"))
                        },
                    ).unwrap_or(false);

                    if anki_cards_needs_fix {
                        println!("🔧 修复 anki_cards 表的外键引用...");

                        // 使用嵌套 SAVEPOINT（不能用 conn.transaction()，外层已有事务）
                        conn.execute_batch("SAVEPOINT v24_anki_fix")?;

                        // 重命名旧表
                        conn.execute("ALTER TABLE anki_cards RENAME TO anki_cards_old", [])?;

                        // 确保旧表包含新列，避免数据丢失或列序错位
                        let ensure_columns = [
                            ("extra_fields_json", "TEXT DEFAULT '{}'"),
                            ("template_id", "TEXT"),
                            ("text", "TEXT"),
                            ("source_type", "TEXT NOT NULL DEFAULT ''"),
                            ("source_id", "TEXT NOT NULL DEFAULT ''"),
                        ];
                        for (column, ddl) in ensure_columns {
                            let has_column: bool = conn
                                .query_row(
                                    "SELECT COUNT(*) FROM pragma_table_info('anki_cards_old') WHERE name = ?1",
                                    params![column],
                                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                                )
                                .unwrap_or(false);
                            if !has_column {
                                let sql = format!(
                                    "ALTER TABLE anki_cards_old ADD COLUMN {} {}",
                                    column, ddl
                                );
                                conn.execute(&sql, [])?;
                            }
                        }

                        // 确保旧表包含新列，避免数据丢失或列序错位
                        let ensure_columns = [
                            ("extra_fields_json", "TEXT DEFAULT '{}'"),
                            ("template_id", "TEXT"),
                            ("text", "TEXT"),
                            ("source_type", "TEXT NOT NULL DEFAULT ''"),
                            ("source_id", "TEXT NOT NULL DEFAULT ''"),
                        ];
                        for (column, ddl) in ensure_columns {
                            let has_column: bool = conn
                                .query_row(
                                    "SELECT COUNT(*) FROM pragma_table_info('anki_cards_old') WHERE name = ?1",
                                    params![column],
                                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                                )
                                .unwrap_or(false);
                            if !has_column {
                                let sql = format!(
                                    "ALTER TABLE anki_cards_old ADD COLUMN {} {}",
                                    column, ddl
                                );
                                conn.execute(&sql, [])?;
                            }
                        }

                        // 确保旧表包含新列，避免数据丢失或列序错位
                        let ensure_columns = [
                            ("extra_fields_json", "TEXT DEFAULT '{}'"),
                            ("template_id", "TEXT"),
                            ("text", "TEXT"),
                            ("source_type", "TEXT NOT NULL DEFAULT ''"),
                            ("source_id", "TEXT NOT NULL DEFAULT ''"),
                        ];
                        for (column, ddl) in ensure_columns {
                            let has_column: bool = conn
                                .query_row(
                                    "SELECT COUNT(*) FROM pragma_table_info('anki_cards_old') WHERE name = ?1",
                                    params![column],
                                    |row| row.get::<_, i32>(0).map(|count| count > 0),
                                )
                                .unwrap_or(false);
                            if !has_column {
                                let sql = format!(
                                    "ALTER TABLE anki_cards_old ADD COLUMN {} {}",
                                    column, ddl
                                );
                                conn.execute(&sql, [])?;
                            }
                        }

                        // 创建新表，外键引用正确的 document_tasks 表
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
                                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                                extra_fields_json TEXT DEFAULT '{}',
                                template_id TEXT,
                                text TEXT,
                                source_type TEXT NOT NULL DEFAULT '',
                                source_id TEXT NOT NULL DEFAULT ''
                            )",
                            [],
                        )?;

                        // 迁移数据
                        conn.execute(
                            "INSERT INTO anki_cards (
                                id, task_id, front, back, tags_json, images_json, is_error_card,
                                error_content, card_order_in_task, created_at, updated_at,
                                extra_fields_json, template_id, text, source_type, source_id
                            )
                            SELECT
                                id, task_id, front, back, tags_json, images_json, is_error_card,
                                error_content, card_order_in_task, created_at, updated_at,
                                COALESCE(extra_fields_json, '{}'), template_id, text, source_type, source_id
                            FROM anki_cards_old",
                            [],
                        )?;

                        // 重建索引
                        conn.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id)", [])?;
                        conn.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card)", [])?;
                        conn.execute(
                            "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)",
                            [],
                        )?;

                        // 删除旧表
                        conn.execute("DROP TABLE anki_cards_old", [])?;

                        conn.execute_batch("RELEASE SAVEPOINT v24_anki_fix")?;
                        println!("anki_cards 表外键引用已修复");
                    }

                    println!("v24: document_tasks 已重建并支持 'Paused'");
                } else {
                    println!("v24: document_tasks 已包含 'Paused'，无需重建");

                    // 即使不需要重建 document_tasks，也要检查 anki_cards 表的外键引用
                    let anki_cards_needs_fix: bool = conn.query_row(
                        "SELECT sql FROM sqlite_master WHERE type='table' AND name='anki_cards'",
                        [],
                        |row| {
                            let sql: String = row.get(0)?;
                            Ok(sql.contains("document_tasks_old"))
                        },
                    ).unwrap_or(false);

                    if anki_cards_needs_fix {
                        println!("🔧 修复 anki_cards 表的外键引用...");

                        // 使用嵌套 SAVEPOINT（不能用 conn.transaction()，外层已有事务）
                        conn.execute_batch("SAVEPOINT v24_anki_fix_else")?;

                        // 重命名旧表
                        conn.execute("ALTER TABLE anki_cards RENAME TO anki_cards_old", [])?;

                        // 创建新表，外键引用正确的 document_tasks 表
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
                                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                                extra_fields_json TEXT DEFAULT '{}',
                                template_id TEXT,
                                text TEXT,
                                source_type TEXT NOT NULL DEFAULT '',
                                source_id TEXT NOT NULL DEFAULT ''
                            )",
                            [],
                        )?;

                        // 迁移数据
                        conn.execute(
                            "INSERT INTO anki_cards (
                                id, task_id, front, back, tags_json, images_json, is_error_card,
                                error_content, card_order_in_task, created_at, updated_at,
                                extra_fields_json, template_id, text, source_type, source_id
                            )
                            SELECT
                                id, task_id, front, back, tags_json, images_json, is_error_card,
                                error_content, card_order_in_task, created_at, updated_at,
                                COALESCE(extra_fields_json, '{}'), template_id, text, source_type, source_id
                            FROM anki_cards_old",
                            [],
                        )?;

                        // 重建索引
                        conn.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id)", [])?;
                        conn.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card)", [])?;
                        conn.execute(
                            "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)",
                            [],
                        )?;

                        // 删除旧表
                        conn.execute("DROP TABLE anki_cards_old", [])?;

                        conn.execute_batch("RELEASE SAVEPOINT v24_anki_fix_else")?;
                        println!("anki_cards 表外键引用已修复");
                    }
                }
                println!("数据库迁移 v23 -> v24 完成");
            }
            25 => {
                // 修复已经在v24但anki_cards表仍然引用document_tasks_old的问题
                println!("开始数据库迁移 v24 -> v25: 修复 anki_cards 表外键引用...");

                // 检查 anki_cards 表的外键引用
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
                    println!("🔧 检测到 anki_cards 表仍然引用 document_tasks_old，开始修复...");

                    // 使用嵌套 SAVEPOINT（不能用 conn.transaction()，外层已有事务）
                    conn.execute_batch("SAVEPOINT v25_anki_fix")?;

                    // 重命名旧表
                    conn.execute("ALTER TABLE anki_cards RENAME TO anki_cards_old", [])?;

                    // 确保旧表包含新列，避免数据丢失或列序错位
                    let ensure_columns = [
                        ("extra_fields_json", "TEXT DEFAULT '{}'"),
                        ("template_id", "TEXT"),
                        ("text", "TEXT"),
                        ("source_type", "TEXT NOT NULL DEFAULT ''"),
                        ("source_id", "TEXT NOT NULL DEFAULT ''"),
                    ];
                    for (column, ddl) in ensure_columns {
                        let has_column: bool = conn
                            .query_row(
                                "SELECT COUNT(*) FROM pragma_table_info('anki_cards_old') WHERE name = ?1",
                                params![column],
                                |row| row.get::<_, i32>(0).map(|count| count > 0),
                            )
                            .unwrap_or(false);
                        if !has_column {
                            let sql =
                                format!("ALTER TABLE anki_cards_old ADD COLUMN {} {}", column, ddl);
                            conn.execute(&sql, [])?;
                        }
                    }

                    // 创建新表，外键引用正确的 document_tasks 表
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
                            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                            extra_fields_json TEXT DEFAULT '{}',
                            template_id TEXT,
                            text TEXT,
                            source_type TEXT NOT NULL DEFAULT '',
                            source_id TEXT NOT NULL DEFAULT ''
                        )",
                        [],
                    )?;

                    // 迁移数据
                    conn.execute(
                        "INSERT INTO anki_cards (
                            id, task_id, front, back, tags_json, images_json, is_error_card,
                            error_content, card_order_in_task, created_at, updated_at,
                            extra_fields_json, template_id, text, source_type, source_id
                        )
                        SELECT
                            id, task_id, front, back, tags_json, images_json, is_error_card,
                            error_content, card_order_in_task, created_at, updated_at,
                            COALESCE(extra_fields_json, '{}'), template_id, text, source_type, source_id
                        FROM anki_cards_old",
                        [],
                    )?;

                    // 重建索引
                    conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id)",
                        [],
                    )?;
                    conn.execute("CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card)", [])?;
                    conn.execute(
                        "CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)",
                        [],
                    )?;

                    // 删除旧表
                    conn.execute("DROP TABLE anki_cards_old", [])?;

                    conn.execute_batch("RELEASE SAVEPOINT v25_anki_fix")?;
                    println!("anki_cards 表外键引用已修复");
                } else {
                    println!("anki_cards 表外键引用正确，无需修复");
                }

                println!("数据库迁移 v24 -> v25 完成");
            }
            26 => {
                println!("开始数据库迁移 v25 -> v26: 为 mistakes 表添加 OCR 笔记字段...");

                let has_column: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='ocr_note'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_column {
                    conn.execute("ALTER TABLE mistakes ADD COLUMN ocr_note TEXT", [])?;
                    println!("已为 mistakes 表添加 ocr_note 列");
                } else {
                    println!("mistakes 表已包含 ocr_note 列，跳过添加");
                }

                println!("数据库迁移 v25 -> v26 完成");
            }
            27 => {
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
            }
            28 => {
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
            }
            29 => {
                println!("开始数据库迁移 v28 -> v29: 添加 stable_id 列用于消息增量保存...");

                let has_column: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name='stable_id'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_column {
                    conn.execute("ALTER TABLE chat_messages ADD COLUMN stable_id TEXT", [])?;
                    println!("已为 chat_messages 表添加 stable_id 列");
                } else {
                    println!("chat_messages 表已包含 stable_id 列，跳过添加");
                }

                // 创建部分唯一索引（仅对非空 stable_id）
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_stable_id ON chat_messages(mistake_id, stable_id) \
                     WHERE stable_id IS NOT NULL AND stable_id <> ''",
                    [],
                )?;
                println!("已创建 chat_messages(mistake_id, stable_id) 部分唯一索引");

                // 创建普通索引加速查询
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_chat_stable_id ON chat_messages(stable_id) \
                     WHERE stable_id IS NOT NULL AND stable_id <> ''",
                    [],
                )?;

                println!("数据库迁移 v28 -> v29 完成");
            }
            30 => {
                println!("开始数据库迁移 v29 -> v30: 预留版本");
                println!("数据库迁移 v29 -> v30 完成");
            }
            31 => {
                println!("开始数据库迁移 v30 -> v31: 确保 stable_id 列与索引存在（幂等补齐）...");

                // 幂等检查并添加 stable_id 列
                let has_column: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name='stable_id'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_column {
                    conn.execute("ALTER TABLE chat_messages ADD COLUMN stable_id TEXT", [])?;
                    println!("已为 chat_messages 表添加 stable_id 列");
                } else {
                    println!("chat_messages 表已包含 stable_id 列，跳过添加");
                }

                // 幂等创建唯一索引
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_stable_id ON chat_messages(mistake_id, stable_id) \
                     WHERE stable_id IS NOT NULL AND stable_id <> ''",
                    [],
                )?;

                // 幂等创建普通索引
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_chat_stable_id ON chat_messages(stable_id) \
                     WHERE stable_id IS NOT NULL AND stable_id <> ''",
                    [],
                )?;

                println!("数据库迁移 v30 -> v31 完成");
            }
            32 => {
                println!("开始数据库迁移 v31 -> v32: 添加模板 AI 会话表...");

                // 创建 template_ai_sessions 表
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS template_ai_sessions (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        base_template_id TEXT,
                        latest_template_json TEXT,
                        language TEXT NOT NULL DEFAULT 'zh-CN',
                        status TEXT NOT NULL DEFAULT 'active',
                        reference_template_ids TEXT NOT NULL DEFAULT '[]',
                        model_override_id TEXT,
                        style_preferences_json TEXT
                    )",
                    [],
                )?;

                // 创建 template_ai_messages 表
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS template_ai_messages (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        payload_json TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(session_id) REFERENCES template_ai_sessions(id) ON DELETE CASCADE
                    )",
                    [],
                )?;

                // 创建索引
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_template_ai_messages_session ON template_ai_messages(session_id)",
                    [],
                )?;
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_template_ai_sessions_status ON template_ai_sessions(status)",
                    [],
                )?;

                println!("数据库迁移 v31 -> v32 完成");
            }
            33 => {
                println!("开始数据库迁移 v32 -> v33: 模板 AI 会话表新增模型/风格字段...");
                if let Err(e) = conn.execute(
                    "ALTER TABLE template_ai_sessions ADD COLUMN model_override_id TEXT",
                    [],
                ) {
                    if !e.to_string().contains("duplicate column name") {
                        return Err(AppError::database(format!(
                            "添加 model_override_id 列失败: {}",
                            e
                        ))
                        .into());
                    }
                }
                if let Err(e) = conn.execute(
                    "ALTER TABLE template_ai_sessions ADD COLUMN style_preferences_json TEXT",
                    [],
                ) {
                    if !e.to_string().contains("duplicate column name") {
                        return Err(AppError::database(format!(
                            "添加 style_preferences_json 列失败: {}",
                            e
                        ))
                        .into());
                    }
                }
                println!("数据库迁移 v32 -> v33 完成");
            }
            34 => {
                println!("开始数据库迁移 v33 -> v34: 创建 temp_sessions 表与索引...");
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS temp_sessions (
                        temp_id TEXT PRIMARY KEY,
                        session_data TEXT NOT NULL,
                        stream_state TEXT NOT NULL DEFAULT 'in_progress',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        last_error TEXT
                    );
                    CREATE INDEX IF NOT EXISTS idx_temp_sessions_state ON temp_sessions(stream_state);
                    CREATE INDEX IF NOT EXISTS idx_temp_sessions_updated_at ON temp_sessions(updated_at);",
                )?;
                println!("数据库迁移 v33 -> v34 完成");
            }
            35 => {
                println!(
                    "开始数据库迁移 v34 -> v35: 为 mistakes 表添加 autosave_signature 字段..."
                );

                let has_column: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('mistakes') WHERE name='autosave_signature'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_column {
                    conn.execute(
                        "ALTER TABLE mistakes ADD COLUMN autosave_signature TEXT",
                        [],
                    )?;
                    println!("已添加 autosave_signature 列");
                } else {
                    println!("mistakes 表已包含 autosave_signature 列，跳过添加");
                }

                println!("数据库迁移 v34 -> v35 完成");
            }
            36 => {
                println!("开始数据库迁移 v35 -> v36: 清理 temp_sessions 表废弃快照字段...");

                // SQLite 不支持直接删除列，需要重建表
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS temp_sessions_new (
                        temp_id TEXT PRIMARY KEY,
                        session_data TEXT NOT NULL,
                        stream_state TEXT NOT NULL DEFAULT 'in_progress',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        last_error TEXT
                    );
                    INSERT INTO temp_sessions_new (temp_id, session_data, stream_state, created_at, updated_at, last_error)
                    SELECT temp_id, session_data, stream_state, created_at, updated_at, last_error
                    FROM temp_sessions;
                    DROP TABLE temp_sessions;
                    ALTER TABLE temp_sessions_new RENAME TO temp_sessions;
                    CREATE INDEX IF NOT EXISTS idx_temp_sessions_state ON temp_sessions(stream_state);
                    CREATE INDEX IF NOT EXISTS idx_temp_sessions_updated_at ON temp_sessions(updated_at);",
                )?;

                println!("数据库迁移 v35 -> v36 完成（已删除 stream_snapshot、last_snapshot_hash、last_snapshot_at 字段）");
            }
            37 => {
                println!("开始数据库迁移 v36 -> v37: 为 translations 表添加收藏和评分字段...");

                // 添加 is_favorite 字段（默认 0 = 未收藏）
                conn.execute(
                    "ALTER TABLE translations ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .ok(); // 忽略已存在错误

                // 添加 quality_rating 字段（可选，1-5 评分，NULL = 未评分）
                conn.execute(
                    "ALTER TABLE translations ADD COLUMN quality_rating INTEGER DEFAULT NULL",
                    [],
                )
                .ok(); // 忽略已存在错误

                // 添加收藏索引以优化收藏列表查询
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_translations_favorite ON translations(is_favorite, created_at DESC)",
                    [],
                )?;

                println!("数据库迁移 v36 -> v37 完成（translations 表新增 is_favorite, quality_rating 字段）");
            }
            38 => {
                println!("开始数据库迁移 v37 -> v38: 为 exam_sheet_sessions 表添加 resource_id 和 content_hash 字段...");

                // 检查并添加 resource_id 字段
                let has_resource_id: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('exam_sheet_sessions') WHERE name='resource_id'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_resource_id {
                    conn.execute(
                        "ALTER TABLE exam_sheet_sessions ADD COLUMN resource_id TEXT",
                        [],
                    )?;
                    println!("已为 exam_sheet_sessions 表添加 resource_id 列");
                } else {
                    println!("exam_sheet_sessions 表已包含 resource_id 列，跳过添加");
                }

                // 检查并添加 content_hash 字段
                let has_content_hash: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('exam_sheet_sessions') WHERE name='content_hash'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if !has_content_hash {
                    conn.execute(
                        "ALTER TABLE exam_sheet_sessions ADD COLUMN content_hash TEXT",
                        [],
                    )?;
                    println!("已为 exam_sheet_sessions 表添加 content_hash 列");
                } else {
                    println!("exam_sheet_sessions 表已包含 content_hash 列，跳过添加");
                }

                // 为 resource_id 添加索引，便于查询已同步的题目集会话
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_exam_sheet_sessions_resource_id ON exam_sheet_sessions(resource_id)",
                    [],
                )?;

                println!("数据库迁移 v37 -> v38 完成（exam_sheet_sessions 表新增 resource_id, content_hash 字段）");
            }
            39 => {
                // Version 39: 彻底删除 subject 相关字段
                println!("📦 开始数据库迁移 v38 -> v39: 彻底删除 subject 字段");

                // 1. 重建 document_tasks 表（删除 subject_name 字段）
                let has_subject_name: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='subject_name'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if has_subject_name {
                    conn.execute("DROP INDEX IF EXISTS idx_document_tasks_subject_name", [])?;
                    conn.execute(
                        "ALTER TABLE document_tasks RENAME TO document_tasks_old_v39",
                        [],
                    )?;
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
                        )",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO document_tasks(id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, error_message, anki_generation_options_json)
                         SELECT id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at, error_message, anki_generation_options_json
                         FROM document_tasks_old_v39",
                        [],
                    )?;
                    conn.execute("DROP TABLE document_tasks_old_v39", [])?;
                    conn.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id)", [])?;
                    conn.execute("CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status)", [])?;
                    println!("document_tasks 表已删除 subject_name 字段");
                }

                // 2. 重建 review_analyses 表（删除 subject 字段）
                let has_review_subject: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('review_analyses') WHERE name='subject'",
                        [],
                        |row| row.get::<_, i32>(0).map(|count| count > 0),
                    )
                    .unwrap_or(false);

                if has_review_subject {
                    conn.execute("DROP INDEX IF EXISTS idx_review_analyses_subject", [])?;
                    conn.execute(
                        "ALTER TABLE review_analyses RENAME TO review_analyses_old_v39",
                        [],
                    )?;
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
                        "INSERT INTO review_analyses(id, name, created_at, updated_at, mistake_ids, consolidated_input, user_question, status, tags, analysis_type)
                         SELECT id, name, created_at, updated_at, mistake_ids, consolidated_input, user_question, status, tags, analysis_type
                         FROM review_analyses_old_v39",
                        [],
                    )?;
                    conn.execute("DROP TABLE review_analyses_old_v39", [])?;
                    println!("review_analyses 表已删除 subject 字段");
                }

                println!("数据库迁移 v38 -> v39 完成（subject 字段已彻底删除）");
            }
            40 => {
                // Version 40: embedding_dimension_registry
                println!("📦 数据库迁移 v39 -> v40: 创建 embedding_dimension_registry");

                conn.execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS embedding_dimension_registry (
                        dimension INTEGER PRIMARY KEY,
                        model_config_id TEXT NOT NULL,
                        model_name TEXT NOT NULL,
                        table_prefix TEXT NOT NULL CHECK(table_prefix IN ('kb_chunks', 'mm_pages')),
                        is_multimodal INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );
                    CREATE INDEX IF NOT EXISTS idx_emb_dim_reg_model ON embedding_dimension_registry(model_config_id);
                    CREATE INDEX IF NOT EXISTS idx_emb_dim_reg_prefix ON embedding_dimension_registry(table_prefix);
                    "#,
                )?;
                println!("embedding_dimension_registry 表已创建");

                println!("数据库迁移 v39 -> v40 完成");
            }
            41 => {
                // Version 41: 原为 mm_page_embeddings.indexing_mode，已废弃
                println!("📦 数据库迁移 v40 -> v41: 跳过（mm_page_embeddings 已废弃）");
            }
            _ => {
                // 未知版本，跳过
            }
        }

        Ok(())
    }

    /// 将内置模板迁移到数据库 - 已禁用，改为统一导入路径
    #[allow(dead_code)]
    fn migrate_builtin_templates_to_db(&self, _conn: &SqlitePooledConnection) -> Result<()> {
        println!("跳过旧的内置模板迁移（使用 JSON 导入机制）");
        return Ok(());
    }
}
