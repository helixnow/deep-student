//! VFS 大文件 Blob 管理
//!
//! 管理大文件的外部存储，实际文件存储在 `vfs_blobs/{hash_prefix}/{hash}.{ext}`。
//!
//! ## 核心方法
//! - `store_blob`: 存储 Blob
//! - `get_blob_path`: 获取 Blob 文件路径
//! - `blob_exists`: 检查 Blob 是否存在

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tracing::{debug, error, info};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::VfsBlob;

static BLOB_FILE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn lock_blob_file_mutation() -> VfsResult<MutexGuard<'static, ()>> {
    BLOB_FILE_MUTATION_LOCK
        .lock()
        .map_err(|_| VfsError::Internal("blob file mutation lock poisoned".to_string()))
}

#[derive(Debug, Clone)]
struct BlobDeletionIntent {
    operation_id: String,
    hash: String,
    relative_path: String,
    expected_hash: Option<String>,
    size: Option<i64>,
}

/// VFS Blob 表 Repo
pub struct VfsBlobRepo;

impl VfsBlobRepo {
    // ========================================================================
    // 存储 Blob
    // ========================================================================

    /// 存储 Blob 文件
    ///
    /// ## 流程
    /// 1. 计算内容哈希
    /// 2. 检查是否已存在（去重）
    /// 3. 写入文件到 `vfs_blobs/{hash_prefix}/{hash}.{ext}`
    /// 4. 创建数据库记录
    ///
    /// ## 参数
    /// - `db`: VFS 数据库
    /// - `data`: 文件内容（字节数组）
    /// - `mime_type`: MIME 类型（可选）
    /// - `extension`: 文件扩展名（可选）
    pub fn store_blob(
        db: &VfsDatabase,
        data: &[u8],
        mime_type: Option<&str>,
        extension: Option<&str>,
    ) -> VfsResult<VfsBlob> {
        let conn = db.get_conn_safe()?;
        Self::store_blob_with_conn(&conn, db.blobs_dir(), data, mime_type, extension)
    }

