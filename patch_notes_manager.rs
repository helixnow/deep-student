impl NotesManager {
    pub fn list_versions_vfs(&self, note_id: &str) -> Result<Vec<(String, String)>> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
        let versions = crate::vfs::VfsNoteRepo::get_versions(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("Failed to list versions: {}", e)))?;
        Ok(versions
            .into_iter()
            .map(|v| (v.version_id, v.created_at))
            .collect())
    }

    pub fn revert_version_vfs(
        &self,
        note_id: &str,
        version_id: &str,
        remark: Option<&str>,
    ) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
        
        let conn = vfs_db.get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
            
        // Get version data
        let mut stmt = conn.prepare("SELECT resource_id, title, tags, created_at FROM notes_versions WHERE version_id=?1 AND note_id=?2")
            .map_err(|e| AppError::database(format!("准备查询失败: {}", e)))?;
        let (resource_id, title, tags_json, _created_at): (String, String, String, String) = stmt.query_row(
            rusqlite::params![version_id, note_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        ).map_err(|e| AppError::database(format!("Failed to find version: {}", e)))?;

        // Get content from resource
        let content_md = crate::vfs::VfsResourceRepo::get_resource(vfs_db, &resource_id)
            .map_err(|e| AppError::database(format!("Failed to load resource: {}", e)))?
            .and_then(|r| r.data)
            .unwrap_or_default();
            
        let tags_vec: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

        if let Some(remark) = remark {
            // Revert as new version: append remark to title and create a new update
            let new_title = format!("{} ({})", title, remark);
            self.update_note_vfs(note_id, Some(&new_title), Some(&content_md), Some(&tags_vec), None)
        } else {
            // Normal revert: just update the note with version's content
            self.update_note_vfs(note_id, Some(&title), Some(&content_md), Some(&tags_vec), None)
        }
    }
}
