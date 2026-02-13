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

/// S3 兼容存储实现
pub struct S3Storage {
    client: aws_sdk_s3::Client,
    bucket: String,
    root: String,
}

impl S3Storage {
    /// 创建 S3 存储实例
    pub async fn new(config: S3Config, root: String) -> Result<Self> {
        if config.endpoint.trim().is_empty() {
            return Err(AppError::validation("S3 endpoint 不能为空"));
        }
        if config.bucket.trim().is_empty() {
            return Err(AppError::validation("S3 bucket 不能为空"));
        }

        // 构建凭证提供者
        let credentials = aws_sdk_s3::config::Credentials::new(
            &config.access_key_id,
            &config.secret_access_key,
            None, // session token
            None, // expiry
            "cloud_storage",
        );

        // 构建 S3 配置
        let mut s3_config_builder = aws_sdk_s3::Config::builder()
            .credentials_provider(credentials)
            .endpoint_url(&config.endpoint)
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

        // path-style 访问（MinIO、某些 S3 兼容服务需要）
        if config.path_style {
            s3_config_builder = s3_config_builder.force_path_style(true);
        }

        let s3_config = s3_config_builder.build();
        let client = aws_sdk_s3::Client::from_conf(s3_config);

        Ok(Self {
            client,
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
            return Ok(checksum);
        }

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
            let mut buffer = vec![0u8; CHUNK_SIZE];

            loop {
                let bytes_read = file
                    .read(&mut buffer)
                    .await
                    .map_err(|e| AppError::file_system(format!("读取文件失败: {e}")))?;
                if bytes_read == 0 {
                    break;
                }
                if part_number > 10_000 {
                    return Err(AppError::validation("S3 分块数超过 10000 的限制"));
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
                .map_err(|e| AppError::network(format!("S3 完成分块上传失败: {e}")))?;

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
        upload_result
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

        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        }

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
        let mut file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| AppError::file_system(format!("创建文件失败: {e}")))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];

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

        let checksum = format!("{:x}", hasher.finalize());
        if let Some(expected) = expected_checksum {
            if expected != checksum {
                return Err(AppError::validation(format!(
                    "校验失败：期望 {}, 实际 {}",
                    expected, checksum
                )));
            }
        }
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
                continuation_token = output.next_continuation_token;
            } else {
                break;
            }
        }

        // 按修改时间降序排列
        files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
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