    /// 存储 Blob 文件（使用现有连接）
    ///
    /// ## 并发安全
    /// 使用 `INSERT ... ON CONFLICT DO UPDATE` 确保并发插入相同 hash 时不会报错，
    /// 而是原子地增加引用计数。文件写入是幂等的（相同 hash 意味着相同内容）。
    pub fn store_blob_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        data: &[u8],
        mime_type: Option<&str>,
        extension: Option<&str>,
    ) -> VfsResult<VfsBlob> {
        // 与物理删除的 quarantine 阶段串行，避免 ref_count 复活与文件 claim
        // 交错后产生有 metadata、无文件的悬挂 blob。
        let _file_guard = lock_blob_file_mutation()?;

        // 1. 计算哈希
        let hash = Self::compute_hash(data);
        debug!("[VFS::BlobRepo] Computed hash: {}", hash);

        let pending: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM __file_deletion_journal
                  WHERE target_kind = 'blob'
                    AND entity_key = ?1
                    AND state = 'prepared'
             )",
            params![&hash],
            |row| row.get(0),
        )?;
        if pending {
            return Err(VfsError::Conflict {
                key: "blob.deletion_prepared".to_string(),
                message: format!(
                    "Blob {} has a prepared deletion; retry after deletion recovery",
                    hash
                ),
            });
        }

        // 2. 构建存储路径
        // ★ 2026-06-12（审阅问题 M1）：同 hash 已有记录时必须复用已登记的
        // relative_path。旧实现总是按本次调用方传入的 extension 重新拼路径，
        // 当两次导入扩展名不同（如 a.pdf 与 a.PDF→pdf / a.bin）时会在磁盘上
        // 写出第二个物理文件，而 DB 记录仍指向旧路径——新文件成为永远不被
        // 清理的孤儿。
        let existing_relative_path: Option<String> = conn
            .query_row(
                "SELECT relative_path FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;

        let (relative_path, absolute_path) = match existing_relative_path {
            Some(rel) => {
                let abs = blobs_dir.join(&rel);
                (rel, abs)
            }
            None => Self::build_blob_path(blobs_dir, &hash, extension)?,
        };

        // 3. 确保目录存在
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                error!("[VFS::BlobRepo] Failed to create blob directory: {}", e);
                VfsError::Io(format!("Failed to create blob directory: {}", e))
            })?;
        }

        // 4. 幂等写入文件（相同 hash 意味着相同内容，覆写安全）
        //    如果文件已存在且大小匹配，跳过写入以优化性能
        let should_write = match fs::metadata(&absolute_path) {
            Ok(meta) => meta.len() != data.len() as u64,
            Err(_) => true, // 文件不存在，需要写入
        };

        if should_write {
            // Atomic write: write to temp file first, then rename to avoid
            // corrupted blobs if the process is killed mid-write.
            // ★ 2026-06-12（审阅问题 M 类）：tmp 文件名加入随机后缀。
            // 旧实现使用固定的 `<hash>.tmp`，并发写入同一 blob 时两个写者共用
            // 一个临时文件：后来者 truncate 前者的数据、先完成者 rename 后
            // 另一方 rename 失败，产生虚假错误。唯一命名让每个写者独立。
            let temp_path = absolute_path.with_extension(format!("{}.tmp", nanoid::nanoid!(8)));

            let write_result = (|| -> VfsResult<()> {
                let mut file = fs::File::create(&temp_path).map_err(|e| {
                    error!("[VFS::BlobRepo] Failed to create temp blob file: {}", e);
                    VfsError::Io(format!("Failed to create temp blob file: {}", e))
                })?;

                file.write_all(data).map_err(|e| {
                    error!("[VFS::BlobRepo] Failed to write temp blob file: {}", e);
                    VfsError::Io(format!("Failed to write temp blob file: {}", e))
                })?;

                // Flush to ensure data is persisted before rename
                file.flush().map_err(|e| {
                    error!("[VFS::BlobRepo] Failed to flush temp blob file: {}", e);
                    VfsError::Io(format!("Failed to flush temp blob file: {}", e))
                })?;

                Ok(())
            })();

            if let Err(e) = write_result {
                // Clean up temp file on failure
                let _ = fs::remove_file(&temp_path);
                return Err(e);
            }

            // Atomic rename: on POSIX this is guaranteed atomic
            if let Err(e) = fs::rename(&temp_path, &absolute_path) {
                let _ = fs::remove_file(&temp_path);
                error!(
                    "[VFS::BlobRepo] Failed to rename temp blob to final path: {}",
                    e
                );
                return Err(VfsError::Io(format!(
                    "Failed to rename temp blob to final path: {}",
                    e
                )));
            }
        } else {
            debug!(
                "[VFS::BlobRepo] Blob file already exists, skipping write: {}",
                hash
            );
        }

        // 5. 原子性插入或更新数据库记录
        //    使用 INSERT ... ON CONFLICT DO UPDATE 确保并发安全：
        //    - 如果 hash 不存在：插入新记录，ref_count = 1
        //    - 如果 hash 已存在：ref_count + 1（UNIQUE 约束在 hash 列）
        let now = chrono::Utc::now().timestamp_millis();
        let size = data.len() as i64;

        conn.execute_batch("SAVEPOINT blob_store_metadata")?;
        let stored = (|| -> VfsResult<(i32, i64)> {
            let result = conn.query_row(
                r#"
                INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
                VALUES (?1, ?2, ?3, ?4, 1, ?5)
                ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1
                RETURNING ref_count, created_at
                "#,
                params![hash, relative_path, size, mime_type, now],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            // 重新导入同一内容撤销尚未发布的 tombstone。先取消 journal，
            // 再删除 ready-only outbox，避免 DELETE trigger 误标 published。
            conn.execute(
                "UPDATE __file_deletion_journal
                    SET state = 'cancelled',
                        cancelled_at = ?2,
                        last_error = 'blob recreated before deletion was published'
                  WHERE target_kind = 'blob'
                    AND entity_key = ?1
                    AND state IN ('prepared', 'ready')",
                params![&hash, chrono::Utc::now().to_rfc3339()],
            )?;
            conn.execute(
                "DELETE FROM __blob_deletion_queue WHERE hash = ?1",
                params![&hash],
            )?;
            Ok(result)
        })();
        let (final_ref_count, final_created_at) = match stored {
            Ok(result) => {
                conn.execute_batch("RELEASE SAVEPOINT blob_store_metadata")?;
                result
            }
            Err(error) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT blob_store_metadata;
                     RELEASE SAVEPOINT blob_store_metadata;",
                );
                return Err(error);
            }
        };

        let is_new = final_ref_count == 1;
        if is_new {
            info!("[VFS::BlobRepo] Stored new blob: {} ({} bytes)", hash, size);
        } else {
            debug!(
                "[VFS::BlobRepo] Blob already exists, incremented ref_count: {} -> {}",
                hash, final_ref_count
            );
        }

        Ok(VfsBlob {
            hash,
            relative_path,
            size,
            mime_type: mime_type.map(|s| s.to_string()),
            ref_count: final_ref_count,
            created_at: final_created_at,
        })
    }

    // ========================================================================
    // 查询 Blob
    // ========================================================================

    /// 根据哈希获取 Blob 元数据
    pub fn get_blob(db: &VfsDatabase, hash: &str) -> VfsResult<Option<VfsBlob>> {
        let conn = db.get_conn_safe()?;
        Self::get_blob_with_conn(&conn, hash)
    }

    /// 根据哈希获取 Blob 元数据（使用现有连接）
    pub fn get_blob_with_conn(conn: &Connection, hash: &str) -> VfsResult<Option<VfsBlob>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT hash, relative_path, size, mime_type, ref_count, created_at
            FROM blobs
            WHERE hash = ?1
            "#,
        )?;

        let blob = stmt
            .query_row(params![hash], Self::row_to_blob)
            .optional()?;

        Ok(blob)
    }

    /// 检查 Blob 是否存在
    pub fn blob_exists(db: &VfsDatabase, hash: &str) -> VfsResult<bool> {
        let conn = db.get_conn_safe()?;
        Self::blob_exists_with_conn(&conn, hash)
    }

    /// 检查 Blob 是否存在（使用现有连接）
    pub fn blob_exists_with_conn(conn: &Connection, hash: &str) -> VfsResult<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// 获取 Blob 文件的绝对路径
    pub fn get_blob_path(db: &VfsDatabase, hash: &str) -> VfsResult<Option<PathBuf>> {
        let conn = db.get_conn_safe()?;
        Self::get_blob_path_with_conn(&conn, db.blobs_dir(), hash)
    }

    /// 获取 Blob 文件的绝对路径（使用现有连接）
    pub fn get_blob_path_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<Option<PathBuf>> {
        let blob = Self::get_blob_with_conn(conn, hash)?;
        Ok(blob.map(|b| blobs_dir.join(&b.relative_path)))
    }

    // ========================================================================
    // 引用计数管理
    // ========================================================================

    /// 增加引用计数
    pub fn increment_ref(db: &VfsDatabase, hash: &str) -> VfsResult<i32> {
        let conn = db.get_conn_safe()?;
        Self::increment_ref_with_conn(&conn, hash)
    }

    /// 增加引用计数（使用现有连接）
    ///
    /// 使用 RETURNING 子句确保更新和读取的原子性
    pub fn increment_ref_with_conn(conn: &Connection, hash: &str) -> VfsResult<i32> {
        // 使用 RETURNING 子句原子地更新并返回新值
        let new_count: i32 = conn
            .query_row(
                "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1 RETURNING ref_count",
                params![hash],
                |row| row.get(0),
            )
            .map_err(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    VfsError::NotFound {
                        resource_type: "blob".to_string(),
                        id: hash.to_string(),
                    }
                } else {
                    VfsError::Database(e.to_string())
                }
            })?;

        debug!(
            "[VFS::BlobRepo] Incremented ref_count for {}: {}",
            hash, new_count
        );
        Ok(new_count)
    }

    /// 减少引用计数
    pub fn decrement_ref(db: &VfsDatabase, hash: &str) -> VfsResult<i32> {
        let conn = db.get_conn_safe()?;
        Self::decrement_ref_with_conn(&conn, db.blobs_dir(), hash)
    }

    /// 减少引用计数（使用现有连接）
    ///
    /// 使用 RETURNING 子句确保更新和读取的原子性。
    ///
    /// ★ 2026-06-10 修复（审阅问题 A2）：引用计数降为 0 时**不再在本函数内删除物理文件**。
    /// 旧行为在调用方事务（BEGIN/SAVEPOINT）内执行 `fs::remove_file`，
    /// 一旦后续 SQL 失败回滚，DB 记录复活但文件已永久丢失。
    /// 现在 ref_count=0 的行保留在 blobs 表中，由调用方在事务提交后调用
    /// `cleanup_unreferenced` / `cleanup_blob_with_conn` 统一清理（两阶段删除）。
    /// 即使应用在提交后、清理前崩溃，残留的 ref_count=0 行也会被下次清扫回收，
    /// 不会造成数据丢失。
    pub fn decrement_ref_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<i32> {
        let _ = blobs_dir; // 保留签名兼容；物理删除已移交事务提交后的清扫阶段
                           // 使用 RETURNING 子句原子地更新并返回新值
        let new_count: i32 = conn.query_row(
            "UPDATE blobs SET ref_count = MAX(0, ref_count - 1) WHERE hash = ?1 RETURNING ref_count",
            params![hash],
            |row| row.get(0),
        ).map_err(|e| {
            if e == rusqlite::Error::QueryReturnedNoRows {
                // blob不存在时返回0，而不是错误
                return VfsError::NotFound {
                    resource_type: "blob".to_string(),
                    id: hash.to_string(),
                };
            }
            VfsError::Database(e.to_string())
        })?;

        debug!(
            "[VFS::BlobRepo] Decremented ref_count for {}: {}",
            hash, new_count
        );

        if new_count == 0 {
            debug!(
                "[VFS::BlobRepo] Blob {} reached ref_count=0, deferred cleanup after commit",
                hash
            );
        }

        Ok(new_count)
    }

    /// 清理无引用的 Blob（删除文件和记录）
    ///
    /// 删除成功后会在 `__blob_deletion_queue` 记录删除意图，
    /// 供后续云同步把删除传播到其他设备（tombstone 机制）。
    pub fn cleanup_blob_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<bool> {
        Self::ensure_deletion_transaction_boundary(conn)?;
        Self::recover_prepared_blob_deletions(conn, blobs_dir)?;
        Self::cleanup_blob_after_recovery(conn, blobs_dir, hash)
    }

    fn cleanup_blob_after_recovery(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<bool> {
        let Some(blob) = Self::get_blob_with_conn(conn, hash)? else {
            return Ok(false);
        };
        if blob.ref_count > 0 {
            return Ok(false);
        }

        let Some(intent) = Self::prepare_blob_deletion(conn, blobs_dir, &blob)? else {
            return Ok(false);
        };
        Self::finish_blob_deletion(conn, blobs_dir, &intent)?;
        info!(
            "[VFS::BlobRepo] Cleaned up blob {} via operation {}",
            hash, intent.operation_id
        );
        Ok(true)
    }

    fn ensure_deletion_transaction_boundary(conn: &Connection) -> VfsResult<()> {
        if conn.is_autocommit() {
            conn.pragma_update(None, "synchronous", "FULL")?;
            Ok(())
        } else {
            Err(VfsError::InvalidState {
                message:
                    "blob physical deletion requires an autocommit connection after metadata commit"
                        .to_string(),
            })
        }
    }

    fn prepare_blob_deletion(
        conn: &Connection,
        blobs_dir: &Path,
        blob: &VfsBlob,
    ) -> VfsResult<Option<BlobDeletionIntent>> {
        Self::ensure_deletion_transaction_boundary(conn)?;
        let file_path = Self::safe_blob_path(blobs_dir, &blob.relative_path)?;
        let (expected_hash, size) = if file_path.try_exists().map_err(|e| {
            VfsError::Io(format!(
                "Failed to inspect blob {} before deletion: {}",
                blob.hash, e
            ))
        })? {
            let actual = Self::compute_file_hash(&file_path)?;
            let size = fs::metadata(&file_path)
                .ok()
                .map(|metadata| metadata.len() as i64);
            (Some(actual), size)
        } else {
            (None, Some(blob.size))
        };
        let intent = BlobDeletionIntent {
            operation_id: uuid::Uuid::new_v4().to_string(),
            hash: blob.hash.clone(),
            relative_path: blob.relative_path.clone(),
            expected_hash,
            size,
        };
        let prepared_at = chrono::Utc::now().to_rfc3339();

        conn.execute_batch("SAVEPOINT blob_deletion_prepare")?;
        let prepared = (|| -> VfsResult<bool> {
            conn.execute(
                "INSERT INTO __file_deletion_journal (
                     operation_id, target_kind, entity_key, local_path,
                     expected_hash, size, state, prepared_at
                 ) VALUES (?1, 'blob', ?2, ?3, ?4, ?5, 'prepared', ?6)",
                params![
                    intent.operation_id,
                    intent.hash,
                    intent.relative_path,
                    intent.expected_hash,
                    intent.size,
                    prepared_at
                ],
            )?;
            let deleted = conn.execute(
                "DELETE FROM blobs WHERE hash = ?1 AND ref_count = 0",
                params![intent.hash],
            )?;
            Ok(deleted == 1)
        })();

        match prepared {
            Ok(true) => {
                conn.execute_batch("RELEASE SAVEPOINT blob_deletion_prepare")?;
                Ok(Some(intent))
            }
            Ok(false) => {
                conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT blob_deletion_prepare;
                     RELEASE SAVEPOINT blob_deletion_prepare;",
                )?;
                Ok(None)
            }
            Err(error) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT blob_deletion_prepare;
                     RELEASE SAVEPOINT blob_deletion_prepare;",
                );
                Err(error)
            }
        }
    }

    pub(crate) fn recover_prepared_blob_deletions(
        conn: &Connection,
        blobs_dir: &Path,
    ) -> VfsResult<u32> {
        Self::ensure_deletion_transaction_boundary(conn)?;
        Self::recover_prepared_blob_deletions_locked(conn, blobs_dir)
    }

    fn recover_prepared_blob_deletions_locked(
        conn: &Connection,
        blobs_dir: &Path,
    ) -> VfsResult<u32> {
        let mut statement = conn.prepare(
            "SELECT operation_id, entity_key, local_path, expected_hash, size
               FROM __file_deletion_journal
              WHERE target_kind = 'blob' AND state = 'prepared'
              ORDER BY prepared_at, operation_id",
        )?;
        let intents = statement
            .query_map([], |row| {
                Ok(BlobDeletionIntent {
                    operation_id: row.get(0)?,
                    hash: row.get(1)?,
                    relative_path: row.get(2)?,
                    expected_hash: row.get(3)?,
                    size: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        let mut recovered = 0;
        for intent in intents {
            Self::finish_blob_deletion(conn, blobs_dir, &intent)?;
            recovered += 1;
        }
        Ok(recovered)
    }

    fn finish_blob_deletion(
        conn: &Connection,
        blobs_dir: &Path,
        intent: &BlobDeletionIntent,
    ) -> VfsResult<()> {
        Self::ensure_deletion_transaction_boundary(conn)?;
        let file_path = Self::safe_blob_path(blobs_dir, &intent.relative_path)?;
        let quarantine_path = Self::blob_quarantine_path(&file_path, &intent.operation_id)?;

        let conflict = {
            let _file_guard = lock_blob_file_mutation()?;
            if quarantine_path
                .try_exists()
                .map_err(|e| VfsError::Io(format!("Failed to inspect blob quarantine: {}", e)))?
            {
                if let Some(conflict) = Self::blob_baseline_conflict(intent, &quarantine_path)? {
                    Some((quarantine_path, conflict))
                } else {
                    fs::remove_file(&quarantine_path).map_err(|e| {
                        VfsError::Io(format!(
                            "Failed to delete claimed blob {}: {}",
                            intent.hash, e
                        ))
                    })?;
                    None
                }
            } else if file_path
                .try_exists()
                .map_err(|e| VfsError::Io(format!("Failed to inspect blob deletion path: {}", e)))?
            {
                if let Some(conflict) = Self::blob_baseline_conflict(intent, &file_path)? {
                    Some((file_path, conflict))
                } else {
                    fs::rename(&file_path, &quarantine_path).map_err(|e| {
                        VfsError::Io(format!(
                            "Failed to claim blob {} for deletion: {}",
                            intent.hash, e
                        ))
                    })?;
                    fs::remove_file(&quarantine_path).map_err(|e| {
                        VfsError::Io(format!(
                            "Failed to delete claimed blob {}: {}",
                            intent.hash, e
                        ))
                    })?;
                    None
                }
            } else {
                None
            }
        };

        if let Some((path, (expected, actual))) = conflict {
            return Self::cancel_blob_baseline_conflict(conn, intent, &path, &expected, &actual);
        }

        Self::mark_blob_deletion_ready(conn, intent)
    }

    fn blob_baseline_conflict(
        intent: &BlobDeletionIntent,
        path: &Path,
    ) -> VfsResult<Option<(String, String)>> {
        let actual = Self::compute_file_hash(path)?;
        match intent.expected_hash.as_deref() {
            Some(expected) if expected == actual => Ok(None),
            expected => Ok(Some((
                expected.unwrap_or("<missing baseline>").to_string(),
                actual,
            ))),
        }
    }

    fn cancel_blob_baseline_conflict(
        conn: &Connection,
        intent: &BlobDeletionIntent,
        path: &Path,
        expected: &str,
        actual: &str,
    ) -> VfsResult<()> {
        let message = format!(
            "blob content changed after prepare: expected={}, actual={}",
            expected, actual
        );
        conn.execute(
            "UPDATE __file_deletion_journal
                SET state = 'cancelled',
                    cancelled_at = ?2,
                    last_error = ?3
              WHERE operation_id = ?1 AND state = 'prepared'",
            params![
                intent.operation_id,
                chrono::Utc::now().to_rfc3339(),
                message
            ],
        )?;
        Err(VfsError::Conflict {
            key: "blob.deletion_content_changed".to_string(),
            message: format!(
                "Blob deletion {} cancelled because {} changed (expected {}, actual {})",
                intent.operation_id,
                path.display(),
                expected,
                actual
            ),
        })
    }

    fn mark_blob_deletion_ready(conn: &Connection, intent: &BlobDeletionIntent) -> VfsResult<()> {
        let ready_at = chrono::Utc::now().to_rfc3339();
        conn.execute_batch("SAVEPOINT blob_deletion_ready")?;
        let result = (|| -> VfsResult<()> {
            conn.execute(
                "INSERT INTO __blob_deletion_queue (
                     hash, relative_path, size, deleted_at, retry_count
                 ) VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT(hash) DO UPDATE SET
                     relative_path = excluded.relative_path,
                     size = excluded.size,
                     deleted_at = excluded.deleted_at,
                     retry_count = 0",
                params![intent.hash, intent.relative_path, intent.size, ready_at],
            )?;
            let updated = conn.execute(
                "UPDATE __file_deletion_journal
                    SET state = 'ready',
                        ready_at = ?2,
                        last_error = NULL
                  WHERE operation_id = ?1
                    AND state IN ('prepared', 'ready')",
                params![intent.operation_id, ready_at],
            )?;
            if updated != 1 {
                return Err(VfsError::InvalidState {
                    message: format!(
                        "blob deletion operation {} cannot advance to ready",
                        intent.operation_id
                    ),
                });
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("RELEASE SAVEPOINT blob_deletion_ready")?;
                Ok(())
            }
            Err(error) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT blob_deletion_ready;
                     RELEASE SAVEPOINT blob_deletion_ready;",
                );
                Err(error)
            }
        }
    }

    fn safe_blob_path(blobs_dir: &Path, relative_path: &str) -> VfsResult<PathBuf> {
        let relative = Path::new(relative_path);
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(VfsError::PathParse {
                path: relative_path.to_string(),
                reason: "blob deletion path must remain relative to vfs_blobs".to_string(),
            });
        }
        Ok(blobs_dir.join(relative))
    }

    fn blob_quarantine_path(path: &Path, operation_id: &str) -> VfsResult<PathBuf> {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| VfsError::PathParse {
                path: path.display().to_string(),
                reason: "blob deletion target has no UTF-8 file name".to_string(),
            })?;
        Ok(path.with_file_name(format!("{}.deleting-{}", file_name, operation_id)))
    }

    fn compute_file_hash(path: &Path) -> VfsResult<String> {
        use std::io::Read;

        let mut file = fs::File::open(path)
            .map_err(|e| VfsError::Io(format!("Failed to open {}: {}", path.display(), e)))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| VfsError::Io(format!("Failed to hash {}: {}", path.display(), e)))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    }

    /// TD-03：删除"无 DB 行登记"的孤儿物理文件（savepoint 回滚后的补偿）。
    ///
    /// 上传 saga 把 `store_blob_with_conn` 的 DB 插入包在 SAVEPOINT 内；
    /// 回滚只撤销 blobs 行，已 rename 落盘的物理文件无法回滚。本函数在
    /// 回滚**之后**调用：
    /// - blobs 行仍存在（hash 在本次上传前已被登记/去重复用）→ no-op，
    ///   绝不删除被复用的 blob 文件；
    /// - blobs 行不存在（行随回滚消失，文件为本次调用新写）→ 删除
    ///   `{prefix}/{hash}.*` 物理文件（跳过 `.tmp`，那是并发写者的活跃临时文件）。
    ///
    /// 返回是否删除了至少一个文件。幂等：重复调用为 no-op。
    ///
    /// 已知窄竞态：回滚后、删除前，并发 `store_blob_with_conn` 复活同 hash
    /// 会重新插入行——此处在删除前逐次复查行存在性以尽量收窄窗口；
    /// 即便误删，内容寻址设计下下次写入会自愈重建。
    pub fn remove_unregistered_blob_file(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<bool> {
        if hash.len() < 2 {
            return Ok(false);
        }
        if Self::blob_exists_with_conn(conn, hash)? {
            return Ok(false);
        }

        let prefix_dir = blobs_dir.join(&hash[..2]);
        let entries = match fs::read_dir(&prefix_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(VfsError::Io(format!(
                    "Failed to enumerate orphan blob directory {}: {}",
                    prefix_dir.display(),
                    error
                )))
            }
        };

        let mut removed = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                VfsError::Io(format!(
                    "Failed to enumerate orphan blob entry in {}: {}",
                    prefix_dir.display(),
                    error
                ))
            })?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(hash) || name.ends_with(".tmp") {
                continue;
            }
            // 删除前复查：并发 store 可能刚复活该 hash 的登记
            if Self::blob_exists_with_conn(conn, hash)? {
                debug!(
                    "[VFS::BlobRepo] Blob {} re-registered concurrently; keep physical file",
                    hash
                );
                return Ok(removed);
            }
            fs::remove_file(entry.path()).map_err(|error| {
                VfsError::Io(format!(
                    "Failed to remove unregistered orphan blob file {}: {}",
                    name, error
                ))
            })?;
            info!(
                "[VFS::BlobRepo] Removed unregistered orphan blob file: {}",
                name
            );
            removed = true;
        }
        Ok(removed)
    }

    /// 清理所有无引用的 Blob
    pub fn cleanup_unreferenced(db: &VfsDatabase) -> VfsResult<u32> {
        let conn = db.get_conn_safe()?;
        Self::cleanup_unreferenced_with_conn(&conn, db.blobs_dir())
    }

    /// 清理所有无引用的 Blob（使用现有连接）
    ///
    /// 每个被删除的 blob 也会入 `__blob_deletion_queue` 供云同步传播。
    pub fn cleanup_unreferenced_with_conn(conn: &Connection, blobs_dir: &Path) -> VfsResult<u32> {
        Self::ensure_deletion_transaction_boundary(conn)?;
        Self::recover_prepared_blob_deletions(conn, blobs_dir)?;

        // 获取所有无引用的 Blob
        let mut stmt = conn.prepare("SELECT hash FROM blobs WHERE ref_count = 0")?;
        let hashes: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut cleaned = 0u32;
        for hash in hashes {
            if Self::cleanup_blob_after_recovery(conn, blobs_dir, &hash)? {
                cleaned += 1;
            }
        }

        // ★ 2026-06-12（审阅问题 M 类）：清理进程崩溃残留的临时写入文件。
        // 只删除 mtime 超过 24h 的 *.tmp，避免误删并发写入中的活跃临时文件。
        Self::sweep_stale_temp_files(blobs_dir);

        info!("[VFS::BlobRepo] Cleaned up {} unreferenced blobs", cleaned);
        Ok(cleaned)
    }

    /// 清理 blobs 目录中残留的过期临时文件（崩溃恢复）
    fn sweep_stale_temp_files(blobs_dir: &Path) {
        const STALE_TMP_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
        let now = std::time::SystemTime::now();

        let Ok(prefix_dirs) = fs::read_dir(blobs_dir) else {
            return;
        };
        let mut removed = 0u32;
        for prefix_entry in prefix_dirs.flatten() {
            let prefix_path = prefix_entry.path();
            if !prefix_path.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(&prefix_path) else {
                continue;
            };
            for file_entry in files.flatten() {
                let path = file_entry.path();
                let is_tmp = path.extension().map(|ext| ext == "tmp").unwrap_or(false);
                if !is_tmp {
                    continue;
                }
                let is_stale = file_entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|mtime| now.duration_since(mtime).ok())
                    .map(|age| age > STALE_TMP_AGE)
                    .unwrap_or(false);
                if is_stale && fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            info!(
                "[VFS::BlobRepo] Removed {} stale temp files from blobs dir",
                removed
            );
        }
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 计算内容的 SHA-256 哈希
    pub fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 构建 Blob 存储路径
    ///
    /// 格式：`{hash_prefix_2}/{hash}.{ext}`
    fn build_blob_path(
        blobs_dir: &Path,
        hash: &str,
        extension: Option<&str>,
    ) -> VfsResult<(String, PathBuf)> {
        // 使用 hash 前 2 字符作为子目录
        let prefix = &hash[..2.min(hash.len())];
        let ext = extension.unwrap_or("bin");
        let filename = format!("{}.{}", hash, ext);
        let relative_path = format!("{}/{}", prefix, filename);
        let absolute_path = blobs_dir.join(&relative_path);

        Ok((relative_path, absolute_path))
    }

    /// 从行数据构建 VfsBlob
    fn row_to_blob(row: &rusqlite::Row) -> rusqlite::Result<VfsBlob> {
        Ok(VfsBlob {
            hash: row.get(0)?,
            relative_path: row.get(1)?,
            size: row.get(2)?,
            mime_type: row.get(3)?,
            ref_count: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    #[test]
    fn test_store_blob() {
        let (temp_dir, db) = setup_test_db();

        let data = b"Hello, VFS Blob!";
        let blob = VfsBlobRepo::store_blob(&db, data, Some("text/plain"), Some("txt"))
            .expect("Store should succeed");

        assert!(!blob.hash.is_empty());
        assert_eq!(blob.size, data.len() as i64);
        assert_eq!(blob.mime_type, Some("text/plain".to_string()));
        assert_eq!(blob.ref_count, 1);

        // 验证文件已创建
        let file_path = temp_dir.path().join("vfs_blobs").join(&blob.relative_path);
        assert!(file_path.exists(), "Blob file should exist");

        // 验证文件内容
        let stored_data = fs::read(&file_path).expect("Read should succeed");
        assert_eq!(stored_data, data);
    }

    #[test]
    fn test_blob_dedup() {
        let (_temp_dir, db) = setup_test_db();

        let data = b"Same content";

        // 存储第一次
        let blob1 =
            VfsBlobRepo::store_blob(&db, data, None, None).expect("First store should succeed");
        assert_eq!(blob1.ref_count, 1);

        // 存储相同内容
        let blob2 =
            VfsBlobRepo::store_blob(&db, data, None, None).expect("Second store should succeed");

        assert_eq!(blob1.hash, blob2.hash, "Should have same hash");
        assert_eq!(blob2.ref_count, 2, "ref_count should be incremented");
    }

    #[test]
    fn test_blob_dedup_different_extension_no_orphan() {
        // ★ 审阅问题 M1：同内容不同扩展名重复导入不应产生孤儿文件
        let (temp_dir, db) = setup_test_db();

        let data = b"Same content, different extension";
        let blob1 = VfsBlobRepo::store_blob(&db, data, None, Some("pdf"))
            .expect("First store should succeed");
        let blob2 = VfsBlobRepo::store_blob(&db, data, None, Some("bin"))
            .expect("Second store should succeed");

        assert_eq!(blob1.hash, blob2.hash);
        assert_eq!(
            blob1.relative_path, blob2.relative_path,
            "Second store must reuse the registered relative_path"
        );
        assert_eq!(blob2.ref_count, 2);

        // 磁盘上只应有一个该 hash 的文件
        let prefix_dir = temp_dir.path().join("vfs_blobs").join(&blob1.hash[..2]);
        let count = fs::read_dir(&prefix_dir)
            .expect("prefix dir should exist")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&blob1.hash))
            .count();
        assert_eq!(count, 1, "Only one physical file should exist for the hash");
    }

    #[test]
    fn test_get_blob_path() {
        let (temp_dir, db) = setup_test_db();

        let data = b"Test data";
        let blob =
            VfsBlobRepo::store_blob(&db, data, None, Some("dat")).expect("Store should succeed");

        let path = VfsBlobRepo::get_blob_path(&db, &blob.hash)
            .expect("Get path should succeed")
            .expect("Path should exist");

        assert!(path.starts_with(temp_dir.path().join("vfs_blobs")));
        assert!(path.exists());
    }

    #[test]
    fn test_ref_count_operations() {
        let (_temp_dir, db) = setup_test_db();

        let data = b"Test data";
        let blob = VfsBlobRepo::store_blob(&db, data, None, None).expect("Store should succeed");

        assert_eq!(blob.ref_count, 1);

        // 增加引用
        let count = VfsBlobRepo::increment_ref(&db, &blob.hash).expect("Increment should succeed");
        assert_eq!(count, 2);

        // 减少引用
        let count = VfsBlobRepo::decrement_ref(&db, &blob.hash).expect("Decrement should succeed");
        assert_eq!(count, 1);

        // 减少到 0
        let count = VfsBlobRepo::decrement_ref(&db, &blob.hash).expect("Decrement should succeed");
        assert_eq!(count, 0);

        // 不能低于 0
        let count = VfsBlobRepo::decrement_ref(&db, &blob.hash).expect("Decrement should succeed");
        assert_eq!(count, 0);
    }

    #[test]
    fn test_compute_hash() {
        let hash1 = VfsBlobRepo::compute_hash(b"test");
        let hash2 = VfsBlobRepo::compute_hash(b"test");
        let hash3 = VfsBlobRepo::compute_hash(b"different");

        assert_eq!(hash1, hash2, "Same content should have same hash");
        assert_ne!(hash1, hash3, "Different content should have different hash");
        assert_eq!(hash1.len(), 64, "SHA-256 should be 64 hex chars");
    }

    #[test]
    fn test_blob_path_structure() {
        let blobs_dir = Path::new("/tmp/vfs_blobs");
        let hash = "abcdef1234567890";

        let (relative, absolute) = VfsBlobRepo::build_blob_path(blobs_dir, hash, Some("pdf"))
            .expect("Build path should succeed");

        assert_eq!(relative, "ab/abcdef1234567890.pdf");
        assert_eq!(absolute, blobs_dir.join("ab/abcdef1234567890.pdf"));
    }

    #[test]
    fn deletion_prepare_failure_keeps_blob_metadata_and_file() {
        let (_temp, db) = setup_test_db();
        let blob = VfsBlobRepo::store_blob(&db, b"prepare failure", None, None).unwrap();
        VfsBlobRepo::decrement_ref(&db, &blob.hash).unwrap();
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_blob_prepare
             BEFORE INSERT ON __file_deletion_journal
             WHEN NEW.target_kind = 'blob'
             BEGIN
                 SELECT RAISE(FAIL, 'injected blob prepare failure');
             END;",
        )
        .unwrap();

        let error =
            VfsBlobRepo::cleanup_blob_with_conn(&conn, db.blobs_dir(), &blob.hash).unwrap_err();
        assert!(error.to_string().contains("injected blob prepare failure"));
        assert!(VfsBlobRepo::blob_exists_with_conn(&conn, &blob.hash).unwrap());
        assert!(db.blobs_dir().join(&blob.relative_path).exists());
    }

    #[test]
    fn recovers_blob_crash_after_prepare() {
        let (_temp, db) = setup_test_db();
        let blob = VfsBlobRepo::store_blob(&db, b"prepared crash", None, None).unwrap();
        VfsBlobRepo::decrement_ref(&db, &blob.hash).unwrap();
        let conn = db.get_conn_safe().unwrap();
        let current = VfsBlobRepo::get_blob_with_conn(&conn, &blob.hash)
            .unwrap()
            .unwrap();
        let intent = VfsBlobRepo::prepare_blob_deletion(&conn, db.blobs_dir(), &current)
            .unwrap()
            .unwrap();

        assert!(!VfsBlobRepo::blob_exists_with_conn(&conn, &blob.hash).unwrap());
        assert!(db.blobs_dir().join(&blob.relative_path).exists());
        assert_eq!(
            VfsBlobRepo::recover_prepared_blob_deletions(&conn, db.blobs_dir()).unwrap(),
            1
        );
        assert!(!db.blobs_dir().join(&blob.relative_path).exists());
        let state: String = conn
            .query_row(
                "SELECT state FROM __file_deletion_journal WHERE operation_id = ?1",
                params![intent.operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn blob_ready_outbox_failure_is_visible_and_recoverable() {
        let (_temp, db) = setup_test_db();
        let blob = VfsBlobRepo::store_blob(&db, b"outbox failure", None, None).unwrap();
        VfsBlobRepo::decrement_ref(&db, &blob.hash).unwrap();
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_blob_outbox
             BEFORE INSERT ON __blob_deletion_queue
             BEGIN
                 SELECT RAISE(FAIL, 'injected blob outbox failure');
             END;",
        )
        .unwrap();

        let error =
            VfsBlobRepo::cleanup_blob_with_conn(&conn, db.blobs_dir(), &blob.hash).unwrap_err();
        assert!(error.to_string().contains("injected blob outbox failure"));
        assert!(!VfsBlobRepo::blob_exists_with_conn(&conn, &blob.hash).unwrap());
        assert!(!db.blobs_dir().join(&blob.relative_path).exists());
        let state: String = conn
            .query_row(
                "SELECT state FROM __file_deletion_journal
                  WHERE target_kind = 'blob' AND entity_key = ?1",
                params![blob.hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "prepared");

        conn.execute_batch("DROP TRIGGER fail_blob_outbox").unwrap();
        assert_eq!(
            VfsBlobRepo::recover_prepared_blob_deletions(&conn, db.blobs_dir()).unwrap(),
            1
        );
        conn.execute(
            "DELETE FROM __blob_deletion_queue WHERE hash = ?1",
            params![blob.hash],
        )
        .unwrap();
        let state: String = conn
            .query_row(
                "SELECT state FROM __file_deletion_journal
                  WHERE target_kind = 'blob' AND entity_key = ?1",
                params![blob.hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "published");
    }
}
