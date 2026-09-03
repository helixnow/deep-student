//! [R10-chaos] 上传/下载幂等混沌：网络重试风暴与"崩溃后重放"场景下，
//! 变更链路的端到端幂等性。从外部 crate 视角钉死：
//!
//! 1. **上传重试风暴幂等**：同一批变更被重试上传 3 次（模拟超时后盲重试），
//!    云端出现 3 个不可变分片，但下载端必须在应用前把等价重试包坍缩为一份，
//!    应用后业务行只有一份、无回声变更；
//! 2. **应用两次幂等**：同一批下载变更被应用两次（模拟应用后、游标提交前
//!    崩溃 → 重启后重放），第二次应用不得产生失败、重复行或回声；
//! 3. **游标提交语义**：不提交下载进度时重复下载返回同样的变更（崩溃安全），
//!    提交后再下载为空（不重复消费）。
//!
//! 全部使用内存 CloudStorage，不依赖 Tauri runtime。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{device_id_short_hash, CloudStorage, FileInfo};
use deep_student_lib::data_governance::sync::{ChangeOperation, SyncChangeWithData, SyncManager};
use deep_student_lib::models::AppError;
use rusqlite::{params, Connection};
use serde_json::json;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// 内存 CloudStorage
// ============================================================================

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

#[async_trait]
impl CloudStorage for MemStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r10-idempotent"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(key).cloned())
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| FileInfo {
                key: key.clone(),
                size: value.len() as u64,
                last_modified: Utc::now(),
                etag: None,
            })
            .collect())
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.files.lock().unwrap().get(key).map(|value| FileInfo {
            key: key.to_string(),
            size: value.len() as u64,
            last_modified: Utc::now(),
            etag: None,
        }))
    }
}

// ============================================================================
// Fixture
// ============================================================================

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            content TEXT,
            updated_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        "#,
    )
    .unwrap();
    conn
}

fn unique_device(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

fn change(
    op: ChangeOperation,
    record_id: &str,
    content: &str,
    updated_at: &str,
) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: op,
        data: Some(json!({
            "id": record_id,
            "content": content,
            "updated_at": updated_at,
        })),
        changed_at: updated_at.to_string(),
        change_log_id: None,
        database_name: Some("vfs".to_string()),
        suppress_change_log: Some(true),
        source_device_id: None,
        source_seq: None,
    }
}

