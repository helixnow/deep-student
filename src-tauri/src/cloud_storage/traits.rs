//! CloudStorage trait 定义
//!
//! 提供统一的云存储访问接口，支持 WebDAV 和 S3 兼容存储
//!
//! ## SOTA 特性
//! - 流式上传/下载：避免大文件占用过多内存
//! - 分块传输：支持 GB 级文件上传
//! - 进度回调：实时反馈传输进度
//! - SHA256 校验：确保数据完整性

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::models::AppError;

pub type Result<T> = std::result::Result<T, AppError>;

/// 上传进度回调类型
pub type UploadProgressCallback = Box<dyn Fn(u64, u64) + Send + Sync>;

/// 下载进度回调类型
pub type DownloadProgressCallback = Box<dyn Fn(u64, u64) + Send + Sync>;

/// 分块上传配置
pub const CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8MB per chunk

/// multipart 上传阈值：16MiB。
///
/// 必须与 S3 客户端 120s 的 `operation_attempt_timeout` 匹配：阈值以下的文件走
/// 单次 PUT（整个请求共用一个 120s 计时），16MiB 在 120s 内只需约 1.1Mbps 上行；
/// 旧值 100MB 会让慢速链路上接近阈值的文件必然触发单请求超时且无法通过重试恢复。
/// 阈值以上走 multipart，每个分块（CHUNK_SIZE）各自计时，不受总时长限制。
pub const MIN_MULTIPART_SIZE: u64 = 16 * 1024 * 1024;

/// [R09-restore-ops][P2-2] 后端不支持断点续传下载时的 fail-closed 错误文案。
///
/// 该错误只应在编排层误调（未先检查 [`CloudStorage::supports_resumable_download`]）
/// 时出现：宁可明确失败，也不能让默认实现悄悄整包重下并把结果冒充"续传成功"。
pub const RESUMABLE_DOWNLOAD_UNSUPPORTED: &str =
    "该云存储后端不支持断点续传下载（fail-closed）：请整包重新下载，或改用支持续传的 WebDAV";

/// 文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// 文件键（路径）
    pub key: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 最后修改时间
    pub last_modified: DateTime<Utc>,
    /// 可选的 ETag（用于校验）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

/// Result of listing a storage prefix.
///
/// `files` must contain every object below `prefix` recursively unless
/// `truncated` is true. Sync download paths treat truncation as a hard error so
/// missing objects cannot be mistaken for deletion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOutcome {
    pub files: Vec<FileInfo>,
    #[serde(default)]
    pub truncated: bool,
}

impl ListOutcome {
    pub fn complete(files: Vec<FileInfo>) -> Self {
        Self {
            files,
            truncated: false,
        }
    }
}

/// 内存级 `get()` 半包闸：响应体读到 EOF 不等于对象完整。
///
/// `get_file` 已按 `stat` 大小拒绝短写；清单 / 变更分片 / 租约走 `get()`，
/// 声明了 `Content-Length` / `content_length` 却短读时必须 fail-closed，
/// 不得把截断字节交给解码或推进水位。缺长度字段保持诚实：无法核对则不冒充已核。
/// 不宣称远端 SHA。
pub(crate) fn ensure_memory_get_matches_declared_len(
    provider: &str,
    key: &str,
    actual_len: u64,
    declared: Option<u64>,
) -> Result<()> {
    match declared {
        Some(expected) if actual_len != expected => Err(AppError::network(format!(
            "{provider} 内存对象下载不完整或对象已变更：{key} 声明 {expected} 字节，实际收到 {actual_len} 字节，已拒绝（请重试）"
        ))),
        _ => Ok(()),
    }
}

/// 统一的云存储访问 trait
///
/// 支持 WebDAV 和 S3 兼容存储（如 AWS S3、Cloudflare R2、阿里云 OSS、MinIO）
#[async_trait]
pub trait CloudStorage: Send + Sync {
    /// 获取存储后端名称（用于日志和调试）
    fn provider_name(&self) -> &'static str;

    /// 返回不含密码/密钥的实例绑定指纹，用于检测同一远端 instance 是否被错误地
    /// 通过不同 provider/root/account 复用。
    fn instance_binding_hint(&self) -> String {
        self.provider_name().to_string()
    }

    /// 检查连接是否可用
    async fn check_connection(&self) -> Result<()>;

    /// 上传文件
    ///
    /// # Arguments
    /// * `key` - 文件路径（相对于 root）
    /// * `data` - 文件内容
    async fn put(&self, key: &str, data: &[u8]) -> Result<()>;

    /// 下载文件
    ///
    /// # Arguments
    /// * `key` - 文件路径
    ///
    /// # Returns
    /// * `Ok(Some(data))` - 文件存在，返回内容
    /// * `Ok(None)` - 文件不存在
    /// * `Err(e)` - 其他错误
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;

