//! S3 兼容存储实现
//!
//! 支持 AWS S3、Cloudflare R2、阿里云 OSS、MinIO 等 S3 兼容服务
//!
//! 需要启用 `cloud_storage_s3` feature

#![cfg(feature = "cloud_storage_s3")]

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::config::S3Config;
use super::traits::{
    ensure_declared_len_within_budget, ensure_memory_get_matches_declared_len, BoundedMemoryBody,
    CloudStorage, DownloadProgressCallback, FileInfo, Result, UploadProgressCallback, CHUNK_SIZE,
    MEMORY_GET_DEFAULT_BUDGET_BYTES, MEMORY_GET_STALL_SECS, MIN_MULTIPART_SIZE,
};
use crate::models::AppError;

/// S3 multipart 上传的分块数硬限制（AWS 及主流兼容服务通用）
const MAX_MULTIPART_PARTS: u64 = 10_000;
/// 单次 `put_file` 内每个 multipart 分块的瞬时失败重试次数（含首次）。
/// 不跨进程、不跨对象，不是增量传输。
const MULTIPART_PART_ATTEMPTS: u32 = 3;
/// 未完成 multipart 的陈旧宽限期。短于此时长的 in-progress 上传可能属于
/// 另一台设备正在传同一内容寻址对象，不得 abort。进程崩溃留下的孤儿
/// 下次对同一 key 再传时才会清。不是跨会话续传，也不是增量传输。
const MULTIPART_STALE_SECS: i64 = 6 * 3600;

/// S3 单个分块大小硬限制：5 GiB
const MAX_PART_SIZE: u64 = 5 * 1024 * 1024 * 1024;

/// 上传前根据文件大小规划 multipart 分块大小。
///
/// 默认使用 `CHUNK_SIZE`（8MiB）；当文件大到 10000 个默认分块装不下时
///（约 78GiB 以上），按比例放大分块并向上对齐到 MiB，确保分块数不超过
/// `MAX_MULTIPART_PARTS`——否则会在上传数十 GB 后才在第 10001 块失败。
/// 超出 S3 极限（10000 × 5GiB）的文件在发起任何网络请求前直接报错。
fn plan_multipart_part_size(file_size: u64) -> Result<usize> {
    const MIB: u64 = 1024 * 1024;
    let min_part = file_size.div_ceil(MAX_MULTIPART_PARTS);
    let part_size = (CHUNK_SIZE as u64).max(min_part.div_ceil(MIB) * MIB);
    if part_size > MAX_PART_SIZE {
        return Err(AppError::validation(format!(
            "文件过大（{file_size} 字节）：即使使用 5GiB 分块也会超过 S3 的 10000 分块限制"
        )));
    }
    Ok(part_size as usize)
}

/// 按给定分块大小计算分块总数（上传前预估用）
fn planned_part_count(file_size: u64, part_size: usize) -> u64 {
    file_size.div_ceil(part_size as u64).max(1)
}

/// S3 兼容存储实现
pub struct S3Storage {
    client: aws_sdk_s3::Client,
    endpoint: String,
    bucket: String,
    root: String,
}

impl S3Storage {
    /// [#57] 归一化用户填写的 S3 endpoint。
    ///
    /// 腾讯云 COS / 阿里云 OSS / 缤纷云 S4 等控制台展示给用户的是
    /// **带 bucket 前缀的访问域名**（如 `https://mybucket.cos.ap-beijing.myqcloud.com`、
    /// `https://mybucket.oss-cn-hangzhou.aliyuncs.com`、`https://mybucket.s3.bitiful.net`）。
    /// 用户把它原样粘贴进 endpoint 并单独填写 bucket 后，SDK 的
    /// virtual-hosted-style 寻址会再拼一次 bucket，产生
    /// `mybucket.mybucket.cos…` 这样的域名，DNS 解析/TLS 证书直接失败，
    /// 表现为"S3 存储无法被识别"。
    ///
    /// 归一化规则（全部是纯字符串变换，不发网络请求）：
    /// 1. 去除首尾空白与尾部 `/`；
    /// 2. 缺少 scheme 时补 `https://`（控制台复制的域名通常不带 scheme）；
    /// 3. 仅当 host 是已知 provider 的 `{bucket}.{service-host}` 形式时剥离 bucket，
    ///    交由 SDK 重新拼接。自建域名和 path-style endpoint 不做猜测性改写。
    ///
    /// 未触发第 3 条时原样返回（仅做 trim/补 scheme），确保已能工作的配置
    /// 的 endpoint 字符串与 instance_binding_hint 完全不变。
    fn normalize_endpoint(endpoint: &str, bucket: &str) -> String {
        let trimmed = endpoint.trim().trim_end_matches('/');
        let with_scheme = if trimmed.contains("://") {
            trimmed.to_string()
        } else {
            format!("https://{trimmed}")
        };

        let bucket = bucket.trim();
        if bucket.is_empty() {
            return with_scheme;
        }
        let Ok(mut url) = url::Url::parse(&with_scheme) else {
            return with_scheme;
        };

        // 只识别 provider 明确定义的 bucket-host 域名。不能仅凭首段等于 bucket
        // 判断，否则 bucket 名为 "s3" 时会把规范 AWS endpoint
        // `s3.us-east-1.amazonaws.com` 错改为 `us-east-1.amazonaws.com`。
        // path-style endpoint 的 bucket 路径属于用户配置，同样不做猜测性剥离。
        if let Some(url::Host::Domain(host)) = url.host() {
            let host = host.to_string();
            if let Some(rest) = host.strip_prefix(&format!("{bucket}.")) {
                if Self::is_known_provider_service_host(rest) && url.set_host(Some(rest)).is_ok() {
                    tracing::info!(
                        "[CloudStorage::S3] endpoint 中检测到 bucket 前缀域名，已归一化为服务端点: {} -> {}",
                        host,
                        rest
                    );
                    return url.to_string().trim_end_matches('/').to_string();
                }
            }
        }

        with_scheme
    }

