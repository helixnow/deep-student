//! 教材库类型与 VFS 代理。
//!
//! ★ 2026-06-13（第二轮收尾 D2）：移除遗留独立 `textbooks.db` 实现
//! （TextbooksDb 的 SQLite open/insert/list/trash 等方法、ListQuery、
//! VfsCreateTextbookParams、list_vfs/delete_vfs/create_vfs/get_vfs_by_sha256、
//! Textbook::to_vfs_textbook）——这些随 `cmd/textbooks.rs` 9 个未注册命令一起死亡。
//! 真实教材功能统一走 VFS（VfsTextbookRepo）。此处仅保留仍被注册命令引用的：
//! - `Textbook` DTO + `VfsTextbook::to_textbook`（textbooks_add / textbooks_relink 返回值）
//! - `VfsUpdateTextbookParams` + `TextbooksDb::{get_vfs, update_vfs}`（textbooks_update_bookmarks）

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// 通过 VFS 获取单个教材
    pub fn get_vfs(vfs_db: &VfsDatabase, id: &str) -> Result<Option<VfsTextbook>> {
        VfsTextbookRepo::get_textbook(vfs_db, id)
            .map_err(|e| AppError::database(format!("VFS 获取教材失败: {}", e)))
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
}

// ============================================================================
// 类型转换函数
// ============================================================================

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
