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
/// 内存级 `get()` 单块停滞上限，与 `get_file` / 续传路径的 90 秒对齐。
/// 不限制总时长：慢但有进展的变更分片可以继续。不宣称远端 SHA。
pub(crate) const MEMORY_GET_STALL_SECS: u64 = 90;

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

/// [R4-get-budget] 内存 GET 预算命中错误的稳定标记子串。
///
/// 预算超限是确定性拒绝：同一对象重试仍会超限，重试层（如 FTP 的 `with_retry`）
/// 据此短路，避免把超预算对象反复下满多遍。改动本常量必须同步检查所有
/// `contains(MEMORY_GET_BUDGET_EXCEEDED)` 判定点。
pub(crate) const MEMORY_GET_BUDGET_EXCEEDED: &str = "超出调用方内存预算";

/// [R4-get-budget] `get()`（无预算参数的旧入口）的兜底预算：256 MiB。
///
/// 控制对象（manifest / 租约 / tombstone / 变更分片 / delta 元数据 / 写后回读）
/// 必须改走 [`CloudStorage::get_bounded`] 并由调用方传入更紧的硬预算；本常量只
/// 防止旧入口彻底无界，取值刻意大于一切合法控制对象，**不作为安全边界使用**。
/// 数据对象（blob / asset / 备份对象）继续走 `get_file` / 续传路径，与本预算无关。
pub const MEMORY_GET_DEFAULT_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

/// [R4-get-budget] 声明长度预检：远端声明（HTTP Content-Length / FTP SIZE）
/// 超出调用方预算时，在读取任何响应体字节之前拒绝。
/// `None`（chunked 等无声明长度）放行到边收边断的有界缓冲路径，不在这里冒充已核。
pub(crate) fn ensure_declared_len_within_budget(
    provider: &str,
    key: &str,
    declared: Option<u64>,
    max_bytes: u64,
) -> Result<()> {
    match declared {
        Some(expected) if expected > max_bytes => Err(AppError::network(format!(
            "{provider} 内存对象声明长度{MEMORY_GET_BUDGET_EXCEEDED}：{key} 声明 {expected} 字节 > 预算 {max_bytes} 字节，已在读取响应体前拒绝"
        ))),
        _ => Ok(()),
    }
}

/// [R4-get-budget] 累计字节数预算闸（先判后收）。
/// 预算命中返回错误而不是截断数据：绝不把前 `max_bytes` 字节冒充完整对象。
pub(crate) fn ensure_received_within_budget(
    provider: &str,
    key: &str,
    received: u64,
    max_bytes: u64,
) -> Result<()> {
    if received > max_bytes {
        return Err(AppError::network(format!(
            "{provider} 内存对象下载{MEMORY_GET_BUDGET_EXCEEDED}：{key} 累计 {received} 字节 > 预算 {max_bytes} 字节，已中断传输"
        )));
    }
    Ok(())
}

/// [R4-get-budget] 内存 GET 的有界缓冲：`push` 在追加前先判预算，缓冲区占用
/// 永远不超过 `max_bytes`（无声明长度的 chunked 流也一样）。
/// 只负责体积；半包/长包与声明长度的一致性仍由
/// [`ensure_memory_get_matches_declared_len`] 收尾核对，两道闸互不替代。
pub(crate) struct BoundedMemoryBody {
    provider: &'static str,
    key: String,
    max_bytes: u64,
    body: Vec<u8>,
}

impl BoundedMemoryBody {
    pub(crate) fn new(provider: &'static str, key: &str, max_bytes: u64) -> Self {
        Self {
            provider,
            key: key.to_string(),
            max_bytes,
            body: Vec::new(),
        }
    }

    /// 追加一块响应体；预算越界时返回错误且**不**追加（缓冲保持在预算内）。
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<()> {
        let would_be = self.body.len() as u64 + chunk.len() as u64;
        ensure_received_within_budget(self.provider, &self.key, would_be, self.max_bytes)?;
        self.body.extend_from_slice(chunk);
        Ok(())
    }

