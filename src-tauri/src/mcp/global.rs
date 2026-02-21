// MCP 全局客户端管理
use super::client::McpClient;
use super::config::McpConfig;
use super::types::{McpError, McpResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::sync::RwLock;

/// 全局 MCP 客户端实例
static GLOBAL_MCP_CLIENT: OnceLock<Arc<RwLock<Option<Arc<McpClient>>>>> = OnceLock::new();

/// 设置全局 MCP 客户端
pub fn set_global_mcp_client(client: Option<Arc<McpClient>>) {
    let global = GLOBAL_MCP_CLIENT.get_or_init(|| Arc::new(RwLock::new(None)));

    // 使用异步运行时设置客户端
    tokio::task::spawn(async move {
        let mut guard = global.write().await;
        *guard = client;
    });
}

/// 获取全局 MCP 客户端
pub async fn get_global_mcp_client() -> Option<Arc<McpClient>> {
    let global = GLOBAL_MCP_CLIENT.get_or_init(|| Arc::new(RwLock::new(None)));

    let guard = global.read().await;
    guard.clone()
}

/// 同步版本的获取全局 MCP 客户端（用于非异步上下文）
pub fn get_global_mcp_client_sync() -> Option<Arc<McpClient>> {
    let global = GLOBAL_MCP_CLIENT.get_or_init(|| Arc::new(RwLock::new(None)));

    // 使用 try_read 避免阻塞
    if let Ok(guard) = global.try_read() {
        guard.clone()
    } else {
        None
    }
}

/// 初始化全局 MCP 客户端
pub async fn initialize_global_mcp_client(config: McpConfig) -> McpResult<()> {
    use super::client::{
        ClientCapabilities, ClientInfo, McpClient, RootsCapability, SamplingCapability,
    };
    use super::transport::{Transport, WebSocketTransport};

    // 创建客户端信息
    let client_info = ClientInfo {
        name: "deep-student".to_string(),
        version: "1.0.0".to_string(),
        protocol_version: config.protocol_version.clone(),
        capabilities: ClientCapabilities {
            roots: Some(RootsCapability {
                list_changed: Some(true),
            }),
            sampling: Some(SamplingCapability { enabled: true }),
            experimental: None,
        },
    };

    // 创建传输层
    let transport: Box<dyn Transport> = match &config.transport {
        super::config::McpTransportConfig::Stdio {
            command,
            args,
            framing,
            env,
            working_dir,
            ..
        } => {
            log::info!(
                "Creating MCP stdio transport: {} {:?} (framing: {:?}, env vars: {})",
                command,
                args,
                framing,
                env.len()
            );

            let transport =
                create_stdio_transport(command, args, framing, env, working_dir.as_ref()).await?;
            Box::new(transport)
        }
        super::config::McpTransportConfig::WebSocket { url, env } => {
            log::info!(
                "Creating MCP websocket transport: {} with {} env vars",
                url,
                env.len()
            );
            // 注意：WebSocket连接的环境变量可能在客户端不直接使用，
            // 但可以用于一些初始化配置或认证
            let transport = WebSocketTransport::new(url.clone());
            if let Err(e) = transport.connect().await {
                return Err(McpError::ConnectionError(format!(
                    "WebSocket connect failed: {}",
                    e
                )));
            }
            Box::new(transport)
        }
        super::config::McpTransportConfig::SSE {
            endpoint,
            api_key,
            oauth,
            headers,
        } => {
            log::info!(
                "Creating MCP SSE transport: {} (auth: {})",
                endpoint,
                if api_key.is_some() {
                    "API key"
                } else if oauth.is_some() {
                    "OAuth"
                } else {
                    "none"
                }
            );

            use super::sse_transport::{SSEConfig, SSETransport};
            use reqwest::header::HeaderMap;

            let mut header_map = HeaderMap::new();
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, value);
                }
            }

            let sse_config = SSEConfig {
                endpoint: endpoint.clone(),
                api_key: api_key.clone(),
                oauth: oauth.clone().map(|o| super::sse_transport::OAuthConfig {
                    client_id: o.client_id,
                    auth_url: o.auth_url,
                    token_url: o.token_url,
                    redirect_uri: o.redirect_uri,
                    scopes: o.scopes,
                }),
                headers: header_map,
                timeout: config.timeout_duration(),
            };

            let transport = SSETransport::new(sse_config).await?;
            Box::new(transport)
        }
        super::config::McpTransportConfig::Http {
            url,
            api_key,
            oauth,
            headers,
        } => {
            log::info!(
                "Creating MCP HTTP transport: {} (auth: {})",
                url,
                if api_key.is_some() {
                    "API key"
                } else if oauth.is_some() {
                    "OAuth"
                } else {
                    "none"
                }
            );

            use super::http_transport::{HttpConfig, HttpTransport};
            use reqwest::header::HeaderMap;

            let mut header_map = HeaderMap::new();
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, value);
                }
            }

            let http_config = HttpConfig {
                url: url.clone(),
                api_key: api_key.clone(),
                oauth: oauth.clone().map(|o| super::http_transport::OAuthConfig {
                    client_id: o.client_id,
                    auth_url: o.auth_url,
                    token_url: o.token_url,
                    redirect_uri: o.redirect_uri,
                    scopes: o.scopes,
                }),
                headers: header_map,
                timeout: config.timeout_duration(),
            };

            let transport = HttpTransport::new(http_config).await?;
            transport.set_protocol_version(&config.protocol_version);
            Box::new(transport)
        }
        super::config::McpTransportConfig::StreamableHttp {
            url,
            api_key,
            oauth,
            headers,
        } => {
            log::info!(
                "Creating MCP Streamable HTTP transport: {} (auth: {})",
                url,
                if api_key.is_some() {
                    "API key"
                } else if oauth.is_some() {
                    "OAuth"
                } else {
                    "none"
                }
            );

            use super::http_transport::{HttpConfig, HttpTransport};
            use reqwest::header::HeaderMap;

            let mut header_map = HeaderMap::new();
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    header_map.insert(name, value);
                }
            }

            let http_config = HttpConfig {
                url: url.clone(),
                api_key: api_key.clone(),
                oauth: oauth.clone().map(|o| super::http_transport::OAuthConfig {
                    client_id: o.client_id,
                    auth_url: o.auth_url,
                    token_url: o.token_url,
                    redirect_uri: o.redirect_uri,
                    scopes: o.scopes,
                }),
                headers: header_map,
                timeout: config.timeout_duration(),
            };

            let transport = HttpTransport::new(http_config).await?;
            transport.set_protocol_version(&config.protocol_version);
            Box::new(transport)
        }
    };

    // 创建客户端
    let client = McpClient::with_options(
        transport,
        client_info,
        Box::new(super::client::DefaultNotificationHandler),
        config.timeout_duration(),
        config.performance.cache_max_size,
        config.resource_cache_duration(),
        config.performance.rate_limit_per_second,
    );

    // 连接并初始化
    client.connect().await.map_err(|e| {
        log::error!("Failed to connect MCP client: {}", e);
        e
    })?;

    let server_info = client.initialize().await.map_err(|e| {
        log::error!("Failed to initialize MCP client: {}", e);
        e
    })?;

    log::info!(
        "MCP client connected to server: {} v{}",
        server_info.name,
        server_info.version
    );

    // 设置全局客户端
    set_global_mcp_client(Some(Arc::new(client)));

    Ok(())
}

