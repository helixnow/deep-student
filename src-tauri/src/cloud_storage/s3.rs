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
    CloudStorage, DownloadProgressCallback, FileInfo, Result, UploadProgressCallback, CHUNK_SIZE,
    MIN_MULTIPART_SIZE,
};
use crate::models::AppError;

/// S3 multipart 上传的分块数硬限制（AWS 及主流兼容服务通用）
const MAX_MULTIPART_PARTS: u64 = 10_000;

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

                let body = aws_sdk_s3::primitives::ByteStream::from(chunk.to_vec());
                let output = self
                    .client
                    .upload_part()
                    .bucket(&self.bucket)
                    .key(&full_key)
                    .upload_id(&upload_id)
                    .part_number(part_number)
                    .body(body)
                    .send()
                    .await
                    .map_err(|e| AppError::network(format!("S3 分块上传失败: {e}")))?;

                let etag = output
                    .e_tag()
                    .ok_or_else(|| AppError::internal("S3 分块上传未返回 ETag"))?
                    .to_string();
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
                let bytes = output
                    .body
                    .collect()
                    .await
                    .map_err(|e| AppError::network(format!("S3 读取响应体失败: {e}")))?
                    .into_bytes()
                    .to_vec();
                Ok(Some(bytes))
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
