//! [R10-chaos] 列表截断混沌：云端 provider 的 list 结果不完整（诚实截断标记
//! 或静默丢条目）时，变更下载必须停在安全点，绝不静默跳号消费或推进游标。
//!
//! 三个混沌面：
//!
//! 1. **诚实截断标记 fail-closed**：provider 通过 `list_outcome` 如实报告
//!    truncated=true → 下载立即拒绝（不消费任何分片、不推进游标）；
//! 2. **静默截断丢中段 seq**：provider 谎报完整但 list 里缺失 seq1（对象仍在）
//!    → seq 缺口证明机制（缺少序号 N 已发布到 M）让下载停在安全点报错，
//!    不得跳号消费 seq2 造成乱序应用；
//! 3. **静默截断丢尾部 seq 不丢数据**：list 缺失尾部 seq2 → 下载安全返回
//!    seq1（合法前缀），游标提交后 provider 恢复，seq2 仍会在下一轮被消费
//!    ——截断窗口不得造成永久跳过。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{device_id_short_hash, CloudStorage, FileInfo, ListOutcome};
use deep_student_lib::data_governance::sync::{ChangeOperation, SyncChangeWithData, SyncManager};
use deep_student_lib::models::AppError;
use rusqlite::Connection;
use serde_json::json;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// 截断混沌 CloudStorage：对象都在，但 list 可以（诚实或静默）不完整
// ============================================================================

#[derive(Clone, Default)]
struct TruncatingStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// 从 list 结果里静默隐藏的 key（get/stat 仍可访问 —— 模拟分页丢条目）
    hidden_from_list: Arc<Mutex<BTreeSet<String>>>,
    /// 诚实截断：list_outcome 如实报告 truncated=true
    honest_truncation: Arc<Mutex<bool>>,
}

impl TruncatingStorage {
    fn hide(&self, key: &str) {
        self.hidden_from_list
            .lock()
            .unwrap()
            .insert(key.to_string());
    }

    fn unhide(&self, key: &str) {
        self.hidden_from_list.lock().unwrap().remove(key);
    }

    fn set_honest_truncation(&self, value: bool) {
        *self.honest_truncation.lock().unwrap() = value;
    }

    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn visible_files(&self, prefix: &str) -> Vec<FileInfo> {
        let hidden = self.hidden_from_list.lock().unwrap();
        self.files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix) && !hidden.contains(*key))
            .map(|(key, value)| FileInfo {
                key: key.clone(),
                size: value.len() as u64,
                last_modified: Utc::now(),
                etag: None,
            })
            .collect()
    }
}