fn all_rows(conn: &Connection) -> Vec<(String, String, String)> {
    let mut stmt = conn
        .prepare("SELECT id, content, updated_at FROM items ORDER BY id")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn pending_count(conn: &Connection) -> usize {
    SyncManager::get_pending_changes(conn, None, None)
        .unwrap()
        .total_count
}

fn sample_changes(tag: &str) -> Vec<SyncChangeWithData> {
    vec![
        change(
            ChangeOperation::Insert,
            &format!("{tag}-a"),
            "alpha-v1",
            "2026-07-10T12:00:00Z",
        ),
        change(
            ChangeOperation::Insert,
            &format!("{tag}-b"),
            "beta-v1",
            "2026-07-10T12:00:00Z",
        ),
        change(
            ChangeOperation::Update,
            &format!("{tag}-a"),
            "alpha-v2",
            "2026-07-10T12:30:00Z",
        ),
    ]
}

// ============================================================================
// 1. 上传重试风暴：3 次盲重试 → 下载坍缩 → 应用一次成形
// ============================================================================

#[tokio::test]
async fn r10_chaos_upload_retry_storm_collapses_before_apply() {
    let storage = MemStorage::default();
    let uploader_id = unique_device("r10-idem-storm-src");
    let uploader = SyncManager::new(uploader_id.clone());
    let downloader = SyncManager::new(unique_device("r10-idem-storm-dst"));

    let changes = sample_changes("storm");
    for round in 0..3 {
        uploader
            .upload_enriched_changes(&storage, &changes, None)
            .await
            .unwrap_or_else(|e| panic!("第 {round} 次重试上传应成功: {e}"));
    }

    // 云端确实存在 3 个不可变分片（重试不覆盖、可审计）
    let shard_keys: Vec<String> = storage
        .list(&format!(
            "data_governance/changes/{}/",
            device_id_short_hash(&uploader_id)
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.key)
        .collect();
    assert_eq!(
        shard_keys.len(),
        3,
        "3 次重试应生成 3 个不可变分片: {shard_keys:?}"
    );

    let downloaded = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("下载重试风暴分片应成功");
    assert!(downloaded.decode_failures.is_empty());
    assert_eq!(
        downloaded.changes.len(),
        changes.len(),
        "下载端必须在应用前把等价重试包坍缩为一份"
    );

    let conn = new_db();
    let applied = SyncManager::apply_downloaded_changes(&conn, &downloaded.changes, None)
        .expect("应用坍缩后的变更应成功");
    assert_eq!(applied.failure_count, 0, "应用失败: {:?}", applied.failures);

    assert_eq!(
        all_rows(&conn),
        vec![
            (
                "storm-a".to_string(),
                "alpha-v2".to_string(),
                "2026-07-10T12:30:00Z".to_string()
            ),
            (
                "storm-b".to_string(),
                "beta-v1".to_string(),
                "2026-07-10T12:00:00Z".to_string()
            ),
        ],
        "重试风暴后业务行必须恰好一份且为最新值"
    );
    assert_eq!(pending_count(&conn), 0, "回放不得产生回声变更");
}

// ============================================================================
// 2. 应用两次幂等：游标提交前崩溃 → 重启重放同一批变更
// ============================================================================

#[tokio::test]
async fn r10_chaos_reapply_same_batch_after_crash_is_idempotent() {
    let storage = MemStorage::default();
    let uploader = SyncManager::new(unique_device("r10-idem-crash-src"));
    let downloader = SyncManager::new(unique_device("r10-idem-crash-dst"));

    let changes = sample_changes("crash");
    uploader
        .upload_enriched_changes(&storage, &changes, None)
        .await
        .expect("上传应成功");

    let conn = new_db();

    // 第一轮：下载 + 应用，但"崩溃"发生在 commit_download_progress 之前
    let first = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("首轮下载应成功");
    let applied = SyncManager::apply_downloaded_changes(&conn, &first.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);
    let rows_after_first = all_rows(&conn);

    // 第二轮（重启后）：游标未提交 → 必须重新拿到同样的变更（崩溃安全，不丢数据）
    let second = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("崩溃后重新下载应成功");
    assert_eq!(
        second.changes.len(),
        first.changes.len(),
        "游标未提交时重新下载必须返回同一批变更（不丢失）"
    );

    // 重放同一批变更必须幂等
    let reapplied = SyncManager::apply_downloaded_changes(&conn, &second.changes, None).unwrap();
    assert_eq!(
        reapplied.failure_count, 0,
        "重放失败: {:?}",
        reapplied.failures
    );
    assert_eq!(
        all_rows(&conn),
        rows_after_first,
        "重放同一批变更后业务行必须逐字节不变"
    );
    let ids: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ids, 2, "重放不得产生重复行");
    assert_eq!(pending_count(&conn), 0, "重放不得产生回声变更");
}

// ============================================================================
// 3. 游标提交语义：提交后再下载为空（不重复消费）
// ============================================================================

#[tokio::test]
async fn r10_chaos_committed_cursor_prevents_reconsumption() {
    let storage = MemStorage::default();
    let uploader = SyncManager::new(unique_device("r10-idem-cursor-src"));
    let downloader = SyncManager::new(unique_device("r10-idem-cursor-dst"));

    let changes = sample_changes("cursor");
    uploader
        .upload_enriched_changes(&storage, &changes, None)
        .await
        .expect("上传应成功");

    let conn = new_db();
    let first = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("首轮下载应成功");
    assert_eq!(first.changes.len(), changes.len());
    let applied = SyncManager::apply_downloaded_changes(&conn, &first.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);

    // 正常路径：应用成功后提交消费游标
    downloader
        .commit_download_progress(&storage, &first)
        .await
        .expect("提交下载进度应成功");

    // 提交后再下载：必须为空（同一分片不得被重复消费）
    let after_commit = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("提交后下载应成功");
    assert!(
        after_commit.changes.is_empty(),
        "游标已提交后不得重复消费同一分片: {:?}",
        after_commit
            .changes
            .iter()
            .map(|c| (&c.table_name, &c.record_id))
            .collect::<Vec<_>>()
    );

    // 上传方追加新分片后，仅新分片被消费（游标只前进不回退）
    let more = vec![change(
        ChangeOperation::Update,
        "cursor-b",
        "beta-v2",
        "2026-07-10T13:00:00Z",
    )];
    uploader
        .upload_enriched_changes(&storage, &more, None)
        .await
        .expect("追加上传应成功");
    let incremental = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("增量下载应成功");
    assert_eq!(incremental.changes.len(), 1, "提交游标后只应消费新增分片");
    assert_eq!(incremental.changes[0].record_id, "cursor-b");
    let applied = SyncManager::apply_downloaded_changes(&conn, &incremental.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);
    assert_eq!(
        all_rows(&conn),
        vec![
            (
                "cursor-a".to_string(),
                "alpha-v2".to_string(),
                "2026-07-10T12:30:00Z".to_string()
            ),
            (
                "cursor-b".to_string(),
                "beta-v2".to_string(),
                "2026-07-10T13:00:00Z".to_string()
            ),
        ]
    );
}
