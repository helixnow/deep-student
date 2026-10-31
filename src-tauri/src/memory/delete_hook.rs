//! memory 对 vfs 笔记删除的接入（原 vfs/handlers.rs 的记忆卫生逻辑）。
//!
//! 逻辑逐字移动：删除前判断笔记是否在记忆根目录内；删除成功后清理索引单元并写审计日志。
//! vfs 不再直接依赖 memory。

use std::sync::Arc;

use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsFolderRepo, VfsNoteRepo};

/// 判断笔记是否位于记忆根目录内；是则返回 (resource_id, title)。
///
/// 任何一步出错都按“非记忆笔记”处理（返回 None），确保记忆逻辑
/// 不影响通用笔记删除路径。
fn memory_note_delete_context(
    vfs_db: &Arc<VfsDatabase>,
    note_id: &str,
) -> Option<(String, String)> {
    let root_id = crate::memory::MemoryConfig::new(vfs_db.clone())
        .get_root_folder_id()
        .ok()
        .flatten()?;
    let note = VfsNoteRepo::get_note(vfs_db, note_id).ok().flatten()?;
    let location = VfsNoteRepo::get_note_location(vfs_db, note_id)
        .ok()
        .flatten()?;
    let folder_id = location.folder_id?;
    if folder_id != root_id {
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(vfs_db, &root_id).ok()?;
        if !folder_ids.contains(&folder_id) {
            return None;
        }
    }
    Some((note.resource_id, note.title))
}

/// 记忆笔记经 UI 删除后的索引/审计卫生（best-effort，只记 warn 不上抛）：
/// - 把该笔记的向量段入 __lance_orphan_queue 并清理索引单元（与
///   MemoryService::delete_with_source 的清理口径一致；后台 drain 兜底删除
///   Lance 向量，恢复笔记时 restore_note 会 mark_pending 重建索引）
/// - 写一条 memory_audit_log，标注来源为用户 UI 删除
fn cleanup_deleted_memory_note(
    vfs_db: &Arc<VfsDatabase>,
    note_id: &str,
    resource_id: &str,
    title: &str,
) {
    match vfs_db.get_conn_safe() {
        Ok(conn) => {
            if let Err(e) = crate::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource(
                &conn,
                resource_id,
            ) {
                log::warn!(
                    "[VFS::handlers] Failed to purge index artifacts for deleted memory note {}: {}",
                    note_id,
                    e
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[VFS::handlers] Failed to get connection for memory note cleanup {}: {}",
                note_id,
                e
            );
        }
    }

    crate::memory::MemoryAuditLogger::new(vfs_db.clone()).log(
        &crate::memory::audit_log::MemoryAuditEntry {
            source: crate::memory::MemoryOpSource::Handler,
            operation: crate::memory::MemoryOpType::Delete,
            success: true,
            note_id: Some(note_id.to_string()),
            title: Some(title.to_string()),
            content_preview: None,
            folder: None,
            event: Some("DELETE".to_string()),
            confidence: None,
            reason: Some("user_ui: 用户经 VFS/DSTU UI 删除记忆笔记 (vfs_delete_note)".to_string()),
            session_id: None,
            duration_ms: None,
            extra_json: None,
        },
    );
}

pub struct MemoryNoteDeleteHook;

impl crate::vfs::hooks::NoteDeleteHook for MemoryNoteDeleteHook {
    fn capture_delete(
        &self,
        db: &Arc<VfsDatabase>,
        note_id: &str,
    ) -> Option<Box<dyn FnOnce() + Send>> {
        let (resource_id, title) = memory_note_delete_context(db, note_id)?;
        let db = Arc::clone(db);
        let note_id = note_id.to_string();
        Some(Box::new(move || {
            cleanup_deleted_memory_note(&db, &note_id, &resource_id, &title)
        }))
    }
}

/// 由 `extensions::register_extensions()` 在启动时调用；幂等。
pub fn install_vfs_hooks() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        crate::vfs::hooks::register_note_delete_hook(Arc::new(MemoryNoteDeleteHook));
    });
}