/// 关闭全局 MCP 客户端
pub async fn shutdown_global_mcp_client() -> McpResult<()> {
    if let Some(client) = get_global_mcp_client().await {
        log::info!("Shutting down MCP client");
        client.disconnect().await?;
    }

    set_global_mcp_client(None);
    Ok(())
}

/// 检查 MCP 是否可用
pub async fn is_mcp_available() -> bool {
    get_global_mcp_client().await.is_some()
}

/// 同步版本检查 MCP 是否可用
pub fn is_mcp_available_sync() -> bool {
    get_global_mcp_client_sync().is_some()
}

/// 创建实际的 stdio 传输实现
pub async fn create_stdio_transport(
    command: &str,
    args: &[String],
    framing: &super::config::McpFraming,
    env: &std::collections::HashMap<String, String>,
    working_dir: Option<&std::path::PathBuf>,
) -> McpResult<impl super::transport::Transport> {
    log::info!(
        "Spawning MCP process: {} {:?} with {} env vars",
        command,
        args,
        env.len()
    );

    // 启动 MCP 子进程
    let mut cmd = Command::new(command);
    cmd.kill_on_drop(true)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    // 添加环境变量
    for (key, value) in env {
        log::debug!("Setting MCP env var: {}={}", key, value);
        cmd.env(key, value);
    }

    let mut child = cmd.spawn().map_err(|e| {
        use std::io::ErrorKind;
        let mut message =
            format!("Failed to spawn process \"{}\": {}", command, e);
        if e.kind() == ErrorKind::NotFound {
            message.push_str(" — ensure the executable exists and is reachable via PATH. If you rely on Node.js tooling, install it and run \"npm install -g @modelcontextprotocol/server-filesystem\".");
        }
        McpError::TransportError(message)
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| McpError::TransportError("Failed to get stdin".to_string()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| McpError::TransportError("Failed to get stdout".to_string()))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| McpError::TransportError("Failed to get stderr".to_string()))?;

    // 创建消息通道
    let (send_tx, send_rx) = mpsc::unbounded_channel::<String>();
    let (recv_tx, recv_rx) = mpsc::unbounded_channel::<String>();

    // 启动 stdout 读取任务（根据分帧格式，支持自动回退）
    let recv_tx_clone = recv_tx.clone();
    let framing_format = framing.clone();
    tokio::spawn(async move {
        // 实现：如果在 JSONL 模式下侦测到以 Content-Length: 开头的行，则切换到 Content-Length 解帧
        match framing_format {
            super::config::McpFraming::JsonLines => {
                let mut reader = BufReader::new(stdout);
                let mut buffer = String::new();
                loop {
                    buffer.clear();
                    match reader.read_line(&mut buffer).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = buffer.trim_end().to_string();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if trimmed.starts_with("Content-Length:") {
                                log::warn!("MCP stdout indicates Content-Length framing while configured JSONL → fallback to Content-Length framing");
                                // 进入 Content-Length 解帧循环：当前已读的是第一行Header
                                // 将第一行header放入一个临时reader流中不容易，直接调用专用读取函数，已读取的header行会丢失，
                                // 但后续消息将按Content-Length正确解帧。
                                loop {
                                    match read_content_length_message(&mut reader).await {
                                        Ok(Some(message)) => {
                                            let _ = recv_tx_clone.send(message);
                                        }
                                        Ok(None) => break,
                                        Err(e) => {
                                            log::error!(
                                                "Error reading (fallback) Content-Length: {}",
                                                e
                                            );
                                            break;
                                        }
                                    }
                                }
                                break;
                            } else {
                                if recv_tx_clone.send(trimmed).is_err() {
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("Error reading from MCP stdout (JSONL): {}", e);
                            break;
                        }
                    }
                }
            }
            super::config::McpFraming::ContentLength => {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_content_length_message(&mut reader).await {
                        Ok(Some(message)) => {
                            if recv_tx_clone.send(message).is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::error!("Error reading from MCP stdout (Content-Length): {}", e);
                            break;
                        }
                    }
                }
            }
        }
        log::info!("MCP stdout reader terminated");
    });

    // 启动 stdin 写入任务（根据分帧格式）
    let framing_format_clone = framing.clone();
    tokio::spawn(async move {
        let mut writer = BufWriter::new(stdin);
        let mut send_rx = send_rx;
        while let Some(message) = send_rx.recv().await {
            match framing_format_clone {
                super::config::McpFraming::JsonLines => {
                    // JSONL 格式：直接写入消息 + 换行符
                    if let Err(e) = writer.write_all(message.as_bytes()).await {
                        log::error!("Error writing to MCP stdin (JSONL): {}", e);
                        break;
                    }
                    if let Err(e) = writer.write_all(b"\n").await {
                        log::error!("Error writing newline to MCP stdin (JSONL): {}", e);
                        break;
                    }
                }
                super::config::McpFraming::ContentLength => {
                    // Content-Length 格式：写入头部 + 空行 + 消息体
                    let content_length_frame = format_content_length_frame(&message);
                    if let Err(e) = writer.write_all(content_length_frame.as_bytes()).await {
                        log::error!("Error writing Content-Length frame to MCP stdin: {}", e);
                        break;
                    }
                }
            }
            if let Err(e) = writer.flush().await {
                log::error!("Error flushing MCP stdin: {}", e);
                break;
            }
        }
        log::info!("MCP stdin writer terminated");
    });

    // 启动 stderr 监控任务
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        log::warn!("MCP stderr: {}", trimmed);
                    }
                }
                Err(e) => {
                    log::error!("Error reading from MCP stderr: {}", e);
                    break;
                }
            }
        }
        log::info!("MCP stderr reader terminated");
    });

    // 将子进程句柄存入传输对象，close() 时负责终止
    Ok(ProcessStdioTransport::new(send_tx, recv_rx, child))
}