    /// 列出指定前缀下的所有文件。
    ///
    /// Contract:
    /// - Results are recursive for every object below `prefix`.
    /// - Results are sorted by `last_modified` descending.
    /// - Implementations that cannot prove completeness must expose that via
    ///   `list_outcome` instead of silently returning a partial list.
    ///
    /// # Arguments
    /// * `prefix` - 路径前缀（如 "backups/"）
    ///
    /// # Returns
    /// 文件信息列表，按 last_modified 降序排列
    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>>;

    /// 列出指定前缀并 report whether the result may be truncated.
    ///
    /// Existing implementations/tests can keep implementing `list`; production
    /// backends override this when a backend-specific truncation signal exists.
    async fn list_outcome(&self, prefix: &str) -> Result<ListOutcome> {
        self.list(prefix).await.map(ListOutcome::complete)
    }

    /// 删除文件
    ///
    /// # Arguments
    /// * `key` - 文件路径
    async fn delete(&self, key: &str) -> Result<()>;

    /// 获取文件元信息
    ///
    /// # Arguments
    /// * `key` - 文件路径
    ///
    /// # Returns
    /// * `Ok(Some(info))` - 文件存在
    /// * `Ok(None)` - 文件不存在
    async fn stat(&self, key: &str) -> Result<Option<FileInfo>>;

