// HTTP传输层实现 - 支持ModelScope MCP服务器
use super::transport::Transport;
use super::types::{McpError, McpResult};
use async_trait::async_trait;
use log::{debug, info};
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    Client,
};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, RwLock};

/// HTTP传输配置
#[derive(Clone)]
pub struct HttpConfig {
    pub url: String,
    pub api_key: Option<String>,
    pub oauth: Option<OAuthConfig>,
    /// 用于 OAuth token 查找的 server_id（与 api_key 互斥：api_key 优先）
    pub auth_provider: Option<String>,
    pub headers: HeaderMap,
    pub timeout: Duration,
}

impl std::fmt::Debug for HttpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpConfig")
            .field("url", &self.url)
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

/// HTTP传输实现
pub struct HttpTransport {
    config: HttpConfig,
    client: Client,
    session_id: Arc<RwLock<Option<String>>>,
    connected: Arc<AtomicBool>,
    inbound_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    inbound_tx: mpsc::UnboundedSender<String>,
    protocol_version: Arc<std::sync::RwLock<Option<String>>>,
}

impl HttpTransport {
    /// 创建新的HTTP传输
    pub async fn new(config: HttpConfig) -> McpResult<Self> {
        // 构建HTTP客户端
        let mut headers = config.headers.clone();

        // 认证优先级：api_key > oauth Bearer
        #[cfg(not(target_os = "android"))]
        {
            use super::auth::resolve_authorization_header;
            if let Some(auth) = resolve_authorization_header(
                config.auth_provider.as_deref(),
                &config.api_key,
                config.oauth.is_some(),
            )
            .await?
            {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&auth)
                        .map_err(|e| McpError::AuthenticationError(e.to_string()))?,
                );
            }
        }
        #[cfg(target_os = "android")]
        if let Some(api_key) = &config.api_key {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| McpError::AuthenticationError(e.to_string()))?,
            );
        }

        // 添加必需的Accept头（ModelScope要求）
        headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );

        let client = Client::builder()
            .timeout(config.timeout)
            .default_headers(headers)
            .build()
            .map_err(|e| McpError::TransportError(e.to_string()))?;

        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();

        let transport = Self {
            config,
            client,
            session_id: Arc::new(RwLock::new(None)),
            connected: Arc::new(AtomicBool::new(true)),
            inbound_rx: Arc::new(Mutex::new(inbound_rx)),
            inbound_tx,
            protocol_version: Arc::new(std::sync::RwLock::new(None)),
        };
        // 不在此处发送任何初始化请求。初始化交由 McpClient.initialize() 统一执行。
        Ok(transport)
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, message: &str) -> McpResult<()> {
        if !self.is_connected() {
            return Err(McpError::ConnectionError(
                "HTTP transport not connected".to_string(),
            ));
        }

        // 提取 method/id 用于日志与 session 处理
        let json_message: Value =
            serde_json::from_str(message).map_err(McpError::SerializationError)?;
        let method = json_message
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        debug!("HTTP MCP sending (method={}): {}", method, message);

        let mut request = self.client.post(&self.config.url);

        // 添加session_id头（如果有的话）
        if let Some(session_id) = self.session_id.read().await.as_ref() {
            request = request.header("Mcp-Session-Id", session_id);
        }
        if let Ok(guard) = self.protocol_version.read() {
            if let Some(protocol) = guard.clone() {
                request = request.header("Mcp-Protocol-Version", protocol);
            }
        }

        let response = request
            .json(&json_message)
            .send()
            .await
            .map_err(|e| McpError::TransportError(format!("Send request failed: {}", e)))?;

        let status = response.status();

        // 初始化响应可能会携带 session id
        if method == "initialize" {
            if let Some(session_id) = response
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
            {
                *self.session_id.write().await = Some(session_id.to_string());
                info!("HTTP MCP session ID: {}", session_id);
            }
        }

        if !status.is_success() {
            return Err(McpError::TransportError(format!(
                "Request failed with status: {}",
                status
            )));
        }

        let body = response
            .text()
            .await
            .map_err(|e| McpError::TransportError(format!("Failed to read response: {}", e)))?;

        // 路由响应给 receive()
        if let Err(_e) = self.inbound_tx.send(body.clone()) {
            // 如果没有接收者，返回错误更利于诊断
            return Err(McpError::TransportError(
                "HTTP inbound queue is closed".to_string(),
            ));
        }

        debug!("HTTP MCP message ok (status={} method={})", status, method);
        Ok(())
    }

    async fn receive(&self) -> McpResult<String> {
        let mut rx = self.inbound_rx.lock().await;
        rx.recv().await.ok_or_else(|| {
            McpError::TransportError(
                "HTTP传输未返回响应，检查Transport.receive实现或服务端行为".to_string(),
            )
        })
    }

    async fn close(&self) -> McpResult<()> {
        self.connected.store(false, Ordering::SeqCst);
        info!("HTTP MCP transport closed");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn transport_name(&self) -> &'static str {
        "http"
    }
}

