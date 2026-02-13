use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::textbook_repo::VfsTextbookRepo;
use crate::vfs::types::VfsTextbook;

type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Textbook {
    pub id: String,
    pub sha256: String,
    pub file_name: String,
    pub file_path: String,
    pub size: u64,
    pub page_count: Option<i64>,
    pub tags_json: String,
    pub favorite: i64,
    pub last_opened_at: Option<String>,
    pub last_page: Option<i64>,
    pub bookmarks_json: String,
    pub cover_key: Option<String>,
    pub origin_json: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListQuery {
    pub q: Option<String>,
    pub favorite: Option<bool>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub sort_by: Option<String>, // name | time
    pub order: Option<String>,   // asc | desc
}

/// VFS 创建教材参数
#[derive(Debug, Clone, Deserialize)]
pub struct VfsCreateTextbookParams {
    /// 文件哈希（SHA256）
    pub sha256: String,
    /// 文件名
    pub file_name: String,
    /// 文件大小（字节）
    pub size: i64,
    /// Blob 哈希（可选，PDF 内容）
    pub blob_hash: Option<String>,
    /// 原始导入路径（可选）
    pub original_path: Option<String>,
}

/// VFS 更新教材参数
#[derive(Debug, Clone, Deserialize, Default)]
pub struct VfsUpdateTextbookParams {
    /// 更新阅读进度（页码）
    pub last_page: Option<i32>,
    /// 更新收藏状态
    pub favorite: Option<bool>,
    /// 更新页数
    pub page_count: Option<i32>,
    /// 更新书签
    pub bookmarks: Option<Vec<Value>>,
}

pub struct TextbooksDb;

impl TextbooksDb {
    pub fn db_path(base_app_data_dir: &Path) -> PathBuf {
        base_app_data_dir.join("databases").join("textbooks.db")
    }

    pub fn open_or_init(base_app_data_dir: &Path) -> Result<Connection> {
        let db_dir = base_app_data_dir.join("databases");
        if let Err(e) = fs::create_dir_all(&db_dir) {
            return Err(AppError::file_system(format!(
                "创建数据库目录失败: {} ({})",
                db_dir.display(),
                e
            )));
        }
        let path = Self::db_path(base_app_data_dir);
        let mut conn = Connection::open(&path).map_err(|e| {
            AppError::database(format!("打开教材数据库失败: {} ({})", path.display(), e))
        })?;
        // PRAGMA
        conn.pragma_update(None, "journal_mode", &"WAL").ok();
        conn.pragma_update(None, "synchronous", &"NORMAL").ok();
        Self::init_schema(&mut conn)?;
        Ok(conn)
    }

    fn init_schema(conn: &mut Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (
              version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS textbooks (
              id TEXT PRIMARY KEY,
              sha256 TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_path TEXT NOT NULL,
              size INTEGER NOT NULL,
              page_count INTEGER,
              tags_json TEXT NOT NULL DEFAULT '[]',
              favorite INTEGER NOT NULL DEFAULT 0,
              last_opened_at TEXT,
              last_page INTEGER,
              bookmarks_json TEXT NOT NULL DEFAULT '[]',
              cover_key TEXT,
              origin_json TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_textbooks_status ON textbooks(status);
            CREATE INDEX IF NOT EXISTS idx_textbooks_favorite ON textbooks(favorite);
            "#,
        )
        .map_err(|e| AppError::database(format!("初始化教材库表失败: {}", e)))?;
        // 若无版本记录，初始化为 1
        let count: i64 = conn
            .query_row("SELECT COUNT(1) FROM schema_version", [], |row| row.get(0))
            .unwrap_or(0);
        if count == 0 {
            conn.execute("INSERT INTO schema_version(version) VALUES (1)", [])
                .map_err(|e| AppError::database(format!("设置教材库 schema 版本失败: {}", e)))?;
        }
        Ok(())
    }

    pub fn insert_or_get(
        conn: &Connection,
        sha256: &str,
        file_name: &str,
        file_path: &str,
        size: u64,
    ) -> Result<Textbook> {
        // 存在则返回
        if let Some(tb) = Self::get_by_sha(conn, sha256)? {
            return Ok(tb);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO files (id, sha256, file_name, file_path, size, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)",
            params![id, sha256, file_name, file_path, size as i64, now, now],
        )
        .map_err(|e| AppError::database(format!("插入教材失败: {}", e)))?;
        Self::get_by_id(conn, &id)?.ok_or_else(|| AppError::database("插入后未找到教材"))
    }

    pub fn get_by_sha(conn: &Connection, sha256: &str) -> Result<Option<Textbook>> {
        conn.query_row(
            "SELECT id, sha256, file_name, file_path, size, page_count, tags_json, favorite, last_opened_at, last_page, bookmarks_json, cover_key, origin_json, status, created_at, updated_at FROM files WHERE sha256=?1 LIMIT 1",
            params![sha256],
            Self::map_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("查询教材失败: {}", e)))
    }

    pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<Textbook>> {
        conn.query_row(
            "SELECT id, sha256, file_name, file_path, size, page_count, tags_json, favorite, last_opened_at, last_page, bookmarks_json, cover_key, origin_json, status, created_at, updated_at FROM files WHERE id=?1 LIMIT 1",
            params![id],
            Self::map_row,
        )
        .optional()
        .map_err(|e| AppError::database(format!("按ID查询教材失败: {}", e)))
    }

    pub fn list(conn: &Connection, q: &ListQuery) -> Result<Vec<Textbook>> {
        let mut sql = String::from("SELECT id, sha256, file_name, file_path, size, page_count, tags_json, favorite, last_opened_at, last_page, bookmarks_json, cover_key, origin_json, status, created_at, updated_at FROM files WHERE 1=1");
        let mut args: Vec<(usize, rusqlite::types::Value)> = Vec::new();

        if let Some(status) = &q.status {
            sql.push_str(" AND status = ?");
            args.push((args.len() + 1, rusqlite::types::Value::from(status.clone())));
        } else {
            sql.push_str(" AND status = 'active'");
        }
        if let Some(fav) = q.favorite {
            sql.push_str(" AND favorite = ?");
            args.push((
                args.len() + 1,
                rusqlite::types::Value::from(if fav { 1 } else { 0 }),
            ));
        }
        if let Some(qs) = &q.q {
            let like = format!("%{}%", qs);
            sql.push_str(" AND (file_name LIKE ? OR tags_json LIKE ?)");
            args.push((args.len() + 1, rusqlite::types::Value::from(like.clone())));
            args.push((args.len() + 1, rusqlite::types::Value::from(like)));
        }

        let order_by = match q.sort_by.as_deref() {
            Some("name") => "file_name",
            _ => "created_at",
        };
        let order = match q.order.as_deref() {
            Some("asc") => "ASC",
            _ => "DESC",
        };
        sql.push_str(&format!(" ORDER BY {} {}", order_by, order));

        if let Some(limit) = q.limit {
            sql.push_str(" LIMIT ?");
            args.push((args.len() + 1, rusqlite::types::Value::from(limit)));
        }
        if let Some(offset) = q.offset {
            sql.push_str(" OFFSET ?");
            args.push((args.len() + 1, rusqlite::types::Value::from(offset)));
        }

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(format!("准备查询失败: {}", e)))?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|(_, v)| v)),
                Self::map_row,
            )
            .map_err(|e| AppError::database(format!("执行查询失败: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(format!("读取行失败: {}", e)))?);
        }
        Ok(out)
    }

    pub fn mark_trashed(conn: &Connection, id: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE textbooks SET status='trashed', updated_at=?2 WHERE id=?1",
            params![id, now],
        )
        .map_err(|e| AppError::database(format!("移动到回收站失败: {}", e)))?;
        Ok(())
    }

    pub fn recover(conn: &Connection, id: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE textbooks SET status='active', updated_at=?2 WHERE id=?1",
            params![id, now],
        )
        .map_err(|e| AppError::database(format!("恢复教材失败: {}", e)))?;
        Ok(())
    }

    pub fn list_trashed(conn: &Connection) -> Result<Vec<Textbook>> {
        let mut stmt = conn
            .prepare("SELECT id, sha256, file_name, file_path, size, page_count, tags_json, favorite, last_opened_at, last_page, bookmarks_json, cover_key, origin_json, status, created_at, updated_at FROM files WHERE status='trashed'")
            .map_err(|e| AppError::database(format!("准备查询回收站失败: {}", e)))?;
        let rows = stmt
            .query_map([], Self::map_row)
            .map_err(|e| AppError::database(format!("执行查询回收站失败: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(format!("读取行失败: {}", e)))?);
        }
        Ok(out)
    }

    pub fn purge_trashed(conn: &Connection) -> Result<usize> {
        conn.execute("DELETE FROM files WHERE status='trashed'", [])
            .map_err(|e| AppError::database(format!("清空回收站失败: {}", e)))
    }

    pub fn delete_permanent(conn: &Connection, id: &str) -> Result<bool> {
        let affected = conn
            .execute("DELETE FROM files WHERE id=?1", params![id])
            .map_err(|e| AppError::database(format!("永久删除教材失败: {}", e)))?;
        Ok(affected > 0)
    }

    /// 更新阅读进度（打开时间和页码）
    pub fn update_reading_progress(
        conn: &Connection,
        id: &str,
        last_page: Option<i64>,
    ) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let affected = if let Some(page) = last_page {
            conn.execute(
                "UPDATE textbooks SET last_opened_at=?2, last_page=?3, updated_at=?4 WHERE id=?1",
                params![id, now, page, now],
            )
        } else {
            conn.execute(
                "UPDATE textbooks SET last_opened_at=?2, updated_at=?3 WHERE id=?1",
                params![id, now, now],
            )
        }
        .map_err(|e| AppError::database(format!("更新阅读进度失败: {}", e)))?;
        Ok(affected > 0)
    }

    /// 设置收藏状态
    pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let fav_val: i64 = if favorite { 1 } else { 0 };
        let affected = conn
            .execute(
                "UPDATE textbooks SET favorite=?2, updated_at=?3 WHERE id=?1",
                params![id, fav_val, now],
            )
            .map_err(|e| AppError::database(format!("设置收藏状态失败: {}", e)))?;
        Ok(affected > 0)
    }

    /// 更新页数（导入后异步计算）
    pub fn update_page_count(conn: &Connection, id: &str, page_count: i64) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let affected = conn
            .execute(
                "UPDATE textbooks SET page_count=?2, updated_at=?3 WHERE id=?1",
                params![id, page_count, now],
            )
            .map_err(|e| AppError::database(format!("更新页数失败: {}", e)))?;
        Ok(affected > 0)
    }

    fn map_row(row: &rusqlite::Row<'_>) -> std::result::Result<Textbook, rusqlite::Error> {
        Ok(Textbook {
            id: row.get(0)?,
            sha256: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            size: row.get::<_, i64>(4)? as u64,
            page_count: row.get(5).ok(),
            tags_json: row.get(6)?,
            favorite: row.get(7)?,
            last_opened_at: row.get(8).ok(),
            last_page: row.get(9).ok(),
            bookmarks_json: row.get(10)?,
            cover_key: row.get(11).ok(),
            origin_json: row.get(12).ok(),
            status: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
        })
    }

    // ========================================================================
    // VFS 代理方法
    // ========================================================================

    /// 通过 VFS 列出教材
    ///
    /// ## 参数
    /// - `vfs_db`: VFS 数据库连接
    /// - `subject`: 科目过滤（可选）
    /// - `include_global`: 是否包含全局教材
    /// - `limit`: 返回数量限制
    /// - `offset`: 偏移量
    pub fn list_vfs(
        vfs_db: &VfsDatabase,
        _subject: Option<&str>,
        _include_global: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<VfsTextbook>> {
        VfsTextbookRepo::list_textbooks(vfs_db, limit, offset)
            .map_err(|e| AppError::database(format!("VFS 列出教材失败: {}", e)))
    }

    /// 通过 VFS 获取单个教材
    pub fn get_vfs(vfs_db: &VfsDatabase, id: &str) -> Result<Option<VfsTextbook>> {
        VfsTextbookRepo::get_textbook(vfs_db, id)
            .map_err(|e| AppError::database(format!("VFS 获取教材失败: {}", e)))
    }

    /// 通过 VFS 根据 SHA256 获取教材
    pub fn get_vfs_by_sha256(vfs_db: &VfsDatabase, sha256: &str) -> Result<Option<VfsTextbook>> {
        VfsTextbookRepo::get_by_sha256(vfs_db, sha256)
            .map_err(|e| AppError::database(format!("VFS 根据 SHA256 获取教材失败: {}", e)))
    }

    /// 通过 VFS 创建教材
    pub fn create_vfs(
        vfs_db: &VfsDatabase,
        params: VfsCreateTextbookParams,
    ) -> Result<VfsTextbook> {
        VfsTextbookRepo::create_textbook(
            vfs_db,
            &params.sha256,
            &params.file_name,
            params.size,
            params.blob_hash.as_deref(),
            params.original_path.as_deref(),
        )
        .map_err(|e| AppError::database(format!("VFS 创建教材失败: {}", e)))
    }

    /// 通过 VFS 更新教材
    ///
    /// 根据提供的参数选择性更新字段
    pub fn update_vfs(
        vfs_db: &VfsDatabase,
        id: &str,
        params: VfsUpdateTextbookParams,
    ) -> Result<Option<VfsTextbook>> {
        // 检查教材是否存在
        let existing = Self::get_vfs(vfs_db, id)?;
        if existing.is_none() {
            return Ok(None);
        }

        // 根据参数执行相应的更新
        if let Some(last_page) = params.last_page {
            VfsTextbookRepo::update_reading_progress(vfs_db, id, last_page)
                .map_err(|e| AppError::database(format!("VFS 更新阅读进度失败: {}", e)))?;
        }

        if let Some(favorite) = params.favorite {
            VfsTextbookRepo::set_favorite(vfs_db, id, favorite)
                .map_err(|e| AppError::database(format!("VFS 设置收藏状态失败: {}", e)))?;
        }

        if let Some(page_count) = params.page_count {
            VfsTextbookRepo::update_page_count(vfs_db, id, page_count)
                .map_err(|e| AppError::database(format!("VFS 更新页数失败: {}", e)))?;
        }

        if let Some(ref bookmarks) = params.bookmarks {
            VfsTextbookRepo::update_bookmarks(vfs_db, id, bookmarks)
                .map_err(|e| AppError::database(format!("VFS 更新书签失败: {}", e)))?;
        }

        // 返回更新后的教材
        Self::get_vfs(vfs_db, id)
    }

    /// 通过 VFS 删除教材（软删除）
    pub fn delete_vfs(vfs_db: &VfsDatabase, id: &str) -> Result<bool> {
        match VfsTextbookRepo::delete_textbook(vfs_db, id) {
            Ok(()) => Ok(true),
            Err(crate::vfs::error::VfsError::NotFound { .. }) => Ok(false),
            Err(e) => Err(AppError::database(format!("VFS 删除教材失败: {}", e))),
        }
    }
}