    pub(crate) fn len(&self) -> u64 {
        self.body.len() as u64
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.body
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

    /// 下载文件（内存级，无预算参数的旧入口）
    ///
    /// [R4-get-budget] 控制对象（manifest / 租约 / tombstone / 变更分片 /
    /// delta 元数据 / 写后回读）必须改用 [`Self::get_bounded`] 并由调用方传入
    /// 硬预算；生产后端的本方法仅以 [`MEMORY_GET_DEFAULT_BUDGET_BYTES`] 兜底，
    /// 防止旧入口完全无界。数据对象走 `get_file` / 续传路径，不走本方法。
    ///
    /// # Arguments
    /// * `key` - 文件路径
    ///
    /// # Returns
    /// * `Ok(Some(data))` - 文件存在，返回内容
    /// * `Ok(None)` - 文件不存在
    /// * `Err(e)` - 其他错误
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;

    /// [R4-get-budget] 带调用方硬预算的内存级下载（控制对象唯一正当入口）。
    ///
    /// 语义契约（生产后端实现必须全部满足）：
    /// - 远端**声明长度**（Content-Length / SIZE）> `max_bytes` → 在读取任何
    ///   响应体字节前拒绝；
    /// - **累计已收字节**将超过 `max_bytes` → 立即中断传输，不再继续收；
    /// - **无声明长度**（chunked 等）→ 有界缓冲边收边计数，缓冲占用永不超过
    ///   `max_bytes`，越界即中断；
    /// - 预算命中返回错误而不是截断数据：绝不把前 `max_bytes` 字节冒充完整对象；
    /// - 不放松既有闸门：按块停滞超时（90 秒）与
    ///   [`ensure_memory_get_matches_declared_len`] 半包收尾核对照旧生效。
    ///
    /// 默认实现是"整包收下后事后核对"的兜底，仅供测试假存储 / 纯内存后端保持
    /// 编译闭合与预算语义（超限同样报错，只是无法在传输中途省流量）；
    /// 真实网络后端（WebDAV / S3 / FTP）必须覆盖为边收边断的实现。
    async fn get_bounded(&self, key: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        match self.get(key).await? {
            Some(data) => {
                ensure_received_within_budget(
                    self.provider_name(),
                    key,
                    data.len() as u64,
                    max_bytes,
                )?;
                Ok(Some(data))
            }
            None => Ok(None),
        }
    }

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

    /// [R4-e2ee-cas] 本后端是否支持「不存在才创建」的条件写（HTTP
    /// `If-None-Match: *` / S3 conditional PUT）。
    ///
    /// 默认 `false`：多数现网 WebDAV / FTP 网关会**静默忽略**条件头，把条件写
    /// 当无条件覆盖执行——这无法在运行时可靠探测（服务器返回 2xx 不代表条件
    /// 生效），因此必须由后端实现经真实服务器验证后显式声明。返回 `true` 的
    /// 后端必须同时实现 [`Self::put_if_absent`]。
    fn supports_conditional_put(&self) -> bool {
        false
    }

    /// [R4-e2ee-cas] 条件创建：`key` 不存在时原子创建并返回 `Ok(true)`；已存在
    /// 时返回 `Ok(false)` 且不得改动远端。
    ///
    /// 默认实现 fail-closed：未声明能力（`supports_conditional_put` = false）
    /// 的后端明确报错。**禁止**用「先 stat 再 put」模拟——那正是本方法要消除
    /// 的 check-then-act 竞态；无法提供原子语义的后端应保持默认，让调用方走
    /// 租约认领协议（`e2ee_claim`）。
    async fn put_if_absent(&self, key: &str, data: &[u8]) -> Result<bool> {
        let _ = (key, data);
        Err(AppError::configuration(format!(
            "云存储后端 {} 不支持条件写（put_if_absent）；调用方应先检查 \
             supports_conditional_put，不支持时改走租约认领协议（e2ee_claim）",
            self.provider_name()
        )))
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

    /// [R5-prove-cost] 本后端是否支持对象前缀读取（[`Self::get_prefix`]）。
    ///
    /// 返回 `true` 的后端必须实现 `get_prefix`；调用方（如上传前的口令首块
    /// 试解）只在此方法返回 `true` 时走前缀读取，否则回退整文件下载路径
    /// （诚实但更贵，行为与历史一致）。
    fn supports_prefix_read(&self) -> bool {
        false
    }

    /// [R5-prove-cost] 读取对象前 `prefix_len` 字节（部分读取，如 DSBK v2
    /// 首块试解只需「头 + 首个密文块」）。
    ///
    /// 契约（实现方必须全部满足）：
    /// - `Ok(Some(bytes))`：`bytes` 是对象的**真实前缀**，长度 =
    ///   `min(prefix_len, 对象总长)`；禁止返回错位/拼接/截断冒充的字节；
    /// - 对象不存在 → `Ok(None)`；
    /// - 通过 HTTP `Range: bytes=0-N` 实现时，若服务端忽略 Range 返回整对象
    ///   （HTTP 200），实现必须在收满 `prefix_len` 字节后**停止消费响应体并
    ///   丢弃连接**，不得把整个对象读进内存、也不得读完再截断；
    /// - `prefix_len == 0` → 直接返回空前缀，不发起网络请求。
    ///
    /// 默认实现 fail-closed：未声明能力（`supports_prefix_read` = false）的
    /// 后端明确报错，绝不静默整包下载冒充前缀读取——调用方应先检查能力位，
    /// 不支持时自行走整文件路径。
    async fn get_prefix(&self, key: &str, prefix_len: u64) -> Result<Option<Vec<u8>>> {
        let _ = (key, prefix_len);
        Err(AppError::configuration(format!(
            "云存储后端 {} 不支持对象前缀读取（get_prefix）；调用方应先检查 \
             supports_prefix_read，不支持时回退整文件下载路径",
            self.provider_name()
        )))
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
    use super::{
        ensure_declared_len_within_budget, ensure_memory_get_matches_declared_len,
        BoundedMemoryBody, CloudStorage, FileInfo, Result, MEMORY_GET_BUDGET_EXCEEDED,
    };

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

    // ============ [R4-get-budget] GET 预算回归（三类形态） ============

    /// 形态一：持续小块灌满超限——服务端用小块把响应体持续灌大，
    /// 必须在累计越界的那一块被中断，且缓冲占用永远不超过预算。
    #[test]
    fn get_budget_small_chunks_flooding_aborts_and_buffer_stays_bounded() {
        const BUDGET: u64 = 1_000;
        let mut body = BoundedMemoryBody::new("S3", "manifests/flood.json", BUDGET);
        let chunk = [0x42u8; 100];

        for i in 0..10 {
            body.push(&chunk)
                .unwrap_or_else(|e| panic!("预算内第 {i} 块不得报错: {e}"));
            assert!(body.len() <= BUDGET, "缓冲占用不得超过预算");
        }
        assert_eq!(body.len(), BUDGET, "恰好灌满预算仍属合法");

        let err = body
            .push(&chunk)
            .expect_err("累计越界的这一块必须中断，不得继续收");
        let msg = err.to_string();
        assert!(
            msg.contains(MEMORY_GET_BUDGET_EXCEEDED),
            "错误必须带预算标记: {msg}"
        );
        assert!(
            msg.contains("manifests/flood.json"),
            "错误必须点名对象: {msg}"
        );
        assert_eq!(
            body.len(),
            BUDGET,
            "越界块不得被追加进缓冲，缓冲保持在预算内"
        );
    }

    /// 形态二：超大 Content-Length——声明长度超预算必须在读任何响应体字节前拒绝。
    #[test]
    fn get_budget_rejects_oversized_declared_length_before_body() {
        const BUDGET: u64 = 4_096;

        let err =
            ensure_declared_len_within_budget("WebDAV", "changes/huge.bin", Some(u64::MAX), BUDGET)
                .expect_err("声明 u64::MAX 字节必须先拒不读 body");
        let msg = err.to_string();
        assert!(
            msg.contains(MEMORY_GET_BUDGET_EXCEEDED),
            "错误必须带预算标记: {msg}"
        );
        assert!(
            msg.contains("读取响应体前"),
            "必须表明在读 body 前拒绝: {msg}"
        );

        let err = ensure_declared_len_within_budget("S3", "k", Some(BUDGET + 1), BUDGET)
            .expect_err("声明刚好越界 1 字节也必须拒");
        assert!(err.to_string().contains(MEMORY_GET_BUDGET_EXCEEDED));

        assert!(
            ensure_declared_len_within_budget("S3", "k", Some(BUDGET), BUDGET).is_ok(),
            "声明恰好等于预算属合法"
        );
    }

    /// 形态三：无声明长度的流式超限——chunked 响应无 Content-Length 时预检必须放行，
    /// 由有界缓冲边收边断，越界即中断。
    #[test]
    fn get_budget_unknown_length_stream_aborts_over_budget() {
        const BUDGET: u64 = 256;
        assert!(
            ensure_declared_len_within_budget("WebDAV", "chunked/no-len", None, BUDGET).is_ok(),
            "无声明长度不得在预检层拒绝（那是有界缓冲的职责）"
        );

        let mut body = BoundedMemoryBody::new("WebDAV", "chunked/no-len", BUDGET);
        body.push(&[0u8; 200]).expect("预算内应收下");
        let err = body
            .push(&[0u8; 200])
            .expect_err("无声明长度的流累计越界必须中断");
        assert!(err.to_string().contains(MEMORY_GET_BUDGET_EXCEEDED));
        assert!(body.len() <= BUDGET, "越界后缓冲不得超过预算");
    }

    /// 测试假存储走 trait 默认 `get_bounded`：不改任何 mock 也能获得预算语义
    /// （整包收下后事后核对，超限报错、预算内放行、not-found 透传）。
    struct FixedBodyStorage {
        body: Vec<u8>,
        exists: bool,
    }

    #[async_trait::async_trait]
    impl CloudStorage for FixedBodyStorage {
        fn provider_name(&self) -> &'static str {
            "fixed-body-test"
        }
        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }
        async fn put(&self, _key: &str, _data: &[u8]) -> Result<()> {
            Ok(())
        }
        async fn get(&self, _key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.exists.then(|| self.body.clone()))
        }
        async fn list(&self, _prefix: &str) -> Result<Vec<FileInfo>> {
            Ok(Vec::new())
        }
        async fn delete(&self, _key: &str) -> Result<()> {
            Ok(())
        }
        async fn stat(&self, _key: &str) -> Result<Option<FileInfo>> {
            Ok(None)
        }
    }