impl HttpTransport {
    pub fn set_protocol_version(&self, version: &str) {
        let mut guard = self
            .protocol_version
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(version.to_string());
    }

    /// HTTP特有的发送并接收方法
    pub async fn send_and_receive(&self, message: &str) -> McpResult<String> {
        if !self.is_connected() {
            return Err(McpError::ConnectionError(
                "HTTP transport not connected".to_string(),
            ));
        }

        debug!("HTTP MCP send_and_receive: {}", message);

        let json_message: Value =
            serde_json::from_str(message).map_err(McpError::SerializationError)?;

        let mut request = self.client.post(&self.config.url);

        // 添加session_id头（如果有的话）
        if let Some(session_id) = self.session_id.read().await.as_ref() {
            request = request.header("Mcp-Session-Id", session_id);
        }
        if let Ok(guard) = self.protocol_version.read() {
            if let Some(protocol) = guard.clone() {
                request = request.header("Mcp-Protocol-Version", protocol);
            }
        }

        let response = request
            .json(&json_message)
            .send()
            .await
            .map_err(|e| McpError::TransportError(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            return Err(McpError::TransportError(format!(
                "Request failed with status: {}",
                response.status()
            )));
        }

        let body = response
            .text()
            .await
            .map_err(|e| McpError::TransportError(format!("Failed to read response: {}", e)))?;

        debug!("HTTP MCP response: {}", body);
        // 注意：不再推送到 inbound_tx，避免 receive() 读到重复消息。
        // send_and_receive 的调用方直接使用返回值即可。
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::auth::resolve_authorization_header;

    #[tokio::test]
    async fn test_http_config() {
        let config = HttpConfig {
            url: "https://example.com/mcp".to_string(),
            api_key: Some("test_key".to_string()),
            oauth: None,
            auth_provider: None,
            headers: HeaderMap::new(),
            timeout: Duration::from_secs(30),
        };

        assert_eq!(config.url, "https://example.com/mcp");
        assert!(config.api_key.is_some());
    }

    /// 连接前鉴权接线：与 HttpTransport::new 相同的 resolve 调用约定（无真实 socket）
    #[tokio::test]
    async fn http_auth_wiring_api_key_beats_oauth_flag() {
        let config = HttpConfig {
            url: "https://example.test/mcp".into(),
            api_key: Some("http-key".into()),
            oauth: Some(OAuthConfig {
                client_id: String::new(),
                auth_url: String::new(),
                token_url: String::new(),
                redirect_uri: "http://127.0.0.1/cb".into(),
                scopes: vec![],
            }),
            auth_provider: Some("global-mcp".into()),
            headers: HeaderMap::new(),
            timeout: Duration::from_secs(5),
        };
        let auth = resolve_authorization_header(
            config.auth_provider.as_deref(),
            &config.api_key,
            config.oauth.is_some(),
        )
        .await
        .unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer http-key"));
    }

    #[tokio::test]
    async fn http_auth_wiring_oauth_without_token_is_reauth() {
        let config = HttpConfig {
            url: "https://example.test/mcp".into(),
            api_key: None,
            oauth: Some(OAuthConfig {
                client_id: String::new(),
                auth_url: String::new(),
                token_url: String::new(),
                redirect_uri: "http://127.0.0.1/cb".into(),
                scopes: vec![],
            }),
            auth_provider: Some("http-missing-oauth-c7".into()),
            headers: HeaderMap::new(),
            timeout: Duration::from_secs(5),
        };
        let err = resolve_authorization_header(
            config.auth_provider.as_deref(),
            &config.api_key,
            config.oauth.is_some(),
        )
        .await
        .expect_err("oauth reauth");
        assert!(err.to_string().contains("OAuth re-authorization required"));
    }
}
