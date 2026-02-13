// OAuth 2.1认证管理 - 支持PKCE（2025强制要求）
// 注意：OAuth2 在 Android 上不可用（会引入 native-tls）
#![cfg(not(target_os = "android"))]

use super::types::{McpError, McpResult};
use chrono::{DateTime, Duration, Utc};
use log::{debug, info, warn};
use oauth2::{
    basic::BasicClient, reqwest::async_http_client, AuthUrl, AuthorizationCode, ClientId,
    ClientSecret, CsrfToken, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken,
    RevocationUrl, Scope, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 认证令牌
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthToken {
    /// API密钥认证
    ApiKey(String),
    /// OAuth 2.1令牌
    OAuth2(OAuth2Token),
    /// 长期访问令牌（fallback）
    LongLivedToken(String),
}

/// OAuth 2.1令牌
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth2Token {
    pub access_token: String,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub refresh_token: Option<String>,
    pub scopes: Vec<String>,
}

impl OAuth2Token {
    /// 检查令牌是否过期
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            Utc::now() >= expires_at
        } else {
            false
        }
    }

    /// 检查令牌是否需要刷新（提前5分钟）
    pub fn needs_refresh(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            Utc::now() + Duration::minutes(5) >= expires_at
        } else {
            false
        }
    }
}

/// OAuth端点
#[derive(Debug, Clone)]
pub struct OAuthEndpoints {
    pub authorization: String,
    pub token: String,
    pub revocation: Option<String>,
    pub userinfo: Option<String>,
}

/// MCP认证管理器
pub struct McpAuthManager {
    oauth_clients: Arc<RwLock<HashMap<String, BasicClient>>>,
    tokens: Arc<RwLock<HashMap<String, AuthToken>>>,
    pkce_verifiers: Arc<RwLock<HashMap<String, PkceCodeVerifier>>>,
}

