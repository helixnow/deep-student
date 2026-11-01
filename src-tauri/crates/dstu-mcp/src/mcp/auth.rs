//! OAuth 2.1 认证管理 — PKCE S256 + RFC 8414 发现 + RFC 7591 动态注册 + 桌面回调
//! Android 上不可用（会引入 native-tls）

#![cfg(not(target_os = "android"))]

use super::oauth_callback::{OAuthCallbackListener, OAuthCallbackResult, OAUTH_CALLBACK_TIMEOUT};
use super::types::{McpError, McpResult};
use crate::secure_store::{SecureStore, SecureStoreConfig};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use log::{debug, error, info, warn};
use oauth2::{
    basic::BasicClient, reqwest::async_http_client, AuthUrl, AuthorizationCode, ClientId,
    ClientSecret, CsrfToken, HttpRequest, HttpResponse, PkceCodeChallenge, PkceCodeVerifier,
    RedirectUrl, RefreshToken, RevocationUrl, Scope, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

const TOKEN_KEY_PREFIX: &str = "internal.oauth.mcp.";
const OAUTH_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const OAUTH_DISCOVERY_MAX_BYTES: usize = 1024 * 1024;
const OAUTH_DISCOVERY_MAX_DEPTH: usize = 4;

/// Token 端点 HTTP 交换错误（可注入实现共用）
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TokenHttpError(pub String);

/// 可注入的 OAuth token/refresh HTTP 执行器。
/// 生产使用 reqwest；测试使用内存 fake，避免真实 loopback socket。
#[async_trait]
pub trait TokenHttpExecutor: Send + Sync {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TokenHttpError>;
}

/// 生产实现：委托 oauth2::reqwest::async_http_client
pub struct ReqwestTokenHttpExecutor;

#[async_trait]
impl TokenHttpExecutor for ReqwestTokenHttpExecutor {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TokenHttpError> {
        validate_secure_oauth_url(&request.url).map_err(TokenHttpError)?;
        tokio::time::timeout(OAUTH_HTTP_TIMEOUT, async_http_client(request))
            .await
            .map_err(|_| TokenHttpError("OAuth token request timed out".to_string()))?
            .map_err(|e| TokenHttpError(e.to_string()))
    }
}

/// 认证令牌
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthToken {
    ApiKey(String),
    OAuth2(OAuth2Token),
    LongLivedToken(String),
}

/// OAuth 2.1 令牌
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth2Token {
    pub access_token: String,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub refresh_token: Option<String>,
    pub scopes: Vec<String>,
}

impl OAuth2Token {
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            Utc::now() >= expires_at
        } else {
            false
        }
    }

    pub fn needs_refresh(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            Utc::now() + Duration::minutes(5) >= expires_at
        } else {
            false
        }
    }
}

/// 持久化载荷（令牌 + 客户端元数据，供重启后 refresh）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedOAuthSession {
    pub token: OAuth2Token,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub auth_url: String,
    pub token_url: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    /// Normalized resource origin this token was authorized for. Legacy records
    /// deserialize empty and are rejected on token retrieval until reauthorized.
    #[serde(default)]
    pub resource_origin: String,
}

/// OAuth 端点
#[derive(Debug, Clone)]
pub struct OAuthEndpoints {
    pub authorization: String,
    pub token: String,
    pub revocation: Option<String>,
    pub userinfo: Option<String>,
    pub registration: Option<String>,
}

/// 启动交互式授权的参数
#[derive(Debug, Clone)]
pub struct StartOAuthParams {
    pub server_id: String,
    pub resource_url: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    /// 为 false 时不打开系统浏览器（测试用）
    pub open_browser: bool,
    pub timeout: Option<std::time::Duration>,
}

/// 启动结果（阻塞完成换码后返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartOAuthOutcome {
    pub server_id: String,
    /// Kept internally for compatibility with existing Rust callers, but never
    /// cross the Tauri serialization boundary. Connections obtain it only via
    /// the resource-bound token command.
    #[serde(default, skip_serializing)]
    pub access_token: String,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub authorization_url: String,
    pub redirect_uri: String,
}

/// MCP 认证管理器
pub struct McpAuthManager {
    oauth_clients: Arc<RwLock<HashMap<String, BasicClient>>>,
    tokens: Arc<RwLock<HashMap<String, AuthToken>>>,
    sessions: Arc<RwLock<HashMap<String, PersistedOAuthSession>>>,
    pkce_verifiers: Arc<RwLock<HashMap<String, PkceCodeVerifier>>>,
    active_cancels: Arc<RwLock<HashMap<String, CancellationToken>>>,
    secure_store: Arc<RwLock<Option<SecureStore>>>,
    token_http: Arc<dyn TokenHttpExecutor>,
}

impl McpAuthManager {
    pub fn new() -> Self {
        Self {
            oauth_clients: Arc::new(RwLock::new(HashMap::new())),
            tokens: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pkce_verifiers: Arc::new(RwLock::new(HashMap::new())),
            active_cancels: Arc::new(RwLock::new(HashMap::new())),
            secure_store: Arc::new(RwLock::new(None)),
            token_http: Arc::new(ReqwestTokenHttpExecutor),
        }
    }

    /// 注入 token/refresh HTTP 执行器（测试用内存 fake）
    pub fn with_token_http_executor(mut self, executor: Arc<dyn TokenHttpExecutor>) -> Self {
        self.token_http = executor;
        self
    }

    /// 绑定 SecureStore（app_data_dir）
    pub async fn attach_secure_store(&self, store: SecureStore) {
        let mut guard = self.secure_store.write().await;
        *guard = Some(store);
    }

    pub async fn attach_secure_store_dir(&self, app_data_dir: PathBuf) {
        let store = SecureStore::new_with_dir(SecureStoreConfig::default(), app_data_dir);
        self.attach_secure_store(store).await;
    }

    fn token_key(server_id: &str) -> String {
        format!("{}{}", TOKEN_KEY_PREFIX, server_id)
    }

    async fn persist_session(
        &self,
        server_id: &str,
        session: &PersistedOAuthSession,
    ) -> McpResult<()> {
        let json = serde_json::to_string(session).map_err(|e| {
            McpError::AuthenticationError(format!("Failed to serialize OAuth session: {}", e))
        })?;
        let store_guard = self.secure_store.read().await;
        let store = store_guard.as_ref().ok_or_else(|| {
            McpError::AuthenticationError(
                "Secure store not configured for MCP OAuth persistence".to_string(),
            )
        })?;
        store
            .save_secret(&Self::token_key(server_id), &json)
            .map_err(|e| {
                McpError::AuthenticationError(format!("Failed to persist OAuth token: {}", e))
            })?;
        Ok(())
    }

    async fn load_session_from_disk(&self, server_id: &str) -> Option<PersistedOAuthSession> {
        let store_guard = self.secure_store.read().await;
        let store = store_guard.as_ref()?;
        let raw = store
            .get_secret(&Self::token_key(server_id))
            .ok()
            .flatten()?;
        serde_json::from_str(&raw).ok()
    }

    async fn delete_session_from_disk(&self, server_id: &str) -> McpResult<()> {
        let store_guard = self.secure_store.read().await;
        if let Some(store) = store_guard.as_ref() {
            let _ = store.delete_secret(&Self::token_key(server_id));
        }
        Ok(())
    }

