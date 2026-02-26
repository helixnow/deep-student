use rusqlite::params;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::types::VfsFolder;

const CONFIG_KEY_ROOT_FOLDER_ID: &str = "memory_root_folder_id";
const CONFIG_KEY_AUTO_CREATE_SUBFOLDERS: &str = "auto_create_subfolders";
const CONFIG_KEY_DEFAULT_CATEGORY: &str = "default_category";
const CONFIG_KEY_PRIVACY_MODE: &str = "privacy_mode";

const DEFAULT_FOLDER_TITLE: &str = "记忆";

#[derive(Clone)]
pub struct MemoryConfig {
    db: Arc<VfsDatabase>,
}

impl MemoryConfig {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    pub fn get(&self, key: &str) -> VfsResult<Option<String>> {
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

    pub fn set(&self, key: &str, value: &str) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
            params![key, value],
        )?;
        debug!("[Memory::Config] Set {} = {}", key, value);
        Ok(())
    }

    pub fn get_root_folder_id(&self) -> VfsResult<Option<String>> {
        self.get(CONFIG_KEY_ROOT_FOLDER_ID)
    }

    pub fn set_root_folder_id(&self, folder_id: &str) -> VfsResult<()> {
        self.set(CONFIG_KEY_ROOT_FOLDER_ID, folder_id)
    }

    pub fn get_or_create_root_folder(&self) -> VfsResult<String> {
        if let Some(folder_id) = self.get_root_folder_id()? {
            if VfsFolderRepo::folder_exists(&self.db, &folder_id)? {
                debug!("[Memory::Config] Using existing root folder: {}", folder_id);
                return Ok(folder_id);
            }
            warn!(
                "[Memory::Config] Configured folder {} not found, creating new one",
                folder_id
            );
        }

        let folder = VfsFolder::new(DEFAULT_FOLDER_TITLE.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Memory::Config] Created default memory folder: {} ({})",
            DEFAULT_FOLDER_TITLE, folder.id
        );
        Ok(folder.id)
    }

    pub fn create_root_folder(&self, title: &str) -> VfsResult<String> {
        let folder = VfsFolder::new(title.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Memory::Config] Created memory root folder: {} ({})",
            title, folder.id
        );
        Ok(folder.id)
    }

    pub fn get_root_folder_title(&self) -> VfsResult<Option<String>> {
        if let Some(folder_id) = self.get_root_folder_id()? {
            if let Some(folder) = VfsFolderRepo::get_folder(&self.db, &folder_id)? {
                return Ok(Some(folder.title));
            }
        }
        Ok(None)
    }

    pub fn is_auto_create_subfolders(&self) -> VfsResult<bool> {
        Ok(self
            .get(CONFIG_KEY_AUTO_CREATE_SUBFOLDERS)?
            .map(|v| v == "true")
            .unwrap_or(true))
    }

    pub fn is_privacy_mode(&self) -> VfsResult<bool> {
        Ok(self
            .get(CONFIG_KEY_PRIVACY_MODE)?
            .map(|v| v == "true")
            .unwrap_or(false))
    }

    pub fn set_privacy_mode(&self, enabled: bool) -> VfsResult<()> {
        self.set(
            CONFIG_KEY_PRIVACY_MODE,
            if enabled { "true" } else { "false" },
        )
    }

    pub fn get_default_category(&self) -> VfsResult<String> {
        Ok(self
            .get(CONFIG_KEY_DEFAULT_CATEGORY)?
            .unwrap_or_else(|| "通用".to_string()))
    }

    pub fn set_auto_create_subfolders(&self, enabled: bool) -> VfsResult<()> {
        self.set(
            CONFIG_KEY_AUTO_CREATE_SUBFOLDERS,
            if enabled { "true" } else { "false" },
        )
    }

    pub fn set_default_category(&self, category: &str) -> VfsResult<()> {
        self.set(CONFIG_KEY_DEFAULT_CATEGORY, category)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_key_constants() {
        assert_eq!(CONFIG_KEY_ROOT_FOLDER_ID, "memory_root_folder_id");
        assert_eq!(CONFIG_KEY_AUTO_CREATE_SUBFOLDERS, "auto_create_subfolders");
        assert_eq!(CONFIG_KEY_DEFAULT_CATEGORY, "default_category");
        assert_eq!(CONFIG_KEY_PRIVACY_MODE, "privacy_mode");
        assert_eq!(DEFAULT_FOLDER_TITLE, "记忆");
    }
}
