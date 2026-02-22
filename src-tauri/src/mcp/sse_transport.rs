// SSE传输层实现 - 支持魔搭hosted服务
use super::client::{McpError, McpResult, Transport};
use crate::utils::sse_buffer::SseLineBuffer;
use async_trait::async_trait;
use futures::stream::StreamExt;
use log::{debug, error, info, warn};
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    Client,
};
use reqwest_eventsource::{Event as SSEEvent, EventSource};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, RwLock};

/// SSE传输配置
#[derive(Clone)]
pub struct SSEConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub oauth: Option<OAuthConfig>,
    pub headers: HeaderMap,
    pub timeout: Duration,
}

impl std::fmt::Debug for SSEConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SSEConfig")
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("oauth", &self.oauth)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// OAuth配置
#[derive(Debug, Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub auth_url: String,
    pub token_url: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

/// SSE传输实现
pub struct SSETransport {
    config: SSEConfig,
    client: Client,
    session_id: Arc<RwLock<Option<String>>>,
    send_tx: mpsc::UnboundedSender<String>,
    recv_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    connected: Arc<AtomicBool>,
    buffer: Arc<Mutex<SseLineBuffer>>,
    /// 最后接收的事件ID，用于断线续传
    last_event_id: Arc<RwLock<Option<String>>>,
}

