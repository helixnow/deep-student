// 笔记历史的 app 侧单测：依赖 app 组合根（`crate::extensions::register_extensions`）与
// app 的 `data_governance::file_deletion_queue`，无法随 notes_exporter 进入 dstu-notes。
// 拆分前位于 `notes_exporter::note_history_app_tests`，模块名、函数名与测试体不变。

// 原 `vfs::repos::note_revision_repo::tests` 中依赖 app 侧模块（extensions 组合根 /
// notes_exporter）的两个笔记历史测试。dstu-vfs 抽取后上移到 app，函数名与测试体不变；
// `create` / `edit` / `latest` 是原测试模块同名辅助函数的副本。
#[cfg(test)]
mod note_history_app_tests {
    use crate::vfs::repos::note_revision_repo::{NoteRevision, NoteRevisionRepo};
    use crate::vfs::types::{VfsCreateNoteParams, VfsNote, VfsUpdateNoteParams};
    use crate::vfs::VfsNoteRepo;
    use rusqlite::Connection;

    fn create(conn: &Connection, content: &str) -> VfsNote {
        VfsNoteRepo::create_note_with_conn(
            conn,
            VfsCreateNoteParams {
                title: "历史测试".into(),
                content: content.into(),
                tags: vec!["tag".into()],
            },
        )
        .unwrap()
    }

    fn edit(conn: &Connection, note: &VfsNote, content: &str) -> VfsNote {
        VfsNoteRepo::update_note_with_conn(
            conn,
            &note.id,
            VfsUpdateNoteParams {
                content: Some(content.into()),
                expected_updated_at: Some(note.updated_at.clone()),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn latest(conn: &Connection, note: &VfsNote) -> NoteRevision {
        let page = NoteRevisionRepo::list(conn, &note.id, None, 1).unwrap();
        NoteRevisionRepo::get(conn, &note.id, &page.items[0].version_id).unwrap()
    }

    #[test]
    fn history_trash_and_shared_asset_references_guard_journal_deletion() {
        // 删除 journal 的笔记资产引用检查由 extensions 注册（拆分后为回调解耦）。
        crate::extensions::register_extensions();
        use crate::data_governance::file_deletion_queue::{
            finish_asset_deletion_with_conn, prepare_asset_deletion_with_conn,
        };
        let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let path = "notes_assets/_global/original/image.png";
        std::fs::create_dir_all(tmp.path().join("notes_assets/_global/original")).unwrap();
        std::fs::write(tmp.path().join(path), b"image bytes").unwrap();
        let key = format!("active/{}", path);
        let prepared =
            prepare_asset_deletion_with_conn(&conn, tmp.path(), &key, std::path::Path::new(path))
                .unwrap();
        let quarantine = tmp
            .path()
            .join(format!("{}.deleting-{}", path, prepared.operation_id));
        std::fs::rename(tmp.path().join(path), quarantine).unwrap();
        let note = create(&conn, &format!("![img]({})", path));
        // A prepared intent from before a restore/save is cancelled during recovery.
        finish_asset_deletion_with_conn(&conn, tmp.path(), &prepared).unwrap();
        assert!(tmp.path().join(path).exists());
        let note = edit(&conn, &note, "removed image");
        assert!(prepare_asset_deletion_with_conn(
            &conn,
            tmp.path(),
            &key,
            std::path::Path::new(path)
        )
        .is_err());
        VfsNoteRepo::delete_note_with_conn(&conn, &note.id).unwrap();
        assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
        let shared = create(&conn, &format!("![shared]({})", path));
        VfsNoteRepo::purge_note_with_conn(&conn, &note.id).unwrap();
        assert!(NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
        VfsNoteRepo::purge_note_with_conn(&conn, &shared.id).unwrap();
        assert!(!NoteRevisionRepo::asset_is_referenced(&conn, path).unwrap());
        let prepared =
            prepare_asset_deletion_with_conn(&conn, tmp.path(), &key, std::path::Path::new(path))
                .unwrap();
        finish_asset_deletion_with_conn(&conn, tmp.path(), &prepared).unwrap();
        assert!(!tmp.path().join(path).exists());
    }

    #[test]
    fn zip_overwrite_captures_body_and_writes_fresh_assets_without_overwriting_history_bytes() {
        use crate::notes_exporter::{ImportConflictStrategy, ImportOptions, NotesImporter};
        use std::io::Write;
        use std::sync::Arc;
        let (tmp, db) = crate::vfs::database::setup_migrated_test_db();
        let db = Arc::new(db);
        let conn = db.get_conn_safe().unwrap();
        let original_path = "notes_assets/_global/original/image.png";
        let note = create(&conn, &format!("![original]({})", original_path));
        let saved = latest(&conn, &note);
        std::fs::create_dir_all(tmp.path().join("notes_assets/_global/original")).unwrap();
        std::fs::write(tmp.path().join(original_path), b"original image").unwrap();
        let archive_path = tmp.path().join("import.zip");
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut archive = zip::ZipWriter::new(file);
            archive
                .start_file("markdown/imported.md", zip::write::FileOptions::default())
                .unwrap();
            write!(
                archive,
                "---\nid: {}\ntitle: Imported\n---\n\n![imported]({})",
                note.id, original_path
            )
            .unwrap();
            archive
                .start_file(
                    "assets/_global/original/image.png",
                    zip::write::FileOptions::default(),
                )
                .unwrap();
            archive.write_all(b"imported image").unwrap();
            archive.finish().unwrap();
        }
        let main_db =
            Arc::new(crate::database::Database::new(&tmp.path().join("mistakes.db")).unwrap());
        let files =
            Arc::new(crate::file_manager::FileManager::new(tmp.path().to_path_buf()).unwrap());
        let result = NotesImporter::new_with_vfs(main_db, files, Some(db.clone()))
            .import_with_options(
                archive_path,
                ImportOptions {
                    conflict_strategy: ImportConflictStrategy::Overwrite,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(result.overwritten_count, 1);
        assert_eq!(
            std::fs::read(tmp.path().join(original_path)).unwrap(),
            b"original image"
        );
        assert_eq!(
            NoteRevisionRepo::get(&conn, &note.id, &saved.summary.version_id)
                .unwrap()
                .content_md,
            saved.content_md
        );
        let imported = latest(&conn, &note);
        let asset = imported
            .asset_refs
            .iter()
            .find(|r| r.kind == "notes_asset")
            .unwrap();
        assert_ne!(asset.value, original_path);
        assert_eq!(
            std::fs::read(tmp.path().join(&asset.value)).unwrap(),
            b"imported image"
        );
    }
}