    /// 从磁盘恢复会话并注册 OAuth 客户端
    pub async fn restore_session(&self, server_id: &str) -> McpResult<Option<AuthToken>> {
        let Some(session) = self.load_session_from_disk(server_id).await else {
            return Ok(None);
        };
        self.register_oauth_client(
            server_id,
            &session.client_id,
            session.client_secret.as_deref(),
            OAuthEndpoints {
                authorization: session.auth_url.clone(),
                token: session.token_url.clone(),
                revocation: None,
                userinfo: None,
                registration: None,
            },
            &session.redirect_uri,
        )
        .await?;
        let token = AuthToken::OAuth2(session.token.clone());
        {
            let mut tokens = self.tokens.write().await;
            tokens.insert(server_id.to_string(), token.clone());
        }
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(server_id.to_string(), session);
        }
        Ok(Some(token))
    }

    pub async fn register_oauth_client(
        &self,
        provider: &str,
        client_id: &str,
        client_secret: Option<&str>,
        endpoints: OAuthEndpoints,
        redirect_uri: &str,
    ) -> McpResult<()> {
        for (label, raw) in [
            ("authorization endpoint", endpoints.authorization.as_str()),
            ("token endpoint", endpoints.token.as_str()),
        ] {
            let parsed = url::Url::parse(raw)
                .map_err(|e| McpError::AuthenticationError(format!("Invalid {label}: {e}")))?;
            validate_secure_oauth_url(&parsed)
                .map_err(|e| McpError::AuthenticationError(format!("Unsafe {label}: {e}")))?;
        }
        let auth_url = AuthUrl::new(endpoints.authorization.clone())
            .map_err(|e| McpError::AuthenticationError(format!("Invalid auth URL: {}", e)))?;
        let token_url = TokenUrl::new(endpoints.token.clone())
            .map_err(|e| McpError::AuthenticationError(format!("Invalid token URL: {}", e)))?;

        let mut client =
            BasicClient::new(
                ClientId::new(client_id.to_string()),
                client_secret.map(|s| ClientSecret::new(s.to_string())),
                auth_url,
                Some(token_url),
            )
            .set_redirect_uri(RedirectUrl::new(redirect_uri.to_string()).map_err(
                |e| McpError::AuthenticationError(format!("Invalid redirect URI: {}", e)),
            )?);

        if let Some(revocation_url) = endpoints.revocation {
            client =
                client.set_revocation_uri(RevocationUrl::new(revocation_url).map_err(|e| {
                    McpError::AuthenticationError(format!("Invalid revocation URL: {}", e))
                })?);
        }

        let mut clients = self.oauth_clients.write().await;
        clients.insert(provider.to_string(), client);
        info!("Registered OAuth client for provider: {}", provider);
        Ok(())
    }

    /// 兼容旧入口：API Key 或报错引导使用 start_oauth
    pub async fn authenticate_modelscope(&self, api_key: Option<String>) -> McpResult<AuthToken> {
        if let Some(key) = api_key {
            info!("Using API key authentication for ModelScope");
            return Ok(AuthToken::ApiKey(key));
        }
        Err(McpError::AuthenticationError(
            "OAuth 2.1 interactive flow requires start_oauth(server_id). \
             Please use API Key authentication or call start_oauth."
                .to_string(),
        ))
    }

    /// 从 resource URL / 域名发现 AS 元数据（RFC 8414 + protected resource）。
    pub async fn discover_oauth_endpoints(
        &self,
        resource_or_domain: &str,
    ) -> McpResult<OAuthEndpoints> {
        let initial = normalize_resource_url(resource_or_domain)?;
        let client = reqwest::Client::builder()
            .timeout(OAUTH_HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("OAuth discovery exceeded redirect limit");
                }
                if validate_secure_oauth_url(attempt.url()).is_ok() {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| {
                McpError::AuthenticationError(format!(
                    "Failed to build OAuth discovery client: {e}"
                ))
            })?;
        let mut visited = HashSet::new();
        discover_oauth_endpoints_inner(&client, initial.as_str(), &mut visited, 0).await
    }

    /// RFC 7591 动态客户端注册（经 TokenHttpExecutor，测试可注入内存 fake）
    pub async fn dynamic_client_register(
        &self,
        registration_endpoint: &str,
        redirect_uri: &str,
        client_name: &str,
    ) -> McpResult<(String, Option<String>)> {
        let body = serde_json::json!({
            "client_name": client_name,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        });

        let url = url::Url::parse(registration_endpoint).map_err(|e| {
            McpError::AuthenticationError(format!("Invalid registration endpoint: {}", e))
        })?;
        let mut headers = oauth2::http::HeaderMap::new();
        headers.insert(
            oauth2::http::header::CONTENT_TYPE,
            oauth2::http::HeaderValue::from_static("application/json"),
        );
        let request = HttpRequest {
            url,
            method: oauth2::http::Method::POST,
            headers,
            body: body.to_string().into_bytes(),
        };

        let response = self.token_http.execute(request).await.map_err(|e| {
            McpError::AuthenticationError(format!(
                "Dynamic client registration request failed: {}",
                e
            ))
        })?;

        if !response.status_code.is_success() {
            let text = String::from_utf8_lossy(&response.body);
            return Err(McpError::AuthenticationError(format!(
                "Dynamic client registration failed ({}). \
                 Provide a client_id or ensure the authorization server supports RFC 7591. Detail: {}",
                response.status_code, text
            )));
        }

        let json: serde_json::Value = serde_json::from_slice(&response.body)
            .map_err(|e| McpError::AuthenticationError(format!("Invalid DCR response: {}", e)))?;
        let client_id = json["client_id"]
            .as_str()
            .ok_or_else(|| {
                McpError::AuthenticationError("DCR response missing client_id".to_string())
            })?
            .to_string();
        let client_secret = json["client_secret"].as_str().map(|s| s.to_string());
        Ok((client_id, client_secret))
    }

    /// 测试用：向管理器注入未过期 OAuth access token（不落盘、不经 HTTP）
    #[cfg(test)]
    pub async fn seed_oauth_token_for_test(&self, server_id: &str, access_token: &str) {
        let mut tokens = self.tokens.write().await;
        tokens.insert(
            server_id.to_string(),
            AuthToken::OAuth2(OAuth2Token {
                access_token: access_token.to_string(),
                token_type: "Bearer".to_string(),
                expires_at: Some(Utc::now() + Duration::hours(1)),
                refresh_token: Some("seed-refresh".to_string()),
                scopes: vec!["mcp".to_string()],
            }),
        );
    }

    pub async fn generate_authorization_url(
        &self,
        provider: &str,
        scopes: &[&str],
    ) -> McpResult<(String, String)> {
        let clients = self.oauth_clients.read().await;
        let client = clients.get(provider).ok_or_else(|| {
            McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
        })?;

        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let csrf_token = CsrfToken::new_random();
        let csrf_string = csrf_token.secret().clone();

        {
            let mut verifiers = self.pkce_verifiers.write().await;
            verifiers.insert(csrf_string.clone(), pkce_verifier);
        }

        let mut req = client.authorize_url(|| csrf_token);
        for scope in scopes {
            req = req.add_scope(Scope::new((*scope).to_string()));
        }
        let (auth_url, _) = req.set_pkce_challenge(pkce_challenge).url();
        Ok((auth_url.to_string(), csrf_string))
    }

    pub async fn exchange_code(
        &self,
        provider: &str,
        code: &str,
        csrf_token: &str,
    ) -> McpResult<AuthToken> {
        let client = {
            let clients = self.oauth_clients.read().await;
            clients.get(provider).cloned().ok_or_else(|| {
                McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
            })?
        };

        let pkce_verifier = {
            let mut verifiers = self.pkce_verifiers.write().await;
            verifiers.remove(csrf_token).ok_or_else(|| {
                McpError::AuthenticationError(
                    "Invalid CSRF token or PKCE verifier not found".to_string(),
                )
            })?
        };

        let http = self.token_http.clone();
        let token_result = client
            .exchange_code(AuthorizationCode::new(code.to_string()))
            .set_pkce_verifier(pkce_verifier)
            .request_async(move |req| {
                let http = http.clone();
                async move { http.execute(req).await }
            })
            .await
            .map_err(|e| McpError::AuthenticationError(format!("Token exchange failed: {}", e)))?;

        let expires_at = token_result
            .expires_in()
            .map(|duration| Utc::now() + Duration::seconds(duration.as_secs() as i64));

        let oauth_token = OAuth2Token {
            access_token: token_result.access_token().secret().clone(),
            token_type: token_result.token_type().as_ref().to_string(),
            expires_at,
            refresh_token: token_result.refresh_token().map(|t| t.secret().clone()),
            scopes: token_result
                .scopes()
                .map(|scopes| scopes.iter().map(|s| s.to_string()).collect())
                .unwrap_or_default(),
        };

        let token = AuthToken::OAuth2(oauth_token);
        let mut tokens = self.tokens.write().await;
        tokens.insert(provider.to_string(), token.clone());
        info!("Successfully exchanged authorization code for token");
        Ok(token)
    }

    pub async fn refresh_token(&self, provider: &str, refresh_token: &str) -> McpResult<AuthToken> {
        let client = {
            let clients = self.oauth_clients.read().await;
            clients.get(provider).cloned().ok_or_else(|| {
                McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
            })?
        };

        let http = self.token_http.clone();
        let token_result = client
            .exchange_refresh_token(&RefreshToken::new(refresh_token.to_string()))
            .request_async(move |req| {
                let http = http.clone();
                async move { http.execute(req).await }
            })
            .await
            .map_err(|e| McpError::AuthenticationError(format!("Token refresh failed: {}", e)))?;

        let expires_at = token_result
            .expires_in()
            .map(|duration| Utc::now() + Duration::seconds(duration.as_secs() as i64));

        let mut oauth_token = OAuth2Token {
            access_token: token_result.access_token().secret().clone(),
            token_type: token_result.token_type().as_ref().to_string(),
            expires_at,
            refresh_token: token_result.refresh_token().map(|t| t.secret().clone()),
            scopes: token_result
                .scopes()
                .map(|scopes| scopes.iter().map(|s| s.to_string()).collect())
                .unwrap_or_default(),
        };

        // 部分 AS 不轮换 refresh_token
        if oauth_token.refresh_token.is_none() {
            oauth_token.refresh_token = Some(refresh_token.to_string());
        }

        let token = AuthToken::OAuth2(oauth_token.clone());
        {
            let mut tokens = self.tokens.write().await;
            tokens.insert(provider.to_string(), token.clone());
        }

        // 更新持久化（先 clone 再 drop guard，避免 if-let 临时写锁跨 await 自死锁）
        let existing = {
            let sessions = self.sessions.read().await;
            sessions.get(provider).cloned()
        };
        if let Some(mut session) = existing {
            session.token = oauth_token;
            let _ = self.persist_session(provider, &session).await;
            self.sessions
                .write()
                .await
                .insert(provider.to_string(), session);
        } else if let Some(mut session) = self.load_session_from_disk(provider).await {
            session.token = oauth_token;
            let _ = self.persist_session(provider, &session).await;
            self.sessions
                .write()
                .await
                .insert(provider.to_string(), session);
        }

        info!("Successfully refreshed token");
        Ok(token)
    }

    pub async fn get_token(&self, provider: &str) -> Option<AuthToken> {
        let tokens = self.tokens.read().await;
        if let Some(t) = tokens.get(provider) {
            return Some(t.clone());
        }
        drop(tokens);
        self.restore_session(provider).await.ok().flatten()
    }

    /// 获取有效令牌（自动 refresh）；api_key 与 oauth 互斥由调用方决定优先级
    pub async fn get_valid_token(&self, provider: &str) -> McpResult<AuthToken> {
        if let Some(token) = self.get_token(provider).await {
            match &token {
                AuthToken::OAuth2(oauth_token) => {
                    if oauth_token.needs_refresh() {
                        if let Some(refresh_token) = &oauth_token.refresh_token {
                            info!("Token needs refresh, refreshing...");
                            return self.refresh_token(provider, refresh_token).await;
                        }
                    }
                    if !oauth_token.is_expired() {
                        return Ok(token);
                    }
                }
                _ => return Ok(token),
            }
        }

        Err(McpError::AuthenticationError(format!(
            "No valid token for provider: {}. Re-authorize required.",
            provider
        )))
    }

    /// Bearer 字符串；无有效令牌时返回错误（含 401 再授权语义）
    pub async fn get_bearer_token(&self, server_id: &str) -> McpResult<String> {
        match self.get_valid_token(server_id).await? {
            AuthToken::OAuth2(t) => Ok(t.access_token),
            AuthToken::ApiKey(k) => Ok(k),
            AuthToken::LongLivedToken(k) => Ok(k),
        }
    }

    /// Return a Bearer token only when it is bound to the current MCP resource
    /// origin. This prevents reusing a server id to exfiltrate a token to a new URL.
    pub async fn get_bearer_token_for_resource(
        &self,
        server_id: &str,
        resource_url: &str,
    ) -> McpResult<String> {
        let requested_origin = normalize_resource_origin(resource_url)?;
        if !self.sessions.read().await.contains_key(server_id) {
            let _ = self.restore_session(server_id).await?;
        }
        let bound_origin = self
            .sessions
            .read()
            .await
            .get(server_id)
            .map(|session| session.resource_origin.clone())
            .unwrap_or_default();
        if bound_origin.is_empty() {
            return Err(McpError::AuthenticationError(
                "OAuth session predates resource binding; re-authorize required".to_string(),
            ));
        }
        if bound_origin != requested_origin {
            return Err(McpError::AuthenticationError(format!(
                "OAuth token resource mismatch: authorized for {bound_origin}, requested {requested_origin}"
            )));
        }
        self.get_bearer_token(server_id).await
    }

    pub async fn revoke_token(&self, provider: &str) -> McpResult<()> {
        {
            let mut tokens = self.tokens.write().await;
            tokens.remove(provider);
        }
        {
            let mut sessions = self.sessions.write().await;
            sessions.remove(provider);
        }
        self.delete_session_from_disk(provider).await?;
        info!("Token revoked for provider: {}", provider);
        Ok(())
    }

    pub async fn cancel_oauth(&self, server_id: &str) {
        let mut cancels = self.active_cancels.write().await;
        if let Some(token) = cancels.remove(server_id) {
            token.cancel();
            info!("Cancelled OAuth flow for {}", server_id);
        }
    }

    pub async fn has_oauth_session(&self, server_id: &str) -> bool {
        if self.tokens.read().await.contains_key(server_id) {
            return true;
        }
        self.load_session_from_disk(server_id).await.is_some()
    }

    pub async fn has_oauth_session_for_resource(
        &self,
        server_id: &str,
        resource_url: &str,
    ) -> bool {
        let Ok(requested_origin) = normalize_resource_origin(resource_url) else {
            return false;
        };
        let in_memory = self.sessions.read().await.get(server_id).cloned();
        let session = match in_memory {
            Some(session) => Some(session),
            None => self.load_session_from_disk(server_id).await,
        };
        session.is_some_and(|value| {
            !value.resource_origin.is_empty() && value.resource_origin == requested_origin
        })
    }

    /// 完整桌面交互授权流
    pub async fn start_oauth(&self, params: StartOAuthParams) -> McpResult<StartOAuthOutcome> {
        let server_id = params.server_id.clone();
        let resource_origin = normalize_resource_origin(&params.resource_url)?;

        self.cancel_oauth(&server_id).await;
        let cancel = CancellationToken::new();
        {
            let mut cancels = self.active_cancels.write().await;
            cancels.insert(server_id.clone(), cancel.clone());
        }

        let endpoints = self.discover_oauth_endpoints(&params.resource_url).await?;

        // 1) 预生成 state，绑定 listener（redirect 与 state 一次定稿）
        let pending_state = CsrfToken::new_random().secret().clone();
        let listener = OAuthCallbackListener::bind(pending_state.clone())
            .await
            .map_err(McpError::AuthenticationError)?;
        let redirect_uri = listener.redirect_uri.clone();

        // 2) client_id 优先；否则 RFC 7591 DCR
        let (client_id, client_secret) = if let Some(id) = params
            .client_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            (id, params.client_secret.clone())
        } else if let Some(reg) = endpoints.registration.as_ref() {
            self.dynamic_client_register(reg, &redirect_uri, "Deep Student MCP")
                .await?
        } else {
            return Err(McpError::AuthenticationError(
                "No client_id provided and authorization server has no registration_endpoint \
                 (RFC 7591). Configure client_id in the MCP server OAuth settings."
                    .to_string(),
            ));
        };

        self.register_oauth_client(
            &server_id,
            &client_id,
            client_secret.as_deref(),
            endpoints.clone(),
            &redirect_uri,
        )
        .await?;

        // 3) 授权 URL：csrf 固定为 pending_state，与 listener 一致
        let authorization_url = {
            let clients = self.oauth_clients.read().await;
            let client = clients.get(&server_id).ok_or_else(|| {
                McpError::AuthenticationError(format!("OAuth client not registered: {}", server_id))
            })?;
            let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
            let csrf_token = CsrfToken::new(pending_state.clone());
            {
                let mut verifiers = self.pkce_verifiers.write().await;
                verifiers.insert(pending_state.clone(), pkce_verifier);
            }
            let mut req = client.authorize_url(|| csrf_token);
            for scope in &params.scopes {
                req = req.add_scope(Scope::new(scope.clone()));
            }
            let (url, state) = req.set_pkce_challenge(pkce_challenge).url();
            debug_assert_eq!(state.secret(), &pending_state);
            url.to_string()
        };

        info!("MCP OAuth authorization URL ready for {}", server_id);

        if params.open_browser {
            if let Err(e) = tauri_plugin_opener::open_url(&authorization_url, None::<&str>) {
                error!("Failed to open system browser: {}", e);
                return Err(McpError::AuthenticationError(format!(
                    "Failed to open system browser: {}",
                    e
                )));
            }
        }

        let timeout = params.timeout.unwrap_or(OAUTH_CALLBACK_TIMEOUT);
        let callback = listener.wait(timeout, Some(cancel.clone())).await;

        {
            let mut cancels = self.active_cancels.write().await;
            cancels.remove(&server_id);
        }

        let code = match callback {
            OAuthCallbackResult::Code { code, state } => {
                if state != pending_state {
                    return Err(McpError::AuthenticationError(
                        "OAuth state mismatch".to_string(),
                    ));
                }
                code
            }
            OAuthCallbackResult::StateMismatch => {
                return Err(McpError::AuthenticationError(
                    "OAuth callback rejected: state mismatch".to_string(),
                ));
            }
            OAuthCallbackResult::Denied { error } => {
                return Err(McpError::AuthenticationError(format!(
                    "Authorization denied: {}",
                    error
                )));
            }
            OAuthCallbackResult::Timeout => {
                return Err(McpError::AuthenticationError(
                    "OAuth authorization timed out (120s)".to_string(),
                ));
            }
            OAuthCallbackResult::Cancelled => {
                return Err(McpError::AuthenticationError(
                    "OAuth authorization cancelled".to_string(),
                ));
            }
        };

        let token = self
            .exchange_code(&server_id, &code, &pending_state)
            .await?;
        let AuthToken::OAuth2(oauth_token) = token else {
            return Err(McpError::AuthenticationError(
                "Unexpected token type after code exchange".to_string(),
            ));
        };

        let session = PersistedOAuthSession {
            token: oauth_token.clone(),
            client_id,
            client_secret,
            auth_url: endpoints.authorization,
            token_url: endpoints.token,
            redirect_uri: redirect_uri.clone(),
            scopes: params.scopes.clone(),
            resource_origin,
        };
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(server_id.clone(), session.clone());
        }
        self.persist_session(&server_id, &session).await?;

        Ok(StartOAuthOutcome {
            server_id,
            access_token: oauth_token.access_token,
            token_type: oauth_token.token_type,
            expires_at: oauth_token.expires_at,
            authorization_url,
            redirect_uri,
        })
    }

    pub fn create_long_lived_token(&self, provider: &str) -> String {
        use rand::{rngs::OsRng, Rng};
        let token: String = (0..32)
            .map(|_| {
                let idx = OsRng.gen_range(0..62);
                let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
                chars[idx] as char
            })
            .collect();
        format!("mcp_{}_{}", provider, token)
    }
}