    /// 检查文件是否存在
    async fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.stat(key).await?.is_some())
    }

    /// 流式上传本地文件（SOTA 特性）
    ///
    /// 自动选择最优上传策略：
    /// - 小文件（< `MIN_MULTIPART_SIZE`）：直接上传
    /// - 大文件（≥ `MIN_MULTIPART_SIZE`）：分块上传
    ///
    /// # Arguments
    /// * `key` - 远程文件路径
    /// * `local_path` - 本地文件路径
    /// * `progress` - 可选的进度回调 (uploaded_bytes, total_bytes)
    ///
    /// # Returns
    /// 上传后的文件 SHA256 校验和
    async fn put_file(
        &self,
        key: &str,
        local_path: &Path,
        progress: Option<UploadProgressCallback>,
    ) -> Result<String> {
        use sha2::{Digest, Sha256};

        // 默认实现：整体读入内存后 `put`。`put` trait 方法本身就是整体缓冲语义，
        // 默认实现无法做真正的流式/分块上传。**GB 级大文件请由具体后端覆盖本方法**
        // （S3 multipart / FTP 流式 STOR / WebDAV 流式 PUT，均已在各后端实现），
        // 避免在内存中驻留整个文件。
        let data = std::fs::read(local_path)
            .map_err(|e| AppError::file_system(format!("读取文件失败: {e}")))?;
        let file_size = data.len() as u64;

        if let Some(ref cb) = progress {
            cb(0, file_size);
        }

        let checksum = {
            let mut hasher = Sha256::new();
            hasher.update(&data);
            format!("{:x}", hasher.finalize())
        };

        self.put(key, &data).await?;

        if let Some(ref cb) = progress {
            cb(file_size, file_size);
        }

        Ok(checksum)
    }

    /// `put` / `put_file` 的 SHA256 来自本地字节。远端若静默短写，仍会带回本地哈希。
    /// 各生产后端在发布成功前调用本方法 `stat` 核对大小；全量回读太贵，短包这一档必须拦下。
    /// 默认 `put_file` **不**自动调用：测试假存储靠覆盖 `put` 模拟短写，编排层另有闸。
    async fn verify_remote_object_size(&self, key: &str, expected_size: u64) -> Result<()> {
        match self.stat(key).await? {
            Some(info) if info.size == expected_size => Ok(()),
            Some(info) => {
                let _ = self.delete(key).await;
                Err(AppError::internal(format!(
                    "云端对象上传后大小不一致：本地 {expected_size} 字节，远端 {} 字节，已停止并不得报成功",
                    info.size
                )))
            }
            None => {
                let _ = self.delete(key).await;
                Err(AppError::internal(
                    "云端对象上传后不存在，已停止并不得报成功".to_string(),
                ))
            }
        }
    }

    /// [R09-restore-ops][P2-2] 本后端是否支持断点续传下载。
    ///
    /// 返回 `true` 的后端必须实现 [`Self::get_file_resumable`]；编排层
    /// （`CloudSyncManager::download_with_progress`）只在此方法返回 `true`
    /// 时保留/复用断点文件，否则回退到整文件下载（中断后整包重下，诚实
    /// 但不留断点）。
    fn supports_resumable_download(&self) -> bool {
        false
    }

    /// [R09-restore-ops][P2-2] 断点续传下载：从 `resume_from` 字节处继续，把
    /// 剩余内容**追加**到 `dest`。
    ///
    /// 契约（实现方必须全部满足，违反任何一条都是数据损坏级缺陷）：
    /// - 调用方保证 `dest` 已有恰好 `resume_from` 字节（`resume_from == 0`
    ///   表示全新下载，`dest` 可以不存在）；
    /// - 只允许两种成功形态：从 `resume_from` 精确续传（返回 `resume_from`），
    ///   或服务端不支持范围请求时**从零重下**（截断 `dest` 后重写，返回 0）。
    ///   **禁止**把错位/截断的字节流追加进 `dest` 后报告成功；
    /// - 服务端返回的续传起点与请求不一致时必须失败（fail-closed），
    ///   不得静默接受；
    /// - 传输中断必须返回错误并保持 `dest` 为"前缀完整"的断点文件
    ///   （已写入的字节都是远端对象的正确前缀），供下次续传；
    /// - 返回成功当且仅当 `dest` 的字节数等于远端对象大小。
    ///
    /// 进度回调报告的是**整个对象**的 (已有+新增字节, 总字节)。
    ///
    /// # Returns
    /// 实际续传起点（`resume_from` 或 0），最终完整性由调用方对整个
    /// `dest` 做 SHA256 校验兜底。
    ///
    /// 默认实现 fail-closed：不支持续传的后端明确报错，绝不静默整包重下
    /// 冒充续传。
    async fn get_file_resumable(
        &self,
        key: &str,
        dest: &Path,
        resume_from: u64,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<u64> {
        let _ = (key, dest, resume_from, progress);
        Err(AppError::configuration(
            RESUMABLE_DOWNLOAD_UNSUPPORTED.to_string(),
        ))
    }

    /// 流式下载文件到本地（SOTA 特性）
    ///
    /// # Arguments
    /// * `key` - 远程文件路径
    /// * `local_path` - 本地保存路径
    /// * `expected_checksum` - 可选的期望 SHA256 校验和
    /// * `progress` - 可选的进度回调
    ///
    /// # Returns
    /// 下载文件的 SHA256 校验和
    async fn get_file(
        &self,
        key: &str,
        local_path: &Path,
        expected_checksum: Option<&str>,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<String> {
        use sha2::{Digest, Sha256};
        use std::io::Write;

        // 获取文件大小
        let file_info = self
            .stat(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total_size = file_info.size;

        if let Some(ref cb) = progress {
            cb(0, total_size);
        }

        // 下载文件
        let data = self
            .get(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;

        // [R10-download] 半包 fail-closed：`get` 正常返回不等于下载完整。
        // 无 `expected_checksum` 的调用方（如文件级对象下载）没有第二道防线，
        // 字节数与云端声明不一致（半包，或对象在 stat 与 get 之间被并发替换）
        // 时必须失败，绝不落盘冒充成功。
        if data.len() as u64 != total_size {
            return Err(AppError::network(format!(
                "下载不完整或云端对象已变更：声明 {total_size} 字节，实际收到 {} 字节，已拒绝保存（请重试）",
                data.len()
            )));
        }

        if let Some(ref cb) = progress {
            cb(total_size / 2, total_size);
        }

        // 计算校验和
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let checksum = format!("{:x}", hasher.finalize());

        // 验证校验和
        if let Some(expected) = expected_checksum {
            if checksum != expected {
                return Err(AppError::validation(format!(
                    "校验和不匹配: 期望 {}, 实际 {}",
                    &expected[..8.min(expected.len())],
                    &checksum[..8]
                )));
            }
        }

        // 确保目录存在
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::file_system(format!("创建目录失败: {e}")))?;
        }

        // 写入文件
        let mut file = std::fs::File::create(local_path)
            .map_err(|e| AppError::file_system(format!("创建文件失败: {e}")))?;
        file.write_all(&data)
            .map_err(|e| AppError::file_system(format!("写入文件失败: {e}")))?;

        if let Some(ref cb) = progress {
            cb(total_size, total_size);
        }

        Ok(checksum)
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_memory_get_matches_declared_len;

    #[test]
    fn memory_get_accepts_matching_or_missing_length() {
        assert!(ensure_memory_get_matches_declared_len("S3", "a", 12, Some(12)).is_ok());
        assert!(
            ensure_memory_get_matches_declared_len("WebDAV", "a", 12, None).is_ok(),
            "缺声明长度不得冒充已核，只能诚实收下"
        );
    }

    #[test]
    fn memory_get_rejects_short_body_when_length_declared() {
        let err = ensure_memory_get_matches_declared_len("S3", "changes/1", 4, Some(12))
            .expect_err("声明长度与实收不符必须 fail-closed");
        let msg = err.to_string();
        assert!(msg.contains("内存对象下载不完整或对象已变更"));
        assert!(msg.contains("changes/1"));
    }
}
