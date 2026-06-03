//! FTP/FTPS 存储实现
//!
//! 基于 suppaftp 的异步 FTP 客户端，支持显式 FTPS（AUTH TLS）

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use suppaftp::{AsyncFtpStream, AsyncNativeTlsFtpStream, AsyncNativeTlsConnector};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::config::FtpConfig;
use super::traits::{
    CloudStorage, DownloadProgressCallback, FileInfo, Result, UploadProgressCallback,
};
use crate::models::AppError;

/// FTP/FTPS 存储实现
pub struct FtpStorage {
    host: String,
    port: u16,
    username: String,
    password: String,
    use_tls: bool,
    root: String,
}

impl FtpStorage {
    /// 创建 FTP 存储实例
    pub fn new(config: FtpConfig, root: String) -> Result<Self> {
        if config.host.trim().is_empty() {
            return Err(AppError::validation("FTP host 不能为空"));
        }

        let is_local = Self::is_local_ftp_host(&config.host);
        if !is_local && !config.use_tls {
            return Err(AppError::configuration(
                "FTP 连接必须使用 TLS 以保护凭据（仅 localhost 允许明文）".to_string(),
            ));
        }

        Ok(Self {
            host: config.host.trim().to_string(),
            port: config.port,
            username: config.username,
            password: config.password,
            use_tls: config.use_tls,
            root: root.trim_matches('/').to_string(),
        })
    }

    /// 判断 FTP host 是否为本地地址
    fn is_local_ftp_host(host: &str) -> bool {
        let host = host.trim().to_lowercase();
        matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1")
    }

    /// 创建 FTP 客户端连接
    async fn create_client(&self) -> Result<FtpClient> {
        let address = format!("{}:{}", self.host, self.port);

        tracing::debug!("[FtpStorage] 正在连接到 {}", address);

        let mut stream = AsyncFtpStream::connect(&address)
            .await
            .map_err(|e| AppError::network(format!("FTP 连接失败 {}: {}", address, e)))?;

        // 设置被动模式（PASV）
        stream
            .transfer_type(suppaftp::types::FileType::Binary)
            .await
            .map_err(|e| AppError::internal(format!("设置 FTP 传输类型失败：{}", e)))?;

        // 如果配置了 TLS，升级为安全连接
        if self.use_tls {
            tracing::debug!("[FtpStorage] 正在升级到 TLS...");
            let mut secure_stream = stream
                .into_secure(AsyncNativeTlsConnector::new(), &self.host)
                .await
                .map_err(|e| AppError::network(format!("FTP TLS 升级失败：{}", e)))?;

            // 登录
            secure_stream
                .login(&self.username, &self.password)
                .await
                .map_err(|e| AppError::authentication(format!("FTP 登录失败：{}", e)))?;

            Ok(FtpClient::Secure(secure_stream))
        } else {
            // 明文登录（仅 localhost 允许）
            stream
                .login(&self.username, &self.password)
                .await
                .map_err(|e| AppError::authentication(format!("FTP 登录失败：{}", e)))?;

            Ok(FtpClient::Plain(stream))
        }
    }

    /// 将相对 key 组合成 FTP 根目录下的远程路径
    fn remote_path(&self, key: &str) -> String {
        Self::join_paths(&self.root, key)
    }

    /// 拼接两个路径片段，去掉首尾斜杠
    fn join_paths(base: &str, child: &str) -> String {
        let base = base.trim_matches('/');
        let preserve_trailing_slash = child.ends_with('/') && !child.trim_matches('/').is_empty();
        let child = child.trim_matches('/');

        match (base.is_empty(), child.is_empty()) {
            (true, true) => String::new(),
            (true, false) => {
                if preserve_trailing_slash {
                    format!("{child}/")
                } else {
                    child.to_string()
                }
            }
            (false, true) => base.to_string(),
            (false, false) => {
                if preserve_trailing_slash {
                    format!("{base}/{child}/")
                } else {
                    format!("{base}/{child}")
                }
            }
        }
    }

    /// 确保远程目录存在（递归创建）
    async fn ensure_directory(&self, client: &mut FtpClient, path: &str) -> Result<()> {
        let parts: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();

        let mut current = String::new();
        for part in parts {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(part);

            // 尝试创建目录
            match client.mkdir(&format!("/{}", current)).await {
                Ok(_) => {
                    tracing::debug!("[FtpStorage] 创建目录：/{}", current);
                }
                Err(e) => {
                    // 550 表示目录已存在，可以忽略
                    let err_str = e.to_string();
                    if !err_str.contains("550") && !err_str.contains("already exists") {
                        tracing::debug!("[FtpStorage] MKDIR /{} 失败：{}", current, e);
                    }
                }
            }
        }
        Ok(())
    }