/// 基于进程的 stdio 传输实现
pub struct ProcessStdioTransport {
    send_tx: mpsc::UnboundedSender<String>,
    recv_rx: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<String>>>,
    connected: Arc<AtomicBool>,
    child: Arc<tokio::sync::Mutex<Option<Child>>>,
}

impl ProcessStdioTransport {
    fn new(
        send_tx: mpsc::UnboundedSender<String>,
        recv_rx: mpsc::UnboundedReceiver<String>,
        child: Child,
    ) -> Self {
        Self {
            send_tx,
            recv_rx: Arc::new(tokio::sync::Mutex::new(recv_rx)),
            connected: Arc::new(AtomicBool::new(true)),
            child: Arc::new(tokio::sync::Mutex::new(Some(child))),
        }
    }
}

#[async_trait::async_trait]
impl super::transport::Transport for ProcessStdioTransport {
    async fn send(&self, message: &str) -> McpResult<()> {
        self.send_tx
            .send(message.to_string())
            .map_err(|e| McpError::TransportError(format!("Send failed: {}", e)))?;
        Ok(())
    }

    async fn receive(&self) -> McpResult<String> {
        let mut recv_rx = self.recv_rx.lock().await;
        recv_rx
            .recv()
            .await
            .ok_or_else(|| McpError::TransportError("Channel closed".to_string()))
    }

