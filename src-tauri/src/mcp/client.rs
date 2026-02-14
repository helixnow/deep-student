// mcp_client.rs - 完整的MCP客户端实现
// 用于连接和交互MCP工具服务器

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::sink::SinkExt;
use futures::stream::{Stream, StreamExt};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

// ==================== 错误定义 ====================

#[derive(Error, Debug)]
pub enum McpError {
    #[error("Connection error: {0}")]
    ConnectionError(String),

    #[error("Protocol error: {0}")]
    ProtocolError(String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Timeout error: {0}")]
    TimeoutError(String),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Server error: {0}")]
    ServerError(String),

    #[error("Transport error: {0}")]
    TransportError(String),

    #[error("Resource not found: {0}")]
    ResourceNotFound(String),

    #[error("Tool not found: {0}")]
    ToolNotFound(String),

    #[error("Prompt not found: {0}")]
    PromptNotFound(String),

    #[error("Authentication error: {0}")]
    AuthenticationError(String),

    #[error("Rate limit exceeded")]
    RateLimitExceeded,

    #[error("Internal error: {0}")]
    InternalError(String),

    #[error("Tool execution error: {0}")]
    ToolExecutionError(String),

    #[error("Message too large: {0}")]
    MessageTooLarge(String),
}

pub type McpResult<T> = Result<T, McpError>;

// ==================== 基础类型定义 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    pub params: Option<Value>,
    pub id: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
    pub id: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Option<Value>,
}

