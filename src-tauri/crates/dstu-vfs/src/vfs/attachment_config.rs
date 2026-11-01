//! 附件配置模块
//!
//! 管理附件根文件夹配置，参考 Memory 模块的实现方式。
//!
//! ## 核心功能
//! - 获取/设置附件根文件夹 ID
//! - 自动创建默认"附件"文件夹
//!
//! ## 配置存储
//! 复用 `memory_config` 表，key 为 `attachment_root_folder_id`

use rusqlite::params;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::types::VfsFolder;

/// 配置键：附件根文件夹 ID
const CONFIG_KEY_ROOT_FOLDER_ID: &str = "attachment_root_folder_id";

/// 默认附件文件夹标题
const DEFAULT_FOLDER_TITLE: &str = "附件";

/// 附件配置管理器
pub struct AttachmentConfig {
    db: Arc<VfsDatabase>,
}

impl AttachmentConfig {
    /// 创建新的配置管理器实例
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    /// 获取配置值
    fn get(&self, key: &str) -> VfsResult<Option<String>> {
        let conn = self.db.get_conn_safe()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM memory_config WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();
        Ok(value.filter(|v| !v.is_empty()))
    }

    /// 设置配置值
    fn set(&self, key: &str, value: &str) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
            params![key, value],
        )?;
        debug!("[Attachment::Config] Set {} = {}", key, value);
        Ok(())
    }

    /// 获取附件根文件夹 ID
    pub fn get_root_folder_id(&self) -> VfsResult<Option<String>> {
        self.get(CONFIG_KEY_ROOT_FOLDER_ID)
    }

    /// 设置附件根文件夹 ID
    pub fn set_root_folder_id(&self, folder_id: &str) -> VfsResult<()> {
        self.set(CONFIG_KEY_ROOT_FOLDER_ID, folder_id)
    }

    /// 获取或创建默认附件文件夹
    ///
    /// 1. 尝试获取已配置的文件夹
    /// 2. 验证文件夹是否存在
    /// 3. 如果不存在，创建新的默认文件夹
    pub fn get_or_create_root_folder(&self) -> VfsResult<String> {
        // 1. 尝试获取已配置的文件夹
        if let Some(folder_id) = self.get_root_folder_id()? {
            // 验证文件夹是否存在
            if VfsFolderRepo::folder_exists(&self.db, &folder_id)? {
                debug!(
                    "[Attachment::Config] Using existing root folder: {}",
                    folder_id
                );
                return Ok(folder_id);
            }
            // 文件夹已删除，清除配置
            warn!(
                "[Attachment::Config] Configured folder {} not found, creating new one",
                folder_id
            );
        }

        // 2. 创建默认文件夹
        let folder = VfsFolder::new(DEFAULT_FOLDER_TITLE.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Attachment::Config] Created default attachment folder: {} ({})",
            DEFAULT_FOLDER_TITLE, folder.id
        );
        Ok(folder.id)
    }

    /// 创建附件根文件夹（指定标题）
    pub fn create_root_folder(&self, title: &str) -> VfsResult<String> {
        let folder = VfsFolder::new(title.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Attachment::Config] Created attachment root folder: {} ({})",
            title, folder.id
        );
        Ok(folder.id)
    }

    /// 获取附件根文件夹标题
    pub fn get_root_folder_title(&self) -> VfsResult<Option<String>> {
        if let Some(folder_id) = self.get_root_folder_id()? {
            if let Some(folder) = VfsFolderRepo::get_folder(&self.db, &folder_id)? {
                return Ok(Some(folder.title));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_key_constants() {
        assert_eq!(CONFIG_KEY_ROOT_FOLDER_ID, "attachment_root_folder_id");
        assert_eq!(DEFAULT_FOLDER_TITLE, "附件");
    }
}
