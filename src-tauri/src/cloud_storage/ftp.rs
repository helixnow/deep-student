//! FTP/FTPS 存储实现
//!
//! 基于 suppaftp 的异步 FTP 客户端，支持显式 FTPS（AUTH TLS）和明文 FTP
//! 使用 tokio 运行时 + rustls TLS 后端

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use rustls::{ClientConfig, RootCertStore};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;
use suppaftp::list::File as FtpListFile;
use suppaftp::tokio::AsyncRustlsConnector;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsFtpStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
use tokio_rustls::TlsConnector;
use uuid::Uuid;

use super::config::FtpConfig;
use super::traits::{
    ensure_declared_len_within_budget, CloudStorage, DownloadProgressCallback, FileInfo,
    ListOutcome, Result, UploadProgressCallback, MEMORY_GET_BUDGET_EXCEEDED,
    MEMORY_GET_DEFAULT_BUDGET_BYTES,
};
use crate::models::AppError;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

/// FTP 数据通道单步操作（建立数据连接、LIST/MLSD、单次读取、传输收尾）的超时上限。
/// 被动模式下服务器或中间防火墙静默丢包时数据通道会无限挂起，必须有超时兜底。
const FTP_DATA_TIMEOUT: Duration = Duration::from_secs(60);

/// 递归列举时最多访问的目录数（与 WebDAV 的遍历上限保持同一量级）。
/// 超过上限时停止遍历并通过 `ListOutcome::truncated` 上报，绝不静默返回部分结果。
const FTP_LIST_MAX_DIRS: usize = 200;

/// 带进度的异步读取器包装器
/// 在每次 read() 后回调已传输字节数
pub(crate) struct ProgressReader<'a, R> {
    inner: R,
    total_size: u64,
    transferred: Arc<AtomicU64>,
    callback: Option<&'a UploadProgressCallback>,
}