// ============================================================================
// 类型转换函数
// ============================================================================

impl Textbook {
    /// 将旧版 Textbook 转换为 VfsTextbook
    pub fn to_vfs_textbook(&self) -> VfsTextbook {
        // 解析 tags_json
        let tags: Vec<String> = serde_json::from_str(&self.tags_json).unwrap_or_default();
        // 解析 bookmarks_json
        let bookmarks: Vec<Value> = serde_json::from_str(&self.bookmarks_json).unwrap_or_default();
        VfsTextbook {
            id: self.id.clone(),
            resource_id: None,
            blob_hash: Some(self.sha256.clone()),
            sha256: self.sha256.clone(),
            file_name: self.file_name.clone(),
            original_path: Some(self.file_path.clone()),
            size: self.size as i64,
            page_count: self.page_count.map(|p| p as i32),
            tags,
            is_favorite: self.favorite != 0,
            last_opened_at: self.last_opened_at.clone(),
            last_page: self.last_page.map(|p| p as i32),
            bookmarks,
            cover_key: self.cover_key.clone(),
            status: self.status.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

impl VfsTextbook {
    /// 将 VfsTextbook 转换为旧版 Textbook
    pub fn to_textbook(&self) -> Textbook {
        // 序列化 tags
        let tags_json = serde_json::to_string(&self.tags).unwrap_or_else(|_| "[]".to_string());
        // 序列化 bookmarks
        let bookmarks_json =
            serde_json::to_string(&self.bookmarks).unwrap_or_else(|_| "[]".to_string());

        Textbook {
            id: self.id.clone(),
            sha256: self.sha256.clone(),
            file_name: self.file_name.clone(),
            file_path: self.original_path.clone().unwrap_or_default(),
            size: self.size as u64,
            page_count: self.page_count.map(|p| p as i64),
            tags_json,
            favorite: if self.is_favorite { 1 } else { 0 },
            last_opened_at: self.last_opened_at.clone(),
            last_page: self.last_page.map(|p| p as i64),
            bookmarks_json,
            cover_key: self.cover_key.clone(),
            origin_json: None,
            status: self.status.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}