impl Default for McpAuthManager {
    fn default() -> Self {
        Self::new()
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn validate_secure_oauth_url(url: &url::Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "OAuth URL is missing a host".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("OAuth URL must not contain userinfo".to_string());
    }
    if url.scheme() == "https" || (url.scheme() == "http" && is_loopback_host(host)) {
        Ok(())
    } else {
        Err("OAuth URLs must use HTTPS (HTTP is allowed only for loopback hosts)".to_string())
    }
}

fn normalize_resource_url(raw: &str) -> McpResult<url::Url> {
    let candidate = if raw.contains("://") {
        raw.trim().to_string()
    } else {
        format!("https://{}", raw.trim())
    };
    let parsed = url::Url::parse(&candidate).map_err(|e| {
        McpError::AuthenticationError(format!("Invalid MCP OAuth resource URL: {e}"))
    })?;
    validate_secure_oauth_url(&parsed).map_err(McpError::AuthenticationError)?;
    Ok(parsed)
}

pub fn normalize_resource_origin(raw: &str) -> McpResult<String> {
    let parsed = normalize_resource_url(raw)?;
    parsed.host_str().ok_or_else(|| {
        McpError::AuthenticationError("MCP OAuth resource URL is missing a host".to_string())
    })?;
    Ok(parsed.origin().ascii_serialization().to_ascii_lowercase())
}

fn endpoint_from_metadata(
    discovery: &serde_json::Value,
    key: &str,
    required: bool,
) -> McpResult<Option<String>> {
    let Some(raw) = discovery.get(key).and_then(|v| v.as_str()) else {
        if required {
            return Err(McpError::AuthenticationError(format!("Missing {key}")));
        }
        return Ok(None);
    };
    let parsed = url::Url::parse(raw)
        .map_err(|e| McpError::AuthenticationError(format!("Invalid {key}: {e}")))?;
    validate_secure_oauth_url(&parsed)
        .map_err(|e| McpError::AuthenticationError(format!("Unsafe {key}: {e}")))?;
    Ok(Some(parsed.to_string()))
}

fn discover_oauth_endpoints_inner<'a>(
    client: &'a reqwest::Client,
    current: &'a str,
    visited: &'a mut HashSet<String>,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = McpResult<OAuthEndpoints>> + Send + 'a>> {
    Box::pin(async move {
        if depth > OAUTH_DISCOVERY_MAX_DEPTH {
            return Err(McpError::AuthenticationError(
                "OAuth discovery exceeded authorization-server depth limit".to_string(),
            ));
        }
        let normalized = normalize_resource_url(current)?;
        let visit_key = normalized.as_str().trim_end_matches('/').to_string();
        if !visited.insert(visit_key) {
            return Err(McpError::AuthenticationError(
                "OAuth discovery authorization-server cycle detected".to_string(),
            ));
        }

        for candidate in discovery_urls(normalized.as_str()) {
            debug!("Discovering OAuth endpoints from: {}", candidate);
            let response = match client.get(&candidate).send().await {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    debug!("Discovery {} -> {}", candidate, response.status());
                    continue;
                }
                Err(error) => {
                    debug!("Discovery {} failed: {}", candidate, error);
                    continue;
                }
            };
            if response
                .content_length()
                .is_some_and(|len| len > OAUTH_DISCOVERY_MAX_BYTES as u64)
            {
                return Err(McpError::AuthenticationError(
                    "OAuth discovery response exceeds size limit".to_string(),
                ));
            }
            let bytes = response.bytes().await.map_err(|e| {
                McpError::AuthenticationError(format!(
                    "Failed to read OAuth discovery response: {e}"
                ))
            })?;
            if bytes.len() > OAUTH_DISCOVERY_MAX_BYTES {
                return Err(McpError::AuthenticationError(
                    "OAuth discovery response exceeds size limit".to_string(),
                ));
            }
            let discovery: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
                McpError::AuthenticationError(format!("Invalid OAuth discovery response: {e}"))
            })?;

            if let Some(issuer) = discovery.get("issuer").and_then(|v| v.as_str()) {
                let issuer_url = normalize_resource_url(issuer).map_err(|_| {
                    McpError::AuthenticationError(
                        "OAuth metadata contains an unsafe issuer".to_string(),
                    )
                })?;
                if normalize_resource_origin(issuer_url.as_str())?
                    != normalize_resource_origin(normalized.as_str())?
                {
                    return Err(McpError::AuthenticationError(
                        "OAuth metadata issuer does not match the discovered authorization server"
                            .to_string(),
                    ));
                }
            }
            if let Some(as_url) = discovery
                .get("authorization_servers")
                .and_then(|v| v.as_array())
                .and_then(|servers| servers.first())
                .and_then(|v| v.as_str())
            {
                normalize_resource_url(as_url)?;
                return discover_oauth_endpoints_inner(client, as_url, visited, depth + 1).await;
            }

            if discovery.get("authorization_endpoint").is_some() {
                return Ok(OAuthEndpoints {
                    authorization: endpoint_from_metadata(
                        &discovery,
                        "authorization_endpoint",
                        true,
                    )?
                    .expect("required endpoint"),
                    token: endpoint_from_metadata(&discovery, "token_endpoint", true)?
                        .expect("required endpoint"),
                    revocation: endpoint_from_metadata(&discovery, "revocation_endpoint", false)?,
                    userinfo: endpoint_from_metadata(&discovery, "userinfo_endpoint", false)?,
                    registration: endpoint_from_metadata(
                        &discovery,
                        "registration_endpoint",
                        false,
                    )?,
                });
            }
        }