impl SSETransport {
    /// 创建新的SSE传输
    pub async fn new(config: SSEConfig) -> McpResult<Self> {
        // 构建HTTP客户端
        let mut headers = config.headers.clone();

        // 添加认证头
        if let Some(api_key) = &config.api_key {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| McpError::AuthenticationError(e.to_string()))?,
            );
        }

        let client = Client::builder()
            .timeout(config.timeout)
            .default_headers(headers)
            .build()
            .map_err(|e| McpError::TransportError(e.to_string()))?;

        // 创建消息通道
        let (send_tx, send_rx) = mpsc::unbounded_channel();
        let (recv_tx, recv_rx) = mpsc::unbounded_channel();

        let transport = Self {
            config,
            client,
            session_id: Arc::new(RwLock::new(None)),
            send_tx,
            recv_rx: Arc::new(Mutex::new(recv_rx)),
            connected: Arc::new(AtomicBool::new(false)),
            buffer: Arc::new(Mutex::new(SseLineBuffer::new())),
            last_event_id: Arc::new(RwLock::new(None)),
        };

        // 启动发送任务
        transport.start_send_task(send_rx);

        // 启动SSE接收任务
        transport.start_receive_task(recv_tx).await?;

        Ok(transport)
    }

    /// 启动发送任务
    fn start_send_task(&self, mut send_rx: mpsc::UnboundedReceiver<String>) {
        let client = self.client.clone();
        let endpoint = self.config.endpoint.clone();
        let session_id = self.session_id.clone();
        let wait_timeout = self.config.timeout; // 在首次发送前等待会话建立

        tokio::spawn(async move {
            while let Some(message) = send_rx.recv().await {
                // 发送前尽量等待会话ID（部分服务端要求）
                let start = std::time::Instant::now();
                loop {
                    let sid_ready = session_id.read().await.is_some();
                    if sid_ready || start.elapsed() >= wait_timeout {
                        break;
                    }
                    // 小步轮询，避免阻塞
                    drop(session_id.read().await);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }

                // 获取会话ID（若存在）
                let session = session_id.read().await;
                let mut request = client
                    .post(&endpoint)
                    .json(&serde_json::from_str::<Value>(&message).unwrap_or(json!({})));

                // 添加会话ID头（魔搭要求）
                if let Some(sid) = session.as_ref() {
                    request = request.header("Mcp-Session-Id", sid.as_str());
                }

                // 发送请求
                match request.send().await {
                    Ok(response) => {
                        if !response.status().is_success() {
                            error!("SSE send failed with status: {}", response.status());
                        } else {
                            debug!("SSE message sent successfully");
                        }
                    }
                    Err(e) => {
                        error!("SSE send error: {}", e);
                    }
                }
            }
            info!("SSE send task terminated");
        });
    }

    /// 启动SSE接收任务
    async fn start_receive_task(&self, recv_tx: mpsc::UnboundedSender<String>) -> McpResult<()> {
        let endpoint = self.config.endpoint.clone();
        let connected = self.connected.clone();
        let buffer = self.buffer.clone();
        let session_id = self.session_id.clone();
        let last_event_id = self.last_event_id.clone();
        let open_timeout = self.config.timeout; // 复用配置超时作为连接建立超时

        // 创建SSE连接（保留认证/自定义头）
        let client = {
            let mut headers = self.config.headers.clone();
            if let Some(api_key) = &self.config.api_key {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {}", api_key))
                        .map_err(|e| McpError::AuthenticationError(e.to_string()))?,
                );
            }
            reqwest::Client::builder()
                .default_headers(headers)
                .build()
                .map_err(|e| McpError::TransportError(e.to_string()))?
        };

        // 启动事件处理循环
        tokio::spawn(async move {
            // 显式声明 SSE Accept 头以提高兼容性
            let es_result =
                EventSource::new(client.get(&endpoint).header("Accept", "text/event-stream"));
            let mut es = match es_result {
                Ok(es) => es,
                Err(e) => {
                    error!("Failed to create EventSource: {:?}", e);
                    connected.store(false, Ordering::SeqCst);
                    return;
                }
            };
            let mut backoff_ms = 500u64;

            loop {
                match es.next().await {
                    Some(Ok(SSEEvent::Open)) => {
                        connected.store(true, Ordering::SeqCst);
                        backoff_ms = 500; // 重置退避时间
                        info!("SSE connection opened");
                    }
                    Some(Ok(SSEEvent::Message(msg))) => {
                        // 保存事件ID用于断线续传
                        if !msg.id.is_empty() {
                            *last_event_id.write().await = Some(msg.id.clone());
                        }

                        // 处理SSE消息
                        let mut buffer_guard = buffer.lock().await;
                        let lines = buffer_guard.process_chunk(&msg.data);

                        for line in lines {
                            // 解析SSE数据行
                            if let Some(data) = line.strip_prefix("data: ") {
                                if data.trim() == "[DONE]" {
                                    debug!("SSE stream done marker received");
                                    continue;
                                }

                                // 检查是否是会话ID
                                if let Ok(json_data) = serde_json::from_str::<Value>(data) {
                                    if let Some(sid) =
                                        json_data.get("sessionId").and_then(|v| v.as_str())
                                    {
                                        *session_id.write().await = Some(sid.to_string());
                                        info!("SSE session ID: {}", sid);
                                    }
                                }

                                if recv_tx.send(data.to_string()).is_err() {
                                    warn!("SSE receiver dropped");
                                    break;
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        error!("SSE error: {:?}", e);
                        connected.store(false, Ordering::SeqCst);

                        // 指数退避重连
                        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(30_000);

                        // 尝试重新创建连接，携带 Last-Event-ID 以支持断线续传
                        let mut reconnect_request =
                            client.get(&endpoint).header("Accept", "text/event-stream");

                        // 添加 Last-Event-ID 头以恢复断点
                        if let Some(last_id) = last_event_id.read().await.as_ref() {
                            reconnect_request = reconnect_request.header("Last-Event-ID", last_id);
                            info!("SSE reconnecting with Last-Event-ID: {}", last_id);
                        }

                        match EventSource::new(reconnect_request) {
                            Ok(new_es) => {
                                es = new_es;
                                info!("SSE reconnecting...");
                            }
                            Err(e) => {
                                error!("SSE reconnect failed: {:?}", e);
                                break;
                            }
                        }
                    }
                    None => {
                        info!("SSE stream ended");
                        break;
                    }
                }
            }

            connected.store(false, Ordering::SeqCst);
            warn!("SSE receive task terminated");
        });

        // 等待连接建立（使用可配置超时，默认与请求超时一致）
        let start = std::time::Instant::now();
        let poll_interval = Duration::from_millis(200);
        while !self.connected.load(Ordering::SeqCst) {
            if start.elapsed() >= open_timeout {
                break;
            }
            tokio::time::sleep(poll_interval).await;
        }

        if !self.connected.load(Ordering::SeqCst) {
            return Err(McpError::ConnectionError(
                "SSE connection timeout".to_string(),
            ));
        }

        Ok(())
    }

    /// 执行OAuth 2.1认证流程（支持PKCE）
    /// Android 平台不支持 OAuth2（需要 native-tls），请使用 API Key 认证
    ///
    /// NOTE: OAuth 2.1 interactive flow 尚未完整实现（需要打开浏览器 + 处理回调）。
    /// 当前直接返回错误，引导用户使用 API Key 认证。
    #[cfg(not(target_os = "android"))]
    pub async fn perform_oauth_authentication(_oauth: &OAuthConfig) -> McpResult<String> {
        // SECURITY: 不返回 mock token，防止使用虚假凭据访问受保护资源。
        // 完整 OAuth 2.1 流程需要：1) 打开浏览器跳转授权 URL  2) 处理 redirect_uri 回调
        // 3) 用 authorization code + PKCE verifier 换取 access_token。
        // 此功能待后续版本实现。
        error!("OAuth 2.1 authentication flow is not yet implemented. Please use API Key authentication.");
        Err(McpError::AuthenticationError(
            "OAuth 2.1 interactive flow is not yet implemented. Please configure an API Key instead.".to_string()
        ))
    }

    /// Android 平台的 OAuth 替代实现：返回错误提示使用 API Key
    #[cfg(target_os = "android")]
    pub async fn perform_oauth_authentication(_oauth: &OAuthConfig) -> McpResult<String> {
        Err(McpError::AuthenticationError(
            "OAuth2 authentication is not supported on Android. Please use API Key authentication instead.".to_string()
        ))
    }
}

#[async_trait]
impl Transport for SSETransport {
    async fn send(&self, message: &str) -> McpResult<()> {
        if !self.is_connected() {
            return Err(McpError::ConnectionError("SSE not connected".to_string()));
        }

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
            .ok_or_else(|| McpError::TransportError("SSE channel closed".to_string()))
    }

    async fn close(&self) -> McpResult<()> {
        self.connected.store(false, Ordering::SeqCst);

        // 清理会话
        if let Some(session_id) = self.session_id.read().await.as_ref() {
            // 发送DELETE请求终止会话
            let _ = self
                .client
                .delete(&self.config.endpoint)
                .header("Mcp-Session-Id", session_id)
                .send()
                .await;
        }

        info!("SSE transport closed");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn transport_name(&self) -> &'static str {
        "sse"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sse_config() {
        let config = SSEConfig {
            endpoint: "https://modelscope.cn/api/v1/mcp/sse".to_string(),
            api_key: Some("test_key".to_string()),
            oauth: None,
            headers: HeaderMap::new(),
            timeout: Duration::from_secs(30),
        };

        assert_eq!(config.endpoint, "https://modelscope.cn/api/v1/mcp/sse");
        assert!(config.api_key.is_some());
    }
}