#[async_trait]
impl CloudStorage for TruncatingStorage {
    fn provider_name(&self) -> &'static str {
        "memory-r10-truncating"
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
        Ok(self.visible_files(prefix))
    }

    async fn list_outcome(&self, prefix: &str) -> CloudResult<ListOutcome> {
        let files = self.visible_files(prefix);
        if *self.honest_truncation.lock().unwrap() {
            Ok(ListOutcome {
                files,
                truncated: true,
            })
        } else {
            Ok(ListOutcome::complete(files))
        }
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

fn unique_device(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

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

fn insert_change(record_id: &str, content: &str, updated_at: &str) -> SyncChangeWithData {
    SyncChangeWithData {
        table_name: "items".to_string(),
        record_id: record_id.to_string(),
        operation: ChangeOperation::Insert,
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

/// 布置两个 seq 分片：seq1 = rec-one, seq2 = rec-two。返回按 seq 升序的 key。
async fn seed_two_shards(storage: &TruncatingStorage, uploader_id: &str) -> Vec<String> {
    let uploader = SyncManager::new(uploader_id.to_string());
    uploader
        .upload_enriched_changes(
            storage,
            &[insert_change("rec-one", "first", "2026-07-10T12:00:00Z")],
            None,
        )
        .await
        .expect("上传 seq1 应成功");
    uploader
        .upload_enriched_changes(
            storage,
            &[insert_change("rec-two", "second", "2026-07-10T12:10:00Z")],
            None,
        )
        .await
        .expect("上传 seq2 应成功");

    let mut keys = storage.keys_with_prefix(&format!(
        "data_governance/changes/{}/",
        device_id_short_hash(uploader_id)
    ));
    keys.sort();
    assert_eq!(keys.len(), 2, "应恰好有两个分片: {keys:?}");
    keys
}

// ============================================================================
// 1. 诚实截断标记：立即 fail-closed
// ============================================================================

#[tokio::test]
async fn r10_chaos_honest_list_truncation_flag_fails_closed() {
    let storage = TruncatingStorage::default();
    let uploader_id = unique_device("r10-trunc-honest-src");
    seed_two_shards(&storage, &uploader_id).await;

    storage.set_honest_truncation(true);
    let downloader = SyncManager::new(unique_device("r10-trunc-honest-dst"));
    let error = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect_err("provider 如实报告列表截断时必须拒绝下载");
    assert!(
        error.to_string().contains("截断"),
        "错误应说明列表被截断: {error}"
    );

    // provider 恢复完整列表后，同一下载端应能完整消费两个分片
    storage.set_honest_truncation(false);
    let downloaded = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("截断恢复后下载应成功");
    assert_eq!(downloaded.changes.len(), 2, "两个分片都应被消费");
}

// ============================================================================
// 2. 静默截断丢中段 seq：seq 缺口证明让下载停在安全点
// ============================================================================

#[tokio::test]
async fn r10_chaos_silent_truncation_hiding_earlier_seq_stops_at_safe_point() {
    let storage = TruncatingStorage::default();
    let uploader_id = unique_device("r10-trunc-gap-src");
    let keys = seed_two_shards(&storage, &uploader_id).await;

    // 静默截断：seq1 从 list 消失（对象本体仍在 —— 分页 bug / 最终一致性窗口）
    storage.hide(&keys[0]);

    let downloader = SyncManager::new(unique_device("r10-trunc-gap-dst"));
    let error = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect_err("seq 缺口必须让下载停在安全点，不得跳号消费 seq2");
    let message = error.to_string();
    assert!(
        message.contains("缺少序号"),
        "错误应指明缺失的序号（缺口证明）: {message}"
    );

    // 截断窗口结束后必须能完整消费，且顺序正确
    storage.unhide(&keys[0]);
    let downloaded = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("列表恢复后下载应成功");
    assert_eq!(downloaded.changes.len(), 2);
    assert_eq!(
        downloaded
            .changes
            .iter()
            .map(|c| c.record_id.as_str())
            .collect::<Vec<_>>(),
        vec!["rec-one", "rec-two"],
        "恢复后必须按 seq 顺序完整消费"
    );
}

// ============================================================================
// 3. 静默截断丢尾部 seq：安全前缀可消费，恢复后尾部不被永久跳过
// ============================================================================

#[tokio::test]
async fn r10_chaos_silent_truncation_hiding_tail_seq_does_not_lose_data() {
    let storage = TruncatingStorage::default();
    let uploader_id = unique_device("r10-trunc-tail-src");
    let keys = seed_two_shards(&storage, &uploader_id).await;

    // 静默截断：尾部 seq2 从 list 消失
    storage.hide(&keys[1]);

    let downloader = SyncManager::new(unique_device("r10-trunc-tail-dst"));
    let first = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("合法前缀 seq1 应可安全消费");
    assert_eq!(
        first
            .changes
            .iter()
            .map(|c| c.record_id.as_str())
            .collect::<Vec<_>>(),
        vec!["rec-one"],
        "截断窗口内只应消费连续前缀"
    );

    // 正常路径：应用 + 提交游标
    let conn = new_db();
    let applied = SyncManager::apply_downloaded_changes(&conn, &first.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);
    downloader
        .commit_download_progress(&storage, &first)
        .await
        .expect("提交 seq1 游标应成功");

    // provider 恢复：seq2 必须在下一轮被消费（不因截断窗口被永久跳过）
    storage.unhide(&keys[1]);
    let second = downloader
        .download_changes(&storage, 0, None)
        .await
        .expect("恢复后下载应成功");
    assert_eq!(
        second
            .changes
            .iter()
            .map(|c| c.record_id.as_str())
            .collect::<Vec<_>>(),
        vec!["rec-two"],
        "截断窗口不得造成 seq2 永久丢失"
    );
    let applied = SyncManager::apply_downloaded_changes(&conn, &second.changes, None).unwrap();
    assert_eq!(applied.failure_count, 0);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2, "两条记录最终都必须落地");
}
