//! `qbank_grading::image_answer` 中依赖 app 的单测。
//!
//! 图片作答解析已搬到 dstu-qbank；该测试要用 app 的 `data_governance::sync` 模拟
//! 跨设备同步落库，因此留在 app。模块路径保持 `qbank_grading::image_answer::tests::…`
//! （见 app `qbank_grading.rs` 里的同名重导出模块）。

use super::*;
use crate::vfs::repos::VfsAttachmentRepo;

fn envelope_json(images: serde_json::Value, text: serde_json::Value) -> String {
    serde_json::json!({ "type": "image_answer", "images": images, "text": text }).to_string()
}

fn image_value(id: &str, mime: &str) -> serde_json::Value {
    serde_json::json!({ "id": id, "name": format!("{id}.jpg"), "mime": mime, "hash": format!("h-{id}") })
}

#[test]
fn reads_synced_image_answer_after_file_id_deduplication() {
    use crate::data_governance::sync::{ChangeOperation, SyncChangeWithData, SyncManager};
    use crate::vfs::types::VfsUploadAttachmentParams;

    let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
    let image_base64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    let conn = db.get_conn_safe().unwrap();
    let local = VfsAttachmentRepo::upload_with_conn(
        &conn,
        db.blobs_dir(),
        VfsUploadAttachmentParams {
            name: "answer.gif".into(),
            mime_type: "image/gif".into(),
            base64_content: image_base64.into(),
            attachment_type: Some("image".into()),
        },
    )
    .unwrap();
    let sha256: String = conn
        .query_row(
            "SELECT sha256 FROM files WHERE id = ?1",
            [&local.source_id],
            |row| row.get(0),
        )
        .unwrap();
    let remote_id = "file_remote_image_answer";
    // A byte-identical file may have a different name on the other device.
    // Keep this a real newer update: an identical row is correctly skipped
    // by sync's semantic-echo guard and cannot assert an applied change.
    let remote_name = "answer-from-other-device.gif";
    let remote_updated_at =
        (chrono::DateTime::parse_from_rfc3339(&local.attachment.updated_at).unwrap()
            + chrono::Duration::milliseconds(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let changes = [SyncChangeWithData {
        table_name: "files".into(),
        record_id: remote_id.into(),
        operation: ChangeOperation::Insert,
        data: Some(serde_json::json!({
            "id": remote_id,
            "sha256": sha256,
            "file_name": remote_name,
            "name": remote_name,
            "type": "image",
            "mime_type": "image/gif",
            "size": local.attachment.size,
            "content_hash": local.attachment.content_hash,
            "resource_id": local.attachment.resource_id,
            "blob_hash": local.attachment.blob_hash,
            "created_at": local.attachment.created_at,
            "updated_at": remote_updated_at,
        })),
        changed_at: remote_updated_at,
        change_log_id: Some(42),
        database_name: Some("vfs".into()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }];
    let result = SyncManager::apply_downloaded_changes(&conn, &changes, None).unwrap();
    assert_eq!(result.failure_count, 0, "{result:?}");
    assert_eq!(result.success_count, 1, "{result:?}");
    assert!(VfsAttachmentRepo::get_by_id_with_conn(&conn, remote_id)
        .unwrap()
        .is_none());
    assert_eq!(
        SyncManager::resolve_persisted_id_alias(&conn, "files", remote_id).unwrap(),
        local.source_id
    );
    let canonical_names: (String, String) = conn
        .query_row(
            "SELECT name, file_name FROM files WHERE id = ?1",
            [&local.source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(canonical_names, (remote_name.into(), remote_name.into()));
    drop(conn);

    // The persisted envelope keeps the remote ID: SQL FK remapping cannot
    // rewrite IDs inside user_answer JSON. Both consumers must still read it.
    let envelope = envelope_json(
        serde_json::json!([image_value(remote_id, "image/gif")]),
        serde_json::json!(""),
    );
    let payload = parse_image_answer_envelope(&envelope).unwrap();
    assert_eq!(payload.images[0].id, remote_id);
    // Thumbnail IPC uses get_content; grading uses the bounded variant.
    assert_eq!(
        VfsAttachmentRepo::get_content(&db, remote_id).unwrap(),
        Some(image_base64.to_string())
    );
    assert_eq!(
        fetch_image_answer_contents(&db, &payload).unwrap(),
        vec![image_base64.to_string()]
    );
    assert!(VfsAttachmentRepo::get_content_bounded(&db, remote_id, 1).is_err());
    assert!(VfsAttachmentRepo::get_content(&db, "file_still_missing")
        .unwrap()
        .is_none());
}