impl McpAuthManager {
    /// 创建新的认证管理器
    pub fn new() -> Self {
        Self {
            oauth_clients: Arc::new(RwLock::new(HashMap::new())),
            tokens: Arc::new(RwLock::new(HashMap::new())),
            pkce_verifiers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 注册OAuth客户端
    pub async fn register_oauth_client(
        &self,
        provider: &str,
        client_id: &str,
        client_secret: Option<&str>,
        endpoints: OAuthEndpoints,
        redirect_uri: &str,
    ) -> McpResult<()> {
        let auth_url = AuthUrl::new(endpoints.authorization)
            .map_err(|e| McpError::AuthenticationError(format!("Invalid auth URL: {}", e)))?;

        let token_url = TokenUrl::new(endpoints.token)
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

    /// 魔搭认证
    pub async fn authenticate_modelscope(&self, api_key: Option<String>) -> McpResult<AuthToken> {
        if let Some(key) = api_key {
            // API Key认证（向后兼容）
            info!("Using API key authentication for ModelScope");
            return Ok(AuthToken::ApiKey(key));
        }

        // OAuth 2.1认证
        info!("Starting OAuth 2.1 authentication for ModelScope");

        // 发现端点
        let endpoints = self.discover_oauth_endpoints("modelscope.cn").await?;

        // 注册客户端
        self.register_oauth_client(
            "modelscope",
            "mcp-client", // 默认客户端ID
            None,
            endpoints,
            "http://localhost:8080/callback", // 本地回调
        )
        .await?;

        // 生成授权URL
        let auth_url = self
            .generate_authorization_url("modelscope", &["mcp:read", "mcp:write", "mcp:admin"])
            .await?;

        info!("Authorization URL: {}", auth_url);

        // 这里需要实际的用户交互
        // 在Tauri应用中，可以打开WebView或浏览器
        warn!(
            "OAuth authentication requires user interaction - returning mock token for development"
        );

        Ok(AuthToken::OAuth2(OAuth2Token {
            access_token: "mock_access_token".to_string(),
            token_type: "Bearer".to_string(),
            expires_at: Some(Utc::now() + Duration::hours(1)),
            refresh_token: Some("mock_refresh_token".to_string()),
            scopes: vec!["mcp:read".to_string(), "mcp:write".to_string()],
        }))
    }

    /// 发现OAuth端点
    async fn discover_oauth_endpoints(&self, domain: &str) -> McpResult<OAuthEndpoints> {
        // 实现OAuth 2.0 Discovery（RFC 8414）
        let well_known_url = format!("https://{}/.well-known/oauth-authorization-server", domain);

        debug!("Discovering OAuth endpoints from: {}", well_known_url);

        let client = reqwest::Client::new();
        let response = client
            .get(&well_known_url)
            .send()
            .await
            .map_err(|e| McpError::AuthenticationError(format!("Discovery failed: {}", e)))?;

        if !response.status().is_success() {
            // Fallback到已知端点
            warn!("OAuth discovery failed, using fallback endpoints");
            return Ok(OAuthEndpoints {
                authorization: format!("https://{}/oauth/authorize", domain),
                token: format!("https://{}/oauth/token", domain),
                revocation: Some(format!("https://{}/oauth/revoke", domain)),
                userinfo: Some(format!("https://{}/oauth/userinfo", domain)),
            });
        }

        let discovery: serde_json::Value = response.json().await.map_err(|e| {
            McpError::AuthenticationError(format!("Invalid discovery response: {}", e))
        })?;

        Ok(OAuthEndpoints {
            authorization: discovery["authorization_endpoint"]
                .as_str()
                .ok_or_else(|| {
                    McpError::AuthenticationError("Missing authorization endpoint".to_string())
                })?
                .to_string(),
            token: discovery["token_endpoint"]
                .as_str()
                .ok_or_else(|| McpError::AuthenticationError("Missing token endpoint".to_string()))?
                .to_string(),
            revocation: discovery["revocation_endpoint"]
                .as_str()
                .map(|s| s.to_string()),
            userinfo: discovery["userinfo_endpoint"]
                .as_str()
                .map(|s| s.to_string()),
        })
    }

    /// 生成授权URL（带PKCE）
    pub async fn generate_authorization_url(
        &self,
        provider: &str,
        scopes: &[&str],
    ) -> McpResult<String> {
        let clients = self.oauth_clients.read().await;
        let client = clients.get(provider).ok_or_else(|| {
            McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
        })?;

        // 生成PKCE challenge（2025强制要求）
        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

        // 保存verifier供后续使用
        let csrf_token = CsrfToken::new_random();
        let csrf_string = csrf_token.secret().clone();

        let mut verifiers = self.pkce_verifiers.write().await;
        verifiers.insert(csrf_string.clone(), pkce_verifier);

        // 构建授权URL
        let (auth_url, _) = client
            .authorize_url(|| csrf_token)
            .add_scopes(scopes.iter().map(|&s| Scope::new(s.to_string())))
            .set_pkce_challenge(pkce_challenge)
            .url();

        Ok(auth_url.to_string())
    }

    /// 交换授权码获取令牌
    pub async fn exchange_code(
        &self,
        provider: &str,
        code: &str,
        csrf_token: &str,
    ) -> McpResult<AuthToken> {
        let clients = self.oauth_clients.read().await;
        let client = clients.get(provider).ok_or_else(|| {
            McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
        })?;

        // 获取PKCE verifier
        let mut verifiers = self.pkce_verifiers.write().await;
        let pkce_verifier = verifiers.remove(csrf_token).ok_or_else(|| {
            McpError::AuthenticationError(
                "Invalid CSRF token or PKCE verifier not found".to_string(),
            )
        })?;

        // 交换令牌
        let token_result = client
            .exchange_code(AuthorizationCode::new(code.to_string()))
            .set_pkce_verifier(pkce_verifier)
            .request_async(async_http_client)
            .await
            .map_err(|e| McpError::AuthenticationError(format!("Token exchange failed: {}", e)))?;

        // 计算过期时间
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

        // 缓存令牌
        let mut tokens = self.tokens.write().await;
        tokens.insert(provider.to_string(), token.clone());

        info!("Successfully exchanged authorization code for token");
        Ok(token)
    }

    /// 刷新令牌
    pub async fn refresh_token(&self, provider: &str, refresh_token: &str) -> McpResult<AuthToken> {
        let clients = self.oauth_clients.read().await;
        let client = clients.get(provider).ok_or_else(|| {
            McpError::AuthenticationError(format!("OAuth client not registered: {}", provider))
        })?;

        let token_result = client
            .exchange_refresh_token(&RefreshToken::new(refresh_token.to_string()))
            .request_async(async_http_client)
            .await
            .map_err(|e| McpError::AuthenticationError(format!("Token refresh failed: {}", e)))?;

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

        // 更新缓存
        let mut tokens = self.tokens.write().await;
        tokens.insert(provider.to_string(), token.clone());

        info!("Successfully refreshed token");
        Ok(token)
    }

    /// 获取缓存的令牌
    pub async fn get_token(&self, provider: &str) -> Option<AuthToken> {
        let tokens = self.tokens.read().await;
        tokens.get(provider).cloned()
    }

    /// 获取有效令牌（自动刷新）
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
            "No valid token for provider: {}",
            provider
        )))
    }

    /// 撤销令牌
    pub async fn revoke_token(&self, provider: &str) -> McpResult<()> {
        let mut tokens = self.tokens.write().await;
        tokens.remove(provider);

        info!("Token revoked for provider: {}", provider);
        Ok(())
    }

    /// 创建长期访问令牌（用于不支持OAuth的客户端）
    pub fn create_long_lived_token(&self, provider: &str) -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let token: String = (0..32)
            .map(|_| {
                let idx = rng.gen_range(0..62);
                let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
                chars[idx] as char
            })
            .collect();

        format!("mcp_{}_{}", provider, token)
    }
}

use std::sync::LazyLock;

// 全局认证管理器实例
static GLOBAL_AUTH_MANAGER: LazyLock<McpAuthManager> = LazyLock::new(|| McpAuthManager::new());

/// 获取全局认证管理器
pub fn get_auth_manager() -> &'static McpAuthManager {
    &GLOBAL_AUTH_MANAGER
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
