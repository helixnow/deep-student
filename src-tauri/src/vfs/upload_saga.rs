//! VFS 上传原子性保障（TD-03）
//!
//! 上传链路 `store_blob → create_file_with_doc_data_in_folder → sync_resource_units`
//! 跨越三个持久化域：
//!
//! 1. **文件系统**（blob 物理文件）——无法参与数据库事务；
//!    写入本身已由 `store_blob_with_conn` 的"临时文件 + 原子 rename"保证不产生半截文件。
//! 2. **SQLite**（blobs / resources / files / folder_items 行）——同一连接内可用
//!    SAVEPOINT 整体回滚。
//! 3. **索引**（vfs_index_units + resources.index_state + LanceDB）——由后台索引
//!    循环异步兜底，失败必须落入显式可重试状态而不是被静默吞掉。
//!
//! 本模块提供最小 saga/补偿原语：
//!
//! - [`with_savepoint`]：把同一连接上的多步 DB 写包进一个可回滚的 SAVEPOINT
//!   （可嵌套在已有事务/SAVEPOINT 内）。
//! - [`UploadSaga`]：记录**本次调用**新建的 blob 引用（含独立连接提交的
//!   PDF 预览页 blob），失败时按"先减本次 +1 的引用、仅当归零才物理删除"的
//!   规则补偿，绝不删除被去重复用的 blob。
//!
//! ## 事务边界约定（调用方遵守）
//!
//! - 任何**其他连接**的写入（预览渲染、根目录创建）必须发生在 `with_savepoint`
//!   之外，否则会被本连接未提交的写锁阻塞直至 busy timeout。
//! - `with_savepoint` 闭包内不得有 `.await`。

use rusqlite::Connection;
use std::path::Path;
use tracing::{debug, error, info, warn};

use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::blob_repo::VfsBlobRepo;
use crate::vfs::types::PdfPreviewJson;

/// 在给定连接上以 SAVEPOINT 执行闭包：
/// - 闭包成功 → RELEASE（并入外层事务或立即提交）；
/// - 闭包失败 → ROLLBACK TO + RELEASE，闭包内所有 DB 写整体撤销。
///
/// SAVEPOINT 可安全嵌套（repo 内部的 `create_file_doc`、`vfs_sync_units`
/// 等内层 savepoint 与本函数兼容）。
///
/// `name` 必须是编译期常量风格的合法标识符（字母/数字/下划线）。
pub fn with_savepoint<T, F>(conn: &Connection, name: &str, f: F) -> VfsResult<T>
where
    F: FnOnce() -> VfsResult<T>,
{
    debug_assert!(
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "savepoint name must be a valid identifier"
    );

    conn.execute_batch(&format!("SAVEPOINT {}", name))
        .map_err(|e| {
            error!("[VFS::UploadSaga] Failed to open savepoint {}: {}", name, e);
            VfsError::Database(format!("Failed to open savepoint {}: {}", name, e))
        })?;

    match f() {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE SAVEPOINT {}", name))
                .map_err(|e| {
                    error!(
                        "[VFS::UploadSaga] Failed to release savepoint {}: {}",
                        name, e
                    );
                    VfsError::Database(format!("Failed to release savepoint {}: {}", name, e))
                })?;
            Ok(value)
        }
        Err(e) => {
            if let Err(rollback_err) = conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {name}; RELEASE SAVEPOINT {name};",
                name = name
            )) {
                // 回滚失败意味着连接处于未知状态：合并上抛，禁止调用方误以为已回滚
                error!(
                    "[VFS::UploadSaga] Rollback of savepoint {} failed: {}",
                    name, rollback_err
                );
                return Err(VfsError::Database(format!(
                    "{}; savepoint {} rollback failed: {}",
                    e, name, rollback_err
                )));
            }
            Err(e)
        }
    }
}

/// 上传补偿账本：跟踪**本次调用**新增的 blob 引用计数。
///
/// 每调用一次 `store_blob_with_conn` 都会给对应 hash 的 `ref_count` +1
/// （新建时置 1）。把这些 +1 逐个登记进账本；`abort` 时按登记逐个
/// `decrement_ref`，再做带 `ref_count = 0` 守卫的 `cleanup_blob`：
///
/// - 去重命中（他人仍引用，ref 回落到 N ≥ 1）→ 仅回退计数，物理文件保留；
/// - 本次独有（ref 归零）→ 删除 DB 行 + 物理文件，并写入删除传播队列。
///
/// `abort` 会清空账本，重复调用是幂等 no-op；`commit` 表示所有引用已被
/// 成功落库的 files 行接管，放弃补偿。
#[derive(Debug, Default)]
pub struct UploadSaga {
    /// 每个元素代表一次本调用产生的 ref_count +1（同一 hash 可出现多次）
    blob_refs: Vec<String>,
    committed: bool,
}