    fn is_known_provider_service_host(host: &str) -> bool {
        let labels = host.split('.').collect::<Vec<_>>();
        match labels.as_slice() {
            // 腾讯云 COS: cos.<region>.myqcloud.com
            ["cos", region, "myqcloud", "com"] => !region.is_empty(),
            // 阿里云 OSS: oss-<region>.aliyuncs.com
            [service, "aliyuncs", "com"] => service
                .strip_prefix("oss-")
                .is_some_and(|region| !region.is_empty()),
            // 缤纷云 S4
            ["s3", "bitiful", "net"] => true,
            // AWS S3 global/regional endpoint.
            ["s3", "amazonaws", "com"] => true,
            ["s3", region, "amazonaws", "com"] => !region.is_empty(),
            [service, "amazonaws", "com"] => service
                .strip_prefix("s3-")
                .is_some_and(|region| !region.is_empty()),
            _ => false,
        }
    }

    /// 创建 S3 存储实例
    pub async fn new(config: S3Config, root: String) -> Result<Self> {
        if config.endpoint.trim().is_empty() {
            return Err(AppError::validation("S3 endpoint 不能为空"));
        }
        if config.bucket.trim().is_empty() {
            return Err(AppError::validation("S3 bucket 不能为空"));
        }

        let endpoint = Self::normalize_endpoint(&config.endpoint, &config.bucket);

        // 构建凭证提供者
        let credentials = aws_sdk_s3::config::Credentials::new(
            &config.access_key_id,
            &config.secret_access_key,
            None, // session token
            None, // expiry
            "cloud_storage",
        );

        let mut s3_config_builder = aws_sdk_s3::Config::builder()
            .credentials_provider(credentials)
            .endpoint_url(&endpoint)
            .timeout_config(
                // [P0-6/F10] 显式超时：避免 TCP 半开/对端无响应时整个同步流程无限挂起。
                // connect 30s 建连上限；operation_attempt 120s 单次尝试上限。该值必须与
                // MIN_MULTIPART_SIZE 配套：阈值以下的单次 PUT 整个请求共用一个 120s 计时
                //（16MiB 只需约 1.1Mbps 上行即可完成）；阈值以上走 multipart，每个分块
                // 各自计时，不受单请求总时长限制。
                aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                    .connect_timeout(std::time::Duration::from_secs(30))
                    .operation_attempt_timeout(std::time::Duration::from_secs(120))
                    .build(),
            )
            // [#57] behavior_version_latest 默认对所有 PutObject 附加 CRC32 校验和头，
            // 腾讯云 COS、阿里云 OSS、部分 MinIO 等 S3 兼容服务不支持，会直接报错或静默失败。
            // WhenRequired = 仅在 API 强制要求时才计算（与旧版 SDK 行为一致），对 AWS 官方 S3 无副作用。
            .request_checksum_calculation(
                aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
            )
            .response_checksum_validation(
                aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
            )
            .behavior_version_latest();

        // 设置区域（如果指定）
        if let Some(region) = &config.region {
            s3_config_builder =
                s3_config_builder.region(aws_sdk_s3::config::Region::new(region.clone()));
        } else {
            // 默认使用 us-east-1（某些 S3 兼容服务需要）
            s3_config_builder =
                s3_config_builder.region(aws_sdk_s3::config::Region::new("us-east-1"));
        }

        if config.path_style {
            s3_config_builder = s3_config_builder.force_path_style(true);
        }

        let s3_config = s3_config_builder.build();
        let client = aws_sdk_s3::Client::from_conf(s3_config);

        Ok(Self {
            client,
            endpoint,
            bucket: config.bucket,
            root: root.trim_matches('/').to_string(),
        })
    }

    /// 构建完整的对象 key
    fn full_key(&self, key: &str) -> String {
        let key = key.trim_start_matches('/');
        if self.root.is_empty() {
            key.to_string()
        } else {
            format!("{}/{}", self.root, key)
        }
    }

    /// 从完整 key 中提取相对 key
    fn relative_key(&self, full_key: &str) -> String {
        let prefix = if self.root.is_empty() {
            String::new()
        } else {
            format!("{}/", self.root)
        };

        if full_key.starts_with(&prefix) {
            full_key[prefix.len()..].to_string()
        } else {
            full_key.to_string()
        }
    }

    /// 解析 `Content-Range: bytes <start>-<end>/<total>` 的起点。
    /// 无法解析（含 `bytes */<total>`）返回 `None`，由调用方 fail-closed。
    fn parse_content_range_start(raw: &str) -> Option<u64> {
        let rest = raw.trim().strip_prefix("bytes")?.trim_start();
        let (start, _) = rest.split_once('-')?;
        start.trim().parse::<u64>().ok()
    }

    /// 根据 S3 `Content-Range` 决定实际写入起点。
    /// 缺字段视为服务端忽略 Range，诚实从零重下；起点不一致 fail-closed。
    fn resume_actual_start(resume_from: u64, content_range: Option<&str>) -> Result<u64> {
        match content_range {
            None => Ok(0),
            Some(header) => match Self::parse_content_range_start(header) {
                Some(start) if start == resume_from => Ok(start),
                _ => Err(AppError::network(format!(
                    "S3 服务端返回的续传起点与请求不一致（fail-closed，拒绝错位追加）：请求 bytes={resume_from}-，Content-Range={header:?}"
                ))),
            },
        }
    }

    /// 缺 `Initiated` 不当陈旧（兼容服务可能省略），避免误杀进行中的上传。
    fn multipart_upload_is_stale(initiated_epoch_secs: Option<i64>, now_epoch_secs: i64) -> bool {
        initiated_epoch_secs
            .is_some_and(|ts| now_epoch_secs.saturating_sub(ts) >= MULTIPART_STALE_SECS)
    }