        let origin = normalize_resource_origin(normalized.as_str())?;
        warn!(
            "OAuth discovery failed, using fallback endpoints for {}",
            origin
        );
        Ok(OAuthEndpoints {
            authorization: format!("{origin}/oauth/authorize"),
            token: format!("{origin}/oauth/token"),
            revocation: Some(format!("{origin}/oauth/revoke")),
            userinfo: Some(format!("{origin}/oauth/userinfo")),
            registration: Some(format!("{origin}/oauth/register")),
        })
    })
}

fn discovery_urls(resource_or_domain: &str) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(parsed) = url::Url::parse(resource_or_domain) {
        let base = parsed.origin().ascii_serialization();
        urls.push(format!("{}/.well-known/oauth-authorization-server", base));
        urls.push(format!("{}/.well-known/oauth-protected-resource", base));
        // 部分 MCP 把 AS 元数据挂在 resource path 下
        if let Some(path) = parsed.path().trim_end_matches('/').strip_prefix('/') {
            if !path.is_empty() {
                let path_base = format!("{}/{}", base, path);
                urls.push(format!(
                    "{}/.well-known/oauth-authorization-server",
                    path_base
                ));
            }
        }
    } else {
        urls.push(format!(
            "https://{}/.well-known/oauth-authorization-server",
            resource_or_domain
        ));
    }
    urls
}