    /// [R5-prove-cost] 未声明前缀读取能力的后端：能力位默认 false，
    /// `get_prefix` 默认实现必须 fail-closed，绝不静默整包下载冒充前缀。
    #[tokio::test]
    async fn default_get_prefix_fails_closed() {
        let storage = FixedBodyStorage {
            body: vec![7u8; 512],
            exists: true,
        };
        assert!(!storage.supports_prefix_read(), "默认必须不声明能力");
        let err = storage
            .get_prefix("backups/x.zip", 64)
            .await
            .expect_err("默认 get_prefix 必须明确报错");
        assert!(
            err.to_string().contains("不支持对象前缀读取"),
            "错误应指明能力缺失与回退方向: {err}"
        );
    }

    #[tokio::test]
    async fn default_get_bounded_enforces_budget_for_test_doubles() {
        let storage = FixedBodyStorage {
            body: vec![7u8; 512],
            exists: true,
        };

        let data = storage
            .get_bounded("k", 512)
            .await
            .expect("预算内必须成功")
            .expect("对象存在");
        assert_eq!(data.len(), 512);

        let err = storage
            .get_bounded("k", 511)
            .await
            .expect_err("超预算必须报错，不得截断冒充完整对象");
        assert!(err.to_string().contains(MEMORY_GET_BUDGET_EXCEEDED));

        let missing = FixedBodyStorage {
            body: Vec::new(),
            exists: false,
        };
        assert!(
            missing
                .get_bounded("k", 1)
                .await
                .expect("not-found 不是错误")
                .is_none(),
            "不存在的对象必须透传 Ok(None)"
        );
    }
}