impl<'a, R> ProgressReader<'a, R> {
    pub fn new(
        inner: R,
        total_size: u64,
        callback: Option<&'a UploadProgressCallback>,
    ) -> (Self, Arc<AtomicU64>) {
        let transferred = Arc::new(AtomicU64::new(0));
        (
            Self {
                inner,
                total_size,
                transferred: Arc::clone(&transferred),
                callback,
            },
            transferred,
        )
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for ProgressReader<'_, R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            let n = buf.filled().len() - before;
            let done = this.transferred.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
            if let Some(ref cb) = this.callback {
                cb(done, this.total_size);
            }
        }
        result
    }
}

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

        Ok(Self {
            host: host.to_string(),
            port: config.port,
            username: config.username,
            password: config.password,
            use_tls: config.use_tls,
            root: root.trim_matches('/').to_string(),
        })
    }

    /// 创建 FTP 客户端连接（带总超时：黑洞主机/防火墙 DROP 下 connect
    /// 或欢迎横幅读取可能无限挂起，必须有上限）
    async fn create_client(&self) -> Result<FtpClient> {
        tokio::time::timeout(Duration::from_secs(45), self.create_client_inner())
            .await
            .map_err(|_| {
                AppError::network(format!(
                    "FTP 连接超时（45 秒）: {}:{}",
                    self.host, self.port
                ))
            })?
    }

    async fn create_client_inner(&self) -> Result<FtpClient> {
        let address = format!("{}:{}", self.host, self.port);

        tracing::debug!("[FtpStorage] 正在连接到 {}", address);

        if self.use_tls {
            // FTPS: 使用 AsyncRustlsFtpStream 作为基础类型
            let stream = AsyncRustlsFtpStream::connect(&address)
                .await
                .map_err(|e| AppError::network(format!("FTP 连接失败 {}: {}", address, e)))?;

            tracing::debug!("[FtpStorage] 正在升级到 TLS...");
            let root_store = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let config = ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();
            let tls_connector = TlsConnector::from(Arc::new(config));
            let mut secure_stream = stream
                .into_secure(AsyncRustlsConnector::from(tls_connector), &self.host)
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
            // 明文 FTP
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

    /// 从 FTP 错误消息中提取三位状态码。
    ///
    /// suppaftp 的 UnexpectedResponse 格式为 "Invalid response: [550] 550 ..."，
    /// 优先解析方括号内的状态码；退路为扫描独立的 4xx/5xx 三位数字标记。
    fn extract_status_code(message: &str) -> Option<u16> {
        if let Some(start) = message.find('[') {
            let rest = &message[start + 1..];
            if let Some(end) = rest.find(']') {
                if let Ok(code) = rest[..end].trim().parse::<u16>() {
                    if (100..600).contains(&code) {
                        return Some(code);
                    }
                }
            }
        }
        message
            .split_whitespace()
            .filter_map(|token| {
                let token = token.trim_matches(|c: char| !c.is_ascii_digit());
                if token.len() == 3 {
                    token.parse::<u16>().ok()
                } else {
                    None
                }
            })
            .find(|code| (400..600).contains(code))
    }

    /// 仅当 FTP 状态码在白名单（550/501）内且服务器消息明确表达"不存在"时才
    /// 归类为 not-found。
    ///
    /// 550 在 FTP 中是多义状态码（不存在/无权限/磁盘错误共用同一码），无法归类
    /// 的 550 必须按真实错误上抛，绝不能当作"文件不存在"从而把删除/下载误判为
    /// 成功。也不再使用无状态码门槛的宽泛子串匹配（如任意 "not found"）。
    fn is_not_found_error(error: &AppError) -> bool {
        let err = error.to_string().to_lowercase();
        let Some(code) = Self::extract_status_code(&err) else {
            return false;
        };
        if !matches!(code, 550 | 501) {
            return false;
        }
        err.contains("no such file")
            || err.contains("no such directory")
            || err.contains("not retrievable")
            || err.contains("does not exist")
            || err.contains("file not found")
            || err.contains("directory not found")
    }

    /// 删除时仅把明确表达 not-found / gone 的 550 CWD 回复视为父目录已不存在。
    ///
    /// 550 也用于权限失败和服务端策略拒绝（vsftpd 的 `550 Failed to change
    /// directory.` 即属无法归类的多义回复）；仅凭状态码或排除少量权限文案放行，
    /// 会把真实删除失败误报为成功。无法归类的 550 必须按真实错误上抛（fail-closed）。
    fn is_missing_directory_error(error: &AppError) -> bool {
        if Self::is_not_found_error(error) {
            return true;
        }
        let err = error.to_string().to_lowercase();
        if Self::extract_status_code(&err) != Some(550) {
            return false;
        }
        let explicitly_missing = [
            "not found",
            "no such file",
            "no such directory",
            "not retrievable",
            "does not exist",
            "不存在",
        ]
        .iter()
        .any(|marker| err.contains(marker));
        let explicitly_gone = err.contains("410") && err.contains("gone");
        explicitly_missing || explicitly_gone
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
        reader: &mut (impl AsyncRead + std::marker::Unpin),
        file_size: u64,
        progress: Option<&UploadProgressCallback>,
    ) -> Result<()> {
        let nonce = Uuid::new_v4().simple();
        let temp_name = format!("{final_name}.tmp-{nonce}");
        // 包装 reader 以支持进度回调
        let (mut progress_reader, _) = ProgressReader::new(reader, file_size, progress);
        client
            .put_file(&temp_name, &mut progress_reader, file_size)
            .await?;
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
                    // 550 表示目录已存在，可以忽略（保持 debug，不制造噪音）
                    let err_str = e.to_string();
                    if err_str.contains("550") || err_str.contains("already exists") {
                        tracing::debug!("[FtpStorage] MKDIR /{} 已存在（忽略）：{}", current, e);
                    } else {
                        // 真实创建失败升为 warn：当前语义仍不在此处返回 Err
                        //（由后续对该路径的写入操作以带上下文的错误显式失败），
                        // 但排障日志必须可见。
                        tracing::warn!("[FtpStorage] MKDIR /{} 失败：{}", current, e);
                    }
                }
            }
        }
        Ok(())
    }

    /// [R4-get-budget] 预算命中是确定性拒绝：同一对象重试仍会超限，
    /// `with_retry` 据此短路，避免把超预算对象反复下满三遍（重试放大）。
    /// 判据是 traits.rs 的稳定标记子串，只命中预算错误，不影响其他重试语义。
    fn is_budget_exceeded_error(error: &AppError) -> bool {
        error.to_string().contains(MEMORY_GET_BUDGET_EXCEEDED)
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
                    // [R4-get-budget] 预算超限不重试：确定性拒绝，重试只会放大流量。
                    if Self::is_budget_exceeded_error(&e) {
                        return Err(e);
                    }
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
    Secure(AsyncRustlsFtpStream),
}