impl UploadSaga {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一次本调用产生的 blob 引用（store_blob 的 +1）。
    pub fn record_blob_ref(&mut self, hash: &str) {
        self.blob_refs.push(hash.to_string());
    }

    /// 登记预览渲染写入的整批页面 blob（每页一次 store → 每页一条引用）。
    pub fn record_preview_blobs(&mut self, preview: &PdfPreviewJson) {
        for page in &preview.pages {
            self.record_blob_ref(&page.blob_hash);
            if let Some(ref compressed) = page.compressed_blob_hash {
                if compressed != &page.blob_hash {
                    self.record_blob_ref(compressed);
                }
            }
        }
    }

    /// 上传成功：引用已由 files/preview_json 行接管，放弃补偿。
    pub fn commit(&mut self) {
        self.committed = true;
        self.blob_refs.clear();
    }

    /// 上传失败：回退本次登记的所有 blob 引用。
    ///
    /// 补偿本身 best-effort：单条失败只记日志继续（残留的 ref_count=0 行
    /// 会被 `cleanup_unreferenced` 后台清扫兜底回收）。
    /// 逆序补偿并清空账本 → 重复调用为幂等 no-op。
    pub fn abort(&mut self, conn: &Connection, blobs_dir: &Path) {
        if self.committed {
            return;
        }
        let refs = std::mem::take(&mut self.blob_refs);
        if refs.is_empty() {
            return;
        }
        info!(
            "[VFS::UploadSaga] Aborting upload, compensating {} blob ref(s)",
            refs.len()
        );
        for hash in refs.iter().rev() {
            match VfsBlobRepo::decrement_ref_with_conn(conn, blobs_dir, hash) {
                Ok(_) => {}
                Err(VfsError::NotFound { .. }) => {
                    // 行已不存在（如已被 savepoint 回滚或并发清扫）→ 无需补偿
                    debug!(
                        "[VFS::UploadSaga] Blob {} already gone during compensation",
                        &hash[..hash.len().min(16)]
                    );
                    continue;
                }
                Err(e) => {
                    warn!(
                        "[VFS::UploadSaga] Failed to decrement blob {} during compensation: {} (left to background sweep)",
                        &hash[..hash.len().min(16)],
                        e
                    );
                    continue;
                }
            }
            // 守卫式清理：仅 ref_count=0 时才删行+删文件，被去重复用的 blob 不受影响
            if let Err(e) = VfsBlobRepo::cleanup_blob_with_conn(conn, blobs_dir, hash) {
                warn!(
                    "[VFS::UploadSaga] Failed to cleanup blob {} during compensation: {} (left to background sweep)",
                    &hash[..hash.len().min(16)],
                    e
                );
            }
        }
    }
}

impl Drop for UploadSaga {
    fn drop(&mut self) {
        if !self.committed && !self.blob_refs.is_empty() {
            // 只警示不补偿：Drop 拿不到连接。走到这里说明调用方漏掉了
            // commit/abort，残留引用由后台清扫兜底。
            warn!(
                "[VFS::UploadSaga] Dropped with {} uncompensated blob ref(s); caller missed commit()/abort()",
                self.blob_refs.len()
            );
        }
    }
}