    /// 中止同一 key 上已超过宽限期的未完成 multipart。
    /// 列举/中止失败只记日志，不得阻断本次上传。不宣称跨会话续传。
    async fn abort_stale_multipart_uploads(&self, full_key: &str) {
        let now_epoch_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let mut key_marker: Option<String> = None;
        let mut upload_id_marker: Option<String> = None;
        loop {
            let mut request = self
                .client
                .list_multipart_uploads()
                .bucket(&self.bucket)
                .prefix(full_key);
            if let Some(marker) = key_marker.take() {
                request = request.key_marker(marker);
            }
            if let Some(marker) = upload_id_marker.take() {
                request = request.upload_id_marker(marker);
            }
            let output = match request.send().await {
                Ok(output) => output,
                Err(e) => {
                    tracing::warn!(
                        "[CloudStorage::S3] 列举未完成 multipart 失败（不阻断本次上传）: {e}"
                    );
                    return;
                }
            };
            for upload in output.uploads() {
                if upload.key() != Some(full_key) {
                    continue;
                }
                let Some(upload_id) = upload.upload_id() else {
                    continue;
                };
                let initiated = upload.initiated().map(|ts| ts.secs());
                if !Self::multipart_upload_is_stale(initiated, now_epoch_secs) {
                    continue;
                }
                if let Err(e) = self
                    .client
                    .abort_multipart_upload()
                    .bucket(&self.bucket)
                    .key(full_key)
                    .upload_id(upload_id)
                    .send()
                    .await
                {
                    tracing::warn!(
                        "[CloudStorage::S3] 中止陈旧 multipart 失败 key={full_key}: {e}"
                    );
                } else {
                    tracing::info!(
                        "[CloudStorage::S3] 已中止陈旧 multipart key={full_key} upload_id={upload_id}"
                    );
                }
            }
            if output.is_truncated() != Some(true) {
                break;
            }
            key_marker = output.next_key_marker().map(str::to_string);
            upload_id_marker = output.next_upload_id_marker().map(str::to_string);
            if key_marker.is_none() {
                break;
            }
        }
    }

    /// 同一 `put_file` 内重试失败分块。不保存 upload_id，中断后仍整对象重传。
    async fn upload_part_with_retry(
        &self,
        full_key: &str,
        upload_id: &str,
        part_number: i32,
        chunk: &[u8],
    ) -> Result<String> {
        let mut last_err = None;
        for attempt in 1..=MULTIPART_PART_ATTEMPTS {
            let body = aws_sdk_s3::primitives::ByteStream::from(chunk.to_vec());
            match self
                .client
                .upload_part()
                .bucket(&self.bucket)
                .key(full_key)
                .upload_id(upload_id)
                .part_number(part_number)
                .body(body)
                .send()
                .await
            {
                Ok(output) => {
                    return output
                        .e_tag()
                        .map(str::to_string)
                        .ok_or_else(|| AppError::internal("S3 分块上传未返回 ETag"));
                }
                Err(e) => {
                    if attempt < MULTIPART_PART_ATTEMPTS {
                        tracing::warn!(
                            "[CloudStorage::S3] 分块 {part_number} 第 {attempt}/{MULTIPART_PART_ATTEMPTS} 次失败，将重试同一分块: {e}"
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1)))
                            .await;
                    }
                    last_err = Some(e);
                }
            }
        }
        Err(AppError::network(format!(
            "S3 分块上传失败（已重试 {MULTIPART_PART_ATTEMPTS} 次）: {}",
            last_err.expect("至少尝试一次")
        )))
    }
}