    async fn close(&self) -> McpResult<()> {
        self.connected.store(false, Ordering::SeqCst);
        // MCP 规范要求的优雅关闭：先关闭 stdin → 等待退出 → SIGTERM → SIGKILL
        if let Some(mut child) = self.child.lock().await.take() {
            // Step 1: 尝试等待子进程自行退出（关闭 stdin 后子进程应检测到 EOF）
            // drop send_tx 已在外层处理（channel 关闭等价于关闭 stdin）
            match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!(
                        "MCP child process exited gracefully on close() with status: {:?}",
                        status
                    );
                    return Ok(());
                }
                Ok(Err(e)) => {
                    log::warn!("MCP child process wait error: {}", e);
                }
                Err(_) => {
                    log::info!("MCP child process did not exit within 3s, sending SIGTERM");
                }
            }

            // Step 2: 发送 SIGTERM（Unix）或直接 kill（Windows）
            #[cfg(unix)]
            {
                if let Some(pid) = child.id() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                    log::info!("Sent SIGTERM to MCP child process (pid={})", pid);
                }
                // 等待 SIGTERM 生效
                match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
                    Ok(Ok(status)) => {
                        log::info!(
                            "MCP child process exited after SIGTERM with status: {:?}",
                            status
                        );
                        return Ok(());
                    }
                    Ok(Err(e)) => {
                        log::warn!("MCP child process wait after SIGTERM error: {}", e);
                    }
                    Err(_) => {
                        log::warn!(
                            "MCP child process did not exit after SIGTERM within 5s, sending SIGKILL"
                        );
                    }
                }
            }

            // Step 3: 强制终止（SIGKILL / TerminateProcess）
            if let Err(e) = child.kill().await {
                log::warn!("Failed to kill MCP child process: {}", e);
            }
            if let Err(e) = child.wait().await {
                log::warn!("Failed to wait MCP child process after kill: {}", e);
            }
            log::info!("MCP child process terminated (forced) on close()");
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn transport_name(&self) -> &'static str {
        "stdio"
    }
}