// ============================================================================
// 故障点单元测试（TD-03）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::repos::file_repo::VfsFileRepo;
    use crate::vfs::repos::index_unit_repo::{self, CreateUnitInput};
    use crate::vfs::repos::{VfsIndexStateRepo, INDEX_STATE_PENDING};
    use crate::vfs::types::VfsFile;
    use rusqlite::params;
    use std::fs;

    fn setup() -> (tempfile::TempDir, crate::vfs::database::VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn count_by_hash(conn: &Connection, table: &str, column: &str, hash: &str) -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {} WHERE {} = ?1", table, column),
            params![hash],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn blob_ref_count(conn: &Connection, hash: &str) -> Option<i32> {
        conn.query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .ok()
    }

    fn blob_file_exists(blobs_dir: &Path, hash: &str) -> bool {
        let prefix_dir = blobs_dir.join(&hash[..2]);
        fs::read_dir(&prefix_dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    let name = e.file_name();
                    let name = name.to_string_lossy().to_string();
                    name.starts_with(hash) && !name.ends_with(".tmp")
                })
            })
            .unwrap_or(false)
    }

    /// 故障点 1：blob 落盘 + 落库之后、创建文件行之前失败。
    /// 期望：savepoint 回滚 blobs 行，补偿删除本次新写的物理文件，不留孤儿。
    #[test]
    fn test_failure_after_blob_rolls_back_row_and_cleans_file() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        let data = b"td03: fail right after blob store";
        let hash = VfsBlobRepo::compute_hash(data);

        let result: VfsResult<()> = with_savepoint(&conn, "td03_blob_fail", || {
            VfsBlobRepo::store_blob_with_conn(
                &conn,
                blobs_dir,
                data,
                Some("application/pdf"),
                None,
            )?;
            Err(VfsError::Other("injected failure after blob".into()))
        });
        assert!(result.is_err());

        // DB 行已随 savepoint 整体回滚
        assert_eq!(
            blob_ref_count(&conn, &hash),
            None,
            "blobs row must be rolled back"
        );
        // 物理文件此刻仍在（rename 已发生，无法回滚）→ 补偿删除
        assert!(blob_file_exists(blobs_dir, &hash));
        let removed = VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &hash).unwrap();
        assert!(removed, "orphan physical file must be removed");
        assert!(!blob_file_exists(blobs_dir, &hash));
    }

    /// 故障点 1 变体：blob 被去重复用（上传前已存在引用）时上传失败。
    /// 期望：回滚只撤销本次 +1，物理文件与原引用不受影响。
    #[test]
    fn test_failure_after_dedup_blob_keeps_shared_blob() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        let data = b"td03: dedup-shared blob survives failed upload";
        // 先前的上传已持有该 blob（已提交，ref=1）
        let blob = VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, data, None, None).unwrap();
        assert_eq!(blob.ref_count, 1);

        let result: VfsResult<()> = with_savepoint(&conn, "td03_dedup_fail", || {
            let again = VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, data, None, None)?;
            assert_eq!(again.ref_count, 2);
            Err(VfsError::Other("injected failure after dedup store".into()))
        });
        assert!(result.is_err());

        // 本次 +1 被回滚，原引用保持
        assert_eq!(blob_ref_count(&conn, &blob.hash), Some(1));
        // 行仍存在 → 物理文件不得被删除
        let removed =
            VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &blob.hash).unwrap();
        assert!(!removed, "shared blob file must NOT be removed");
        assert!(blob_file_exists(blobs_dir, &blob.hash));
    }

    /// 故障点 2：resources/files/folder_items 行创建之后、savepoint 提交之前失败。
    /// 期望：blob 行 + 三张业务表整体回滚，物理文件被补偿删除。
    #[test]
    fn test_failure_after_file_row_rolls_back_everything() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        let data = b"td03: fail after file row created";
        let hash = VfsBlobRepo::compute_hash(data);
        let mut created_flag: Option<bool> = None;

        let result: VfsResult<()> = with_savepoint(&conn, "td03_row_fail", || {
            let blob = VfsBlobRepo::store_blob_with_conn(
                &conn,
                blobs_dir,
                data,
                Some("application/pdf"),
                None,
            )?;
            let (_file, created) = VfsFileRepo::create_file_with_doc_data_in_folder_outcome(
                &conn,
                &hash,
                "td03-row-fail.pdf",
                data.len() as i64,
                "pdf",
                Some("application/pdf"),
                Some(&blob.hash),
                None,
                None,
                None,
                Some("extracted text"),
                Some(1),
            )?;
            created_flag = Some(created);
            Err(VfsError::Other("injected failure after file row".into()))
        });
        assert!(result.is_err());
        assert_eq!(
            created_flag,
            Some(true),
            "file row must have been created before injection"
        );

        // 所有 DB 写整体回滚
        assert_eq!(count_by_hash(&conn, "files", "sha256", &hash), 0);
        assert_eq!(count_by_hash(&conn, "resources", "hash", &hash), 0);
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM folder_items WHERE item_type = 'file'"
            ),
            0
        );
        assert_eq!(blob_ref_count(&conn, &hash), None);

        // 物理文件补偿删除
        let removed = VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &hash).unwrap();
        assert!(removed);
        assert!(!blob_file_exists(blobs_dir, &hash));
    }

    /// 预览页 blob 补偿：只回退本次调用登记的引用；
    /// 被他人共享的页面 blob 只回落计数不删文件；abort 幂等。
    #[test]
    fn test_saga_abort_only_releases_refs_created_by_this_call() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        // 页面 A：先前的资源已引用（模拟跨 PDF 去重命中）
        let page_a = b"td03: shared preview page";
        let blob_a =
            VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, page_a, None, Some("png")).unwrap();
        // 页面 B：仅本次调用产生
        let page_b = b"td03: unique preview page";

        let mut saga = UploadSaga::new();
        let a_again =
            VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, page_a, None, Some("png")).unwrap();
        assert_eq!(a_again.ref_count, 2);
        saga.record_blob_ref(&a_again.hash);
        let blob_b =
            VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, page_b, None, Some("png")).unwrap();
        saga.record_blob_ref(&blob_b.hash);

        saga.abort(&conn, blobs_dir);

        // A：回落到原引用，文件保留
        assert_eq!(blob_ref_count(&conn, &blob_a.hash), Some(1));
        assert!(blob_file_exists(blobs_dir, &blob_a.hash));
        // B：归零 → 行与文件都被清理
        assert_eq!(blob_ref_count(&conn, &blob_b.hash), None);
        assert!(!blob_file_exists(blobs_dir, &blob_b.hash));

        // abort 幂等：再次调用不得再动 A 的引用
        saga.abort(&conn, blobs_dir);
        assert_eq!(blob_ref_count(&conn, &blob_a.hash), Some(1));
    }

    /// 故障点 3：文件已创建但索引同步失败。
    /// 期望：资源进入显式可重试状态（failed + 退避），用户/调度重试后重新入队；
    /// 单元同步重复执行幂等。
    #[test]
    fn test_index_failure_enters_retryable_state_and_sync_is_idempotent() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        let data = b"td03: index failure retry path";
        let hash = VfsBlobRepo::compute_hash(data);
        let blob = VfsBlobRepo::store_blob_with_conn(&conn, blobs_dir, data, None, None).unwrap();
        let (file, created) = VfsFileRepo::create_file_with_doc_data_in_folder_outcome(
            &conn,
            &hash,
            "td03-index-fail.txt",
            data.len() as i64,
            "document",
            Some("text/plain"),
            Some(&blob.hash),
            None,
            None,
            None,
            Some("some indexable text"),
            None,
        )
        .unwrap();
        assert!(created);
        let resource_id = file.resource_id.clone().expect("resource id");

        // 新建资源 index_state 为 NULL → 天然在待索引队列中（NULL 视同 pending）
        let pending = VfsIndexStateRepo::get_pending_resources_with_conn(&conn, 10, 3).unwrap();
        assert!(pending.contains(&resource_id));

        // 索引同步失败 → 显式可重试状态：failed + 退避 + 计数
        VfsIndexStateRepo::mark_failed_with_conn(&conn, &resource_id, "injected index failure")
            .unwrap();
        let (state, retry_count, next_retry_at): (String, i32, i64) = conn
            .query_row(
                "SELECT index_state, index_retry_count, index_next_retry_at FROM resources WHERE id = ?1",
                params![resource_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "failed");
        assert_eq!(retry_count, 1);
        assert!(next_retry_at > chrono::Utc::now().timestamp_millis());

        // 显式重试（用户操作或后台退避到期）→ 重新入队
        VfsIndexStateRepo::set_index_state_with_conn(
            &conn,
            &resource_id,
            INDEX_STATE_PENDING,
            None,
            None,
        )
        .unwrap();
        let pending = VfsIndexStateRepo::get_pending_resources_with_conn(&conn, 10, 3).unwrap();
        assert!(pending.contains(&resource_id));

        // 单元同步幂等：重复执行产生相同的 Unit 集合，无重复行
        let inputs = || {
            vec![CreateUnitInput {
                resource_id: resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("some indexable text".to_string()),
                text_source: Some("native".to_string()),
            }]
        };
        let first = index_unit_repo::sync_units(&conn, &resource_id, inputs()).unwrap();
        let second = index_unit_repo::sync_units(&conn, &resource_id, inputs()).unwrap();
        assert_eq!(first.units.len(), 1);
        assert_eq!(second.units.len(), 1);
        assert_eq!(
            first.units[0].id, second.units[0].id,
            "retry must reuse the same unit"
        );
        assert_eq!(
            count_by_hash(&conn, "vfs_index_units", "resource_id", &resource_id),
            1,
            "no duplicate units after retried sync"
        );
    }

    /// 单元同步中途失败必须整体回滚（不得留下半套 Units）。
    #[test]
    fn test_sync_units_rolls_back_partial_writes_on_failure() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();

        // 直接构造 resource 行（sync_units 不校验外键之外的资源状态）
        conn.execute(
            "INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
             VALUES ('res_td03sync', 'h', 'file', 'f', 'files', 'inline', '', 0, 0, 0)",
            [],
        )
        .unwrap();

        // 两个相同 unit_index → 第二条违反 UNIQUE(resource_id, unit_index)
        let inputs = vec![
            CreateUnitInput {
                resource_id: "res_td03sync".to_string(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("first".to_string()),
                text_source: Some("native".to_string()),
            },
            CreateUnitInput {
                resource_id: "res_td03sync".to_string(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("duplicate".to_string()),
                text_source: Some("native".to_string()),
            },
        ];

        let result = index_unit_repo::sync_units(&conn, "res_td03sync", inputs);
        assert!(result.is_err(), "duplicate unit_index must fail");
        assert_eq!(
            count_by_hash(&conn, "vfs_index_units", "resource_id", "res_td03sync"),
            0,
            "partially created units must be rolled back"
        );
    }

    /// 重复重试端到端：失败 → 重试成功 → 再次重复上传（去重），
    /// 全程引用计数与行数保持一致，不产生孤儿或悬挂引用。
    #[test]
    fn test_failed_upload_retry_is_idempotent() {
        let (_tmp, db) = setup();
        let conn = db.get_conn_safe().unwrap();
        let blobs_dir = db.blobs_dir();

        let data = b"td03: retry after failure";
        let hash = VfsBlobRepo::compute_hash(data);

        let attempt = |inject_failure: bool| -> VfsResult<(VfsFile, bool)> {
            let mut saga = UploadSaga::new();
            let step = with_savepoint(&conn, "td03_retry", || {
                let blob = VfsBlobRepo::store_blob_with_conn(
                    &conn,
                    blobs_dir,
                    data,
                    Some("application/pdf"),
                    None,
                )?;
                let outcome = VfsFileRepo::create_file_with_doc_data_in_folder_outcome(
                    &conn,
                    &hash,
                    "td03-retry.pdf",
                    data.len() as i64,
                    "pdf",
                    Some("application/pdf"),
                    Some(&blob.hash),
                    None,
                    None,
                    None,
                    Some("text"),
                    Some(1),
                )?;
                if inject_failure {
                    return Err(VfsError::Other("injected".into()));
                }
                Ok((blob.hash, outcome))
            });
            match step {
                Ok((blob_hash, (file, created))) => {
                    if created {
                        saga.commit();
                    } else {
                        // 去重命中：本次 store 的 +1 未被新文件行接管 → 回退
                        saga.record_blob_ref(&blob_hash);
                        saga.abort(&conn, blobs_dir);
                    }
                    Ok((file, created))
                }
                Err(e) => {
                    saga.abort(&conn, blobs_dir);
                    let _ = VfsBlobRepo::remove_unregistered_blob_file(&conn, blobs_dir, &hash);
                    Err(e)
                }
            }
        };

        // 第 1 次：失败 → 全量回滚 + 物理文件清理
        assert!(attempt(true).is_err());
        assert_eq!(count_by_hash(&conn, "files", "sha256", &hash), 0);
        assert_eq!(blob_ref_count(&conn, &hash), None);
        assert!(!blob_file_exists(blobs_dir, &hash));

        // 第 2 次：重试成功 → 恰好一份数据
        let (file2, created2) = attempt(false).unwrap();
        assert!(created2);
        assert_eq!(count_by_hash(&conn, "files", "sha256", &hash), 1);
        assert_eq!(blob_ref_count(&conn, &hash), Some(1));
        assert!(blob_file_exists(blobs_dir, &hash));

        // 第 3 次：重复上传（去重命中）→ 复用已有文件，引用计数不漂移
        let (file3, created3) = attempt(false).unwrap();
        assert!(!created3, "third attempt must dedup to the existing file");
        assert_eq!(file3.id, file2.id);
        assert_eq!(count_by_hash(&conn, "files", "sha256", &hash), 1);
        assert_eq!(
            blob_ref_count(&conn, &hash),
            Some(1),
            "dedup retry must not leak ref_count"
        );
        assert!(blob_file_exists(blobs_dir, &hash));
    }
}
