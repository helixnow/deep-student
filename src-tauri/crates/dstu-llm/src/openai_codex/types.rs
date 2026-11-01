use crate::openai_codex::error::CodexAuthErrorDto;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub(crate) const SESSION_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCodexSession {
    pub schema_version: u8,
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: Option<String>,
    pub expires_at_unix_ms: i64,
    pub account_id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub is_fedramp: bool,
    #[serde(default)]
    pub last_refresh_at: Option<i64>,
}

impl fmt::Debug for StoredCodexSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredCodexSession")
            .field("schema_version", &self.schema_version)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("id_token", &self.id_token.as_ref().map(|_| "[REDACTED]"))
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .field("account_id", &redact_account_id(&self.account_id))
            .field("email", &self.email)
            .field("plan_type", &self.plan_type)
            .field("is_fedramp", &self.is_fedramp)
            .field("last_refresh_at", &self.last_refresh_at)
            .finish()
    }
}

impl StoredCodexSession {
    pub(crate) fn is_valid(&self) -> bool {
        self.schema_version == SESSION_SCHEMA_VERSION
            && !self.access_token.trim().is_empty()
            && !self.refresh_token.trim().is_empty()
            && !self.account_id.trim().is_empty()
            && self.expires_at_unix_ms > 0
    }
}

pub struct CodexRequestAuth {
    access_token: Zeroizing<String>,
    account_id: String,
    generation: u64,
    expires_at_unix_ms: i64,
    is_fedramp: bool,
}

impl Clone for CodexRequestAuth {
    fn clone(&self) -> Self {
        Self {
            access_token: Zeroizing::new(self.access_token.to_string()),
            account_id: self.account_id.clone(),
            generation: self.generation,
            expires_at_unix_ms: self.expires_at_unix_ms,
            is_fedramp: self.is_fedramp,
        }
    }
}

impl fmt::Debug for CodexRequestAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodexRequestAuth")
            .field("access_token", &"[REDACTED]")
            .field("account_id", &redact_account_id(&self.account_id))
            .field("generation", &self.generation)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .field("is_fedramp", &self.is_fedramp)
            .finish()
    }
}

impl CodexRequestAuth {
    pub(crate) fn new(session: &StoredCodexSession, generation: u64) -> Self {
        Self {
            access_token: Zeroizing::new(session.access_token.clone()),
            account_id: session.account_id.clone(),
            generation,
            expires_at_unix_ms: session.expires_at_unix_ms,
            is_fedramp: session.is_fedramp,
        }
    }

    pub(crate) fn access_token(&self) -> &str {
        self.access_token.as_str()
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn expires_at_unix_ms(&self) -> i64 {
        self.expires_at_unix_ms
    }

    pub(crate) fn is_fedramp(&self) -> bool {
        self.is_fedramp
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexLoginKind {
    Browser,
    Device,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAuthPhase {
    SignedOut,
    Authorizing,
    Authenticated,
    Refreshing,
    ReauthenticationRequired,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub phase: CodexAuthPhase,
    pub has_usable_session: bool,
    pub account_hint: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub is_fedramp: bool,
    pub expires_at_unix_ms: Option<i64>,
    pub generation: u64,
    pub active_login_kind: Option<CodexLoginKind>,
    pub active_attempt_id: Option<String>,
    pub authorization_url: Option<String>,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub poll_interval_seconds: Option<u64>,
    pub last_error: Option<CodexAuthErrorDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoginStart {
    pub attempt_id: String,
    pub authorization_url: String,
    pub redirect_uri: String,
    pub expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginStart {
    pub attempt_id: String,
    pub verification_url: String,
    pub user_code: String,
    pub expires_at_unix_ms: i64,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<CodexRateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary: Option<CodexRateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<CodexRateLimits>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub rate_limits_by_limit_id: HashMap<String, CodexRateLimits>,
    pub fetched_at: i64,
}

#[derive(Default)]
pub(crate) struct RuntimeUsageMetrics {
    pub authenticated_requests: u64,
    pub refresh_attempts: u64,
    pub refresh_successes: u64,
    pub refresh_failures: u64,
    pub unauthorized_refreshes: u64,
    pub last_refresh_at_unix_ms: Option<i64>,
}

pub(crate) fn redact_account_id(account_id: &str) -> String {
    let suffix: String = account_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if suffix.is_empty() {
        "***".to_string()
    } else {
        format!("***{}", suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_auth_debug_is_redacted() {
        let session = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "access-secret".to_string(),
            refresh_token: "refresh-secret".to_string(),
            id_token: Some("id-secret".to_string()),
            expires_at_unix_ms: 42,
            account_id: "account-123456789".to_string(),
            email: Some("user@example.com".to_string()),
            plan_type: Some("plus".to_string()),
            is_fedramp: false,
            last_refresh_at: None,
        };
        let debug = format!("{:?}", CodexRequestAuth::new(&session, 7));
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("account-123456789"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn stored_session_debug_is_redacted() {
        let session = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "access-secret".to_string(),
            refresh_token: "refresh-secret".to_string(),
            id_token: Some("id-secret".to_string()),
            expires_at_unix_ms: 42,
            account_id: "account-123456789".to_string(),
            email: Some("user@example.com".to_string()),
            plan_type: Some("plus".to_string()),
            is_fedramp: false,
            last_refresh_at: None,
        };
        let debug = format!("{:?}", session);
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("refresh-secret"));
        assert!(!debug.contains("id-secret"));
    }

    #[test]
    fn stored_session_requires_account_id() {
        let session = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "access-secret".to_string(),
            refresh_token: "refresh-secret".to_string(),
            id_token: None,
            expires_at_unix_ms: 42,
            account_id: "  ".to_string(),
            email: None,
            plan_type: None,
            is_fedramp: false,
            last_refresh_at: None,
        };
        assert!(!session.is_valid());
    }
}