    /// 带重试的 FTP 操作
    async fn with_retry<T, F, Fut>(&self, operation: F) -> Result<T>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let max_retries = 3;
        let mut last_error = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = Duration::from_millis(500 * (1 << attempt));
                tokio::time::sleep(delay).await;
                tracing::debug!("[FtpStorage] 重试 {}/{}", attempt + 1, max_retries);
            }

            match operation().await {
                Ok(result) => return Ok(result),
                Err(e) => {
                    last_error = Some(e);
                    if attempt == max_retries - 1 {
                        break;
                    }
                }
            }
        }

        Err(last_error.unwrap())
    }
}

/// FTP 客户端枚举（支持明文和安全连接）
enum FtpClient {
    Plain(AsyncFtpStream),
    Secure(AsyncNativeTlsFtpStream),
}

impl FtpClient {
    async fn cwd(&mut self, path: &str) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .cwd(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP CWD 失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .cwd(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP CWD 失败：{}", e)))?,
        }
        Ok(())
    }

    async fn mkdir(&mut self, path: &str) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .mkdir(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MKDIR 失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .mkdir(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MKDIR 失败：{}", e)))?,
        }
        Ok(())
    }

    async fn put_file<P: AsRef<Path>>(&mut self, path: P) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .put_file(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .put_file(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e)))?,
        }
        Ok(())
    }

    async fn get_file<P: AsRef<Path>>(&mut self, path: P) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .get_file(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .get_file(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?,
        }
        Ok(())
    }

    async fn list(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        match self {
            FtpClient::Plain(stream) => Ok(stream
                .list(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e)))?
                .unwrap_or_default()),
            FtpClient::Secure(stream) => Ok(stream
                .list(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e)))?
                .unwrap_or_default()),
        }
    }

    async fn delete(&mut self, path: &str) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .delete(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP DELETE 失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .delete(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP DELETE 失败：{}", e)))?,
        }
        Ok(())
    }

    async fn size(&mut self, path: &str) -> Result<u64> {
        match self {
            FtpClient::Plain(stream) => Ok(stream
                .size(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP SIZE 失败：{}", e)))?
                .unwrap_or(0)),
            FtpClient::Secure(stream) => Ok(stream
                .size(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP SIZE 失败：{}", e)))?
                .unwrap_or(0)),
        }
    }

    async fn mdtm(&mut self, path: &str) -> Result<chrono::DateTime<chrono::Utc>> {
        match self {
            FtpClient::Plain(stream) => Ok(stream
                .mdtm(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MDTM 失败：{}", e)))?
                .unwrap_or_else(|| chrono::Utc::now())),
            FtpClient::Secure(stream) => Ok(stream
                .mdtm(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MDTM 失败：{}", e)))?
                .unwrap_or_else(|| chrono::Utc::now())),
        }
    }

    async fn quit(&mut self) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .quit()
                .await
                .map_err(|e| AppError::network(format!("FTP 断开失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .quit()
                .await
                .map_err(|e| AppError::network(format!("FTP 断开失败：{}", e)))?,
        }
        Ok(())
    }
}

#[async_trait]
impl CloudStorage for FtpStorage {
    fn provider_name(&self) -> &'static str {
        "FTP"
    }

    async fn check_connection(&self) -> Result<()> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;
            // 尝试切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;
            client.quit().await?;
            Ok(())
        })
        .await
    }

    async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 确保根目录存在
            client.cwd("/").await?;
            self.ensure_directory(&mut client, &self.root).await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 确保父目录存在
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    self.ensure_directory(&mut client, parent_path).await?;
                    client.cwd(&format!("/{}/{}", self.root, parent_path))
                        .await?;
                }
            }

            // 创建临时文件
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-upload-")
                .tempfile()
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            // 写入数据
            let mut file = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            file.write_all(data)
                .await
                .map_err(|e| AppError::file_system(format!("写入临时文件失败：{}", e)))?;
            file.flush()
                .await
                .map_err(|e| AppError::file_system(format!("刷新临时文件失败：{}", e)))?;
            drop(file);

            // 上传文件
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            client.put_file(&temp_path).await?;

            // 清理临时文件
            let _ = std::fs::remove_file(&temp_path);

            client.quit().await?;
            Ok(())
        })
        .await
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 检查文件是否存在
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    client.cwd(parent_path).await?;
                }
            }

            // 获取文件大小
            let size = client.size(filename).await?;
            if size == 0 {
                // 尝试获取修改时间来判断文件是否存在
                match client.mdtm(filename).await {
                    Ok(_) => {}
                    Err(_) => {
                        client.quit().await?;
                        return Ok(None);
                    }
                }
            }

            // 创建临时文件
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-download-")
                .tempfile()
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            // 下载文件
            client.get_file(&temp_path).await?;
            client.quit().await?;

            // 读取文件内容
            let data = tokio::fs::read(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("读取临时文件失败：{}", e)))?;

            // 清理临时文件
            let _ = std::fs::remove_file(&temp_path);

            Ok(Some(data))
        })
        .await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 如果有 prefix，切换到对应目录
            if !prefix.is_empty() {
                let prefix_path = prefix.trim_matches('/');
                client.cwd(prefix_path).await?;
            }

            // 列出文件
            let entries = client.list(None).await?;
            let mut files = Vec::new();

            for entry in entries {
                // 解析 LIST 输出（格式：-rw-r--r--  1 user group  1234 Jun  3 12:00 filename）
                let parts: Vec<&str> = entry.split_whitespace().collect();
                if parts.len() < 9 {
                    continue;
                }

                // 跳过目录
                let perms = parts[0];
                if perms.starts_with('d') {
                    continue;
                }

                // 提取文件名和大小
                let size = parts[4].parse::<u64>().unwrap_or(0);
                let filename = parts[8..].join(" ");

                // 跳过隐藏文件
                if filename.starts_with('.') {
                    continue;
                }

                // 构建完整路径
                let full_key = if prefix.is_empty() {
                    filename.clone()
                } else {
                    format!("{}/{}", prefix.trim_matches('/'), filename)
                };

                // 获取修改时间
                let file_path = if prefix.is_empty() {
                    filename.clone()
                } else {
                    format!("{}/{}", prefix.trim_matches('/'), filename)
                };

                let modified = client.mdtm(&file_path).await.unwrap_or_else(|_| chrono::Utc::now());

                files.push(FileInfo {
                    key: full_key,
                    size,
                    last_modified: modified,
                    etag: None,
                });
            }

            client.quit().await?;

            // 按修改时间降序排列
            files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
            Ok(files)
        })
        .await
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 切换到文件所在目录
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    client.cwd(parent_path).await?;
                }
            }

            // 删除文件
            match client.delete(filename).await {
                Ok(_) => {}
                Err(e) => {
                    // 文件不存在也算成功
                    let err_str = e.to_string();
                    if !err_str.contains("550") && !err_str.contains("not found") {
                        return Err(e);
                    }
                }
            }

            client.quit().await?;
            Ok(())
        })
        .await
    }

    async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 切换到文件所在目录
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    client.cwd(parent_path).await?;
                }
            }

            // 获取文件大小
            let size = match client.size(filename).await {
                Ok(size) => size,
                Err(_) => {
                    client.quit().await?;
                    return Ok(None);
                }
            };

            // 获取修改时间
            let modified = client.mdtm(filename).await?;

            client.quit().await?;

            Ok(Some(FileInfo {
                key: key.to_string(),
                size,
                last_modified: modified,
                etag: None,
            }))
        })
        .await
    }

    async fn put_file(
        &self,
        key: &str,
        local_path: &Path,
        progress: Option<UploadProgressCallback>,
    ) -> Result<String> {
        self.with_retry(|| async {
            let metadata = tokio::fs::metadata(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("读取文件元信息失败：{}", e)))?;
            let file_size = metadata.len();

            // 计算 SHA256
            let checksum = tokio::task::spawn_blocking({
                let path = local_path.to_path_buf();
                move || {
                    use crate::backup_common::calculate_file_hash;
                    calculate_file_hash(&path)
                }
            })
            .await
            .map_err(|e| AppError::internal(format!("计算校验和任务失败：{}", e)))??;

            if let Some(ref cb) = progress {
                cb(0, file_size);
            }

            let mut client = self.create_client().await?;

            // 确保根目录存在
            client.cwd("/").await?;
            self.ensure_directory(&mut client, &self.root).await?;

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 确保父目录存在
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    self.ensure_directory(&mut client, parent_path).await?;
                    client.cwd(&format!("/{}/{}", self.root, parent_path))
                        .await?;
                }
            }

            // 上传文件
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);

            // 读取文件并上传
            let mut file = tokio::fs::File::open(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("打开文件失败：{}", e)))?;

            // 创建临时文件用于上传（suppaftp 需要文件路径）
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-upload-")
                .tempfile()
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            // 复制文件内容
            let mut temp_writer = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            tokio::io::copy(&mut file, &mut temp_writer)
                .await
                .map_err(|e| AppError::file_system(format!("复制文件失败：{}", e)))?;
            temp_writer
                .flush()
                .await
                .map_err(|e| AppError::file_system(format!("刷新临时文件失败：{}", e)))?;
            drop(temp_writer);

            // 上传
            client.put_file(&temp_path).await?;

            // 报告进度
            if let Some(ref cb) = progress {
                cb(file_size, file_size);
            }

            // 清理临时文件
            let _ = std::fs::remove_file(&temp_path);

            client.quit().await?;

            Ok(checksum)
        })
        .await
    }

    async fn get_file(
        &self,
        key: &str,
        local_path: &Path,
        expected_checksum: Option<&str>,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<String> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 获取文件大小
            let stat = self.stat(key).await?;
            let total_size = stat.as_ref().map(|s| s.size).unwrap_or(0);

            if let Some(ref cb) = progress {
                cb(0, total_size);
            }

            // 切换到根目录
            client.cwd(&format!("/{}", self.root)).await?;

            // 切换到文件所在目录
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    client.cwd(parent_path).await?;
                }
            }

            // 确保目标目录存在
            if let Some(parent) = local_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::file_system(format!("创建目录失败：{}", e)))?;
            }

            // 创建临时下载文件
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-download-")
                .tempfile_in(local_path.parent().unwrap_or(Path::new(".")))
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            // 下载文件
            client.get_file(&temp_path).await?;
            client.quit().await?;

            // 计算校验和并读取文件
            let mut hasher = Sha256::new();
            let mut file = tokio::fs::File::open(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("打开临时文件失败：{}", e)))?;
            let mut buffer = vec![0u8; 8192];
            let mut downloaded = 0u64;

            loop {
                let bytes_read = file
                    .read(&mut buffer)
                    .await
                    .map_err(|e| AppError::file_system(format!("读取临时文件失败：{}", e)))?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
                downloaded += bytes_read as u64;

                if let Some(ref cb) = progress {
                    cb(downloaded, total_size);
                }
            }

            let checksum = format!("{:x}", hasher.finalize());

            // 验证校验和
            if let Some(expected) = expected_checksum {
                if checksum != expected {
                    return Err(AppError::validation(format!(
                        "校验和不匹配：期望 {}, 实际 {}",
                        &expected[..8.min(expected.len())],
                        &checksum[..8]
                    )));
                }
            }

            // 移动到目标位置
            tokio::fs::rename(&temp_path, local_path)
                .await
                .map_err(|e| AppError::file_system(format!("保存文件失败：{}", e)))?;

            if let Some(ref cb) = progress {
                cb(total_size, total_size);
            }

            Ok(checksum)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_join_paths() {
        assert_eq!(FtpStorage::join_paths("root", "file.txt"), "root/file.txt");
        assert_eq!(FtpStorage::join_paths("root/", "file.txt"), "root/file.txt");
        assert_eq!(FtpStorage::join_paths("root", "/file.txt"), "root/file.txt");
        assert_eq!(FtpStorage::join_paths("", "file.txt"), "file.txt");
        assert_eq!(FtpStorage::join_paths("root", ""), "root");
        assert_eq!(FtpStorage::join_paths("", ""), "");
    }

    #[test]
    fn test_remote_path() {
        let storage = FtpStorage::new(
            FtpConfig {
                host: "localhost".into(),
                port: 21,
                username: "user".into(),
                password: "pass".into(),
                use_tls: false,
            },
            "deep-student-sync".into(),
        )
        .unwrap();

        assert_eq!(
            storage.remote_path("objects/basic/hello.txt"),
            "deep-student-sync/objects/basic/hello.txt"
        );
    }

    #[test]
    fn test_is_local_ftp_host() {
        assert!(FtpStorage::is_local_ftp_host("localhost"));
        assert!(FtpStorage::is_local_ftp_host("127.0.0.1"));
        assert!(FtpStorage::is_local_ftp_host("::1"));
        assert!(FtpStorage::is_local_ftp_host("  localhost  "));

        assert!(
            !FtpStorage::is_local_ftp_host("ftp.example.com"),
            "remote host should not be treated as local"
        );
        assert!(
            !FtpStorage::is_local_ftp_host("localhost.evil.com"),
            "localhost.evil.com should not be treated as local"
        );
    }
}