#[async_trait]
impl CloudStorage for S3Storage {
    fn provider_name(&self) -> &'static str {
        "S3"
    }

    fn instance_binding_hint(&self) -> String {
        format!(
            "s3|endpoint={}|bucket={}|root={}",
            self.endpoint, self.bucket, self.root
        )
    }

    async fn check_connection(&self) -> Result<()> {
        // 尝试 HEAD bucket 检查连接
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 连接检测失败: {e}")))?;
        Ok(())
    }

    async fn put_file(
        &self,
        key: &str,
        local_path: &Path,
        progress: Option<UploadProgressCallback>,
    ) -> Result<String> {
        let metadata = std::fs::metadata(local_path)
            .map_err(|e| AppError::file_system(format!("读取文件元信息失败: {e}")))?;
        let file_size = metadata.len();
        let full_key = self.full_key(key);

        let progress: Option<std::sync::Arc<UploadProgressCallback>> =
            progress.map(std::sync::Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(0, file_size);
        }

        if file_size < MIN_MULTIPART_SIZE {
            let checksum = tokio::task::spawn_blocking({
                let path = local_path.to_path_buf();
                move || crate::backup_common::calculate_file_hash(&path)
            })
            .await
            .map_err(|e| AppError::internal(format!("计算校验和任务失败: {e}")))??;

            let body = aws_sdk_s3::primitives::ByteStream::from_path(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("读取文件失败: {e}")))?;
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .body(body)
                .send()
                .await
                .map_err(|e| AppError::network(format!("S3 上传失败: {e}")))?;
            if let Some(cb) = progress.as_ref() {
                cb(file_size, file_size);
            }
            self.verify_remote_object_size(key, file_size).await?;
            return Ok(checksum);
        }

        // 上传前先规划分块大小并校验分块数：超大文件（>78GiB）自动放大分块，
        // 超出 S3 极限的文件直接拒绝，避免传完几十 GB 才发现超过 10000 分块。
        let part_size = plan_multipart_part_size(file_size)?;
        let planned_parts = planned_part_count(file_size, part_size);
        log::debug!(
            "[CloudStorage::S3] multipart 上传 {full_key}: {file_size} 字节，计划 {planned_parts} 块 × {part_size} 字节"
        );
        self.abort_stale_multipart_uploads(&full_key).await;

        let create_resp = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(&full_key)
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 创建分块上传失败: {e}")))?;

        let upload_id = create_resp
            .upload_id()
            .ok_or_else(|| AppError::internal("S3 分块上传未返回 upload_id"))?
            .to_string();

        let upload_result: Result<String> = async {
            let mut file = tokio::fs::File::open(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("打开文件失败: {e}")))?;
            let mut hasher = Sha256::new();
            let mut completed_parts = Vec::new();
            let mut part_number: i32 = 1;
            let mut uploaded = 0u64;
            let mut buffer = vec![0u8; part_size];

            loop {
                let mut bytes_read = 0usize;
                while bytes_read < part_size {
                    let n = file
                        .read(&mut buffer[bytes_read..])
                        .await
                        .map_err(|e| AppError::file_system(format!("读取文件失败: {e}")))?;
                    if n == 0 {
                        break;
                    }
                    bytes_read += n;
                }

                if bytes_read == 0 {
                    break;
                }
                // 兜底防御：正常情况下 plan_multipart_part_size 已保证不会超限，
                // 仅当文件在上传期间被写入变大时才可能触发。
                if part_number as u64 > MAX_MULTIPART_PARTS {
                    return Err(AppError::validation(
                        "S3 分块数超过 10000 的限制（文件可能在上传期间被修改变大）",
                    ));
                }

                let chunk = &buffer[..bytes_read];
                hasher.update(chunk);

                let etag = self
                    .upload_part_with_retry(&full_key, &upload_id, part_number, chunk)
                    .await?;
                completed_parts.push(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .set_part_number(Some(part_number))
                        .set_e_tag(Some(etag))
                        .build(),
                );

                uploaded += bytes_read as u64;
                if let Some(cb) = progress.as_ref() {
                    cb(uploaded, file_size);
                }
                part_number += 1;
            }

            let completed = aws_sdk_s3::types::CompletedMultipartUpload::builder()
                .set_parts(Some(completed_parts))
                .build();
            self.client
                .complete_multipart_upload()
                .bucket(&self.bucket)
                .key(&full_key)
                .upload_id(&upload_id)
                .multipart_upload(completed)
                .send()
                .await
                .map_err(|e| AppError::network(format!("S3 完成分块上传失败: {e:?}")))?;

            Ok(format!("{:x}", hasher.finalize()))
        }
        .await;

        if let Err(err) = upload_result {
            let _ = self
                .client
                .abort_multipart_upload()
                .bucket(&self.bucket)
                .key(&full_key)
                .upload_id(&upload_id)
                .send()
                .await;
            return Err(err);
        }

        if let Some(cb) = progress.as_ref() {
            cb(file_size, file_size);
        }
        let checksum = upload_result?;
        self.verify_remote_object_size(key, file_size).await?;
        Ok(checksum)
    }

    async fn get_file(
        &self,
        key: &str,
        local_path: &Path,
        expected_checksum: Option<&str>,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<String> {
        let info = self
            .stat(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total_size = info.size;
        let progress: Option<std::sync::Arc<DownloadProgressCallback>> =
            progress.map(std::sync::Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(0, total_size);
        }

        let parent = local_path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        let temp_path = tempfile::Builder::new()
            .prefix(".download-")
            .tempfile_in(parent)
            .map_err(|e| AppError::file_system(format!("创建临时下载文件失败: {e}")))?
            .into_temp_path();

        let full_key = self.full_key(key);
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 下载失败: {e}")))?;

        let mut reader = output.body.into_async_read();
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];

        {
            let mut file = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("创建文件失败: {e}")))?;

            loop {
                let bytes_read = reader
                    .read(&mut buffer)
                    .await
                    .map_err(|e| AppError::network(format!("读取 S3 响应失败: {e}")))?;
                if bytes_read == 0 {
                    break;
                }
                let chunk = &buffer[..bytes_read];
                file.write_all(chunk)
                    .await
                    .map_err(|e| AppError::file_system(format!("写入文件失败: {e}")))?;
                hasher.update(chunk);
                downloaded += bytes_read as u64;
                if let Some(cb) = progress.as_ref() {
                    cb(downloaded, total_size);
                }
            }
            file.flush()
                .await
                .map_err(|e| AppError::file_system(format!("刷新文件失败: {e}")))?;
            file.sync_all()
                .await
                .map_err(|e| AppError::file_system(format!("同步文件失败: {e}")))?;
        }

        // [R10-download] 半包 fail-closed：响应流读到 EOF 不等于下载完成。
        // 流提前结束（半包）或对象在 stat 与 GET 之间被并发替换（大小不同）
        // 都在此拒绝——无 expected_checksum 的调用方没有第二道防线。
        if downloaded != total_size {
            return Err(AppError::network(format!(
                "S3 下载不完整或对象已变更：声明 {total_size} 字节，实际收到 {downloaded} 字节，已拒绝保存（请重试）"
            )));
        }

        let checksum = format!("{:x}", hasher.finalize());
        if let Some(expected) = expected_checksum {
            if expected != checksum {
                return Err(AppError::validation(format!(
                    "校验失败：期望 {}, 实际 {}",
                    expected, checksum
                )));
            }
        }
        temp_path
            .persist(local_path)
            .map_err(|e| AppError::file_system(format!("保存下载文件失败: {}", e.error)))?;
        Ok(checksum)
    }

    fn supports_resumable_download(&self) -> bool {
        true
    }

    /// 基于 S3 Range GET 的断点续传。语义对齐 WebDAV：
    /// 精确 `Content-Range` 追加；缺字段当忽略 Range 从零重下；错位 fail-closed。
    async fn get_file_resumable(
        &self,
        key: &str,
        dest: &Path,
        resume_from: u64,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<u64> {
        let info = self
            .stat(key)
            .await?
            .ok_or_else(|| AppError::not_found("云端文件不存在"))?;
        let total_size = info.size;
        if resume_from > total_size {
            return Err(AppError::validation(format!(
                "本地断点（{resume_from} 字节）大于云端对象（{total_size} 字节），断点无效，请删除断点文件后整包重新下载"
            )));
        }
        let progress: Option<std::sync::Arc<DownloadProgressCallback>> =
            progress.map(std::sync::Arc::from);
        if let Some(cb) = progress.as_ref() {
            cb(resume_from, total_size);
        }
        if resume_from == total_size {
            return Ok(resume_from);
        }

        let full_key = self.full_key(key);
        let mut request = self.client.get_object().bucket(&self.bucket).key(&full_key);
        if resume_from > 0 {
            request = request.range(format!("bytes={resume_from}-"));
        }
        let output = request
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 续传下载失败: {e}")))?;
        let actual_start = Self::resume_actual_start(resume_from, output.content_range())?;
        if actual_start == 0 && resume_from > 0 {
            tracing::warn!(
                "S3 服务端未按 Range 续传（无匹配 Content-Range），已丢弃本地断点从零重下: {}",
                key
            );
        }

        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        let mut file = if actual_start > 0 {
            let file = tokio::fs::OpenOptions::new()
                .append(true)
                .open(dest)
                .await
                .map_err(|e| AppError::file_system(format!("打开断点文件失败: {e}")))?;
            let existing = file
                .metadata()
                .await
                .map_err(|e| AppError::file_system(format!("读取断点文件元信息失败: {e}")))?
                .len();
            if existing != actual_start {
                return Err(AppError::file_system(format!(
                    "断点文件大小（{existing} 字节）与续传起点（{actual_start} 字节）不一致，拒绝错位追加"
                )));
            }
            file
        } else {
            tokio::fs::File::create(dest)
                .await
                .map_err(|e| AppError::file_system(format!("创建下载文件失败: {e}")))?
        };

        let mut reader = output.body.into_async_read();
        let mut written = actual_start;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let bytes_read =
                tokio::time::timeout(std::time::Duration::from_secs(90), reader.read(&mut buffer))
                    .await
                    .map_err(|_| {
                        AppError::network(
                    "S3 续传下载停滞超过 90 秒，连接可能已断开（已写入的断点保留，可重试续传）"
                        .to_string(),
                )
                    })?
                    .map_err(|e| AppError::network(format!("读取 S3 响应失败: {e}")))?;
            if bytes_read == 0 {
                break;
            }
            let chunk = &buffer[..bytes_read];
            if written + bytes_read as u64 > total_size {
                return Err(AppError::validation(format!(
                    "云端对象返回超过声明大小（{total_size} 字节）的数据，拒绝写入（对象可能已被并发修改）"
                )));
            }
            file.write_all(chunk)
                .await
                .map_err(|e| AppError::file_system(format!("写入文件失败: {e}")))?;
            written += bytes_read as u64;
            if let Some(cb) = progress.as_ref() {
                cb(written, total_size);
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::file_system(format!("刷新文件失败: {e}")))?;
        file.sync_all()
            .await
            .map_err(|e| AppError::file_system(format!("同步文件失败: {e}")))?;

        if written != total_size {
            return Err(AppError::network(format!(
                "S3 下载在 {written}/{total_size} 字节处中断（已写入的断点保留，可重试续传）"
            )));
        }
        Ok(actual_start)
    }

    fn supports_prefix_read(&self) -> bool {
        true
    }

    /// [R5-prove-cost] 基于 S3 Range GET 的对象前缀读取（`bytes=0-{prefix_len-1}`）。
    ///
    /// 诚实语义对齐 WebDAV：
    /// - 返回 `Content-Range` 时校验起点必须为 0（错位 fail-closed）；
    /// - 服务端忽略 Range（无 `Content-Range`，整对象响应）时只消费前
    ///   `prefix_len` 字节后停止读取并丢弃连接，不整包读入内存；
    /// - `NoSuchKey` → `Ok(None)`。
    async fn get_prefix(&self, key: &str, prefix_len: u64) -> Result<Option<Vec<u8>>> {
        if prefix_len == 0 {
            return Ok(Some(Vec::new()));
        }
        let full_key = self.full_key(key);
        let result = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .range(format!("bytes=0-{}", prefix_len - 1))
            .send()
            .await;
        let output = match result {
            Ok(output) => output,
            Err(e) => {
                let service_error = e.into_service_error();
                if service_error.is_no_such_key() {
                    return Ok(None);
                }
                return Err(AppError::network(format!(
                    "S3 前缀读取失败: {service_error}"
                )));
            }
        };

        // 起点必须是 0：错位前缀比失败更危险（试解结论会失真）。
        // 无 Content-Range = 服务端忽略 Range 返回整对象，起点即 0，合法。
        if let Some(content_range) = output.content_range() {
            match Self::parse_content_range_start(content_range) {
                Some(0) => {}
                _ => {
                    return Err(AppError::network(format!(
                        "S3 服务端返回的前缀起点不是 0（fail-closed，拒绝错位字节）：\
                         请求 bytes=0-，Content-Range={content_range:?}"
                    )));
                }
            }
        }

        // 有界缓冲：只收前 prefix_len 字节；预分配封顶 8 MiB，防御异常大的
        // prefix_len 造成一次性大分配（正常首块试解 ≈ 1 MiB + 60 B）。
        let mut reader = output.body.into_async_read();
        let mut prefix: Vec<u8> =
            Vec::with_capacity(usize::try_from(prefix_len.min(8 * 1024 * 1024)).unwrap_or(0));
        let mut buffer = vec![0u8; 64 * 1024];
        while (prefix.len() as u64) < prefix_len {
            let bytes_read =
                tokio::time::timeout(std::time::Duration::from_secs(90), reader.read(&mut buffer))
                    .await
                    .map_err(|_| {
                        AppError::network("S3 前缀读取停滞超过 90 秒，连接可能已断开".to_string())
                    })?
                    .map_err(|e| AppError::network(format!("读取 S3 响应失败: {e}")))?;
            if bytes_read == 0 {
                break; // 对象比 prefix_len 短：诚实返回实际前缀
            }
            let need = usize::try_from(prefix_len - prefix.len() as u64)
                .unwrap_or(usize::MAX)
                .min(bytes_read);
            prefix.extend_from_slice(&buffer[..need]);
        }
        // 收满即返回；reader/连接随作用域丢弃，剩余响应体不再消费。
        Ok(Some(prefix))
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
        let full_key = self.full_key(key);

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .body(aws_sdk_s3::primitives::ByteStream::from(data.to_vec()))
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 上传失败: {e}")))?;

        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        // [R4-get-budget] 无预算旧入口：仅兜底默认预算，防止彻底无界。
        // 控制对象请改走 get_bounded 并由调用方传入硬预算。
        self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES).await
    }

    async fn get_bounded(&self, key: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        let full_key = self.full_key(key);

        let result = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .send()
            .await;

        match result {
            Ok(output) => {
                let declared = output.content_length().and_then(|n| u64::try_from(n).ok());
                // [R4-get-budget] 声明长度超预算：先拒，不读任何响应体字节
                //（连接随 output/body 丢弃而中止）。
                ensure_declared_len_within_budget("S3", key, declared, max_bytes)?;
                let mut reader = output.body.into_async_read();
                // [R4-get-budget] 无/负 content_length 折叠为 None 后走有界缓冲：
                // 累计将越界的那一块立即断流，缓冲占用永不超过预算。
                let mut body = BoundedMemoryBody::new("S3", key, max_bytes);
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    let n = tokio::time::timeout(
                        std::time::Duration::from_secs(MEMORY_GET_STALL_SECS),
                        reader.read(&mut buffer),
                    )
                    .await
                    .map_err(|_| {
                        AppError::network(
                            "S3 内存对象下载停滞超过 90 秒，连接可能已断开".to_string(),
                        )
                    })?
                    .map_err(|e| AppError::network(format!("S3 读取响应体失败: {e}")))?;
                    if n == 0 {
                        break;
                    }
                    body.push(&buffer[..n])?;
                }
                ensure_memory_get_matches_declared_len("S3", key, body.len(), declared)?;
                Ok(Some(body.into_bytes()))
            }
            Err(e) => {
                // 检查是否是 NoSuchKey 错误
                let service_error = e.into_service_error();
                if service_error.is_no_such_key() {
                    Ok(None)
                } else {
                    Err(AppError::network(format!("S3 下载失败: {service_error}")))
                }
            }
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        let full_prefix = self.full_key(prefix);

        let mut files = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&full_prefix);

            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let output = request
                .send()
                .await
                .map_err(|e| AppError::network(format!("S3 列出文件失败: {e}")))?;

            if let Some(contents) = output.contents {
                for object in contents {
                    let key = object.key.unwrap_or_default();
                    // 跳过"目录"（以 / 结尾的虚拟目录）
                    if key.ends_with('/') {
                        continue;
                    }

                    let size = object.size.unwrap_or(0) as u64;
                    let last_modified = object
                        .last_modified
                        .and_then(|dt| DateTime::from_timestamp(dt.secs(), dt.subsec_nanos()))
                        .unwrap_or_else(|| {
                            log::warn!("[CloudStorage::S3] Missing or invalid last_modified timestamp for key '{}', using epoch fallback", key);
                            DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                        });
                    let etag = object.e_tag;

                    files.push(FileInfo {
                        key: self.relative_key(&key),
                        size,
                        last_modified,
                        etag,
                    });
                }
            }

            // 检查是否还有更多结果
            if output.is_truncated.unwrap_or(false) {
                match output.next_continuation_token {
                    Some(token) => continuation_token = Some(token),
                    None => {
                        // is_truncated=true 却没有 continuation token：
                        // 不带 token 重发只会拿到同一页（死循环），静默 break 则
                        // 返回截断列表（上层可能据此误判删除/上传）。如实报错。
                        return Err(AppError::network(
                            "S3 列表被截断但未返回 continuation token，无法安全继续分页"
                                .to_string(),
                        ));
                    }
                }
            } else {
                break;
            }
        }

        // 按修改时间降序排列
        files.sort_by_key(|b| std::cmp::Reverse(b.last_modified));
        Ok(files)
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let full_key = self.full_key(key);

        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .send()
            .await
            .map_err(|e| AppError::network(format!("S3 删除失败: {e}")))?;

        Ok(())
    }

    async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
        let full_key = self.full_key(key);

        let result = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&full_key)
            .send()
            .await;

        match result {
            Ok(output) => {
                let size = output.content_length.unwrap_or(0) as u64;
                let last_modified = output
                    .last_modified
                    .and_then(|dt| DateTime::from_timestamp(dt.secs(), dt.subsec_nanos()))
                    .unwrap_or_else(|| {
                        log::warn!("[CloudStorage::S3] Missing or invalid last_modified timestamp for key '{}', using epoch fallback", key);
                        DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                    });
                let etag = output.e_tag;

                Ok(Some(FileInfo {
                    key: key.to_string(),
                    size,
                    last_modified,
                    etag,
                }))
            }
            Err(e) => {
                // 检查是否是 NotFound 错误
                let service_error = e.into_service_error();
                if service_error.is_not_found() {
                    Ok(None)
                } else {
                    Err(AppError::network(format!(
                        "S3 获取文件信息失败: {service_error}"
                    )))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    #[test]
    fn put_file_source_guards_remote_size_check() {
        let source = include_str!("s3.rs");
        assert!(
            source.contains("self.verify_remote_object_size(key, file_size)"),
            "S3 put_file must HEAD remote size after PUT/multipart; SDK success is not enough"
        );
        assert!(
            source.contains("fn supports_resumable_download(&self) -> bool {\n        true"),
            "S3 必须声明支持 Range 续传，编排层才会保留断点"
        );
        assert!(
            source.contains("request.range(format!(\"bytes={resume_from}-\"))"),
            "S3 续传必须发 Range GET"
        );
        assert!(
            source.contains("upload_part_with_retry"),
            "S3 multipart 单分块瞬时失败必须重试，不得整对象立即 abort"
        );
        assert!(
            source.contains("ensure_memory_get_matches_declared_len(\"S3\""),
            "S3 get() 必须按 content_length 拒绝半包，记录级/清单不得收下截断体"
        );
        assert!(
            source.contains("S3 内存对象下载停滞超过 90 秒"),
            "S3 get() 必须按块停滞超时，不得用整段 collect 冒充已读完"
        );
        // [R4-get-budget] 预算三件套：声明预检、有界缓冲、旧入口兜底预算。
        assert!(
            source.contains("async fn get_bounded(&self, key: &str, max_bytes: u64)"),
            "S3 必须实现带调用方硬预算的 get_bounded"
        );
        assert!(
            source.contains("ensure_declared_len_within_budget(\"S3\""),
            "S3 get_bounded 必须在读响应体前按 content_length 预检预算"
        );
        assert!(
            source.contains("BoundedMemoryBody::new(\"S3\""),
            "S3 get_bounded 必须用有界缓冲，content_length 缺失/为负也不得无界累积"
        );
        assert!(
            source.contains("self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)"),
            "S3 get() 旧入口必须走默认兜底预算，不得回到无界路径"
        );
        assert!(
            source.contains("abort_stale_multipart_uploads"),
            "S3 multipart 必须在创建新 upload 前清理同一 key 的陈旧未完成上传"
        );
        // [R5-prove-cost] 前缀读取：能力位 + Range GET + 有界消费。
        assert!(
            source.contains("fn supports_prefix_read(&self) -> bool {\n        true"),
            "S3 必须声明支持前缀读取，prove 首块试解才不会回退整包下载"
        );
        assert!(
            source.contains(".range(format!(\"bytes=0-{}\", prefix_len - 1))"),
            "S3 前缀读取必须发 bytes=0-N 的 Range GET"
        );
        assert!(
            source.contains("while (prefix.len() as u64) < prefix_len"),
            "S3 前缀读取必须在收满 prefix_len 后停止消费响应体（服务端忽略 Range 时也不得整包读入）"
        );
        assert!(
            source.contains("MULTIPART_STALE_SECS"),
            "陈旧宽限期必须存在，不得误杀进行中的同 key 上传"
        );
    }

    #[test]
    fn stale_multipart_keeps_recent_and_unknown_initiated() {
        let now = 1_800_000_000;
        assert!(
            !S3Storage::multipart_upload_is_stale(Some(now - 60), now),
            "一分钟前发起的上传不得当陈旧"
        );
        assert!(
            !S3Storage::multipart_upload_is_stale(None, now),
            "缺 Initiated 不得 abort，避免兼容服务误杀"
        );
        assert!(S3Storage::multipart_upload_is_stale(
            Some(now - MULTIPART_STALE_SECS),
            now
        ));
        assert!(S3Storage::multipart_upload_is_stale(
            Some(now - MULTIPART_STALE_SECS - 1),
            now
        ));
    }

    #[test]
    fn parse_content_range_start_accepts_standard_form() {
        assert_eq!(
            S3Storage::parse_content_range_start("bytes 7000-9999/10000"),
            Some(7000)
        );
        assert_eq!(
            S3Storage::parse_content_range_start(" bytes 0-1/2"),
            Some(0)
        );
    }

    #[test]
    fn parse_content_range_start_rejects_unsatisfiable_form() {
        assert_eq!(S3Storage::parse_content_range_start("bytes */10000"), None);
        assert_eq!(S3Storage::parse_content_range_start("bytes"), None);
    }

    #[test]
    fn resume_actual_start_restarts_when_range_ignored() {
        assert_eq!(S3Storage::resume_actual_start(0, None).unwrap(), 0);
        assert_eq!(
            S3Storage::resume_actual_start(7000, None).unwrap(),
            0,
            "无 Content-Range 必须诚实从零重下，不得冒充续传"
        );
        assert_eq!(
            S3Storage::resume_actual_start(7000, Some("bytes 7000-9999/10000")).unwrap(),
            7000
        );
    }

    #[test]
    fn resume_actual_start_fails_closed_on_misaligned_range() {
        let error = S3Storage::resume_actual_start(7000, Some("bytes 7001-9999/10000"))
            .expect_err("错位 Content-Range 必须 fail-closed");
        assert!(error.to_string().contains("拒绝错位追加"), "实际: {error}");
        let error = S3Storage::resume_actual_start(7000, Some("bytes */10000"))
            .expect_err("无法解析的 Content-Range 必须 fail-closed");
        assert!(error.to_string().contains("拒绝错位追加"), "实际: {error}");
    }

    #[test]
    fn multipart_threshold_fits_single_put_attempt_timeout() {
        // 单次 PUT 受 120s operation_attempt_timeout 限制且整个请求共用一个计时。
        // 阈值必须落在 16–32MiB 区间：足够小使慢速链路（~1-2Mbps 上行）也能在
        // 120s 内完成接近阈值的单 PUT——旧 100MB 阈值在此场景必然超时。
        assert!(
            MIN_MULTIPART_SIZE <= 32 * MIB,
            "multipart 阈值过大，会与 120s 单次尝试超时冲突"
        );
        assert!(
            MIN_MULTIPART_SIZE >= 16 * MIB,
            "multipart 阈值过小，会给小文件带来不必要的多请求开销"
        );
        // 阈值以上的文件至少能切出 2 个分块，multipart 才有意义
        assert!(MIN_MULTIPART_SIZE >= CHUNK_SIZE as u64);
    }

    #[test]
    fn plan_part_size_uses_default_chunk_for_common_sizes() {
        // 阈值边界与常见大文件（10GiB）都应使用默认 8MiB 分块
        assert_eq!(
            plan_multipart_part_size(MIN_MULTIPART_SIZE).unwrap(),
            CHUNK_SIZE
        );
        assert_eq!(plan_multipart_part_size(10 * GIB).unwrap(), CHUNK_SIZE);
        // 8MiB × 10000 = 78.125GiB 恰好装得下
        assert_eq!(
            plan_multipart_part_size(CHUNK_SIZE as u64 * MAX_MULTIPART_PARTS).unwrap(),
            CHUNK_SIZE
        );
    }

    /// [#57 回归] 腾讯云 COS / 阿里云 OSS / 缤纷云 S4 控制台展示的是带
    /// bucket 前缀的访问域名；原样粘贴 + 单独填写 bucket 会让 SDK 的
    /// virtual-hosted-style 寻址拼出 `bucket.bucket.…` 域名，DNS/TLS 直接失败。
    #[test]
    fn normalize_endpoint_strips_bucket_prefixed_host() {
        // 腾讯云 COS：bucket 命名带 APPID 后缀
        assert_eq!(
            S3Storage::normalize_endpoint(
                "https://mybucket-1250000000.cos.ap-beijing.myqcloud.com",
                "mybucket-1250000000"
            ),
            "https://cos.ap-beijing.myqcloud.com"
        );
        // 阿里云 OSS
        assert_eq!(
            S3Storage::normalize_endpoint(
                "https://mybucket.oss-cn-hangzhou.aliyuncs.com/",
                "mybucket"
            ),
            "https://oss-cn-hangzhou.aliyuncs.com"
        );
        // 缤纷云 S4
        assert_eq!(
            S3Storage::normalize_endpoint("https://mybucket.s3.bitiful.net", "mybucket"),
            "https://s3.bitiful.net"
        );
        // AWS 官方 virtual-host 域名同样归一化回服务端点
        assert_eq!(
            S3Storage::normalize_endpoint(
                "https://mybucket.s3.us-east-1.amazonaws.com",
                "mybucket"
            ),
            "https://s3.us-east-1.amazonaws.com"
        );
    }

    #[test]
    fn plan_part_size_scales_up_to_respect_ten_thousand_part_limit() {
        // 80GiB 按 8MiB 分块需要 10240 块，超过 10000：必须在上传前放大分块
        for file_size in [80 * GIB, 500 * GIB, 5 * 1024 * GIB] {
            let part_size = plan_multipart_part_size(file_size).unwrap();
            assert!(
                part_size > CHUNK_SIZE,
                "{file_size} 字节的文件应使用大于默认值的分块"
            );
            assert!(
                planned_part_count(file_size, part_size) <= MAX_MULTIPART_PARTS,
                "{file_size} 字节的文件分块数不得超过 10000"
            );
            assert!(part_size as u64 <= MAX_PART_SIZE);
            assert_eq!(part_size as u64 % MIB, 0, "分块大小应对齐到 MiB");
        }
    }

    #[test]
    fn plan_part_size_rejects_files_beyond_s3_hard_limits() {
        // 超过 10000 × 5GiB 的对象无论如何切分都传不上去，必须在发起请求前报错
        let max_object = MAX_MULTIPART_PARTS * MAX_PART_SIZE;
        assert!(plan_multipart_part_size(max_object).is_ok());
        assert!(plan_multipart_part_size(max_object + 1).is_err());
    }

    #[test]
    fn planned_part_count_covers_exact_and_ragged_sizes() {
        assert_eq!(planned_part_count(2 * CHUNK_SIZE as u64, CHUNK_SIZE), 2);
        assert_eq!(planned_part_count(2 * CHUNK_SIZE as u64 + 1, CHUNK_SIZE), 3);
        assert_eq!(planned_part_count(1, CHUNK_SIZE), 1);
        assert_eq!(planned_part_count(0, CHUNK_SIZE), 1);
    }

    #[test]
    fn normalize_endpoint_adds_https_scheme_and_trims() {
        // 控制台复制的域名通常不带 scheme
        assert_eq!(
            S3Storage::normalize_endpoint("  cos.ap-beijing.myqcloud.com  ", "mybucket"),
            "https://cos.ap-beijing.myqcloud.com"
        );
        // 带 scheme + 尾部斜杠 + 空白：只做清理，不改动其余部分
        assert_eq!(
            S3Storage::normalize_endpoint(" https://s3.example.com/ ", "b"),
            "https://s3.example.com"
        );
    }

    #[test]
    fn normalize_endpoint_keeps_path_style_paths_untouched() {
        // path-style endpoint 的 bucket 路径属于用户配置，不能猜测性剥离。
        assert_eq!(
            S3Storage::normalize_endpoint(
                "https://cos.ap-beijing.myqcloud.com/mybucket",
                "mybucket"
            ),
            "https://cos.ap-beijing.myqcloud.com/mybucket"
        );
        assert_eq!(
            S3Storage::normalize_endpoint("https://gw.example.com/s3/mybucket", "mybucket"),
            "https://gw.example.com/s3/mybucket"
        );
    }

    #[test]
    fn normalize_endpoint_keeps_canonical_endpoints_untouched() {
        // 正常服务端点：host 不以 bucket 开头，原样保留
        assert_eq!(
            S3Storage::normalize_endpoint("https://cos.ap-beijing.myqcloud.com", "mybucket"),
            "https://cos.ap-beijing.myqcloud.com"
        );
        // Cloudflare R2 账户端点不受影响
        assert_eq!(
            S3Storage::normalize_endpoint(
                "https://0123456789abcdef.r2.cloudflarestorage.com",
                "mybucket"
            ),
            "https://0123456789abcdef.r2.cloudflarestorage.com"
        );
        // 未触发归一化时字符串完全不变（大小写等原样），
        // 保证 instance_binding_hint 对既有可用配置保持稳定
        assert_eq!(
            S3Storage::normalize_endpoint("https://MinIO.Example.com:9000", "mybucket"),
            "https://MinIO.Example.com:9000"
        );
    }

    #[test]
    fn normalize_endpoint_conservative_cases() {
        // IP / localhost 不适用 virtual-host 寻址，不剥离
        assert_eq!(
            S3Storage::normalize_endpoint("http://127.0.0.1:9000", "127"),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            S3Storage::normalize_endpoint("http://localhost:9000", "localhost"),
            "http://localhost:9000"
        );
        // 剥离后只剩两段域名：保守跳过，避免误伤真实端点
        // （如 bucket 恰好叫 "s3"、端点是 s3.bitiful.net 的情况）
        assert_eq!(
            S3Storage::normalize_endpoint("https://s3.bitiful.net", "s3"),
            "https://s3.bitiful.net"
        );
        // 即使剩余 host 段数充足，也只剥离明确的 provider bucket-host 模式。
        assert_eq!(
            S3Storage::normalize_endpoint("https://mybucket.s3.example.com", "mybucket"),
            "https://mybucket.s3.example.com"
        );
        // bucket 恰好名为 s3 时，规范 AWS regional endpoint 不能被误剥。
        assert_eq!(
            S3Storage::normalize_endpoint("https://s3.us-east-1.amazonaws.com", "s3"),
            "https://s3.us-east-1.amazonaws.com"
        );
        // bucket 为空时只做 trim/补 scheme
        assert_eq!(
            S3Storage::normalize_endpoint("https://s3.example.com", ""),
            "https://s3.example.com"
        );
    }
}