impl FtpClient {
    /// 给数据通道 future 加超时，防止被动模式下数据连接被静默丢弃时无限挂起
    async fn data_timeout<T>(
        op: &str,
        duration: Duration,
        fut: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::time::timeout(duration, fut).await.map_err(|_| {
            AppError::network(format!(
                "FTP {op} 数据通道超时（{} 秒），已中断以避免无限挂起",
                duration.as_secs()
            ))
        })?
    }

    /// 单次数据通道读取（带空闲超时）：只要数据仍在流动就不会误伤慢速传输
    async fn read_with_timeout(
        reader: &mut (impl AsyncRead + std::marker::Unpin),
        buf: &mut [u8],
    ) -> Result<usize> {
        tokio::time::timeout(FTP_DATA_TIMEOUT, reader.read(buf))
            .await
            .map_err(|_| {
                AppError::network(format!(
                    "FTP 数据通道读取超时（{} 秒），已中断以避免无限挂起",
                    FTP_DATA_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|e| AppError::file_system(format!("FTP 读取数据失败：{}", e)))
    }

    /// 整体上传超时：基础 120 秒 + 按最低 64 KiB/s 吞吐折算的传输时间。
    /// suppaftp 在内部完成整个 STOR 拷贝，无法按块注入空闲超时，只能设总上限。
    fn transfer_timeout(total_size: u64) -> Duration {
        Duration::from_secs(120).saturating_add(Duration::from_secs(total_size / (64 * 1024)))
    }

    async fn stream_to_file(
        reader: &mut (impl AsyncRead + std::marker::Unpin),
        temp_path: &Path,
        total_size: u64,
        progress: Option<&DownloadProgressCallback>,
    ) -> Result<String> {
        let mut file = tokio::fs::File::create(temp_path)
            .await
            .map_err(|e| AppError::file_system(format!("创建临时下载文件失败：{}", e)))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut tmp = [0u8; 64 * 1024];

        loop {
            let n = Self::read_with_timeout(reader, &mut tmp).await?;
            if n == 0 {
                break;
            }
            file.write_all(&tmp[..n])
                .await
                .map_err(|e| AppError::file_system(format!("写入临时下载文件失败：{}", e)))?;
            hasher.update(&tmp[..n]);
            downloaded += n as u64;
            // [R4-get-budget] 超过声明大小立即中断：EOF 之前就能确定这不是
            // 声明的那个对象（错版本/并发替换/注入），不必把超量字节继续灌满
            // 磁盘再拒。文案保持"下载不完整"语义，与收尾校验同一失败类别。
            if downloaded > total_size {
                return Err(AppError::network(format!(
                    "FTP 下载不完整或对象已变更：服务端声明 {total_size} 字节，实际已收到 {downloaded} 字节且数据仍在继续，已中断"
                )));
            }
            if let Some(cb) = progress {
                cb(downloaded, total_size);
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::file_system(format!("刷新临时下载文件失败：{}", e)))?;

        // [R10-download][已登记 FIX-QUEUE] 半包 fail-closed：FTP 数据通道的
        // EOF 与"传输完成"不可区分（连接被服务端/中间设备掐断同样表现为
        // EOF），实际字节数必须与 SIZE 声明一致（传输固定为 Binary 模式，
        // SIZE 即精确字节数），否则绝不把半包当成功。
        if downloaded != total_size {
            return Err(AppError::network(format!(
                "FTP 下载不完整：服务端声明 {total_size} 字节，实际收到 {downloaded} 字节，已拒绝保存（请重试）"
            )));
        }

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

    /// suppaftp v7 tokio: put_file(filename, reader) 接收远程文件名和一个 tokio::io::AsyncRead + Unpin 的 reader
    async fn put_file(
        &mut self,
        filename: &str,
        reader: &mut (impl AsyncRead + std::marker::Unpin),
        total_size: u64,
    ) -> Result<u64> {
        let limit = Self::transfer_timeout(total_size);
        match self {
            FtpClient::Plain(stream) => {
                Self::data_timeout("STOR", limit, async {
                    stream
                        .put_file(filename, reader)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e)))
                })
                .await
            }
            FtpClient::Secure(stream) => {
                Self::data_timeout("STOR", limit, async {
                    stream
                        .put_file(filename, reader)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 上传失败：{}", e)))
                })
                .await
            }
        }
    }

    /// suppaftp v7 tokio: 使用 retr_as_stream 获取数据流后用 ReadExt 逐块读取
    async fn retr_to_vec(&mut self, filename: &str) -> Result<Vec<u8>> {
        match self {
            FtpClient::Plain(stream) => {
                let mut data_stream = Self::data_timeout("RETR", FTP_DATA_TIMEOUT, async {
                    stream
                        .retr_as_stream(filename)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))
                })
                .await?;
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                loop {
                    let n = Self::read_with_timeout(&mut data_stream, &mut tmp).await?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                Self::data_timeout("RETR 收尾", FTP_DATA_TIMEOUT, async {
                    stream
                        .finalize_retr_stream(data_stream)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))
                })
                .await?;
                Ok(buf)
            }
            FtpClient::Secure(stream) => {
                let mut data_stream = Self::data_timeout("RETR", FTP_DATA_TIMEOUT, async {
                    stream
                        .retr_as_stream(filename)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))
                })
                .await?;
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                loop {
                    let n = Self::read_with_timeout(&mut data_stream, &mut tmp).await?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                Self::data_timeout("RETR 收尾", FTP_DATA_TIMEOUT, async {
                    stream
                        .finalize_retr_stream(data_stream)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))
                })
                .await?;
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
                let mut data_stream = Self::data_timeout("RETR", FTP_DATA_TIMEOUT, async {
                    stream
                        .retr_as_stream(filename)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))
                })
                .await?;
                let checksum =
                    Self::stream_to_file(&mut data_stream, temp_path, total_size, progress).await?;
                Self::data_timeout("RETR 收尾", FTP_DATA_TIMEOUT, async {
                    stream
                        .finalize_retr_stream(data_stream)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))
                })
                .await?;
                Ok(checksum)
            }
            FtpClient::Secure(stream) => {
                let mut data_stream = Self::data_timeout("RETR", FTP_DATA_TIMEOUT, async {
                    stream
                        .retr_as_stream(filename)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载失败：{}", e)))
                })
                .await?;
                let checksum =
                    Self::stream_to_file(&mut data_stream, temp_path, total_size, progress).await?;
                Self::data_timeout("RETR 收尾", FTP_DATA_TIMEOUT, async {
                    stream
                        .finalize_retr_stream(data_stream)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP 下载结束失败：{}", e)))
                })
                .await?;
                Ok(checksum)
            }
        }
    }

    /// suppaftp v7: list 返回 Result<Vec<String>>
    async fn list(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        match self {
            FtpClient::Plain(stream) => {
                Self::data_timeout("LIST", FTP_DATA_TIMEOUT, async {
                    stream
                        .list(path)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e)))
                })
                .await
            }
            FtpClient::Secure(stream) => {
                Self::data_timeout("LIST", FTP_DATA_TIMEOUT, async {
                    stream
                        .list(path)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP LIST 失败：{}", e)))
                })
                .await
            }
        }
    }

    async fn mlsd(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        match self {
            FtpClient::Plain(stream) => {
                Self::data_timeout("MLSD", FTP_DATA_TIMEOUT, async {
                    stream
                        .mlsd(path)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP MLSD 失败：{}", e)))
                })
                .await
            }
            FtpClient::Secure(stream) => {
                Self::data_timeout("MLSD", FTP_DATA_TIMEOUT, async {
                    stream
                        .mlsd(path)
                        .await
                        .map_err(|e| AppError::file_system(format!("FTP MLSD 失败：{}", e)))
                })
                .await
            }
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

    /// suppaftp v7: 删除文件的方法名是 rm
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

    /// suppaftp v7: size 返回 FtpResult<usize>，转为 u64
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

    /// suppaftp v7: mdtm 返回 FtpResult<NaiveDateTime>，转为 DateTime<Utc>
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

            let mut cursor = Cursor::new(data);
            self.upload_reader_atomic(&mut client, filename, &mut cursor, data.len() as u64, None)
                .await?;

            client.quit().await?;
            Ok(())
        })
        .await
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        // [R4-get-budget] 无预算旧入口：仅兜底默认预算，防止彻底无界。
        // 控制对象请改走 get_bounded 并由调用方传入硬预算。
        self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES).await
    }

    async fn get_bounded(&self, key: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
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

            // [R4-get-budget] SIZE 即声明长度：超出调用方预算先拒，不发 RETR、
            // 不读任何数据字节。预算错误优先于 quit 结果（quit 失败不得吞掉拒绝）。
            if let Err(budget_err) =
                ensure_declared_len_within_budget("FTP", key, Some(size), max_bytes)
            {
                let _ = client.quit().await;
                return Err(budget_err);
            }

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

            // 使用临时文件流式下载，避免大文件占用过多内存；
            // SIZE 已通过预算预检，且 stream_to_file 在超出声明大小时中途断流，
            // 因此读回内存的字节数不会超过 max_bytes。
            let temp_dir = std::env::temp_dir();
            let temp_file = tempfile::Builder::new()
                .prefix("ftp-get-")
                .tempfile_in(&temp_dir)
                .map_err(|e| AppError::file_system(format!("创建临时文件失败: {}", e)))?;
            let temp_path = temp_file.path().to_path_buf();

            let _checksum = client
                .retr_to_file(filename, &temp_path, size, None)
                .await?;

            // 读取临时文件内容
            let data = tokio::fs::read(&temp_path)
                .await
                .map_err(|e| AppError::file_system(format!("读取临时文件失败: {}", e)))?;

            // 清理临时文件
            let _ = tokio::fs::remove_file(&temp_path).await;

            client.quit().await?;
            Ok(Some(data))
        })
        .await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
        Ok(self.list_outcome(prefix).await?.files)
    }

    async fn list_outcome(&self, prefix: &str) -> Result<ListOutcome> {
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            client.cwd("/").await?;
            let mut files = Vec::new();
            let start = prefix.trim_matches('/').to_string();
            let mut dirs = vec![start];
            let mut visited_dirs = std::collections::HashSet::new();
            let mut truncated = false;

            while let Some(relative_dir) = dirs.pop() {
                if !visited_dirs.insert(relative_dir.clone()) {
                    continue;
                }
                if visited_dirs.len() > FTP_LIST_MAX_DIRS {
                    tracing::warn!(
                        "[FtpStorage] 递归列举已访问 {FTP_LIST_MAX_DIRS} 个目录，\
                         停止遍历并将结果标记为截断"
                    );
                    truncated = true;
                    break;
                }
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
                                return Err(list_err);
                            }
                        }
                    }
                };

                for raw in raw_entries {
                    let trimmed = raw.trim();
                    if trimmed.is_empty()
                        || trimmed
                            .strip_prefix("total ")
                            .is_some_and(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
                    {
                        continue;
                    }
                    let Some(entry) = Self::parse_list_entry(&raw) else {
                        return Err(AppError::network(format!(
                            "FTP 列表包含无法解析的条目，已拒绝把不完整结果当作成功: {}",
                            raw
                        )));
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
            files.sort_by_key(|b| std::cmp::Reverse(b.last_modified));
            Ok(ListOutcome { files, truncated })
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

            // 切换到文件所在目录。父目录不存在时目标文件必然不存在：
            // 与 S3/WebDAV 的幂等删除语义对齐（删除不存在的 key 视为成功），
            // 否则资产 tombstone 等对遗留路径的删除会在 FTP 上误报硬错误。
            // 无法归类为 not-found 的 CWD 失败（如权限问题）仍按真实错误上抛。
            let filename = key.rfind('/').map(|i| &key[i + 1..]).unwrap_or(key);
            if let Some(parent) = key.rfind('/') {
                let parent_path = &key[..parent];
                if !parent_path.is_empty() {
                    let full_parent = self.remote_path(parent_path);
                    if let Err(err) = client.cwd(&Self::absolute_path(&full_parent)).await {
                        if !Self::is_missing_directory_error(&err) {
                            return Err(err);
                        }
                        let _ = client.quit().await;
                        return Ok(());
                    }
                }
            }

            // suppaftp v7: 删除文件使用 rm
            match client.rm(filename).await {
                Ok(_) => {}
                Err(e) => {
                    // 文件不存在也算成功
                    if !Self::is_not_found_error(&e) {
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

            // 获取修改时间（mdtm 失败应按 not-found 处理）
            let modified = match client.mdtm(filename).await {
                Ok(dt) => dt,
                Err(err) => {
                    client.quit().await?;
                    if Self::is_not_found_error(&err) {
                        return Ok(None);
                    }
                    return Err(err);
                }
            };

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
        let progress_ref = &progress;
        let checksum = self
            .with_retry(|| async {
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

                if let Some(cb) = progress_ref.as_ref() {
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

                let mut file = tokio::fs::File::open(local_path)
                    .await
                    .map_err(|e| AppError::file_system(format!("打开文件失败：{}", e)))?;
                self.upload_reader_atomic(
                    &mut client,
                    filename,
                    &mut file,
                    file_size,
                    progress_ref.as_ref(),
                )
                .await?;

                client.quit().await?;

                Ok(checksum)
            })
            .await?;
        // STOR 成功不等于对象完整落地。核对放在重试环外，避免确定性短写连传三遍。
        let file_size = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| AppError::file_system(format!("读取文件元信息失败：{}", e)))?
            .len();
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
        self.with_retry(|| async {
            let mut client = self.create_client().await?;

            // 获取文件大小。[R10-download] stat=None 直接按 not-found 失败：
            // 原实现按 total_size=0 继续 RETR，与半包字节数校验冲突且语义不诚实。
            let total_size = match self.stat(key).await? {
                Some(info) => info.size,
                None => return Err(AppError::not_found("云端文件不存在")),
            };

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
            let temp_path = tempfile::Builder::new()
                .prefix("ftp-download-")
                .tempfile_in(local_path.parent().unwrap_or_else(|| Path::new(".")))
                .map_err(|e| AppError::file_system(format!("创建临时文件失败：{}", e)))?
                .into_temp_path();

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

            std::fs::File::open(&temp_path)
                .and_then(|file| file.sync_all())
                .map_err(|e| AppError::file_system(format!("同步下载文件失败：{}", e)))?;
            temp_path
                .persist(local_path)
                .map_err(|e| AppError::file_system(format!("保存文件失败：{}", e.error)))?;

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
    fn test_pyftpdlib_not_retrievable_is_not_found() {
        let error = AppError::file_system(
            "FTP SIZE 失败：Invalid response: [550] 550 /missing/file.txt is not retrievable.",
        );

        assert!(FtpStorage::is_not_found_error(&error));
    }

    #[test]
    fn test_not_found_whitelist_accepts_explicit_missing_messages() {
        for message in [
            "FTP SIZE 失败：Invalid response: [550] 550 No such file or directory.",
            "FTP MLSD 失败：Invalid response: [501] 501 No such directory.",
            "FTP CWD 失败：Invalid response: [550] 550 /a/b: No such file or directory",
            "FTP DELETE 失败：Invalid response: [550] 550 File not found.",
        ] {
            assert!(
                FtpStorage::is_not_found_error(&AppError::file_system(message)),
                "应归类为 not-found: {message}"
            );
        }
    }

    #[test]
    fn test_broad_not_found_substring_no_longer_matches() {
        // 无状态码门槛的宽泛 "not found" 不再把任意错误当成"文件不存在"
        for message in [
            "FTP DELETE 失败：object not found",
            "FTP CWD 失败：host not found",
            "连接失败：server not found in DNS",
            "FTP SIZE 失败：目标不存在",
        ] {
            assert!(
                !FtpStorage::is_not_found_error(&AppError::file_system(message)),
                "缺少状态码时不得归类为 not-found: {message}"
            );
        }
    }

    #[test]
    fn test_unclassifiable_550_is_not_treated_as_missing() {
        // 550 是多义状态码：无法确认"不存在"语义时必须按真实错误上抛，
        // 不能把权限/磁盘错误误判为删除成功或文件不存在
        for message in [
            "FTP DELETE 失败：Invalid response: [550] 550 Permission denied.",
            "FTP CWD 失败：Invalid response: [550] 550 Failed to change directory.",
            "FTP RM 失败：Invalid response: [550] 550 Requested action not taken.",
        ] {
            assert!(
                !FtpStorage::is_not_found_error(&AppError::file_system(message)),
                "无法归类的 550 不得当作 not-found: {message}"
            );
        }
    }

    #[test]
    fn explicit_missing_parent_directory_cwd_is_treated_as_absent() {
        for message in [
            "FTP CWD 失败：Invalid response: [550] 550 /root/data_governance/assets: No such file or directory",
            "FTP CWD 失败：Invalid response: [550] 550 Directory not found.",
            "FTP CWD 失败：Invalid response: [550] 550 410 Gone.",
        ] {
            let error = AppError::file_system(message);
            assert!(
                FtpStorage::is_missing_directory_error(&error),
                "expected {message} to be treated as a missing directory"
            );
        }
    }

    #[test]
    fn test_extract_status_code() {
        assert_eq!(
            FtpStorage::extract_status_code("invalid response: [550] 550 no such file"),
            Some(550)
        );
        assert_eq!(
            FtpStorage::extract_status_code("ftp cwd 失败：550 no such directory."),
            Some(550)
        );
        assert_eq!(FtpStorage::extract_status_code("object not found"), None);
        assert_eq!(FtpStorage::extract_status_code("connection reset"), None);
    }

    #[test]
    fn ambiguous_or_permission_denied_cwd_is_still_an_error() {
        for message in [
            "FTP CWD 失败：Invalid response: [550] 550 Failed to change directory.",
            "FTP CWD 失败：Invalid response: [550] 550 Permission denied.",
            "FTP CWD 失败：Invalid response: [550] 550 Requested action not taken.",
            "FTP CWD 失败：Invalid response: [450] 450 No such directory.",
            "FTP CWD 失败：Invalid response: [450] 450 /root/550: No such directory.",
        ] {
            let error = AppError::file_system(message);
            assert!(
                !FtpStorage::is_missing_directory_error(&error),
                "expected ambiguous or non-550 CWD failure to remain an error: {message}"
            );
        }
    }

    #[test]
    fn ftp_contract_source_guards() {
        let source = include_str!("ftp.rs");
        let production_source = source.split("#[cfg(test)]").next().unwrap_or(source);

        assert!(
            production_source.contains("suppaftp::tokio::AsyncRustlsConnector"),
            "FTP FTPS must use rustls"
        );
        assert!(
            production_source.contains("suppaftp::tokio::{AsyncFtpStream, AsyncRustlsFtpStream}"),
            "FTP must stay on suppaftp tokio backend"
        );
        assert!(
            !production_source.contains("async-std"),
            "FTP must not depend on async-std"
        );
        assert!(
            !production_source.contains("native-tls"),
            "FTP must not depend on native-tls"
        );
        assert!(
            !production_source.contains("openssl"),
            "FTP must not depend on openssl"
        );

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

        assert!(
            production_source.contains("async fn list_outcome"),
            "FTP list must expose truncation state via list_outcome"
        );
        assert!(
            production_source.contains("truncated = true"),
            "FTP list must mark traversal limits as truncated instead of \
             unconditionally reporting complete"
        );
        assert!(
            production_source.contains("FTP_LIST_MAX_DIRS"),
            "FTP recursive listing must be bounded by a directory limit"
        );

        assert!(
            !production_source.contains("err.contains(\"not found\")"),
            "not-found classification must not rely on the broad \"not found\" substring"
        );
        assert!(
            production_source.contains("fn extract_status_code"),
            "not-found classification must be gated on an FTP status-code whitelist"
        );

        assert!(
            production_source.contains("FTP_DATA_TIMEOUT"),
            "FTP data-channel operations must be bounded by tokio timeouts"
        );
        assert!(
            production_source.contains("fn transfer_timeout"),
            "FTP STOR uploads must have an overall timeout bound"
        );
        assert!(
            production_source.contains("read_with_timeout"),
            "FTP RETR reads must use idle timeouts to avoid passive-mode hangs"
        );
        assert!(
            production_source.contains("self.verify_remote_object_size(key, file_size)"),
            "FTP put_file must SIZE the remote object after STOR; transfer EOF is not enough"
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

        // [R4-get-budget] 预算三件套：SIZE 预检、越界断流、旧入口兜底预算。
        assert!(
            get_body.contains("async fn get_bounded(&self, key: &str, max_bytes: u64)"),
            "FTP 必须实现带调用方硬预算的 get_bounded"
        );
        assert!(
            get_body.contains("ensure_declared_len_within_budget(\"FTP\""),
            "FTP get_bounded 必须在发 RETR 前按 SIZE 预检调用方预算"
        );
        assert!(
            get_body.contains("self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)"),
            "FTP get() 旧入口必须走默认兜底预算，不得回到无界路径"
        );
        assert!(
            production_source.contains("if downloaded > total_size"),
            "FTP stream_to_file 必须在超出声明大小时中途断流，不得收满才拒"
        );
        assert!(
            production_source.contains("is_budget_exceeded_error(&e)"),
            "FTP with_retry 必须对预算超限错误短路，不得重试放大流量"
        );
    }

    // ============ [R10-download] stream_to_file 半包 fail-closed ============

    #[tokio::test]
    async fn stream_to_file_accepts_exact_size_and_returns_sha256() {
        use sha2::{Digest, Sha256};
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("exact.bin");

        let checksum =
            FtpClient::stream_to_file(&mut data.as_slice(), &dest, data.len() as u64, None)
                .await
                .expect("字节数与声明一致的下载应成功");

        let expected = format!("{:x}", Sha256::digest(&data));
        assert_eq!(checksum, expected);
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn stream_to_file_rejects_truncated_stream() {
        // 数据通道提前 EOF（半包）：声明 10_000 字节，只送到 4_096 字节。
        let data: Vec<u8> = (0..4_096u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("truncated.bin");

        let error = FtpClient::stream_to_file(&mut data.as_slice(), &dest, 10_000, None)
            .await
            .expect_err("半包必须失败，绝不当成功");
        assert!(
            error.to_string().contains("下载不完整"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn stream_to_file_rejects_oversized_stream() {
        // 服务端送来的字节数超过 SIZE 声明（对象被并发替换等错版本形态）。
        let data: Vec<u8> = vec![0x5A; 8_192];
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("oversized.bin");

        let error = FtpClient::stream_to_file(&mut data.as_slice(), &dest, 1_024, None)
            .await
            .expect_err("超过声明大小的流必须失败");
        assert!(
            error.to_string().contains("下载不完整"),
            "unexpected error: {error}"
        );
    }

    // ============ [R4-get-budget] GET 预算回归 ============

    /// 形态一（FTP 侧）：持续小块灌满超限——数据通道持续送来远超 SIZE 声明的
    /// 字节时，必须在越界后立即中断，而不是把 8 MiB 全部灌满磁盘才在 EOF 后拒绝。
    #[tokio::test]
    async fn stream_to_file_aborts_oversized_stream_midway() {
        let data: Vec<u8> = vec![0x42; 8 * 1024 * 1024];
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("flood.bin");

        let error = FtpClient::stream_to_file(&mut data.as_slice(), &dest, 1_024, None)
            .await
            .expect_err("超过声明大小必须中途断流");
        assert!(
            error.to_string().contains("下载不完整"),
            "unexpected error: {error}"
        );

        // 中途断流的证据：落盘字节数至多为声明大小 + 一个 64 KiB 读块，
        // 远小于灌入总量 8 MiB。
        let written = std::fs::metadata(&dest).unwrap().len();
        assert!(
            written <= 1_024 + 64 * 1024,
            "越界后仍在继续写盘：已写 {written} 字节（灌入 8 MiB）"
        );
    }

    /// 形态二（FTP 侧）：SIZE（声明长度）超预算的错误必须被归类为预算错误，
    /// 且 with_retry 对其短路——确定性拒绝不得重试放大（原本会整包重下三遍）。
    #[tokio::test]
    async fn with_retry_does_not_retry_budget_exceeded_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};

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

        // 真实预算错误来自共享预检 helper，保证与生产文案一致。
        let budget_error = || {
            ensure_declared_len_within_budget("FTP", "changes/huge.bin", Some(u64::MAX), 4_096)
                .expect_err("声明超预算必须报错")
        };
        assert!(
            FtpStorage::is_budget_exceeded_error(&budget_error()),
            "预算错误必须被标记判据命中"
        );
        assert!(
            !FtpStorage::is_budget_exceeded_error(&AppError::network(
                "FTP 下载不完整：服务端声明 10 字节，实际收到 4 字节".to_string()
            )),
            "普通网络/半包错误不得被误判为预算错误（它们仍应重试）"
        );

        let attempts = AtomicUsize::new(0);
        let result: Result<()> = storage
            .with_retry(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(budget_error())
            })
            .await;

        let err = result.expect_err("预算错误必须上抛");
        assert!(err.to_string().contains("超出调用方内存预算"));
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "预算超限是确定性拒绝，必须只尝试一次"
        );
    }
}