/// 读取 Content-Length 格式的消息
async fn read_content_length_message(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<Option<String>, std::io::Error> {
    // 读取头部
    let mut headers = Vec::new();
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            return Ok(None); // EOF
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            // 空行表示头部结束
            break;
        }

        headers.push(trimmed.to_string());
    }

    // 解析 Content-Length 头
    let mut content_length = 0;
    for header in headers {
        if let Some(value) = header.strip_prefix("Content-Length: ") {
            content_length = value.trim().parse::<usize>().map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Invalid Content-Length value: {}", e),
                )
            })?;
            break;
        }
    }

    if content_length == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Missing or invalid Content-Length header",
        ));
    }

    // 最大消息大小限制（100MB）
    const MAX_MESSAGE_SIZE: usize = 100 * 1024 * 1024;
    if content_length > MAX_MESSAGE_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Message size {} exceeds maximum allowed size {}",
                content_length, MAX_MESSAGE_SIZE
            ),
        ));
    }

    // 读取消息体
    let mut buffer = vec![0; content_length];
    reader.read_exact(&mut buffer).await?;

    let message = String::from_utf8(buffer).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Invalid UTF-8 in message body: {}", e),
        )
    })?;

    Ok(Some(message))
}

/// 构造Content-Length格式的帧
pub fn format_content_length_frame(message: &str) -> String {
    let content_length = message.len();
    format!("Content-Length: {}\r\n\r\n{}", content_length, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_content_length_frame_basic() {
        let message = r#"{"jsonrpc":"2.0","id":1,"method":"test"}"#;
        let frame = format_content_length_frame(message);
        let expected = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
        assert_eq!(frame, expected);
    }

    #[test]
    fn test_format_content_length_frame_empty() {
        let message = "";
        let frame = format_content_length_frame(message);
        let expected = "Content-Length: 0\r\n\r\n";
        assert_eq!(frame, expected);
    }

    #[test]
    fn test_format_content_length_frame_unicode() {
        let message = r#"{"method":"测试","params":{"中文":"内容"}}"#;
        let frame = format_content_length_frame(message);
        let expected_length = message.len(); // 字节长度，不是字符长度
        let expected = format!("Content-Length: {}\r\n\r\n{}", expected_length, message);
        assert_eq!(frame, expected);

        // 验证中文字符的字节长度计算正确
        assert!(expected_length > 30); // 中文字符占用更多字节
    }

    #[test]
    fn test_format_content_length_frame_with_newlines() {
        let message = "{\n  \"method\": \"test\",\n  \"params\": {}\n}";
        let frame = format_content_length_frame(message);
        let expected = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
        assert_eq!(frame, expected);
    }
}