// ==================== MCP协议类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    pub tools: Option<ToolsCapability>,
    pub resources: Option<ResourcesCapability>,
    pub prompts: Option<PromptsCapability>,
    pub logging: Option<LoggingCapability>,
    pub experimental: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsCapability {
    pub list_changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourcesCapability {
    pub list_changed: Option<bool>,
    pub subscribe: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptsCapability {
    pub list_changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingCapability {
    pub levels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {
    pub roots: Option<RootsCapability>,
    pub sampling: Option<SamplingCapability>,
    pub experimental: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootsCapability {
    pub list_changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingCapability {
    pub enabled: bool,
}

// ==================== 工具相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub content: Vec<Content>,
    pub is_error: Option<bool>,
}

// ==================== 资源相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub uri: String,
    pub name: String,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceContent {
    pub uri: String,
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub blob: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceTemplate {
    pub uri_template: String,
    pub name: String,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

// ==================== 提示相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub name: String,
    pub description: Option<String>,
    pub arguments: Option<Vec<PromptArgument>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptArgument {
    pub name: String,
    pub description: Option<String>,
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptMessage {
    pub role: String,
    pub content: Content,
}

// ==================== 内容类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "image")]
    Image { data: String, mime_type: String },

    #[serde(rename = "resource")]
    Resource { resource: ResourceContent },
}

// ==================== 采样相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingMessage {
    pub role: String,
    pub content: Content,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageRequest {
    pub messages: Vec<SamplingMessage>,
    pub model_preferences: Option<ModelPreferences>,
    pub system_prompt: Option<String>,
    pub include_context: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i32>,
    pub stop_sequences: Option<Vec<String>>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPreferences {
    pub hints: Option<Vec<ModelHint>>,
    pub cost_priority: Option<f64>,
    pub speed_priority: Option<f64>,
    pub intelligence_priority: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelHint {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageResult {
    pub content: Content,
    pub model: String,
    pub role: String,
    pub stop_reason: Option<String>,
}

// ==================== 日志相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub level: LogLevel,
    pub logger: Option<String>,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warning,
    Error,
    Critical,
}

// ==================== 根目录相关类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Root {
    pub uri: String,
    pub name: Option<String>,
}

// ==================== 传输层trait ====================

#[async_trait]
pub trait Transport: Send + Sync {
    async fn send(&self, message: &str) -> McpResult<()>;
    async fn receive(&self) -> McpResult<String>;
    async fn close(&self) -> McpResult<()>;
    fn is_connected(&self) -> bool;
    fn transport_name(&self) -> &'static str {
        "unknown"
    }
}

// ==================== Stdio传输实现 ====================

pub struct StdioTransport {
    stdin_rx: Arc<Mutex<mpsc::UnboundedReceiver<String>>>,
    stdout_tx: Arc<Mutex<mpsc::UnboundedSender<String>>>,
    connected: Arc<AtomicBool>,
}

impl StdioTransport {
    pub fn new() -> (
        Self,
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedReceiver<String>,
    ) {
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();

        let transport = Self {
            stdin_rx: Arc::new(Mutex::new(stdin_rx)),
            stdout_tx: Arc::new(Mutex::new(stdout_tx)),
            connected: Arc::new(AtomicBool::new(true)),
        };

        (transport, stdin_tx, stdout_rx)
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn send(&self, message: &str) -> McpResult<()> {
        let tx = self.stdout_tx.lock().await;
        tx.send(message.to_string())
            .map_err(|e| McpError::TransportError(e.to_string()))?;
        Ok(())
    }

    async fn receive(&self) -> McpResult<String> {
        let mut rx = self.stdin_rx.lock().await;
        rx.recv()
            .await
            .ok_or_else(|| McpError::TransportError("Channel closed".to_string()))
    }

    async fn close(&self) -> McpResult<()> {
        self.connected.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn transport_name(&self) -> &'static str {
        "stdio"
    }
}

// ==================== WebSocket传输实现 ====================

pub struct WebSocketTransport {
    url: String,
    outbound_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    inbound_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    connected: Arc<AtomicBool>,
    manager_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl WebSocketTransport {
    pub fn new(url: String) -> Self {
        Self {
            url,
            outbound_tx: Arc::new(Mutex::new(None)),
            inbound_rx: Arc::new(Mutex::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            manager_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn connect(&self) -> McpResult<()> {
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::protocol::Message;
        let url = self.url.clone();
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<String>();

        *self.outbound_tx.lock().await = Some(outbound_tx);
        *self.inbound_rx.lock().await = Some(inbound_rx);

        let connected = self.connected.clone();
        let url_for_task = url.clone();
        let manager = tokio::spawn(async move {
            let mut backoff_ms = 500u64;
            loop {
                match connect_async(&url_for_task).await {
                    Ok((ws_stream, _)) => {
                        connected.store(true, Ordering::SeqCst);
                        let (mut write, mut read) = ws_stream.split();
                        // Heartbeat
                        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                        loop {
                            tokio::select! {
                                biased;
                                // Outbound application messages
                                maybe_msg = outbound_rx.recv() => {
                                    match maybe_msg {
                                        Some(txt) => {
                                            if let Err(e) = write.send(Message::Text(txt)).await {
                                                error!("MCP WS send error: {}", e);
                                                break;
                                            }
                                        }
                                        None => { break; }
                                    }
                                }
                                // Inbound WS frames
                                inbound = read.next() => {
                                    match inbound {
                                        Some(Ok(Message::Text(txt))) => { let _ = inbound_tx.send(txt); }
                                        Some(Ok(Message::Binary(bin))) => {
                                            // Assume UTF-8 JSON if server sends binary
                                            if let Ok(txt) = String::from_utf8(bin) { let _ = inbound_tx.send(txt); }
                                        }
                                        Some(Ok(Message::Ping(p))) => {
                                            // Respond with Pong
                                            if let Err(e) = write.send(Message::Pong(p)).await { error!("MCP WS pong error: {}", e); break; }
                                        }
                                        Some(Ok(Message::Pong(_))) => { /* ignore */ }
                                        Some(Ok(Message::Frame(_))) => { /* ignore */ }
                                        Some(Ok(Message::Close(_))) => { break; }
                                        Some(Err(e)) => { error!("MCP WS read error: {}", e); break; }
                                        None => { break; }
                                    }
                                }
                                _ = heartbeat.tick() => {
                                    if let Err(e) = write.send(Message::Ping(Vec::new())).await {
                                        error!("MCP WS heartbeat error: {}", e);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("MCP WS connect error: {}", e);
                    }
                }
                connected.store(false, Ordering::SeqCst);
                // Exponential backoff for reconnect
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(10_000);
            }
        });
        *self.manager_handle.lock().await = Some(manager);
        Ok(())
    }
}

#[async_trait]
impl Transport for WebSocketTransport {
    async fn send(&self, message: &str) -> McpResult<()> {
        let tx_guard = self.outbound_tx.lock().await;
        if let Some(tx) = tx_guard.as_ref() {
            tx.send(message.to_string())
                .map_err(|e| McpError::TransportError(e.to_string()))?;
            Ok(())
        } else {
            Err(McpError::TransportError("Not connected".to_string()))
        }
    }

    async fn receive(&self) -> McpResult<String> {
        let mut rx_guard = self.inbound_rx.lock().await;
        if let Some(rx) = rx_guard.as_mut() {
            rx.recv()
                .await
                .ok_or_else(|| McpError::TransportError("Channel closed".to_string()))
        } else {
            Err(McpError::TransportError("Not connected".to_string()))
        }
    }

    async fn close(&self) -> McpResult<()> {
        self.connected.store(false, Ordering::SeqCst);
        *self.outbound_tx.lock().await = None;
        *self.inbound_rx.lock().await = None;
        if let Some(handle) = self.manager_handle.lock().await.take() {
            handle.abort();
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn transport_name(&self) -> &'static str {
        "websocket"
    }
}

// ==================== 请求管理器 ====================

struct PendingRequest {
    tx: oneshot::Sender<McpResult<JsonRpcResponse>>,
    created_at: SystemTime,
}

pub struct RequestManager {
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    timeout_duration: Duration,
}

impl RequestManager {
    pub fn new(timeout_duration: Duration) -> Self {
        let pending = Arc::new(Mutex::new(HashMap::<String, PendingRequest>::new()));
        let pending_clone = pending.clone();

        // 启动超时清理任务：主动通知等待方请求已超时，而非仅静默移除
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                let mut pending = pending_clone.lock().await;
                let now = SystemTime::now();
                let expired_keys: Vec<String> = pending
                    .iter()
                    .filter(|(_, req)| {
                        now.duration_since(req.created_at).unwrap_or_default() >= timeout_duration
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in expired_keys {
                    if let Some(req) = pending.remove(&key) {
                        let _ = req.tx.send(Err(McpError::TimeoutError(
                            "Request expired during periodic cleanup".to_string(),
                        )));
                    }
                }
            }
        });

        Self {
            pending,
            timeout_duration,
        }
    }

    pub async fn register_request(
        &self,
        id: String,
    ) -> oneshot::Receiver<McpResult<JsonRpcResponse>> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        pending.insert(
            id,
            PendingRequest {
                tx,
                created_at: SystemTime::now(),
            },
        );
        rx
    }

    pub async fn complete_request(&self, id: String, response: McpResult<JsonRpcResponse>) {
        let mut pending = self.pending.lock().await;
        if let Some(request) = pending.remove(&id) {
            let _ = request.tx.send(response);
        }
    }

    pub async fn cancel_request(&self, id: &str) {
        let mut pending = self.pending.lock().await;
        if let Some(request) = pending.remove(id) {
            let _ = request
                .tx
                .send(Err(McpError::TimeoutError("Request cancelled".to_string())));
        }
    }
}

// ==================== 通知处理器 ====================

#[async_trait]
pub trait NotificationHandler: Send + Sync {
    async fn handle_notification(&self, method: &str, params: Option<Value>);
}

pub struct DefaultNotificationHandler;

#[async_trait]
impl NotificationHandler for DefaultNotificationHandler {
    async fn handle_notification(&self, method: &str, params: Option<Value>) {
        debug!(
            "Received notification: {} with params: {:?}",
            method, params
        );
    }
}

// ==================== 流式结果管理器 ====================

struct StreamManager {
    inner: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<McpResult<Content>>>>>,
}

impl StreamManager {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    async fn register(&self, id: String, tx: mpsc::UnboundedSender<McpResult<Content>>) {
        self.inner.lock().await.insert(id, tx);
    }
    async fn push(&self, id: &str, item: McpResult<Content>) {
        if let Some(tx) = self.inner.lock().await.get(id) {
            let _ = tx.send(item);
        }
    }
    async fn complete(&self, id: &str) {
        self.inner.lock().await.remove(id);
    }
}

// ==================== 会话管理 ====================

pub struct Session {
    pub id: String,
    pub server_info: Option<ServerInfo>,
    pub client_info: ClientInfo,
    pub initialized: bool,
    pub created_at: SystemTime,
    pub metadata: HashMap<String, Value>,
}

impl Session {
    pub fn new(client_info: ClientInfo) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            server_info: None,
            client_info,
            initialized: false,
            created_at: SystemTime::now(),
            metadata: HashMap::new(),
        }
    }
}

// ==================== 资源缓存 ====================

pub struct ResourceCache {
    cache: Arc<RwLock<HashMap<String, CachedResource>>>,
    max_size: usize,
    ttl: Duration,
}

struct CachedResource {
    content: ResourceContent,
    cached_at: SystemTime,
    access_count: usize,
}

impl ResourceCache {
    pub fn new(max_size: usize, ttl: Duration) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            max_size,
            ttl,
        }
    }

    pub async fn get(&self, uri: &str) -> Option<ResourceContent> {
        let mut cache = self.cache.write().await;
        if let Some(cached) = cache.get_mut(uri) {
            let now = SystemTime::now();
            if now.duration_since(cached.cached_at).unwrap_or_default() < self.ttl {
                cached.access_count += 1;
                return Some(cached.content.clone());
            } else {
                cache.remove(uri);
            }
        }
        None
    }

    pub async fn put(&self, uri: String, content: ResourceContent) {
        let mut cache = self.cache.write().await;

        // 如果缓存已满，移除最少访问的项
        if cache.len() >= self.max_size {
            if let Some(key_to_remove) = cache
                .iter()
                .min_by_key(|(_, v)| v.access_count)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&key_to_remove);
            }
        }

        cache.insert(
            uri,
            CachedResource {
                content,
                cached_at: SystemTime::now(),
                access_count: 0,
            },
        );
    }

    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }
}

// ==================== 速率限制器 ====================

pub struct RateLimiter {
    requests_per_second: usize,
    window: Arc<Mutex<Vec<SystemTime>>>,
}

impl RateLimiter {
    pub fn new(requests_per_second: usize) -> Self {
        Self {
            requests_per_second,
            window: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn check_rate_limit(&self) -> McpResult<()> {
        let mut window = self.window.lock().await;
        let now = SystemTime::now();
        let one_second_ago = now - Duration::from_secs(1);

        // 移除一秒前的请求
        window.retain(|&time| time > one_second_ago);

        if window.len() >= self.requests_per_second {
            return Err(McpError::RateLimitExceeded);
        }

        window.push(now);
        Ok(())
    }
}

// ==================== 事件系统 ====================

#[derive(Debug, Clone)]
pub enum McpEvent {
    Connected,
    Disconnected,
    ServerInfoReceived(ServerInfo),
    ToolsChanged,
    ResourcesChanged,
    PromptsChanged,
    RootsChanged,
    Error(String),
}

pub type EventHandler = Arc<dyn Fn(McpEvent) + Send + Sync>;

pub struct EventEmitter {
    handlers: Arc<RwLock<Vec<EventHandler>>>,
}

impl EventEmitter {
    pub fn new() -> Self {
        Self {
            handlers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn on(&self, handler: EventHandler) {
        let mut handlers = self.handlers.write().await;
        handlers.push(handler);
    }

    pub async fn emit(&self, event: McpEvent) {
        let handlers = self.handlers.read().await;
        for handler in handlers.iter() {
            handler(event.clone());
        }
    }
}

// ==================== MCP客户端主体 ====================

pub struct McpClient {
    transport: Arc<Box<dyn Transport>>,
    session: Arc<RwLock<Session>>,
    request_manager: Arc<RequestManager>,
    notification_handler: Arc<Box<dyn NotificationHandler>>,
    resource_cache: Arc<ResourceCache>,
    rate_limiter: Arc<RateLimiter>,
    event_emitter: Arc<EventEmitter>,
    message_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    stream_manager: Arc<StreamManager>,
}

impl McpClient {
    pub fn new(transport: Box<dyn Transport>, client_info: ClientInfo) -> Self {
        Self::with_options(
            transport,
            client_info,
            Box::new(DefaultNotificationHandler),
            Duration::from_secs(30),
            100,
            Duration::from_secs(300),
            10,
        )
    }

    pub fn with_options(
        transport: Box<dyn Transport>,
        client_info: ClientInfo,
        notification_handler: Box<dyn NotificationHandler>,
        request_timeout: Duration,
        cache_max_size: usize,
        cache_ttl: Duration,
        rate_limit: usize,
    ) -> Self {
        Self {
            transport: Arc::new(transport),
            session: Arc::new(RwLock::new(Session::new(client_info))),
            request_manager: Arc::new(RequestManager::new(request_timeout)),
            notification_handler: Arc::new(notification_handler),
            resource_cache: Arc::new(ResourceCache::new(cache_max_size, cache_ttl)),
            rate_limiter: Arc::new(RateLimiter::new(rate_limit)),
            event_emitter: Arc::new(EventEmitter::new()),
            message_rx: Arc::new(Mutex::new(None)),
            shutdown_tx: Arc::new(Mutex::new(None)),
            stream_manager: Arc::new(StreamManager::new()),
        }
    }

    // ==================== 连接管理 ====================

    pub async fn connect(&self) -> McpResult<()> {
        if !self.transport.is_connected() {
            return Err(McpError::ConnectionError(
                "Transport not connected".to_string(),
            ));
        }

        // 启动消息接收任务
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        let transport = self.transport.clone();
        let request_manager = self.request_manager.clone();
        let notification_handler = self.notification_handler.clone();
        let event_emitter = self.event_emitter.clone();
        let stream_manager = self.stream_manager.clone();
        info!("MCP message loop starting (timeout_ms={}, cache_max_size={}, cache_ttl_ms={}, rate_limit={})",
              self.request_manager.timeout_duration.as_millis(),
              self.resource_cache.max_size,
              self.resource_cache.ttl.as_millis(),
              self.rate_limiter.requests_per_second);

        tokio::spawn(async move {
            Self::message_loop(
                transport,
                request_manager,
                notification_handler,
                event_emitter,
                stream_manager,
                shutdown_rx,
            )
            .await;
        });

        self.event_emitter.emit(McpEvent::Connected).await;
        Ok(())
    }

    pub async fn disconnect(&self) -> McpResult<()> {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }

        self.transport.close().await?;
        self.event_emitter.emit(McpEvent::Disconnected).await;
        Ok(())
    }

    async fn message_loop(
        transport: Arc<Box<dyn Transport>>,
        request_manager: Arc<RequestManager>,
        notification_handler: Arc<Box<dyn NotificationHandler>>,
        event_emitter: Arc<EventEmitter>,
        stream_manager: Arc<StreamManager>,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        let mut last_error: Option<String> = None;
        let mut attempt: usize = 0;
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                result = transport.receive() => {
                    match result {
                        Ok(message) => {
                            attempt = 0; // reset
                            if let Err(e) = Self::handle_message(
                                &message,
                                request_manager.clone(),
                                notification_handler.clone(),
                                event_emitter.clone(),
                                stream_manager.clone(),
                            ).await {
                                error!("MCP handle_message error: {}", e);
                            }
                        }
                        Err(e) => {
                            let err_str = e.to_string();
                            attempt += 1;
                            error!("MCP receive error: {} (attempt={})", err_str, attempt);
                            event_emitter.emit(McpEvent::Error(err_str.clone())).await;
                            last_error = Some(err_str);
                            break;
                        }
                    }
                }
            }
        }
        if let Some(err) = last_error {
            warn!("MCP message loop exited due to error: {}", err);
        } else {
            info!("MCP message loop exited normally");
        }
    }

    async fn handle_message(
        message: &str,
        request_manager: Arc<RequestManager>,
        notification_handler: Arc<Box<dyn NotificationHandler>>,
        event_emitter: Arc<EventEmitter>,
        stream_manager: Arc<StreamManager>,
    ) -> McpResult<()> {
        // 尝试解析为响应
        if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(message) {
            if let Some(id) = response.id.as_ref() {
                let id_str = match id {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => return Ok(()),
                };
                request_manager.complete_request(id_str, Ok(response)).await;
            }
        }
        // 尝试解析为通知
        else if let Ok(notification) = serde_json::from_str::<JsonRpcNotification>(message) {
            let params_for_handler = notification.params.clone();
            notification_handler
                .handle_notification(&notification.method, params_for_handler)
                .await;

            // 处理特定通知
            match notification.method.as_str() {
                "tools/list_changed" => {
                    event_emitter.emit(McpEvent::ToolsChanged).await;
                }
                "tools/call_output" | "tools/call_progress" | "tools/call_chunk" => {
                    if let Some(params) = notification.params {
                        let id_opt = params
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            });
                        if let Some(id) = id_opt {
                            if let Some(content_val) = params.get("content") {
                                if let Ok(content) =
                                    serde_json::from_value::<Content>(content_val.clone())
                                {
                                    stream_manager.push(&id, Ok(content)).await;
                                } else if let Some(text) =
                                    content_val.get("text").and_then(|x| x.as_str())
                                {
                                    stream_manager
                                        .push(
                                            &id,
                                            Ok(Content::Text {
                                                text: text.to_string(),
                                            }),
                                        )
                                        .await;
                                }
                            }
                        }
                    }
                }
                "resources/list_changed" => {
                    event_emitter.emit(McpEvent::ResourcesChanged).await;
                }
                "prompts/list_changed" => {
                    event_emitter.emit(McpEvent::PromptsChanged).await;
                }
                "roots/list_changed" => {
                    event_emitter.emit(McpEvent::RootsChanged).await;
                }
                _ => {}
            }
        }

        Ok(())
    }

    // ==================== 初始化 ====================

    pub async fn initialize(&self) -> McpResult<ServerInfo> {
        let session = self.session.read().await;
        let params = json!({
            "protocolVersion": session.client_info.protocol_version,
            "capabilities": session.client_info.capabilities,
            "clientInfo": {
                "name": session.client_info.name,
                "version": session.client_info.version,
            }
        });
        drop(session);

        let response = self.send_request("initialize", Some(params)).await?;

        if let Some(result) = response.result {
            // Accept MCP initialize result { protocolVersion, capabilities, serverInfo: { name, version } }
            let protocol_version = result
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let caps_val = result
                .get("capabilities")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let capabilities: ServerCapabilities =
                serde_json::from_value(caps_val).unwrap_or(ServerCapabilities {
                    tools: None,
                    resources: None,
                    prompts: None,
                    logging: None,
                    experimental: None,
                });
            let (name, version) = if let Some(si) = result.get("serverInfo") {
                (
                    si.get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    si.get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            } else {
                (
                    result
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    result
                        .get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            };
            let server_info = ServerInfo {
                name,
                version,
                protocol_version,
                capabilities,
            };

            let mut session = self.session.write().await;
            session.server_info = Some(server_info.clone());
            session.initialized = true;

            self.event_emitter
                .emit(McpEvent::ServerInfoReceived(server_info.clone()))
                .await;

            // 发送initialized通知
            self.send_notification("initialized", None).await?;

            Ok(server_info)
        } else {
            Err(McpError::ProtocolError("Initialize failed".to_string()))
        }
    }

    pub async fn ping(&self) -> McpResult<()> {
        let response = self.send_request("ping", None).await?;
        if response.result.is_some() {
            Ok(())
        } else {
            Err(McpError::ProtocolError("Ping failed".to_string()))
        }
    }

    // ==================== 工具操作 ====================

    pub async fn list_tools(&self) -> McpResult<Vec<Tool>> {
        // MCP 规范：支持 pagination cursor，循环获取所有页（安全上限 100 页防止异常服务器死循环）
        let mut all_tools: Vec<Tool> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut page_count = 0u32;
        loop {
            page_count += 1;
            if page_count > 100 { break; }
            let params = if let Some(ref c) = cursor {
                Some(json!({ "cursor": c }))
            } else {
                None
            };
            let response = self.send_request("tools/list", params).await?;
            if let Some(result) = response.result {
                let tools: Vec<Tool> =
                    serde_json::from_value(result.get("tools").unwrap_or(&json!([])).clone())?;
                all_tools.extend(tools);
                cursor = result
                    .get("nextCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    break;
                }
            } else {
                if all_tools.is_empty() {
                    return Err(McpError::ProtocolError("Failed to list tools".to_string()));
                }
                break;
            }
        }
        Ok(all_tools)
    }

    pub async fn call_tool(&self, name: &str, arguments: Option<Value>) -> McpResult<ToolResult> {
        self.rate_limiter.check_rate_limit().await?;

        let params = json!({
            "name": name,
            "arguments": arguments,
        });

        let response = self.send_request("tools/call", Some(params)).await?;

        if let Some(result) = response.result {
            let tool_result: ToolResult = serde_json::from_value(result)?;
            // 检查 is_error 字段，符合 MCP 协议规范
            if tool_result.is_error == Some(true) {
                let error_msg = tool_result
                    .content
                    .iter()
                    .filter_map(|c| {
                        if let Content::Text { text } = c {
                            Some(text.clone())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                warn!("Tool '{}' execution failed: {}", name, error_msg);
                return Err(McpError::ToolExecutionError(if error_msg.is_empty() {
                    "Tool execution failed".to_string()
                } else {
                    error_msg
                }));
            }
            Ok(tool_result)
        } else if let Some(error) = response.error {
            Err(McpError::ServerError(error.message))
        } else {
            Err(McpError::ProtocolError("Tool call failed".to_string()))
        }
    }

    // ==================== 资源操作 ====================

    pub async fn list_resources(&self) -> McpResult<Vec<Resource>> {
        // MCP 规范：支持 pagination cursor（安全上限 100 页）
        let mut all_resources: Vec<Resource> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut page_count = 0u32;
        loop {
            page_count += 1;
            if page_count > 100 { break; }
            let params = if let Some(ref c) = cursor {
                Some(json!({ "cursor": c }))
            } else {
                None
            };
            let response = self.send_request("resources/list", params).await?;
            if let Some(result) = response.result {
                let resources: Vec<Resource> =
                    serde_json::from_value(result.get("resources").unwrap_or(&json!([])).clone())?;
                all_resources.extend(resources);
                cursor = result
                    .get("nextCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    break;
                }
            } else {
                if all_resources.is_empty() {
                    return Err(McpError::ProtocolError(
                        "Failed to list resources".to_string(),
                    ));
                }
                break;
            }
        }
        Ok(all_resources)
    }

    pub async fn list_resource_templates(&self) -> McpResult<Vec<ResourceTemplate>> {
        // MCP 规范：支持 pagination cursor（安全上限 100 页）
        let mut all_templates: Vec<ResourceTemplate> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut page_count = 0u32;
        loop {
            page_count += 1;
            if page_count > 100 { break; }
            let params = if let Some(ref c) = cursor {
                Some(json!({ "cursor": c }))
            } else {
                None
            };
            let response = self.send_request("resources/templates/list", params).await?;
            if let Some(result) = response.result {
                let templates: Vec<ResourceTemplate> = serde_json::from_value(
                    result
                        .get("resourceTemplates")
                        .unwrap_or(&json!([]))
                        .clone(),
                )?;
                all_templates.extend(templates);
                cursor = result
                    .get("nextCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    break;
                }
            } else {
                if all_templates.is_empty() {
                    return Err(McpError::ProtocolError(
                        "Failed to list resource templates".to_string(),
                    ));
                }
                break;
            }
        }
        Ok(all_templates)
    }

    pub async fn read_resource(&self, uri: &str) -> McpResult<ResourceContent> {
        // 检查缓存
        if let Some(cached) = self.resource_cache.get(uri).await {
            return Ok(cached);
        }

        self.rate_limiter.check_rate_limit().await?;

        let params = json!({
            "uri": uri,
        });

        let response = self.send_request("resources/read", Some(params)).await?;

        if let Some(result) = response.result {
            let contents: Vec<ResourceContent> =
                serde_json::from_value(result.get("contents").unwrap_or(&json!([])).clone())?;

            if let Some(content) = contents.into_iter().next() {
                // 缓存资源
                self.resource_cache
                    .put(uri.to_string(), content.clone())
                    .await;
                Ok(content)
            } else {
                Err(McpError::ResourceNotFound(uri.to_string()))
            }
        } else {
            Err(McpError::ProtocolError(
                "Failed to read resource".to_string(),
            ))
        }
    }

    pub async fn subscribe_resource(&self, uri: &str) -> McpResult<()> {
        let params = json!({
            "uri": uri,
        });

        let response = self
            .send_request("resources/subscribe", Some(params))
            .await?;

        if response.result.is_some() {
            Ok(())
        } else {
            Err(McpError::ProtocolError(
                "Failed to subscribe to resource".to_string(),
            ))
        }
    }

    pub async fn unsubscribe_resource(&self, uri: &str) -> McpResult<()> {
        let params = json!({
            "uri": uri,
        });

        let response = self
            .send_request("resources/unsubscribe", Some(params))
            .await?;

        if response.result.is_some() {
            Ok(())
        } else {
            Err(McpError::ProtocolError(
                "Failed to unsubscribe from resource".to_string(),
            ))
        }
    }

    // ==================== 提示操作 ====================

    pub async fn list_prompts(&self) -> McpResult<Vec<Prompt>> {
        // MCP 规范：支持 pagination cursor（安全上限 100 页）
        let mut all_prompts: Vec<Prompt> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut page_count = 0u32;
        loop {
            page_count += 1;
            if page_count > 100 { break; }
            let params = if let Some(ref c) = cursor {
                Some(json!({ "cursor": c }))
            } else {
                None
            };
            let response = self.send_request("prompts/list", params).await?;
            if let Some(result) = response.result {
                let prompts: Vec<Prompt> =
                    serde_json::from_value(result.get("prompts").unwrap_or(&json!([])).clone())?;
                all_prompts.extend(prompts);
                cursor = result
                    .get("nextCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    break;
                }
            } else {
                if all_prompts.is_empty() {
                    return Err(McpError::ProtocolError(
                        "Failed to list prompts".to_string(),
                    ));
                }
                break;
            }
        }
        Ok(all_prompts)
    }

    pub async fn get_prompt(
        &self,
        name: &str,
        arguments: Option<HashMap<String, Value>>,
    ) -> McpResult<Vec<PromptMessage>> {
        self.rate_limiter.check_rate_limit().await?;

        let params = json!({
            "name": name,
            "arguments": arguments,
        });

        let response = self.send_request("prompts/get", Some(params)).await?;

        if let Some(result) = response.result {
            let messages: Vec<PromptMessage> =
                serde_json::from_value(result.get("messages").unwrap_or(&json!([])).clone())?;
            Ok(messages)
        } else {
            Err(McpError::ProtocolError("Failed to get prompt".to_string()))
        }
    }

    // ==================== 采样操作 ====================

    pub async fn create_message(
        &self,
        request: CreateMessageRequest,
    ) -> McpResult<CreateMessageResult> {
        self.rate_limiter.check_rate_limit().await?;

        let params = serde_json::to_value(request)?;
        let response = self
            .send_request("sampling/createMessage", Some(params))
            .await?;

        if let Some(result) = response.result {
            let message_result: CreateMessageResult = serde_json::from_value(result)?;
            Ok(message_result)
        } else {
            Err(McpError::ProtocolError(
                "Failed to create message".to_string(),
            ))
        }
    }

    // ==================== 日志操作 ====================

    pub async fn set_log_level(&self, level: LogLevel) -> McpResult<()> {
        let params = json!({
            "level": level,
        });

        let response = self.send_request("logging/setLevel", Some(params)).await?;

        if response.result.is_some() {
            Ok(())
        } else {
            Err(McpError::ProtocolError(
                "Failed to set log level".to_string(),
            ))
        }
    }

    // ==================== 根目录操作 ====================

    pub async fn list_roots(&self) -> McpResult<Vec<Root>> {
        let response = self.send_request("roots/list", None).await?;

        if let Some(result) = response.result {
            let roots: Vec<Root> =
                serde_json::from_value(result.get("roots").unwrap_or(&json!([])).clone())?;
            Ok(roots)
        } else {
            Err(McpError::ProtocolError("Failed to list roots".to_string()))
        }
    }

    // ==================== 完成操作 ====================

    pub async fn complete(&self, ref_type: &str, partial: &str) -> McpResult<Vec<String>> {
        let params = json!({
            "ref": {
                "type": ref_type,
                "partial": partial,
            }
        });

        let response = self
            .send_request("completion/complete", Some(params))
            .await?;

        if let Some(result) = response.result {
            let completions: Vec<String> =
                serde_json::from_value(result.get("completions").unwrap_or(&json!([])).clone())?;
            Ok(completions)
        } else {
            Err(McpError::ProtocolError(
                "Failed to get completions".to_string(),
            ))
        }
    }

    // ==================== 底层方法 ====================

    async fn send_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> McpResult<JsonRpcResponse> {
        let id = Uuid::new_v4().to_string();
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
            id: Some(Value::String(id.clone())),
        };
        // Register first to avoid races
        let rx = self.request_manager.register_request(id.clone()).await;
        let message = serde_json::to_string(&request)?;
        debug!("MCP send_request start: method={}, id={}", method, id);
        let t0 = std::time::Instant::now();
        self.transport.send(&message).await?;
        debug!(
            "MCP send_request sent: method={}, id={}, send_ms={}",
            method,
            id,
            t0.elapsed().as_millis()
        );

        // If no background message manager is running (e.g., in unit tests),
        // try to opportunistically receive one message and dispatch it.
        let has_manager = self.shutdown_tx.lock().await.as_ref().is_some();
        if !has_manager {
            if let Ok(Ok(msg)) = timeout(Duration::from_millis(25), self.transport.receive()).await
            {
                let _ = Self::handle_message(
                    &msg,
                    self.request_manager.clone(),
                    self.notification_handler.clone(),
                    self.event_emitter.clone(),
                    self.stream_manager.clone(),
                )
                .await;
            }
        }

        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => {
                debug!("MCP send_request ok: method={}, id={}", method, id);
                result
            }
            Ok(Err(e)) => {
                error!(
                    "MCP send_request channel error: method={}, id={}, error={:?}",
                    method, id, e
                );
                Err(McpError::ProtocolError(format!(
                    "Channel recv error: {}",
                    e
                )))
            }
            Err(_) => {
                self.request_manager.cancel_request(&id).await;
                // 提示传输类型辅助诊断
                let tname = self.transport.transport_name();
                error!(
                    "MCP send_request timeout: method={}, id={}, transport={}",
                    method, id, tname
                );
                Err(McpError::TimeoutError("Request timeout".to_string()))
            }
        }
    }

    async fn send_notification(&self, method: &str, params: Option<Value>) -> McpResult<()> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };

        let message = serde_json::to_string(&notification)?;
        self.transport.send(&message).await?;

        Ok(())
    }

    // ==================== 辅助方法 ====================

    pub async fn get_server_info(&self) -> Option<ServerInfo> {
        let session = self.session.read().await;
        session.server_info.clone()
    }

    pub async fn is_initialized(&self) -> bool {
        let session = self.session.read().await;
        session.initialized
    }

    pub async fn on_event<F>(&self, handler: F)
    where
        F: Fn(McpEvent) + Send + Sync + 'static,
    {
        self.event_emitter.on(Arc::new(handler)).await;
    }

    pub async fn clear_resource_cache(&self) {
        self.resource_cache.clear().await;
    }
}

// ==================== 批处理支持 ====================

pub struct BatchRequest {
    pub requests: Vec<(String, String, Option<Value>)>, // (id, method, params)
}

impl McpClient {
    pub async fn send_batch(
        &self,
        batch: BatchRequest,
    ) -> McpResult<Vec<McpResult<JsonRpcResponse>>> {
        let mut receivers = Vec::new();
        let mut messages = Vec::new();

        for (id, method, params) in batch.requests {
            let request = JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                method,
                params,
                id: Some(Value::String(id.clone())),
            };

            messages.push(request);
            receivers.push(self.request_manager.register_request(id).await);
        }

        let batch_message = serde_json::to_string(&messages)?;
        self.transport.send(&batch_message).await?;

        let mut results = Vec::new();
        for rx in receivers {
            let result = match timeout(Duration::from_secs(30), rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(e)) => Err(McpError::ProtocolError(format!(
                    "Channel recv error: {}",
                    e
                ))),
                Err(_) => Err(McpError::TimeoutError("Request timeout".to_string())),
            };
            results.push(result);
        }

        Ok(results)
    }
}

// ==================== Stream支持 ====================

pub struct ToolResultStream {
    rx: mpsc::UnboundedReceiver<McpResult<Content>>,
}

impl Stream for ToolResultStream {
    type Item = McpResult<Content>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

impl McpClient {
    pub async fn call_tool_stream(
        &self,
        name: &str,
        arguments: Option<Value>,
    ) -> McpResult<ToolResultStream> {
        self.rate_limiter.check_rate_limit().await?;
        let (tx, rx) = mpsc::unbounded_channel();
        let id = Uuid::new_v4().to_string();
        self.stream_manager.register(id.clone(), tx.clone()).await;

        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            method: "tools/call".to_string(),
            params: Some(json!({ "name": name, "arguments": arguments })),
            id: Some(Value::String(id.clone())),
        };
        let rx_final = self.request_manager.register_request(id.clone()).await;
        let request_json = serde_json::to_string(&request)?;
        self.transport.send(&request_json).await?;

        let sm = self.stream_manager.clone();
        tokio::spawn(async move {
            match timeout(Duration::from_secs(120), rx_final).await {
                Ok(Ok(Ok(resp))) => {
                    if let Some(result_val) = resp.result {
                        if let Ok(tool_result) = serde_json::from_value::<ToolResult>(result_val) {
                            for c in tool_result.content {
                                let _ = sm.inner.lock().await.get(&id).map(|s| s.send(Ok(c)));
                            }
                        }
                    } else if let Some(err) = resp.error {
                        let _ = sm
                            .inner
                            .lock()
                            .await
                            .get(&id)
                            .map(|s| s.send(Err(McpError::ServerError(err.message))));
                    }
                }
                Ok(Ok(Err(e))) => {
                    let _ = sm.inner.lock().await.get(&id).map(|s| s.send(Err(e)));
                }
                Ok(Err(recv_err)) => {
                    let _ = sm.inner.lock().await.get(&id).map(|s| {
                        s.send(Err(McpError::ProtocolError(format!(
                            "Channel recv error: {}",
                            recv_err
                        ))))
                    });
                }
                Err(_) => {
                    let _ = sm.inner.lock().await.get(&id).map(|s| {
                        s.send(Err(McpError::TimeoutError("Request timeout".to_string())))
                    });
                }
            }
            sm.complete(&id).await;
        });

        Ok(ToolResultStream { rx })
    }
}

impl Clone for McpClient {
    fn clone(&self) -> Self {
        Self {
            transport: self.transport.clone(),
            session: self.session.clone(),
            request_manager: self.request_manager.clone(),
            notification_handler: self.notification_handler.clone(),
            resource_cache: self.resource_cache.clone(),
            rate_limiter: self.rate_limiter.clone(),
            event_emitter: self.event_emitter.clone(),
            message_rx: self.message_rx.clone(),
            shutdown_tx: self.shutdown_tx.clone(),
            stream_manager: self.stream_manager.clone(),
        }
    }
}

// ==================== 重连机制 ====================

pub struct ReconnectingClient {
    client: Arc<RwLock<Option<McpClient>>>,
    config: ReconnectConfig,
    transport_factory: Arc<Box<dyn Fn() -> Box<dyn Transport> + Send + Sync>>,
    client_info: ClientInfo,
}

pub struct ReconnectConfig {
    pub max_attempts: usize,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub exponential_base: f64,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            exponential_base: 2.0,
        }
    }
}

impl ReconnectingClient {
    pub fn new<F>(transport_factory: F, client_info: ClientInfo, config: ReconnectConfig) -> Self
    where
        F: Fn() -> Box<dyn Transport> + Send + Sync + 'static,
    {
        Self {
            client: Arc::new(RwLock::new(None)),
            config,
            transport_factory: Arc::new(Box::new(transport_factory)),
            client_info,
        }
    }

    pub async fn connect(&self) -> McpResult<()> {
        let mut attempt = 0;
        let mut delay = self.config.initial_delay;

        loop {
            attempt += 1;

            match self.try_connect().await {
                Ok(()) => {
                    info!("Successfully connected");
                    return Ok(());
                }
                Err(e) => {
                    if attempt >= self.config.max_attempts {
                        error!("Max reconnection attempts reached");
                        return Err(e);
                    }

                    warn!(
                        "Connection attempt {} failed: {}, retrying in {:?}",
                        attempt, e, delay
                    );

                    sleep(delay).await;

                    delay = Duration::from_secs_f64(
                        (delay.as_secs_f64() * self.config.exponential_base)
                            .min(self.config.max_delay.as_secs_f64()),
                    );
                }
            }
        }
    }

    async fn try_connect(&self) -> McpResult<()> {
        let transport = (self.transport_factory)();
        let client = McpClient::new(transport, self.client_info.clone());

        client.connect().await?;
        client.initialize().await?;

        *self.client.write().await = Some(client);
        Ok(())
    }

    pub async fn with_client<F, R>(&self, f: F) -> McpResult<R>
    where
        F: FnOnce(&McpClient) -> BoxFuture<'_, McpResult<R>>,
    {
        let client_guard = self.client.read().await;
        if let Some(client) = client_guard.as_ref() {
            f(client).await
        } else {
            Err(McpError::ConnectionError("Not connected".to_string()))
        }
    }
}

// ==================== 测试辅助 ====================

#[cfg(test)]
mod tests {
    use super::*;

    struct MockTransport {
        responses: Arc<Mutex<Vec<String>>>,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl MockTransport {
        fn new(responses: Vec<String>) -> Self {
            Self {
                responses: Arc::new(Mutex::new(responses)),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait]
    impl Transport for MockTransport {
        async fn send(&self, message: &str) -> McpResult<()> {
            let mut requests = self.requests.lock().await;
            requests.push(message.to_string());
            Ok(())
        }

        async fn receive(&self) -> McpResult<String> {
            let mut responses = self.responses.lock().await;
            responses
                .pop()
                .ok_or_else(|| McpError::TransportError("No more responses".to_string()))
        }

        async fn close(&self) -> McpResult<()> {
            Ok(())
        }

        fn is_connected(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn test_client_initialization() {
        let transport = MockTransport::new(vec![json!({
            "jsonrpc": "2.0",
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": {
                    "name": "test-server",
                    "version": "1.0.0"
                }
            },
            "id": "test-id"
        })
        .to_string()]);

        let client_info = ClientInfo {
            name: "test-client".to_string(),
            version: "1.0.0".to_string(),
            protocol_version: "2024-11-05".to_string(),
            capabilities: ClientCapabilities {
                roots: None,
                sampling: None,
                experimental: None,
            },
        };

        let client = McpClient::new(Box::new(transport), client_info);
        let result = client.initialize().await;

        assert!(result.is_ok());
    }
}

// ==================== 示例用法 ====================

#[allow(unexpected_cfgs)]
#[cfg(feature = "examples")]
pub mod examples {
    use super::*;

    pub async fn example_usage() -> McpResult<()> {
        // 创建客户端信息
        let client_info = ClientInfo {
            name: "my-ai-app".to_string(),
            version: "1.0.0".to_string(),
            protocol_version: "2024-11-05".to_string(),
            capabilities: ClientCapabilities {
                roots: Some(RootsCapability {
                    list_changed: Some(true),
                }),
                sampling: Some(SamplingCapability { enabled: true }),
                experimental: None,
            },
        };

        // 创建传输层
        let (transport, _stdin_tx, _stdout_rx) = StdioTransport::new();

        // 创建客户端
        let client = McpClient::new(Box::new(transport), client_info);

        // 设置事件处理器
        client
            .on_event(|event| match event {
                McpEvent::Connected => println!("Connected to server"),
                McpEvent::ServerInfoReceived(info) => {
                    println!("Server: {} v{}", info.name, info.version);
                }
                _ => {}
            })
            .await;

        // 连接并初始化
        client.connect().await?;
        let server_info = client.initialize().await?;
        println!("Connected to: {}", server_info.name);

        // 列出工具
        let tools = client.list_tools().await?;
        for tool in tools {
            println!("Tool: {} - {:?}", tool.name, tool.description);
        }

        // 调用工具
        let result = client
            .call_tool(
                "calculator",
                Some(json!({
                    "operation": "add",
                    "a": 5,
                    "b": 3
                })),
            )
            .await?;

        println!("Tool result: {:?}", result);

        // 读取资源
        let resource = client.read_resource("file:///example.txt").await?;
        println!("Resource content: {:?}", resource.text);

        // 断开连接
        client.disconnect().await?;

        Ok(())
    }
}

// ==================== 导出 ====================

pub mod prelude {
    pub use super::{
        ClientCapabilities, ClientInfo, Content, EventEmitter, LogEntry, LogLevel, McpClient,
        McpError, McpEvent, McpResult, NotificationHandler, Prompt, PromptArgument, PromptMessage,
        ReconnectConfig, ReconnectingClient, Resource, ResourceContent, ResourceTemplate,
        ServerCapabilities, ServerInfo, StdioTransport, Tool, ToolCall, ToolResult, Transport,
        WebSocketTransport,
    };
}