use std::sync::LazyLock;

static GLOBAL_AUTH_MANAGER: LazyLock<McpAuthManager> = LazyLock::new(McpAuthManager::new);

pub fn get_auth_manager() -> &'static McpAuthManager {
    &GLOBAL_AUTH_MANAGER
}

/// 解析传输层 Authorization：api_key 优先于 oauth
pub async fn resolve_authorization_header(
    server_id: Option<&str>,
    api_key: &Option<String>,
    oauth_configured: bool,
) -> McpResult<Option<String>> {
    if let Some(key) = api_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Ok(Some(format!("Bearer {}", key)));
    }
    if oauth_configured {
        let id = server_id.ok_or_else(|| {
            McpError::AuthenticationError(
                "OAuth configured but server_id missing for token lookup".to_string(),
            )
        })?;
        match get_auth_manager().get_bearer_token(id).await {
            Ok(token) => Ok(Some(format!("Bearer {}", token))),
            Err(e) => Err(McpError::AuthenticationError(format!(
                "OAuth re-authorization required: {}",
                e
            ))),
        }
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oauth2::http::StatusCode;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration as StdDuration;
    use uuid::Uuid;

    /// 内存 fake AS：直接解析 oauth2 HttpRequest，无 socket
    struct FakeTokenHttp {
        refresh_count: AtomicUsize,
        dcr_count: AtomicUsize,
        /// 拒绝缺少 code_verifier 的 authorization_code 请求
        require_pkce: bool,
        /// refresh 时人工延迟，放大并发竞态
        refresh_delay_ms: u64,
        /// AS 不轮换 refresh_token
        omit_refresh_in_response: bool,
    }

    impl FakeTokenHttp {
        fn new() -> Self {
            Self {
                refresh_count: AtomicUsize::new(0),
                dcr_count: AtomicUsize::new(0),
                require_pkce: true,
                refresh_delay_ms: 0,
                omit_refresh_in_response: false,
            }
        }

        fn json_ok(body: serde_json::Value) -> HttpResponse {
            HttpResponse {
                status_code: StatusCode::OK,
                headers: Default::default(),
                body: body.to_string().into_bytes(),
            }
        }

        fn json_err(status: StatusCode, body: serde_json::Value) -> HttpResponse {
            HttpResponse {
                status_code: status,
                headers: Default::default(),
                body: body.to_string().into_bytes(),
            }
        }

        fn is_dcr(request: &HttpRequest) -> bool {
            if request.method != oauth2::http::Method::POST {
                return false;
            }
            let path = request.url.path().to_lowercase();
            if path.contains("register") {
                return true;
            }
            serde_json::from_slice::<serde_json::Value>(&request.body)
                .ok()
                .and_then(|v| v.get("client_name").map(|_| ()))
                .is_some()
        }
    }

    #[async_trait]
    impl TokenHttpExecutor for FakeTokenHttp {
        async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, TokenHttpError> {
            // RFC 7591 DCR（JSON body）
            if Self::is_dcr(&request) {
                self.dcr_count.fetch_add(1, Ordering::SeqCst);
                let body: serde_json::Value = serde_json::from_slice(&request.body)
                    .map_err(|e| TokenHttpError(format!("bad DCR json: {}", e)))?;
                if body
                    .get("redirect_uris")
                    .and_then(|v| v.as_array())
                    .is_none()
                {
                    return Ok(Self::json_err(
                        StatusCode::BAD_REQUEST,
                        serde_json::json!({"error": "invalid_client_metadata"}),
                    ));
                }
                return Ok(Self::json_ok(serde_json::json!({
                    "client_id": "dcr-client-xyz",
                    "client_id_issued_at": 1,
                    "token_endpoint_auth_method": "none",
                })));
            }

            let form: HashMap<String, String> = url::form_urlencoded::parse(&request.body)
                .into_owned()
                .collect();
            let grant = form.get("grant_type").map(String::as_str).unwrap_or("");
            match grant {
                "authorization_code" => {
                    if self.require_pkce
                        && form
                            .get("code_verifier")
                            .map(|s| s.is_empty())
                            .unwrap_or(true)
                    {
                        return Ok(Self::json_err(
                            StatusCode::BAD_REQUEST,
                            serde_json::json!({
                                "error": "invalid_request",
                                "error_description": "code_verifier required",
                            }),
                        ));
                    }
                    Ok(Self::json_ok(serde_json::json!({
                        "access_token": "access-from-code",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "refresh_token": "refresh-1",
                        "scope": "mcp",
                    })))
                }
                "refresh_token" => {
                    if self.refresh_delay_ms > 0 {
                        tokio::time::sleep(StdDuration::from_millis(self.refresh_delay_ms)).await;
                    }
                    let n = self.refresh_count.fetch_add(1, Ordering::SeqCst) + 1;
                    let mut body = serde_json::json!({
                        "access_token": format!("access-refreshed-{}", n),
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "scope": "mcp",
                    });
                    if !self.omit_refresh_in_response {
                        body["refresh_token"] = serde_json::json!("refresh-1");
                    }
                    Ok(Self::json_ok(body))
                }
                other => Err(TokenHttpError(format!("unsupported grant_type: {}", other))),
            }
        }
    }

    async fn register_test_client(manager: &McpAuthManager, server_id: &str) {
        manager
            .register_oauth_client(
                server_id,
                "test-client",
                None,
                OAuthEndpoints {
                    authorization: "https://as.test/authorize".into(),
                    token: "https://as.test/token".into(),
                    revocation: None,
                    userinfo: None,
                    registration: None,
                },
                "http://127.0.0.1:9/auth/callback",
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_api_key_auth() {
        let manager = McpAuthManager::new();
        let token = manager
            .authenticate_modelscope(Some("test_key".to_string()))
            .await
            .unwrap();
        match token {
            AuthToken::ApiKey(key) => assert_eq!(key, "test_key"),
            _ => panic!("Expected API key token"),
        }
    }

    #[test]
    fn resource_origin_normalization_is_secure_and_stable() {
        assert_eq!(
            normalize_resource_origin("https://Example.COM:443/mcp?q=1").unwrap(),
            "https://example.com"
        );
        assert!(normalize_resource_origin("http://example.com/mcp").is_err());
        assert_eq!(
            normalize_resource_origin("http://127.0.0.1:8080/mcp").unwrap(),
            "http://127.0.0.1:8080"
        );
    }

    #[tokio::test]
    async fn bearer_token_is_bound_to_resource_origin() {
        let manager = McpAuthManager::new();
        manager
            .seed_oauth_token_for_test("bound", "secret-token")
            .await;
        manager.sessions.write().await.insert(
            "bound".into(),
            PersistedOAuthSession {
                token: OAuth2Token {
                    access_token: "secret-token".into(),
                    token_type: "Bearer".into(),
                    expires_at: Some(Utc::now() + Duration::hours(1)),
                    refresh_token: None,
                    scopes: vec![],
                },
                client_id: "client".into(),
                client_secret: None,
                auth_url: "https://auth.test/authorize".into(),
                token_url: "https://auth.test/token".into(),
                redirect_uri: "http://127.0.0.1/callback".into(),
                scopes: vec![],
                resource_origin: "https://resource.test".into(),
            },
        );
        assert_eq!(
            manager
                .get_bearer_token_for_resource("bound", "https://resource.test/mcp")
                .await
                .unwrap(),
            "secret-token"
        );
        assert!(
            manager
                .has_oauth_session_for_resource("bound", "https://resource.test/other")
                .await
        );
        assert!(
            !manager
                .has_oauth_session_for_resource("bound", "https://attacker.test/mcp")
                .await
        );
        assert!(manager
            .get_bearer_token_for_resource("bound", "https://attacker.test/mcp")
            .await
            .is_err());

        manager
            .sessions
            .write()
            .await
            .get_mut("bound")
            .unwrap()
            .resource_origin
            .clear();
        assert!(
            !manager
                .has_oauth_session_for_resource("bound", "https://resource.test/mcp")
                .await
        );
    }

    #[tokio::test]
    async fn test_oauth_token_expiration() {
        let token = OAuth2Token {
            access_token: "test".to_string(),
            token_type: "Bearer".to_string(),
            expires_at: Some(Utc::now() - Duration::hours(1)),
            refresh_token: None,
            scopes: vec![],
        };
        assert!(token.is_expired());
        assert!(token.needs_refresh());
    }

    #[tokio::test]
    async fn test_long_lived_token_generation() {
        let manager = McpAuthManager::new();
        let token = manager.create_long_lived_token("test");
        assert!(token.starts_with("mcp_test_"));
        assert!(token.len() > 10);
    }

    /// 负样本：CSRF/state 不匹配 → PKCE verifier 查找失败，拒绝换码
    #[tokio::test]
    async fn rejects_exchange_on_state_mismatch() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake);
        register_test_client(&manager, "srv").await;

        let (_url, good_state) = manager
            .generate_authorization_url("srv", &["mcp"])
            .await
            .unwrap();

        let err = manager
            .exchange_code("srv", "code-1", "wrong-state-not-equal-to-csrf")
            .await
            .expect_err("state mismatch must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("PKCE verifier not found") || msg.contains("Invalid CSRF"),
            "unexpected error: {}",
            msg
        );

        // good_state 仍在 map 中，说明错误路径未消耗正确 verifier
        assert!(manager
            .pkce_verifiers
            .read()
            .await
            .contains_key(&good_state));
    }

    /// 负样本：PKCE verifier 缺失（未走 generate_authorization_url）必须拒绝
    #[tokio::test]
    async fn rejects_exchange_when_pkce_verifier_missing() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake);
        register_test_client(&manager, "srv").await;

        let err = manager
            .exchange_code("srv", "code-1", "orphan-csrf-never-stored")
            .await
            .expect_err("missing PKCE verifier must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("PKCE verifier not found") || msg.contains("Invalid CSRF"),
            "unexpected error: {}",
            msg
        );
    }

    /// Hermetic：内存 fake 换码（校验 PKCE code_verifier 会发出）
    #[tokio::test]
    async fn hermetic_exchange_code_via_fake_http() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake);
        register_test_client(&manager, "srv").await;
        let (_url, state) = manager
            .generate_authorization_url("srv", &["mcp"])
            .await
            .unwrap();
        let token = manager
            .exchange_code("srv", "test-auth-code", &state)
            .await
            .expect("fake token exchange");
        let AuthToken::OAuth2(oauth) = token else {
            panic!("expected oauth2");
        };
        assert_eq!(oauth.access_token, "access-from-code");
        assert_eq!(oauth.refresh_token.as_deref(), Some("refresh-1"));
    }

    /// Hermetic：落盘后新实例可恢复
    #[tokio::test]
    async fn hermetic_persist_and_restore_session() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let manager = McpAuthManager::new();
        manager
            .attach_secure_store_dir(tmp.path().to_path_buf())
            .await;
        let server_id = "persist-srv";
        let session = PersistedOAuthSession {
            token: OAuth2Token {
                access_token: "access-from-code".into(),
                token_type: "Bearer".into(),
                expires_at: Some(Utc::now() + Duration::hours(1)),
                refresh_token: Some("refresh-1".into()),
                scopes: vec!["mcp".into()],
            },
            client_id: "test-client".into(),
            client_secret: None,
            auth_url: "https://as.test/authorize".into(),
            token_url: "https://as.test/token".into(),
            redirect_uri: "http://127.0.0.1:9/auth/callback".into(),
            scopes: vec!["mcp".into()],
            resource_origin: "https://resource.test".into(),
        };
        manager.persist_session(server_id, &session).await.unwrap();

        let manager2 = McpAuthManager::new();
        manager2
            .attach_secure_store_dir(tmp.path().to_path_buf())
            .await;
        let restored = manager2.restore_session(server_id).await.unwrap();
        let AuthToken::OAuth2(tok) = restored.expect("restored") else {
            panic!("expected oauth2");
        };
        assert_eq!(tok.access_token, "access-from-code");
    }

    /// Hermetic：过期后自动 refresh（fake HTTP）
    #[tokio::test]
    async fn hermetic_auto_refresh_via_fake_http() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake.clone());
        register_test_client(&manager, "refresh-srv").await;
        let expired = OAuth2Token {
            access_token: "old".into(),
            token_type: "Bearer".into(),
            expires_at: Some(Utc::now() - Duration::minutes(1)),
            refresh_token: Some("refresh-1".into()),
            scopes: vec!["mcp".into()],
        };
        {
            let mut tokens = manager.tokens.write().await;
            tokens.insert("refresh-srv".into(), AuthToken::OAuth2(expired.clone()));
            let mut sessions = manager.sessions.write().await;
            sessions.insert(
                "refresh-srv".into(),
                PersistedOAuthSession {
                    token: expired,
                    client_id: "test-client".into(),
                    client_secret: None,
                    auth_url: "https://as.test/authorize".into(),
                    token_url: "https://as.test/token".into(),
                    redirect_uri: "http://127.0.0.1:9/auth/callback".into(),
                    scopes: vec!["mcp".into()],
                    resource_origin: "https://resource.test".into(),
                },
            );
        }
        let refreshed = manager.get_valid_token("refresh-srv").await.unwrap();
        let AuthToken::OAuth2(tok) = refreshed else {
            panic!("expected oauth2");
        };
        assert!(tok.access_token.starts_with("access-refreshed-"));
        assert!(fake.refresh_count.load(Ordering::SeqCst) >= 1);
    }

    /// Hermetic 聚合：state 拒绝 + 换码 + 落盘恢复 + 过期 refresh
    #[tokio::test]
    async fn oauth_full_flow_state_mismatch_persist_and_refresh() {
        let fake = Arc::new(FakeTokenHttp::new());
        let tmp = tempfile::tempdir().expect("tempdir");
        let manager = McpAuthManager::new().with_token_http_executor(fake.clone());
        manager
            .attach_secure_store_dir(tmp.path().to_path_buf())
            .await;

        let server_id = "test-server";
        register_test_client(&manager, server_id).await;

        // --- (a) state 不匹配被拒 ---
        {
            let (_url, _good) = manager
                .generate_authorization_url(server_id, &["mcp"])
                .await
                .unwrap();
            let err = manager
                .exchange_code(server_id, "x", "bad-state")
                .await
                .expect_err("state mismatch");
            assert!(
                err.to_string().contains("PKCE verifier not found")
                    || err.to_string().contains("Invalid CSRF")
            );
        }

        // --- 合法换码（fake 校验 code_verifier 存在）---
        let (_auth_url, pending_state) = manager
            .generate_authorization_url(server_id, &["mcp"])
            .await
            .unwrap();
        let token = manager
            .exchange_code(server_id, "test-auth-code", &pending_state)
            .await
            .expect("code exchange");
        let AuthToken::OAuth2(oauth) = token else {
            panic!("expected oauth2");
        };
        assert_eq!(oauth.access_token, "access-from-code");
        assert_eq!(oauth.refresh_token.as_deref(), Some("refresh-1"));

        let session = PersistedOAuthSession {
            token: oauth.clone(),
            client_id: "test-client".into(),
            client_secret: None,
            auth_url: "https://as.test/authorize".into(),
            token_url: "https://as.test/token".into(),
            redirect_uri: "http://127.0.0.1:9/auth/callback".into(),
            scopes: vec!["mcp".into()],
            resource_origin: "https://resource.test".into(),
        };
        {
            let mut sessions = manager.sessions.write().await;
            sessions.insert(server_id.to_string(), session.clone());
        }
        manager.persist_session(server_id, &session).await.unwrap();

        // --- (b) token 落盘后新实例可恢复 ---
        let manager2 = McpAuthManager::new().with_token_http_executor(fake.clone());
        manager2
            .attach_secure_store_dir(tmp.path().to_path_buf())
            .await;
        let restored = manager2.restore_session(server_id).await.unwrap();
        let AuthToken::OAuth2(restored_tok) = restored.expect("restored") else {
            panic!("expected oauth2");
        };
        assert_eq!(restored_tok.access_token, "access-from-code");

        // --- (c) 过期后自动 refresh ---
        {
            let mut sessions = manager2.sessions.write().await;
            let s = sessions.get_mut(server_id).unwrap();
            s.token.expires_at = Some(Utc::now() - Duration::minutes(1));
            s.token.refresh_token = Some("refresh-1".into());
            let mut tokens = manager2.tokens.write().await;
            tokens.insert(server_id.to_string(), AuthToken::OAuth2(s.token.clone()));
        }
        let refreshed = manager2.get_valid_token(server_id).await.unwrap();
        let AuthToken::OAuth2(refreshed_tok) = refreshed else {
            panic!("expected oauth2");
        };
        assert!(refreshed_tok.access_token.starts_with("access-refreshed-"));
        assert!(fake.refresh_count.load(Ordering::SeqCst) >= 1);
    }

    /// Hermetic：授权 URL 含 PKCE S256 challenge
    #[tokio::test]
    async fn authorization_url_includes_pkce_s256_challenge() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake);
        register_test_client(&manager, "pkce-url").await;
        let (url, state) = manager
            .generate_authorization_url("pkce-url", &["mcp"])
            .await
            .unwrap();
        assert!(!state.is_empty());
        assert!(
            url.contains("code_challenge="),
            "missing code_challenge in {}",
            url
        );
        assert!(
            url.to_ascii_lowercase().contains("s256"),
            "missing S256 method in {}",
            url
        );
        assert!(url.contains("state="));
    }

    /// Hermetic：RFC 7591 DCR 经 fake HTTP（无 socket）
    #[tokio::test]
    async fn hermetic_dcr_via_fake_http() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake.clone());
        let (client_id, secret) = manager
            .dynamic_client_register(
                "https://as.test/oauth/register",
                "http://127.0.0.1:9/auth/callback",
                "Deep Student MCP",
            )
            .await
            .expect("DCR");
        assert_eq!(client_id, "dcr-client-xyz");
        assert!(secret.is_none());
        assert_eq!(fake.dcr_count.load(Ordering::SeqCst), 1);

        // 负样本：缺 redirect_uris
        let bad = Arc::new(FakeTokenHttp::new());
        let manager_bad = McpAuthManager::new().with_token_http_executor(bad);
        // 直接打 execute 路径已在 Fake 内校验；此处用空 register URL body 由实现构造完整 body，
        // 改测：无效 registration endpoint URL
        let err = manager_bad
            .dynamic_client_register("not a url", "http://127.0.0.1/cb", "x")
            .await
            .expect_err("invalid url");
        assert!(err.to_string().contains("Invalid registration endpoint"));
    }

    /// 负样本：过期且无 refresh_token → 必须再授权
    #[tokio::test]
    async fn expired_without_refresh_token_requires_reauth() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake.clone());
        register_test_client(&manager, "no-rt").await;
        {
            let mut tokens = manager.tokens.write().await;
            tokens.insert(
                "no-rt".into(),
                AuthToken::OAuth2(OAuth2Token {
                    access_token: "stale".into(),
                    token_type: "Bearer".into(),
                    expires_at: Some(Utc::now() - Duration::minutes(1)),
                    refresh_token: None,
                    scopes: vec![],
                }),
            );
        }
        let err = manager
            .get_valid_token("no-rt")
            .await
            .expect_err("must require reauth");
        let msg = err.to_string();
        assert!(
            msg.contains("Re-authorize") || msg.contains("No valid token"),
            "unexpected: {}",
            msg
        );
        assert_eq!(
            fake.refresh_count.load(Ordering::SeqCst),
            0,
            "must not attempt refresh without refresh_token"
        );
    }

    /// 降级：未过期但进入 refresh 窗口、无 refresh_token → 仍返回现有 access_token
    #[tokio::test]
    async fn near_expiry_without_refresh_token_degrades_to_current() {
        let fake = Arc::new(FakeTokenHttp::new());
        let manager = McpAuthManager::new().with_token_http_executor(fake.clone());
        register_test_client(&manager, "grace").await;
        {
            let mut tokens = manager.tokens.write().await;
            tokens.insert(
                "grace".into(),
                AuthToken::OAuth2(OAuth2Token {
                    access_token: "still-good".into(),
                    token_type: "Bearer".into(),
                    // needs_refresh: now+5min >= expires → true；is_expired: false
                    expires_at: Some(Utc::now() + Duration::minutes(2)),
                    refresh_token: None,
                    scopes: vec![],
                }),
            );
        }
        let tok = manager.get_valid_token("grace").await.unwrap();
        let AuthToken::OAuth2(oauth) = tok else {
            panic!("expected oauth2");
        };
        assert_eq!(oauth.access_token, "still-good");
        assert_eq!(fake.refresh_count.load(Ordering::SeqCst), 0);
    }

    /// AS 不轮换 refresh_token 时保留旧 refresh（实现内降级）
    #[tokio::test]
    async fn refresh_preserves_old_refresh_token_when_as_omits_it() {
        let fake = Arc::new(FakeTokenHttp {
            refresh_count: AtomicUsize::new(0),
            dcr_count: AtomicUsize::new(0),
            require_pkce: true,
            refresh_delay_ms: 0,
            omit_refresh_in_response: true,
        });
        let manager = McpAuthManager::new().with_token_http_executor(fake);
        register_test_client(&manager, "omit-rt").await;
        let refreshed = manager
            .refresh_token("omit-rt", "refresh-keep-me")
            .await
            .unwrap();
        let AuthToken::OAuth2(oauth) = refreshed else {
            panic!("expected oauth2");
        };
        assert!(oauth.access_token.starts_with("access-refreshed-"));
        assert_eq!(oauth.refresh_token.as_deref(), Some("refresh-keep-me"));
    }

    /// 回归：并发 refresh + persist 不自死锁（第 2 轮修复）
    #[tokio::test]
    async fn concurrent_refresh_no_deadlock() {
        let fake = Arc::new(FakeTokenHttp {
            refresh_count: AtomicUsize::new(0),
            dcr_count: AtomicUsize::new(0),
            require_pkce: true,
            refresh_delay_ms: 40,
            omit_refresh_in_response: false,
        });
        let tmp = tempfile::tempdir().expect("tempdir");
        let manager = Arc::new(McpAuthManager::new().with_token_http_executor(fake.clone()));
        manager
            .attach_secure_store_dir(tmp.path().to_path_buf())
            .await;
        register_test_client(&manager, "concurrent").await;

        let expired = OAuth2Token {
            access_token: "old".into(),
            token_type: "Bearer".into(),
            expires_at: Some(Utc::now() - Duration::minutes(1)),
            refresh_token: Some("refresh-1".into()),
            scopes: vec!["mcp".into()],
        };
        let session = PersistedOAuthSession {
            token: expired.clone(),
            client_id: "test-client".into(),
            client_secret: None,
            auth_url: "https://as.test/authorize".into(),
            token_url: "https://as.test/token".into(),
            redirect_uri: "http://127.0.0.1:9/auth/callback".into(),
            scopes: vec!["mcp".into()],
            resource_origin: "https://resource.test".into(),
        };
        {
            let mut tokens = manager.tokens.write().await;
            tokens.insert("concurrent".into(), AuthToken::OAuth2(expired));
            let mut sessions = manager.sessions.write().await;
            sessions.insert("concurrent".into(), session.clone());
        }
        manager
            .persist_session("concurrent", &session)
            .await
            .unwrap();

        let mut handles = Vec::new();
        for _ in 0..8 {
            let m = manager.clone();
            handles.push(tokio::spawn(async move {
                m.get_valid_token("concurrent").await
            }));
        }

        let joined = tokio::time::timeout(StdDuration::from_secs(8), async {
            let mut oks = 0usize;
            for h in handles {
                let r = h.await.expect("join");
                assert!(r.is_ok(), "refresh err: {:?}", r.err());
                oks += 1;
            }
            oks
        })
        .await
        .expect("concurrent refresh deadlocked (timeout)");
        assert_eq!(joined, 8);
        assert!(fake.refresh_count.load(Ordering::SeqCst) >= 1);
    }

    /// 传输接线：api_key 优先于 oauth
    #[tokio::test]
    async fn resolve_authorization_prefers_api_key_over_oauth() {
        let header =
            resolve_authorization_header(Some("any-server"), &Some("sk-api-key".into()), true)
                .await
                .unwrap();
        assert_eq!(header.as_deref(), Some("Bearer sk-api-key"));
    }

    /// 传输接线：oauth 配置且无 token → 401 再授权语义
    #[tokio::test]
    async fn resolve_authorization_oauth_missing_token_requires_reauth() {
        let err =
            resolve_authorization_header(Some("definitely-missing-oauth-server-c7"), &None, true)
                .await
                .expect_err("missing oauth token");
        let msg = err.to_string();
        assert!(
            msg.contains("OAuth re-authorization required") || msg.contains("Re-authorize"),
            "unexpected: {}",
            msg
        );
    }

    /// 传输接线：oauth 已有 token → 注入 Bearer（经全局 manager，无 socket）
    #[tokio::test]
    async fn resolve_authorization_injects_oauth_bearer() {
        let server_id = format!("c7-bearer-{}", Uuid::new_v4());
        let mgr = get_auth_manager();
        mgr.seed_oauth_token_for_test(&server_id, "access-seeded-c7")
            .await;
        let header = resolve_authorization_header(Some(&server_id), &None, true)
            .await
            .expect("bearer");
        assert_eq!(header.as_deref(), Some("Bearer access-seeded-c7"));
        let _ = mgr.revoke_token(&server_id).await;
    }

    /// 负样本：oauth 配置但缺 server_id
    #[tokio::test]
    async fn resolve_authorization_oauth_without_server_id_errors() {
        let err = resolve_authorization_header(None, &None, true)
            .await
            .expect_err("server_id required");
        assert!(err.to_string().contains("server_id missing"));
    }

    /// 无凭据 → None（不注入）
    #[tokio::test]
    async fn resolve_authorization_none_when_unconfigured() {
        let header = resolve_authorization_header(Some("x"), &None, false)
            .await
            .unwrap();
        assert!(header.is_none());
    }
}
