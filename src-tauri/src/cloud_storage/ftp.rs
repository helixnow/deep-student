//! FTP/FTPS 存储实现
//!
//! 基于 suppaftp 的异步 FTP 客户端，支持显式 FTPS（AUTH TLS）和 localhost 明文 FTP

use async_std::io::{ReadExt, WriteExt};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use suppaftp::async_native_tls::TlsConnector;
use suppaftp::list::File as FtpListFile;
use suppaftp::{AsyncFtpStream, AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use uuid::Uuid;

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

#[derive(Debug)]
struct FtpListEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: DateTime<Utc>,
}

impl FtpStorage {
    /// 创建 FTP 存储实例
    pub fn new(config: FtpConfig, root: String) -> Result<Self> {
        let host = config.host.trim();
        if host.is_empty() {
            return Err(AppError::validation("FTP host 不能为空"));
        }

        if !Self::is_local_ftp_host(host) && !config.use_tls {
            return Err(AppError::validation(
                "FTP 必须启用 FTPS（仅 localhost 允许明文 FTP）",
            ));
        }

        Ok(Self {
            host: host.to_string(),
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

        if self.use_tls {
            // FTPS: 使用 AsyncNativeTlsFtpStream 作为基础类型，
            // 使得 into_secure 的 Stream 类型参数匹配
            let stream = AsyncNativeTlsFtpStream::connect(&address)
                .await
                .map_err(|e| AppError::network(format!("FTP 连接失败 {}: {}", address, e)))?;

            tracing::debug!("[FtpStorage] 正在升级到 TLS...");
            let mut secure_stream = stream
                .into_secure(
                    AsyncNativeTlsConnector::from(TlsConnector::new()),
                    &self.host,
                )
                .await
                .map_err(|e| AppError::network(format!("FTP TLS 升级失败：{}", e)))?;

            // 登录（在 TLS 升级之后进行，确保凭据加密传输）
            secure_stream
                .login(&self.username, &self.password)
                .await
                .map_err(|e| AppError::authentication(format!("FTP 登录失败：{}", e)))?;

            // 登录后再设置传输类型
            secure_stream
                .transfer_type(suppaftp::types::FileType::Binary)
                .await
                .map_err(|e| AppError::internal(format!("设置 FTP 传输类型失败：{}", e)))?;

            Ok(FtpClient::Secure(secure_stream))
        } else {
            // 明文 FTP 仅允许 localhost，避免远程凭据明文传输
            let mut stream = AsyncFtpStream::connect(&address)
                .await
                .map_err(|e| AppError::network(format!("FTP 连接失败 {}: {}", address, e)))?;

            // 先登录，再设置传输类型（有些服务器要求先认证）
            stream
                .login(&self.username, &self.password)
                .await
                .map_err(|e| AppError::authentication(format!("FTP 登录失败：{}", e)))?;

            stream
                .transfer_type(suppaftp::types::FileType::Binary)
                .await
                .map_err(|e| AppError::internal(format!("设置 FTP 传输类型失败：{}", e)))?;

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

    fn absolute_path(path: &str) -> String {
        let path = path.trim_matches('/');
        if path.is_empty() {
            "/".to_string()
        } else {
            format!("/{path}")
        }
    }

    fn split_parent_filename(key: &str) -> (&str, &str) {
        key.rfind('/')
            .map(|i| (&key[..i], &key[i + 1..]))
            .unwrap_or(("", key))
    }

    fn is_not_found_error(error: &AppError) -> bool {
        let err = error.to_string().to_lowercase();
        err.contains("550")
            || err.contains("not found")
            || err.contains("no such file")
            || err.contains("不存在")
    }

    fn parse_list_entry(line: &str) -> Option<FtpListEntry> {
        let parsed = FtpListFile::from_mlsx_line(line)
            .or_else(|_| FtpListFile::try_from(line))
            .ok()?;
        Some(FtpListEntry {
            name: parsed.name().to_string(),
            is_dir: parsed.is_directory(),
            size: parsed.size() as u64,
            modified: DateTime::<Utc>::from(parsed.modified()),
        })
    }

    async fn upload_reader_atomic(
        &self,
        client: &mut FtpClient,
        final_name: &str,
        reader: &mut (impl async_std::io::Read + std::marker::Unpin),
    ) -> Result<()> {
        let nonce = Uuid::new_v4().simple();
        let temp_name = format!("{final_name}.tmp-{nonce}");
        client.put_file(&temp_name, reader).await?;
        if let Err(err) = client.rename(&temp_name, final_name).await {
            let _ = client.rm(&temp_name).await;
            return Err(err);
        }
        Ok(())
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
    async fn stream_to_file(
        reader: &mut (impl async_std::io::Read + std::marker::Unpin),
        temp_path: &Path,
        total_size: u64,
        progress: Option<&DownloadProgressCallback>,
    ) -> Result<String> {
        let mut file = async_std::fs::File::create(temp_path)
            .await
            .map_err(|e| AppError::file_system(format!("创建临时下载文件失败：{}", e)))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut tmp = [0u8; 64 * 1024];

        loop {
            let n = reader
                .read(&mut tmp)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 读取数据失败：{}", e)))?;
            if n == 0 {
                break;
            }
            file.write_all(&tmp[..n])
                .await
                .map_err(|e| AppError::file_system(format!("写入临时下载文件失败：{}", e)))?;
            hasher.update(&tmp[..n]);
            downloaded += n as u64;
            if let Some(cb) = progress {
                cb(downloaded, total_size);
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::file_system(format!("刷新临时下载文件失败：{}", e)))?;

        Ok(format!("{:x}", hasher.finalize()))
    }

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

    /// suppaftp 6.0.7: put_file(filename, reader) 接收远程文件名和一个 async_std::io::Read + Unpin 的 reader
    async fn put_file(
        &mut self,
        filename: &str,
        reader: &mut (impl async_std::io::Read + std::marker::Unpin),
    ) -> Result<u64> {
        match self {
            FtpClient::Plain(stream) => stream
                .put_file(filename, reader)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .put_file(filename, reader)
                .await
                .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e))),
        }
    }

    /// suppaftp 6.0.7: 使用 retr_as_stream 获取数据流后用 ReadExt 逐块读取
    async fn retr_to_vec(&mut self, filename: &str) -> Result<Vec<u8>> {
        match self {
            FtpClient::Plain(stream) => {
                let mut data_stream = stream
                    .retr_as_stream(filename)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?;
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                loop {
                    let n = data_stream
                        .read(&mut tmp)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 读取数据失败：{}", e)))?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                stream
                    .finalize_retr_stream(data_stream)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))?;
                Ok(buf)
            }
            FtpClient::Secure(stream) => {
                let mut data_stream = stream
                    .retr_as_stream(filename)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?;
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                loop {
                    let n = data_stream
                        .read(&mut tmp)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 读取数据失败：{}", e)))?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                stream
                    .finalize_retr_stream(data_stream)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))?;
                Ok(buf)
            }
        }
    }

    async fn retr_to_file(
        &mut self,
        filename: &str,
        temp_path: &Path,
        total_size: u64,
        progress: Option<&DownloadProgressCallback>,
    ) -> Result<String> {
        match self {
            FtpClient::Plain(stream) => {
                let mut data_stream = stream
                    .retr_as_stream(filename)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?;
                let checksum =
                    Self::stream_to_file(&mut data_stream, temp_path, total_size, progress).await?;
                stream
                    .finalize_retr_stream(data_stream)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))?;
                Ok(checksum)
            }
            FtpClient::Secure(stream) => {
                let mut data_stream = stream
                    .retr_as_stream(filename)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))?;
                let checksum =
                    Self::stream_to_file(&mut data_stream, temp_path, total_size, progress).await?;
                stream
                    .finalize_retr_stream(data_stream)
                    .await
                    .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))?;
                Ok(checksum)
            }
        }
    }

    /// suppaftp 6.0.7: list 返回 Result<Vec<String>>
    async fn list(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        match self {
            FtpClient::Plain(stream) => stream
                .list(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .list(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e))),
        }
    }

    async fn mlsd(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        match self {
            FtpClient::Plain(stream) => stream
                .mlsd(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MLSD 失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .mlsd(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP MLSD 失败：{}", e))),
        }
    }

    async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .rename(from, to)
                .await
                .map_err(|e| AppError::file_system(format!("FTP RENAME 失败：{}", e)))?,
            FtpClient::Secure(stream) => stream
                .rename(from, to)
                .await
                .map_err(|e| AppError::file_system(format!("FTP RENAME 失败：{}", e)))?,
        }
        Ok(())
    }

    /// suppaftp 6.0.7: 删除文件的方法名是 rm
    async fn rm(&mut self, path: &str) -> Result<()> {
        match self {
            FtpClient::Plain(stream) => stream
                .rm(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP DELETE 失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .rm(path)
                .await
                .map_err(|e| AppError::file_system(format!("FTP DELETE 失败：{}", e))),
        }
    }

    /// suppaftp 6.0.7: size 返回 FtpResult<usize>，转为 u64
    async fn size(&mut self, path: &str) -> Result<u64> {
        match self {
            FtpClient::Plain(stream) => stream
                .size(path)
                .await
                .map(|s| s as u64)
                .map_err(|e| AppError::file_system(format!("FTP SIZE 失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .size(path)
                .await
                .map(|s| s as u64)
                .map_err(|e| AppError::file_system(format!("FTP SIZE 失败：{}", e))),
        }
    }

    /// suppaftp 6.0.7: mdtm 返回 FtpResult<NaiveDateTime>，转为 DateTime<Utc>
    async fn mdtm(&mut self, path: &str) -> Result<DateTime<Utc>> {
        match self {
            FtpClient::Plain(stream) => stream
                .mdtm(path)
                .await
                .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc))
                .map_err(|e| AppError::file_system(format!("FTP MDTM 失败：{}", e))),
            FtpClient::Secure(stream) => stream
                .mdtm(path)
                .await
                .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc))
                .map_err(|e| AppError::file_system(format!("FTP MDTM 失败：{}", e))),
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

    fn instance_binding_hint(&self) -> String {
        format!(
            "ftp|host={}|port={}|user={}|tls={}|root={}",
            self.host, self.port, self.username, self.use_tls, self.root
        )
    }

    async fn check_connection(&self) -> Result<()> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;
            // 先确保根目录存在（与 put / put_file 保持一致）
            client.cwd("/").await?;
            self.ensure_directory(&mut client, &self.root).await?;
            // 再确认可以切换进去
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
            client.cwd(&Self::absolute_path(&self.root)).await?;

            // 确保父目录存在
            let (parent_path, filename) = Self::split_parent_filename(key);
            if !parent_path.is_empty() {
                let full_parent = self.remote_path(parent_path);
                self.ensure_directory(&mut client, &full_parent).await?;
                client.cwd(&Self::absolute_path(&full_parent)).await?;
            }

            let mut cursor = async_std::io::Cursor::new(data);
            self.upload_reader_atomic(&mut client, filename, &mut cursor)
                .await?;

            client.quit().await?;
            Ok(())
        })
        .await
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            client.cwd("/").await?;
            let (parent_path, filename) = Self::split_parent_filename(key);
            let full_parent = Self::join_paths(&self.root, parent_path);
            if let Err(err) = client.cwd(&Self::absolute_path(&full_parent)).await {
                client.quit().await?;
                if Self::is_not_found_error(&err) {
                    return Ok(None);
                }
                return Err(err);
            }

            let size = match client.size(filename).await {
                Ok(s) => s,
                Err(err) => {
                    client.quit().await?;
                    if Self::is_not_found_error(&err) {
                        return Ok(None);
                    }
                    return Err(err);
                }
            };

            if size == 0 {
                // 再通过 mdtm 确认
                match client.mdtm(filename).await {
                    Ok(_) => {}
                    Err(err) => {
                        client.quit().await?;
                        if Self::is_not_found_error(&err) {
                            return Ok(None);
                        }
                        return Err(err);
                    }
                }
            }

            let data = client.retr_to_vec(filename).await?;

            client.quit().await?;
            Ok(Some(data))
        })
        .await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            client.cwd("/").await?;
            let mut files = Vec::new();
            let start = prefix.trim_matches('/').to_string();
            let mut dirs = vec![start];

            while let Some(relative_dir) = dirs.pop() {
                let full_dir = Self::join_paths(&self.root, &relative_dir);
                let full_dir_abs = Self::absolute_path(&full_dir);
                let raw_entries = match client.mlsd(Some(&full_dir_abs)).await {
                    Ok(entries) => entries,
                    Err(mlsd_err) => {
                        if Self::is_not_found_error(&mlsd_err) {
                            continue;
                        }
                        match client.list(Some(&full_dir_abs)).await {
                            Ok(entries) => entries,
                            Err(list_err) => {
                                if Self::is_not_found_error(&list_err) {
                                    continue;
                                }
                                return Err(mlsd_err);
                            }
                        }
                    }
                };

                for raw in raw_entries {
                    let Some(entry) = Self::parse_list_entry(&raw) else {
                        tracing::warn!("[FtpStorage] 无法解析 LIST/MLSD 条目: {}", raw);
                        continue;
                    };
                    if entry.name == "." || entry.name == ".." || entry.name.starts_with('.') {
                        continue;
                    }
                    let key = Self::join_paths(&relative_dir, &entry.name);
                    if entry.is_dir {
                        dirs.push(key);
                    } else {
                        files.push(FileInfo {
                            key,
                            size: entry.size,
                            last_modified: entry.modified,
                            etag: None,
                        });
                    }
                }
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

            // 确保根目录存在并切换
            client.cwd("/").await?;
            self.ensure_directory(&mut client, &self.root).await?;
            client.cwd(&Self::absolute_path(&self.root)).await?;

            // 切换到文件所在目录
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    let full_parent = self.remote_path(parent_path);
                    client.cwd(&Self::absolute_path(&full_parent)).await?;
                }
            }

            // suppaftp 6.0.7: 删除文件使用 rm
            match client.rm(filename).await {
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

            client.cwd("/").await?;
            let (parent_path, filename) = Self::split_parent_filename(key);
            let full_parent = Self::join_paths(&self.root, parent_path);
            if let Err(err) = client.cwd(&Self::absolute_path(&full_parent)).await {
                client.quit().await?;
                if Self::is_not_found_error(&err) {
                    return Ok(None);
                }
                return Err(err);
            }

            let size = match client.size(filename).await {
                Ok(size) => size,
                Err(err) => {
                    client.quit().await?;
                    if Self::is_not_found_error(&err) {
                        return Ok(None);
                    }
                    return Err(err);
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
            client.cwd(&Self::absolute_path(&self.root)).await?;

            // 确保父目录存在
            let (parent_path, filename) = Self::split_parent_filename(key);
            if !parent_path.is_empty() {
                let full_parent = self.remote_path(parent_path);
                self.ensure_directory(&mut client, &full_parent).await?;
                client.cwd(&Self::absolute_path(&full_parent)).await?;
            }

            let mut file = async_std::fs::File::open(local_path)
                .await
                .map_err(|e| AppError::file_system(format!("打开文件失败：{}", e)))?;
            self.upload_reader_atomic(&mut client, filename, &mut file)
                .await?;

            // 报告进度
            if let Some(ref cb) = progress {
                cb(file_size, file_size);
            }

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

            // 读路径禁止 MKD 副作用：目录不存在应按 not-found 或真实错误返回。
            client.cwd("/").await?;
            client.cwd(&Self::absolute_path(&self.root)).await?;

            // 切换到文件所在目录
            let (parent_path, filename) = Self::split_parent_filename(key);
            if !parent_path.is_empty() {
                let full_parent = self.remote_path(parent_path);
                match client.cwd(&Self::absolute_path(&full_parent)).await {
                    Ok(_) => {}
                    Err(e) if Self::is_not_found_error(&e) => {
                        client.quit().await?;
                        return Err(AppError::not_found("云端文件不存在"));
                    }
                    Err(e) => return Err(e),
                }
            }

            // 确保目标目录存在
            if let Some(parent) = local_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::file_system(format!("创建目录失败：{}", e)))?;
            }

            // 写入临时文件
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-download-")
                .tempfile_in(local_path.parent().unwrap_or_else(|| Path::new(".")))
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            let checksum = client
                .retr_to_file(filename, &temp_path, total_size, progress.as_ref())
                .await?;
            client.quit().await?;

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

            if let Some(ref cb) = progress {
                cb(total_size, total_size);
            }

            // 原子重命名
            tokio::fs::rename(&temp_path, local_path)
                .await
                .map_err(|e| AppError::file_system(format!("保存文件失败：{}", e)))?;

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

    #[test]
    fn ftp_contract_source_guards() {
        let source = include_str!("ftp.rs");

        assert!(
            source.contains("async fn upload_reader_atomic"),
            "FTP writes must upload to a temporary object and rename into place"
        );
        assert!(
            source.contains("client.rename(&temp_name, final_name).await"),
            "FTP atomic visibility depends on RNFR/RNTO rename"
        );
        assert!(
            source.contains("client.mlsd(Some(&full_dir_abs))"),
            "FTP list must prefer MLSD so directory entries are typed"
        );
        assert!(
            source.contains("dirs.push(key)"),
            "FTP list must recursively traverse directories"
        );

        let get_body = source
            .split("async fn get(&self, key: &str)")
            .nth(1)
            .and_then(|s| s.split("async fn list(&self").next())
            .expect("get body");
        assert!(
            !get_body.contains("ensure_directory"),
            "FTP get/stat/list read paths must not create directories"
        );
    }
}
