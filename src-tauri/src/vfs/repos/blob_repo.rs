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
use tracing::{debug, error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::VfsBlob;

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::BlobRepo] Row parse error (skipped): {}", e);
            None
        }
    }
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
        // 1. 计算哈希
        let hash = Self::compute_hash(data);
        debug!("[VFS::BlobRepo] Computed hash: {}", hash);

        // 2. 构建存储路径
        let (relative_path, absolute_path) = Self::build_blob_path(blobs_dir, &hash, extension)?;

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
            let temp_path = absolute_path.with_extension("tmp");

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

        let (final_ref_count, final_created_at): (i32, i64) = conn.query_row(
            r#"
            INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
            VALUES (?1, ?2, ?3, ?4, 1, ?5)
            ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1
            RETURNING ref_count, created_at
            "#,
            params![hash, relative_path, size, mime_type, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

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
    /// 使用 RETURNING 子句确保更新和读取的原子性
    /// 如果引用计数降为 0，可以选择删除文件和记录（可配置）
    pub fn decrement_ref_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<i32> {
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

        // 可选：清理无引用的 Blob
        if new_count == 0 {
            // 启用blob清理逻辑
            if let Err(e) = Self::cleanup_blob_with_conn(conn, blobs_dir, hash) {
                warn!("[VFS::BlobRepo] Failed to cleanup blob {}: {}", hash, e);
            }
        }

        Ok(new_count)
    }

    /// 清理无引用的 Blob（删除文件和记录）
    pub fn cleanup_blob_with_conn(
        conn: &Connection,
        blobs_dir: &Path,
        hash: &str,
    ) -> VfsResult<bool> {
        // 检查引用计数
        let ref_count: i32 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);

        if ref_count > 0 {
            return Ok(false);
        }

        // 获取文件路径
        if let Some(blob) = Self::get_blob_with_conn(conn, hash)? {
            let file_path = blobs_dir.join(&blob.relative_path);
            if file_path.exists() {
                fs::remove_file(&file_path).map_err(|e| {
                    error!("[VFS::BlobRepo] Failed to delete blob file: {}", e);
                    VfsError::Io(format!("Failed to delete blob file: {}", e))
                })?;
            }
        }

        // 删除数据库记录
        conn.execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;

        info!("[VFS::BlobRepo] Cleaned up blob: {}", hash);
        Ok(true)
    }

    /// 清理所有无引用的 Blob
    pub fn cleanup_unreferenced(db: &VfsDatabase) -> VfsResult<u32> {
        let conn = db.get_conn_safe()?;
        Self::cleanup_unreferenced_with_conn(&conn, db.blobs_dir())
    }

    /// 清理所有无引用的 Blob（使用现有连接）
    pub fn cleanup_unreferenced_with_conn(conn: &Connection, blobs_dir: &Path) -> VfsResult<u32> {
        // 获取所有无引用的 Blob
        let mut stmt = conn.prepare("SELECT hash, relative_path FROM blobs WHERE ref_count = 0")?;

        let blobs: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(log_and_skip_err)
            .collect();

        let mut cleaned = 0u32;

        for (hash, relative_path) in blobs {
            // 删除文件
            let file_path = blobs_dir.join(&relative_path);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("[VFS::BlobRepo] Failed to delete blob file {}: {}", hash, e);
                    continue;
                }
            }

            // 删除记录
            conn.execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
            cleaned += 1;
        }

        info!("[VFS::BlobRepo] Cleaned up {} unreferenced blobs", cleaned);
        Ok(cleaned)
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
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let db = VfsDatabase::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, db)
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
}
