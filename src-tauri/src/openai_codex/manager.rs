use crate::database::Database;
use crate::openai_codex::error::{CodexAuthError, CodexErrorClass};
use crate::openai_codex::protocol::{
    build_codex_request_headers, CodexEndpointConfig, CODEX_ORIGINATOR, OPENAI_OAUTH_SCOPE,
};
use crate::openai_codex::store::{CodexCredentialStore, DatabaseCodexCredentialStore};
use crate::openai_codex::types::{
    redact_account_id, BrowserLoginStart, CodexAuthPhase, CodexAuthStatus, CodexLoginKind,
    CodexRateLimitWindow, CodexRateLimits, CodexRequestAuth, CodexUsageSnapshot, DeviceLoginStart,
    RuntimeUsageMetrics, StoredCodexSession, SESSION_SCHEMA_VERSION,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use hyper::service::service_fn;
use hyper::{Body, Request, Response, StatusCode};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const CALLBACK_PORTS: [u16; 2] = [1455, 1457];
const BROWSER_LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DEVICE_LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CALLBACK_RESULT_TIMEOUT: Duration = Duration::from_secs(90);
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;
const MIN_USABLE_ACCESS_TOKEN_MS: i64 = 30 * 1000;
const DEVICE_POLL_SAFETY_MARGIN: Duration = Duration::from_secs(3);
const DEFAULT_TOKEN_LIFETIME_SECONDS: i64 = 3600;
const MIN_TOKEN_LIFETIME_SECONDS: i64 = 60;
const MAX_TOKEN_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
const MAX_OAUTH_RESPONSE_BODY_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub struct CodexAuthManager {
    inner: Arc<Inner>,
}

struct Inner {
    http: Option<reqwest::Client>,
    endpoints: CodexEndpointConfig,
    store: Arc<dyn CodexCredentialStore>,
    state: RwLock<RuntimeState>,
    refresh_gate: Mutex<()>,
}

struct RuntimeState {
    session: Option<StoredCodexSession>,
    generation: u64,
    phase: CodexAuthPhase,
    active_attempt: Option<ActiveAttempt>,
    last_error: Option<crate::openai_codex::error::CodexAuthErrorDto>,
    usage: RuntimeUsageMetrics,
}

#[derive(Clone)]
struct ActiveAttempt {
    id: String,
    kind: CodexLoginKind,
    expires_at_unix_ms: i64,
    authorization_url: Option<String>,
    verification_url: Option<String>,
    user_code: Option<String>,
    poll_interval_seconds: Option<u64>,
    previous_phase: Option<CodexAuthPhase>,
    cancel: CancellationToken,
}

struct UnavailableCredentialStore;

impl CodexCredentialStore for UnavailableCredentialStore {
    fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
        Err(CodexAuthError::CredentialStore)
    }

    fn save(&self, _session: &StoredCodexSession) -> Result<(), CodexAuthError> {
        Err(CodexAuthError::CredentialStore)
    }

    fn delete(&self) -> Result<(), CodexAuthError> {
        Err(CodexAuthError::CredentialStore)
    }
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

enum CallbackPayload {
    Code {
        code: String,
        reply: oneshot::Sender<bool>,
    },
    Denied {
        code: String,
        reply: oneshot::Sender<bool>,
    },
}

enum DevicePollResult {
    Pending,
    Authorized {
        authorization_code: String,
        code_verifier: String,
    },
}

impl CodexAuthManager {
    pub fn new(database: Arc<Database>) -> Self {
        let store_result = DatabaseCodexCredentialStore::new(database);
        let (store, load_result): (
            Arc<dyn CodexCredentialStore>,
            Result<Option<StoredCodexSession>, CodexAuthError>,
        ) = match store_result {
            Ok(store) => {
                let store: Arc<dyn CodexCredentialStore> = Arc::new(store);
                let loaded = store.load();
                (store, loaded)
            }
            Err(error) => (Arc::new(UnavailableCredentialStore), Err(error)),
        };

        let (session, phase, last_error) = match load_result {
            Ok(Some(session)) => (Some(session), CodexAuthPhase::Authenticated, None),
            Ok(None) => (None, CodexAuthPhase::SignedOut, None),
            Err(error) => (None, CodexAuthPhase::Error, Some(error.to_dto())),
        };

        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .ok();

        Self {
            inner: Arc::new(Inner {
                http,
                endpoints: CodexEndpointConfig::default(),
                store,
                state: RwLock::new(RuntimeState {
                    session,
                    generation: 1,
                    phase,
                    active_attempt: None,
                    last_error,
                    usage: RuntimeUsageMetrics::default(),
                }),
                refresh_gate: Mutex::new(()),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        endpoints: CodexEndpointConfig,
        store: Arc<dyn CodexCredentialStore>,
    ) -> Self {
        let session = store.load().ok().flatten();
        let phase = if session.is_some() {
            CodexAuthPhase::Authenticated
        } else {
            CodexAuthPhase::SignedOut
        };
        Self {
            inner: Arc::new(Inner {
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .ok(),
                endpoints,
                store,
                state: RwLock::new(RuntimeState {
                    session,
                    generation: 1,
                    phase,
                    active_attempt: None,
                    last_error: None,
                    usage: RuntimeUsageMetrics::default(),
                }),
                refresh_gate: Mutex::new(()),
            }),
        }
    }

    pub async fn status(&self) -> CodexAuthStatus {
        let state = self.inner.state.read().await;
        CodexAuthStatus {
            phase: state.phase,
            has_usable_session: state.session.is_some() && !requires_reauthentication(&state),
            account_hint: state
                .session
                .as_ref()
                .filter(|session| !session.account_id.trim().is_empty())
                .map(|session| redact_account_id(&session.account_id)),
            email: state
                .session
                .as_ref()
                .and_then(|session| session.email.clone()),
            plan_type: state
                .session
                .as_ref()
                .and_then(|session| session.plan_type.clone()),
            is_fedramp: state
                .session
                .as_ref()
                .map(|session| session.is_fedramp)
                .unwrap_or(false),
            expires_at_unix_ms: state
                .active_attempt
                .as_ref()
                .map(|attempt| attempt.expires_at_unix_ms)
                .or_else(|| {
                    state
                        .session
                        .as_ref()
                        .map(|session| session.expires_at_unix_ms)
                }),
            generation: state.generation,
            active_login_kind: state.active_attempt.as_ref().map(|attempt| attempt.kind),
            active_attempt_id: state
                .active_attempt
                .as_ref()
                .map(|attempt| attempt.id.clone()),
            authorization_url: state
                .active_attempt
                .as_ref()
                .and_then(|attempt| attempt.authorization_url.clone()),
            verification_url: state
                .active_attempt
                .as_ref()
                .and_then(|attempt| attempt.verification_url.clone()),
            user_code: state
                .active_attempt
                .as_ref()
                .and_then(|attempt| attempt.user_code.clone()),
            poll_interval_seconds: state
                .active_attempt
                .as_ref()
                .and_then(|attempt| attempt.poll_interval_seconds),
            last_error: state.last_error.clone(),
        }
    }

    pub async fn usage_snapshot(&self) -> Result<CodexUsageSnapshot, CodexAuthError> {
        let mut response_auth = self.request_auth(false).await?;
        let response = self.fetch_usage(&response_auth).await?;
        let response = if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            response_auth = self
                .refresh_after_unauthorized(response_auth.generation())
                .await?;
            self.fetch_usage(&response_auth).await?
        } else {
            response
        };

        let status = response.status();
        let body_bytes = read_response_body_limited(response, "usage").await?;
        let body = if status.is_success() {
            serde_json::from_slice(&body_bytes).map_err(|_| CodexAuthError::MalformedResponse {
                field: "usage response",
            })?
        } else {
            parse_error_body(&body_bytes)
        };
        if status == reqwest::StatusCode::UNAUTHORIZED {
            let error = CodexAuthError::OAuthRejected {
                stage: "usage",
                code: "unauthorized_after_refresh".to_string(),
                permanent: true,
                reauth_required: true,
            };
            self.mark_reauthentication_required_with_error(response_auth.generation(), &error)
                .await;
            return Err(error);
        }
        if !status.is_success() {
            return Err(oauth_rejection("usage", status, &body));
        }
        Ok(parse_usage_snapshot(&body, now_ms()))
    }

    pub fn responses_endpoint(&self) -> &str {
        self.inner.endpoints.responses_url.as_str()
    }

    pub async fn mark_reauthentication_required(&self, observed_generation: u64) -> bool {
        let error = CodexAuthError::ReauthenticationRequired;
        self.mark_reauthentication_required_with_error(observed_generation, &error)
            .await
    }

    async fn mark_reauthentication_required_with_error(
        &self,
        observed_generation: u64,
        error: &CodexAuthError,
    ) -> bool {
        let mut state = self.inner.state.write().await;
        if state.generation != observed_generation {
            return false;
        }
        state.last_error = Some(error.to_dto());
        set_stable_phase_preserving_login(&mut state, CodexAuthPhase::ReauthenticationRequired);
        true
    }

    async fn fetch_usage(
        &self,
        auth: &CodexRequestAuth,
    ) -> Result<reqwest::Response, CodexAuthError> {
        let headers = build_codex_request_headers(auth, &format!("usage-{}", Uuid::new_v4()))?;
        self.http()?
            .get(self.inner.endpoints.usage_url.clone())
            .headers(headers)
            .send()
            .await
            .map_err(|_| CodexAuthError::Network { stage: "usage" })
    }

    pub async fn start_browser_login(&self) -> Result<BrowserLoginStart, CodexAuthError> {
        self.ensure_no_active_login().await?;
        let listener = bind_callback_listener().await?;
        let port = listener
            .local_addr()
            .map_err(|_| CodexAuthError::CallbackBind)?
            .port();
        let redirect_uri = format!("http://localhost:{}/auth/callback", port);
        let pkce = generate_pkce();
        let state_token = random_urlsafe(32);
        let attempt_id = Uuid::new_v4().to_string();
        let expires_at_unix_ms = now_ms() + BROWSER_LOGIN_TIMEOUT.as_millis() as i64;
        let cancel = CancellationToken::new();

        let authorization_url = build_authorization_url(
            &self.inner.endpoints,
            &redirect_uri,
            &pkce.challenge,
            &state_token,
        )?;

        self.install_attempt(ActiveAttempt {
            id: attempt_id.clone(),
            kind: CodexLoginKind::Browser,
            expires_at_unix_ms,
            authorization_url: Some(authorization_url.clone()),
            verification_url: None,
            user_code: None,
            poll_interval_seconds: None,
            previous_phase: None,
            cancel: cancel.clone(),
        })
        .await?;

        let manager = self.clone();
        let task_attempt_id = attempt_id.clone();
        let task_redirect_uri = redirect_uri.clone();
        tokio::spawn(async move {
            manager
                .run_browser_login(
                    listener,
                    task_attempt_id,
                    task_redirect_uri,
                    pkce.verifier,
                    state_token,
                    cancel,
                )
                .await;
        });

        Ok(BrowserLoginStart {
            attempt_id,
            authorization_url,
            redirect_uri,
            expires_at_unix_ms,
        })
    }

    pub async fn start_device_login(&self) -> Result<DeviceLoginStart, CodexAuthError> {
        self.ensure_no_active_login().await?;
        let attempt_id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let mut expires_at_unix_ms = now_ms() + DEVICE_LOGIN_TIMEOUT.as_millis() as i64;
        self.install_attempt(ActiveAttempt {
            id: attempt_id.clone(),
            kind: CodexLoginKind::Device,
            expires_at_unix_ms,
            authorization_url: None,
            verification_url: Some(self.inner.endpoints.device_verification_url.to_string()),
            user_code: None,
            poll_interval_seconds: None,
            previous_phase: None,
            cancel: cancel.clone(),
        })
        .await?;

        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(CodexAuthError::Cancelled),
            result = self.request_device_code() => result,
        };
        let (device_auth_id, user_code, poll_interval, server_expires_in) = match result {
            Ok(value) => value,
            Err(error) => {
                self.finish_attempt_error(&attempt_id, &error).await;
                return Err(error);
            }
        };
        if let Some(seconds) = server_expires_in {
            let bounded = seconds.clamp(60, DEVICE_LOGIN_TIMEOUT.as_secs());
            expires_at_unix_ms = now_ms() + (bounded as i64 * 1000);
        }
        {
            let mut state = self.inner.state.write().await;
            let Some(attempt) = state
                .active_attempt
                .as_mut()
                .filter(|attempt| attempt.id == attempt_id && !cancel.is_cancelled())
            else {
                return Err(CodexAuthError::Cancelled);
            };
            attempt.expires_at_unix_ms = expires_at_unix_ms;
            attempt.user_code = Some(user_code.clone());
            attempt.poll_interval_seconds = Some(poll_interval.as_secs());
        }

        let manager = self.clone();
        let task_attempt_id = attempt_id.clone();
        let task_user_code = user_code.clone();
        tokio::spawn(async move {
            manager
                .run_device_login(
                    task_attempt_id,
                    device_auth_id,
                    task_user_code,
                    poll_interval,
                    expires_at_unix_ms,
                    cancel,
                )
                .await;
        });

        Ok(DeviceLoginStart {
            attempt_id,
            verification_url: self.inner.endpoints.device_verification_url.to_string(),
            user_code,
            expires_at_unix_ms,
            poll_interval_seconds: poll_interval.as_secs(),
        })
    }

    pub async fn cancel_login(&self, attempt_id: &str) -> Result<(), CodexAuthError> {
        // Login installation uses the same gate. Whichever operation acquires it first is the
        // linearization point: cancellation prevents persistence, while a completed save makes
        // the attempt no longer cancellable.
        let _refresh_guard = self.inner.refresh_gate.lock().await;
        let cancel = {
            let mut state = self.inner.state.write().await;
            let Some(attempt) = state.active_attempt.as_ref() else {
                return Err(CodexAuthError::AttemptNotFound);
            };
            if attempt.id != attempt_id {
                return Err(CodexAuthError::AttemptNotFound);
            }
            let cancel = attempt.cancel.clone();
            let previous_phase = attempt.previous_phase;
            state.active_attempt = None;
            if state.phase == CodexAuthPhase::Authorizing {
                state.phase = restore_phase_after_login_attempt(&state, previous_phase);
            }
            state.last_error = None;
            cancel
        };
        cancel.cancel();
        Ok(())
    }

    pub async fn logout(&self) -> Result<(), CodexAuthError> {
        // Once local deletion starts it must finish before a new login can persist, even if the
        // command waiter is dropped. This also prevents a late delete from removing new tokens.
        let manager = self.clone();
        let task = tokio::spawn(async move { manager.logout_transaction().await });
        task.await.map_err(|_| CodexAuthError::CredentialStore)?
    }

    async fn logout_transaction(&self) -> Result<(), CodexAuthError> {
        // Wait for an in-flight refresh before deleting so it cannot repopulate storage.
        let _refresh_guard = self.inner.refresh_gate.lock().await;
        let (refresh_token, active_cancel) = {
            let mut state = self.inner.state.write().await;
            let active_attempt = state.active_attempt.take();
            let previous_phase = active_attempt
                .as_ref()
                .and_then(|attempt| attempt.previous_phase);
            if active_attempt.is_some() && state.phase == CodexAuthPhase::Authorizing {
                state.phase = restore_phase_after_login_attempt(&state, previous_phase);
            }
            (
                state
                    .session
                    .as_ref()
                    .map(|session| Zeroizing::new(session.refresh_token.clone())),
                active_attempt.map(|attempt| attempt.cancel),
            )
        };
        if let Some(cancel) = active_cancel {
            cancel.cancel();
        }

        // Local deletion is the logout boundary. Keep the live session untouched when encrypted
        // storage cannot delete it, and do not revoke a token that the application must retain.
        let store = self.inner.store.clone();
        tokio::task::spawn_blocking(move || store.delete())
            .await
            .map_err(|_| CodexAuthError::CredentialStore)??;
        let late_cancel = {
            let mut state = self.inner.state.write().await;
            let late_cancel = state.active_attempt.take().map(|attempt| attempt.cancel);
            state.session = None;
            state.generation = state.generation.saturating_add(1);
            state.phase = CodexAuthPhase::SignedOut;
            state.last_error = None;
            late_cancel
        };
        if let Some(cancel) = late_cancel {
            cancel.cancel();
        }

        if let (Some(client), Some(refresh_token)) = (self.inner.http.as_ref(), refresh_token) {
            let revoke = client
                .post(self.inner.endpoints.revoke_url.clone())
                .json(&json!({
                    "token": refresh_token.as_str(),
                    "token_type_hint": "refresh_token",
                    "client_id": self.inner.endpoints.client_id,
                }))
                .send();
            // Revocation is deliberately best-effort after the local logout has committed.
            let _ = tokio::time::timeout(Duration::from_secs(5), revoke).await;
        }
        Ok(())
    }

    pub async fn request_auth(
        &self,
        force_refresh: bool,
    ) -> Result<CodexRequestAuth, CodexAuthError> {
        let (observed_generation, expires_at) = {
            let state = self.inner.state.read().await;
            if requires_reauthentication(&state) {
                return Err(CodexAuthError::ReauthenticationRequired);
            }
            let session = state.session.as_ref().ok_or(CodexAuthError::SignedOut)?;
            (state.generation, session.expires_at_unix_ms)
        };

        if force_refresh || expires_at <= now_ms() + REFRESH_SKEW_MS {
            match self
                .refresh_internal(observed_generation, force_refresh, false)
                .await
            {
                Ok(auth) => return Ok(auth),
                Err(error)
                    if !force_refresh
                        && error.class() == CodexErrorClass::Transient
                        && expires_at > now_ms() + MIN_USABLE_ACCESS_TOKEN_MS => {}
                Err(error) => return Err(error),
            }
        }

        self.current_auth_and_record_request().await
    }

    pub async fn refresh_after_unauthorized(
        &self,
        observed_generation: u64,
    ) -> Result<CodexRequestAuth, CodexAuthError> {
        {
            let mut state = self.inner.state.write().await;
            state.usage.unauthorized_refreshes =
                state.usage.unauthorized_refreshes.saturating_add(1);
        }
        self.refresh_internal(observed_generation, true, true).await
    }

    async fn run_browser_login(
        &self,
        listener: TcpListener,
        attempt_id: String,
        redirect_uri: String,
        code_verifier: String,
        expected_state: String,
        cancel: CancellationToken,
    ) {
        let (callback_tx, mut callback_rx) = mpsc::channel::<CallbackPayload>(1);
        let listener_cancel = cancel.clone();
        let server_state = expected_state.clone();
        let server_task = tokio::spawn(async move {
            run_callback_server(listener, server_state, callback_tx, listener_cancel).await;
        });

        let callback = tokio::select! {
            _ = cancel.cancelled() => Err(CodexAuthError::Cancelled),
            _ = tokio::time::sleep(BROWSER_LOGIN_TIMEOUT) => Err(CodexAuthError::Timeout),
            value = callback_rx.recv() => value.ok_or(CodexAuthError::Cancelled),
        };

        let result = match callback {
            Ok(CallbackPayload::Code { code, reply }) => {
                let exchange =
                    self.exchange_authorization_code(&code, &redirect_uri, &code_verifier);
                let result = tokio::select! {
                    _ = cancel.cancelled() => Err(CodexAuthError::Cancelled),
                    result = exchange => result.and_then(|tokens| self.session_from_initial_tokens(tokens)),
                };
                let installed = match result {
                    Ok(session) => self.persist_and_install(&attempt_id, session).await,
                    Err(error) => Err(error),
                };
                let _ = reply.send(installed.is_ok());
                installed
            }
            Ok(CallbackPayload::Denied { code, reply }) => {
                let _ = reply.send(false);
                Err(CodexAuthError::AuthorizationDenied { code })
            }
            Err(error) => Err(error),
        };

        cancel.cancel();
        let _ = server_task.await;
        match result {
            Ok(()) => self.finish_attempt_success(&attempt_id).await,
            Err(error) => self.finish_attempt_error(&attempt_id, &error).await,
        }
    }

    async fn run_device_login(
        &self,
        attempt_id: String,
        device_auth_id: String,
        user_code: String,
        poll_interval: Duration,
        expires_at_unix_ms: i64,
        cancel: CancellationToken,
    ) {
        let mut consecutive_network_failures = 0u8;
        let result = loop {
            if now_ms() >= expires_at_unix_ms {
                break Err(CodexAuthError::Timeout);
            }
            let delay = poll_interval + DEVICE_POLL_SAFETY_MARGIN;
            tokio::select! {
                _ = cancel.cancelled() => break Err(CodexAuthError::Cancelled),
                _ = tokio::time::sleep(delay) => {}
            }

            let poll = self.poll_device_code(&device_auth_id, &user_code).await;
            match poll {
                Ok(DevicePollResult::Pending) => {
                    consecutive_network_failures = 0;
                }
                Ok(DevicePollResult::Authorized {
                    authorization_code,
                    code_verifier,
                }) => {
                    let redirect_uri = self.inner.endpoints.device_redirect_url.to_string();
                    let exchange = self.exchange_authorization_code(
                        &authorization_code,
                        &redirect_uri,
                        &code_verifier,
                    );
                    let tokens = tokio::select! {
                        _ = cancel.cancelled() => Err(CodexAuthError::Cancelled),
                        result = exchange => result,
                    };
                    let installed =
                        match tokens.and_then(|tokens| self.session_from_initial_tokens(tokens)) {
                            Ok(session) => self.persist_and_install(&attempt_id, session).await,
                            Err(error) => Err(error),
                        };
                    break installed;
                }
                Err(error) if error.class() == CodexErrorClass::Transient => {
                    consecutive_network_failures = consecutive_network_failures.saturating_add(1);
                    if consecutive_network_failures >= 3 {
                        break Err(error);
                    }
                }
                Err(error) => break Err(error),
            }
        };

        match result {
            Ok(()) => self.finish_attempt_success(&attempt_id).await,
            Err(error) => self.finish_attempt_error(&attempt_id, &error).await,
        }
    }

    async fn request_device_code(
        &self,
    ) -> Result<(String, String, Duration, Option<u64>), CodexAuthError> {
        let client = self.http()?;
        let response = client
            .post(self.inner.endpoints.device_user_code_url.clone())
            .header(
                reqwest::header::USER_AGENT,
                format!("deep-student/{}", env!("CARGO_PKG_VERSION")),
            )
            .json(&json!({ "client_id": self.inner.endpoints.client_id }))
            .send()
            .await
            .map_err(|_| CodexAuthError::Network {
                stage: "device_authorization",
            })?;
        let status = response.status();
        let body_bytes = read_response_body_limited(response, "device_authorization").await?;
        let body = if status.is_success() {
            serde_json::from_slice(&body_bytes).map_err(|_| CodexAuthError::MalformedResponse {
                field: "device authorization response",
            })?
        } else {
            parse_error_body(&body_bytes)
        };
        if !status.is_success() {
            return Err(oauth_rejection("device_authorization", status, &body));
        }

        let device_auth_id = required_string(&body, "device_auth_id")?;
        let user_code = required_string_alias(&body, &["user_code", "usercode"], "user_code")?;
        let interval_seconds = body
            .get("interval")
            .and_then(value_as_u64)
            .unwrap_or(5)
            .clamp(1, 60);
        let expires_in = body.get("expires_in").and_then(value_as_u64);
        Ok((
            device_auth_id,
            user_code,
            Duration::from_secs(interval_seconds),
            expires_in,
        ))
    }

    async fn poll_device_code(
        &self,
        device_auth_id: &str,
        user_code: &str,
    ) -> Result<DevicePollResult, CodexAuthError> {
        let client = self.http()?;
        let response = client
            .post(self.inner.endpoints.device_token_url.clone())
            .header(
                reqwest::header::USER_AGENT,
                format!("deep-student/{}", env!("CARGO_PKG_VERSION")),
            )
            .json(&json!({
                "device_auth_id": device_auth_id,
                "user_code": user_code,
            }))
            .send()
            .await
            .map_err(|_| CodexAuthError::Network {
                stage: "device_poll",
            })?;
        let status = response.status();
        let body_bytes = read_response_body_limited(response, "device_poll").await?;
        let body = if status.is_success() {
            serde_json::from_slice(&body_bytes).map_err(|_| CodexAuthError::MalformedResponse {
                field: "device poll response",
            })?
        } else {
            parse_error_body(&body_bytes)
        };
        if status.is_success() {
            return Ok(DevicePollResult::Authorized {
                authorization_code: required_string(&body, "authorization_code")?,
                code_verifier: required_string(&body, "code_verifier")?,
            });
        }

        let code = oauth_error_code(&body);
        if status.as_u16() == 403
            || status.as_u16() == 404
            || matches!(code.as_str(), "authorization_pending" | "slow_down")
        {
            return Ok(DevicePollResult::Pending);
        }
        Err(oauth_rejection("device_poll", status, &body))
    }

    async fn exchange_authorization_code(
        &self,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
    ) -> Result<OAuthTokenResponse, CodexAuthError> {
        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", self.inner.endpoints.client_id.as_str()),
            ("code_verifier", code_verifier),
        ];
        self.token_request("token_exchange", &params).await
    }

    async fn refresh_token(
        &self,
        refresh_token: &str,
    ) -> Result<OAuthTokenResponse, CodexAuthError> {
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", self.inner.endpoints.client_id.as_str()),
        ];
        self.token_request("refresh", &params).await
    }

    async fn token_request(
        &self,
        stage: &'static str,
        params: &[(&str, &str)],
    ) -> Result<OAuthTokenResponse, CodexAuthError> {
        let client = self.http()?;
        let response = client
            .post(self.inner.endpoints.token_url.clone())
            .header(
                reqwest::header::USER_AGENT,
                format!("deep-student/{}", env!("CARGO_PKG_VERSION")),
            )
            .form(params)
            .send()
            .await
            .map_err(|_| CodexAuthError::Network { stage })?;
        let status = response.status();
        let body_bytes = read_response_body_limited(response, stage).await?;
        if !status.is_success() {
            let body = parse_error_body(&body_bytes);
            return Err(oauth_rejection(stage, status, &body));
        }
        let tokens: OAuthTokenResponse =
            serde_json::from_slice(&body_bytes).map_err(|_| CodexAuthError::MalformedResponse {
                field: "token response",
            })?;
        if tokens.access_token.trim().is_empty() {
            return Err(CodexAuthError::MalformedResponse {
                field: "access_token",
            });
        }
        Ok(tokens)
    }

    async fn refresh_internal(
        &self,
        observed_generation: u64,
        force: bool,
        from_unauthorized: bool,
    ) -> Result<CodexRequestAuth, CodexAuthError> {
        // Refresh owns rotating credentials, so it must outlive a request future that is dropped
        // after the OAuth server has accepted the refresh token. Tokio detaches spawned tasks when
        // their JoinHandle is dropped; all state and storage commits happen in that task.
        let manager = self.clone();
        let task = tokio::spawn(async move {
            manager
                .refresh_transaction(observed_generation, force, from_unauthorized)
                .await
        });
        task.await.map_err(|_| CodexAuthError::Network {
            stage: "refresh_task",
        })?
    }

    async fn refresh_transaction(
        &self,
        observed_generation: u64,
        force: bool,
        from_unauthorized: bool,
    ) -> Result<CodexRequestAuth, CodexAuthError> {
        let _refresh_guard = self.inner.refresh_gate.lock().await;
        let current = {
            let mut state = self.inner.state.write().await;
            if requires_reauthentication(&state) {
                return Err(CodexAuthError::ReauthenticationRequired);
            }
            let session = state
                .session
                .as_ref()
                .ok_or(CodexAuthError::SignedOut)?
                .clone();
            let generation = state.generation;
            if state.generation != observed_generation
                || (!force && session.expires_at_unix_ms > now_ms() + REFRESH_SKEW_MS)
            {
                state.usage.authenticated_requests =
                    state.usage.authenticated_requests.saturating_add(1);
                return Ok(CodexRequestAuth::new(&session, generation));
            }
            if state.active_attempt.is_none() {
                state.phase = CodexAuthPhase::Refreshing;
            }
            state.usage.refresh_attempts = state.usage.refresh_attempts.saturating_add(1);
            session
        };

        let tokens = self.refresh_token(&current.refresh_token).await;
        let refreshed =
            match tokens.and_then(|tokens| merge_refresh_session(&current, tokens, now_ms())) {
                Ok(session) => session,
                Err(error) => {
                    self.record_refresh_error(observed_generation, &error, false)
                        .await;
                    return Err(error);
                }
            };

        let identity_result = {
            let state = self.inner.state.read().await;
            if state.generation != observed_generation {
                let session = state.session.as_ref().ok_or(CodexAuthError::SignedOut)?;
                return Ok(CodexRequestAuth::new(session, state.generation));
            }
            match state.session.as_ref() {
                None => Err(CodexAuthError::SignedOut),
                Some(live_session) => validate_refresh_identity(live_session, &current, &refreshed),
            }
        };
        if let Err(error) = identity_result {
            self.record_refresh_error(observed_generation, &error, false)
                .await;
            return Err(error);
        }

        // refresh_gate keeps the live generation stable while encrypted storage runs off the
        // async executor. A post-save generation CAS still protects future non-gated mutations.
        let store = self.inner.store.clone();
        let persisted_session = refreshed.clone();
        let save_result = tokio::task::spawn_blocking(move || store.save(&persisted_session))
            .await
            .map_err(|_| CodexAuthError::CredentialStore)
            .and_then(|result| result);
        if let Err(error) = save_result {
            // The OAuth server may already have invalidated the old rotating refresh token. The
            // in-memory session is unsafe when its replacement cannot be persisted.
            self.record_refresh_error(observed_generation, &error, true)
                .await;
            return Err(error);
        }

        let mut state = self.inner.state.write().await;
        // Logout waits on refresh_gate, so only a newer successful login can change generation.
        // Never overwrite that newer account with this refresh result.
        if state.generation != observed_generation {
            let session = state.session.as_ref().ok_or(CodexAuthError::SignedOut)?;
            return Ok(CodexRequestAuth::new(session, state.generation));
        }
        state.session = Some(refreshed);
        state.generation = state.generation.saturating_add(1);
        set_stable_phase_preserving_login(&mut state, CodexAuthPhase::Authenticated);
        state.last_error = None;
        state.usage.refresh_successes = state.usage.refresh_successes.saturating_add(1);
        state.usage.last_refresh_at_unix_ms = Some(now_ms());
        state.usage.authenticated_requests = state.usage.authenticated_requests.saturating_add(1);
        let session = state.session.as_ref().expect("installed session");
        let auth = CodexRequestAuth::new(session, state.generation);
        let _ = from_unauthorized;
        Ok(auth)
    }

    async fn record_refresh_error(
        &self,
        observed_generation: u64,
        error: &CodexAuthError,
        persistence_uncertain: bool,
    ) {
        let mut state = self.inner.state.write().await;
        state.usage.refresh_failures = state.usage.refresh_failures.saturating_add(1);
        if state.generation != observed_generation {
            return;
        }
        state.last_error = Some(error.to_dto());
        let phase = if persistence_uncertain
            || error.class() == CodexErrorClass::ReauthenticationRequired
        {
            CodexAuthPhase::ReauthenticationRequired
        } else if state.session.is_some() {
            CodexAuthPhase::Authenticated
        } else {
            CodexAuthPhase::Error
        };
        set_stable_phase_preserving_login(&mut state, phase);
    }

    async fn current_auth_and_record_request(&self) -> Result<CodexRequestAuth, CodexAuthError> {
        let mut state = self.inner.state.write().await;
        if requires_reauthentication(&state) {
            return Err(CodexAuthError::ReauthenticationRequired);
        }
        let session = state.session.as_ref().ok_or(CodexAuthError::SignedOut)?;
        if session.expires_at_unix_ms <= now_ms() {
            return Err(CodexAuthError::ReauthenticationRequired);
        }
        let auth = CodexRequestAuth::new(session, state.generation);
        state.usage.authenticated_requests = state.usage.authenticated_requests.saturating_add(1);
        Ok(auth)
    }

    fn session_from_initial_tokens(
        &self,
        tokens: OAuthTokenResponse,
    ) -> Result<StoredCodexSession, CodexAuthError> {
        let refresh_token = tokens
            .refresh_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(CodexAuthError::MalformedResponse {
                field: "refresh_token",
            })?
            .to_string();
        let account_id = extract_account_id(&tokens).ok_or(CodexAuthError::MissingAccountId)?;
        let metadata = extract_token_metadata(&tokens);
        let refreshed_at = now_ms();
        Ok(StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: tokens.access_token.clone(),
            refresh_token,
            id_token: tokens.id_token.clone(),
            expires_at_unix_ms: expiry_from_response(refreshed_at, tokens.expires_in),
            account_id,
            email: metadata.email,
            plan_type: metadata.plan_type,
            is_fedramp: metadata.is_fedramp.unwrap_or(false),
            last_refresh_at: Some(refreshed_at),
        })
    }

    async fn persist_and_install(
        &self,
        attempt_id: &str,
        session: StoredCodexSession,
    ) -> Result<(), CodexAuthError> {
        // The detached transaction closes the post-save cancellation window: once persistence
        // starts, the matching memory commit still runs even if the login waiter is dropped.
        let manager = self.clone();
        let attempt_id = attempt_id.to_string();
        let task = tokio::spawn(async move {
            let result = manager
                .persist_and_install_transaction(&attempt_id, session)
                .await;
            if let Err(error) = &result {
                manager.finish_attempt_error(&attempt_id, error).await;
            }
            result
        });
        task.await.map_err(|_| CodexAuthError::CredentialStore)?
    }

    async fn persist_and_install_transaction(
        &self,
        attempt_id: &str,
        session: StoredCodexSession,
    ) -> Result<(), CodexAuthError> {
        // Serialize login installation with refresh/logout so a late refresh can never
        // overwrite a newly selected account in encrypted storage.
        let _refresh_guard = self.inner.refresh_gate.lock().await;
        {
            let state = self.inner.state.read().await;
            if state
                .active_attempt
                .as_ref()
                .map(|attempt| attempt.id.as_str())
                != Some(attempt_id)
            {
                return Err(CodexAuthError::Cancelled);
            }
        }

        // The gate is the cancel/save linearization point. It keeps the attempt stable while the
        // synchronous store runs, without holding a Tokio state lock or blocking an async worker.
        let store = self.inner.store.clone();
        let persisted_session = session.clone();
        tokio::task::spawn_blocking(move || store.save(&persisted_session))
            .await
            .map_err(|_| CodexAuthError::CredentialStore)??;
        let mut state = self.inner.state.write().await;
        debug_assert_eq!(
            state
                .active_attempt
                .as_ref()
                .map(|attempt| attempt.id.as_str()),
            Some(attempt_id)
        );
        state.session = Some(session);
        state.active_attempt = None;
        state.generation = state.generation.saturating_add(1);
        state.phase = CodexAuthPhase::Authenticated;
        state.last_error = None;
        Ok(())
    }

    async fn ensure_no_active_login(&self) -> Result<(), CodexAuthError> {
        if self.inner.state.read().await.active_attempt.is_some() {
            Err(CodexAuthError::LoginBusy)
        } else {
            Ok(())
        }
    }

    async fn install_attempt(&self, mut attempt: ActiveAttempt) -> Result<(), CodexAuthError> {
        let mut state = self.inner.state.write().await;
        if state.active_attempt.is_some() {
            return Err(CodexAuthError::LoginBusy);
        }
        attempt.previous_phase = Some(state.phase);
        state.phase = CodexAuthPhase::Authorizing;
        state.last_error = None;
        state.active_attempt = Some(attempt);
        Ok(())
    }

    async fn finish_attempt_success(&self, attempt_id: &str) {
        let mut state = self.inner.state.write().await;
        if state
            .active_attempt
            .as_ref()
            .map(|attempt| attempt.id.as_str())
            == Some(attempt_id)
        {
            state.active_attempt = None;
            state.phase = base_phase(&state);
            state.last_error = None;
        }
    }

    async fn finish_attempt_error(&self, attempt_id: &str, error: &CodexAuthError) {
        let mut state = self.inner.state.write().await;
        if state
            .active_attempt
            .as_ref()
            .map(|attempt| attempt.id.as_str())
            != Some(attempt_id)
        {
            return;
        }
        let previous_phase = state
            .active_attempt
            .as_ref()
            .and_then(|attempt| attempt.previous_phase);
        state.active_attempt = None;
        state.last_error = Some(error.to_dto());
        state.phase = if error.class() == CodexErrorClass::ReauthenticationRequired {
            CodexAuthPhase::ReauthenticationRequired
        } else if state.phase == CodexAuthPhase::Authorizing {
            restore_phase_after_login_attempt(&state, previous_phase)
        } else {
            base_phase(&state)
        };
    }

    fn http(&self) -> Result<&reqwest::Client, CodexAuthError> {
        self.inner.http.as_ref().ok_or(CodexAuthError::Network {
            stage: "http_client_initialization",
        })
    }
}

async fn bind_callback_listener() -> Result<TcpListener, CodexAuthError> {
    for port in CALLBACK_PORTS {
        if let Ok(listener) = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            return Ok(listener);
        }
    }
    Err(CodexAuthError::CallbackBind)
}

async fn run_callback_server(
    listener: TcpListener,
    expected_state: String,
    callback_tx: mpsc::Sender<CallbackPayload>,
    cancel: CancellationToken,
) {
    loop {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _peer)) = accepted else {
            break;
        };
        let state = expected_state.clone();
        let tx = callback_tx.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                handle_callback_request(request, state.clone(), tx.clone())
            });
            let _ = hyper::server::conn::Http::new()
                .http1_only(true)
                .serve_connection(stream, service)
                .await;
        });
    }
}

async fn handle_callback_request(
    request: Request<Body>,
    expected_state: String,
    callback_tx: mpsc::Sender<CallbackPayload>,
) -> Result<Response<Body>, Infallible> {
    if request.method() != hyper::Method::GET || request.uri().path() != "/auth/callback" {
        return Ok(html_response(StatusCode::NOT_FOUND, false));
    }
    let params: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();

    // Validate state before consuming provider errors as well. OpenCode accepts an error before
    // checking state, allowing any local process to cancel a pending login.
    if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
        return Ok(html_response(StatusCode::BAD_REQUEST, false));
    }

    let (reply_tx, reply_rx) = oneshot::channel();
    let payload = if let Some(error) = params.get("error") {
        CallbackPayload::Denied {
            code: sanitize_oauth_code(error),
            reply: reply_tx,
        }
    } else if let Some(code) = params.get("code").filter(|code| !code.is_empty()) {
        CallbackPayload::Code {
            code: code.clone(),
            reply: reply_tx,
        }
    } else {
        return Ok(html_response(StatusCode::BAD_REQUEST, false));
    };

    if callback_tx.send(payload).await.is_err() {
        return Ok(html_response(StatusCode::GONE, false));
    }
    let success = tokio::time::timeout(CALLBACK_RESULT_TIMEOUT, reply_rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false);
    Ok(html_response(
        if success {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        success,
    ))
}

fn html_response(status: StatusCode, success: bool) -> Response<Body> {
    let message = if success {
        "Authorization complete. You can return to Deep Student."
    } else {
        "Authorization could not be completed. Return to Deep Student for details."
    };
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        )
        .header("cache-control", "no-store")
        .body(Body::from(format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Deep Student</title><p>{}</p>",
            message
        )))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

struct PkcePair {
    verifier: String,
    challenge: String,
}

fn generate_pkce() -> PkcePair {
    let verifier = random_urlsafe(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair {
        verifier,
        challenge,
    }
}

fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn build_authorization_url(
    endpoints: &CodexEndpointConfig,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, CodexAuthError> {
    let mut url = endpoints.authorize_url.clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &endpoints.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", OPENAI_OAUTH_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", CODEX_ORIGINATOR);
    Ok(url.to_string())
}

fn parse_jwt_claims(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn account_id_from_claims(claims: &Value) -> Option<String> {
    claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|value| value.get("chatgpt_account_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .get("organizations")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn extract_account_id(tokens: &OAuthTokenResponse) -> Option<String> {
    tokens
        .id_token
        .as_deref()
        .and_then(parse_jwt_claims)
        .as_ref()
        .and_then(account_id_from_claims)
        .or_else(|| {
            parse_jwt_claims(&tokens.access_token)
                .as_ref()
                .and_then(account_id_from_claims)
        })
}

#[derive(Default)]
struct TokenMetadata {
    email: Option<String>,
    plan_type: Option<String>,
    is_fedramp: Option<bool>,
}

fn extract_token_metadata(tokens: &OAuthTokenResponse) -> TokenMetadata {
    let id_claims = tokens.id_token.as_deref().and_then(parse_jwt_claims);
    let access_claims = parse_jwt_claims(&tokens.access_token);
    let primary = id_claims
        .as_ref()
        .map(metadata_from_claims)
        .unwrap_or_default();
    let secondary = access_claims
        .as_ref()
        .map(metadata_from_claims)
        .unwrap_or_default();
    TokenMetadata {
        email: primary.email.or(secondary.email),
        plan_type: primary.plan_type.or(secondary.plan_type),
        is_fedramp: primary.is_fedramp.or(secondary.is_fedramp),
    }
}

fn metadata_from_claims(claims: &Value) -> TokenMetadata {
    let auth = claims.get("https://api.openai.com/auth");
    let profile = claims.get("https://api.openai.com/profile");

    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| {
            auth.and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            profile
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let plan_type = claims
        .get("chatgpt_plan_type")
        .or_else(|| claims.get("plan_type"))
        .and_then(Value::as_str)
        .or_else(|| {
            auth.and_then(|value| {
                value
                    .get("chatgpt_plan_type")
                    .or_else(|| value.get("plan_type"))
            })
            .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let is_fedramp = claims
        .get("is_fedramp")
        .and_then(Value::as_bool)
        .or_else(|| {
            auth.and_then(|value| {
                value
                    .get("chatgpt_account_is_fedramp")
                    .or_else(|| value.get("is_fedramp"))
            })
            .and_then(Value::as_bool)
        });

    TokenMetadata {
        email,
        plan_type,
        is_fedramp,
    }
}

fn merge_refresh_session(
    current: &StoredCodexSession,
    tokens: OAuthTokenResponse,
    refreshed_at_unix_ms: i64,
) -> Result<StoredCodexSession, CodexAuthError> {
    let current_account_id = current.account_id.trim();
    if current_account_id.is_empty() {
        return Err(CodexAuthError::MissingAccountId);
    }
    let incoming_account_id = extract_account_id(&tokens);
    if let Some(incoming) = incoming_account_id.as_deref() {
        if incoming != current_account_id {
            return Err(CodexAuthError::AccountChanged);
        }
    }
    let account_id = incoming_account_id.unwrap_or_else(|| current_account_id.to_string());
    let refresh_token = tokens
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| current.refresh_token.clone());
    let metadata = extract_token_metadata(&tokens);
    let id_token = tokens
        .id_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| current.id_token.clone());
    Ok(StoredCodexSession {
        schema_version: SESSION_SCHEMA_VERSION,
        access_token: tokens.access_token.clone(),
        refresh_token,
        id_token,
        expires_at_unix_ms: expiry_from_response(refreshed_at_unix_ms, tokens.expires_in),
        account_id,
        email: metadata.email.or_else(|| current.email.clone()),
        plan_type: metadata.plan_type.or_else(|| current.plan_type.clone()),
        is_fedramp: metadata.is_fedramp.unwrap_or(current.is_fedramp),
        last_refresh_at: Some(refreshed_at_unix_ms),
    })
}

fn validate_refresh_identity(
    live: &StoredCodexSession,
    requested: &StoredCodexSession,
    refreshed: &StoredCodexSession,
) -> Result<(), CodexAuthError> {
    let live_account_id = live.account_id.trim();
    let requested_account_id = requested.account_id.trim();
    if live_account_id.is_empty()
        || requested_account_id.is_empty()
        || refreshed.account_id.trim().is_empty()
    {
        return Err(CodexAuthError::MissingAccountId);
    }
    if live_account_id != requested_account_id
        || refreshed.account_id.trim() != requested_account_id
    {
        return Err(CodexAuthError::AccountChanged);
    }
    Ok(())
}

fn parse_usage_snapshot(body: &Value, fetched_at_unix_ms: i64) -> CodexUsageSnapshot {
    let outer_plan = string_at(body, &["plan_type", "planType"]);
    let mut by_limit_id = HashMap::new();

    if let Some(entries) = body
        .get("rate_limits_by_limit_id")
        .or_else(|| body.get("rateLimitsByLimitId"))
        .and_then(Value::as_object)
    {
        for (limit_id, value) in entries {
            if let Some(parsed) = parse_rate_limits(
                value,
                Some(limit_id),
                outer_plan.as_deref(),
                fetched_at_unix_ms,
            ) {
                by_limit_id.insert(limit_id.clone(), parsed);
            }
        }
    }

    if let Some(entries) = body
        .get("additional_rate_limits")
        .or_else(|| body.get("additionalRateLimits"))
        .and_then(Value::as_array)
    {
        for value in entries {
            let fallback_id = string_at(
                value,
                &[
                    "limit_id",
                    "limitId",
                    "metered_feature",
                    "meteredFeature",
                    "limit_name",
                    "limitName",
                ],
            )
            .unwrap_or_else(|| format!("additional_{}", by_limit_id.len() + 1));
            if let Some(parsed) = parse_rate_limits(
                value,
                Some(&fallback_id),
                outer_plan.as_deref(),
                fetched_at_unix_ms,
            ) {
                by_limit_id.insert(fallback_id, parsed);
            }
        }
    }

    if let Some(entries) = body.get("rate_limits").or_else(|| body.get("rateLimits")) {
        if let Some(array) = entries.as_array() {
            for value in array {
                if let Some(parsed) =
                    parse_rate_limits(value, None, outer_plan.as_deref(), fetched_at_unix_ms)
                {
                    let id = parsed
                        .limit_id
                        .clone()
                        .unwrap_or_else(|| format!("limit_{}", by_limit_id.len() + 1));
                    by_limit_id.insert(id, parsed);
                }
            }
        } else if let Some(object) = entries.as_object() {
            if looks_like_rate_limit(entries) {
                if let Some(parsed) = parse_rate_limits(
                    entries,
                    Some("codex"),
                    outer_plan.as_deref(),
                    fetched_at_unix_ms,
                ) {
                    by_limit_id.entry("codex".to_string()).or_insert(parsed);
                }
            } else {
                for (limit_id, value) in object {
                    if let Some(parsed) = parse_rate_limits(
                        value,
                        Some(limit_id),
                        outer_plan.as_deref(),
                        fetched_at_unix_ms,
                    ) {
                        by_limit_id.entry(limit_id.clone()).or_insert(parsed);
                    }
                }
            }
        }
    }

    for (key, limit_id) in [
        ("rate_limit", "codex"),
        ("rateLimit", "codex"),
        ("code_review_rate_limit", "codex_review"),
        ("codeReviewRateLimit", "codex_review"),
    ] {
        if let Some(value) = body.get(key) {
            if let Some(parsed) = parse_rate_limits(
                value,
                Some(limit_id),
                outer_plan.as_deref(),
                fetched_at_unix_ms,
            ) {
                by_limit_id.entry(limit_id.to_string()).or_insert(parsed);
            }
        }
    }

    if by_limit_id.is_empty() && looks_like_rate_limit(body) {
        if let Some(parsed) = parse_rate_limits(
            body,
            Some("codex"),
            outer_plan.as_deref(),
            fetched_at_unix_ms,
        ) {
            by_limit_id.insert("codex".to_string(), parsed);
        }
    }

    let rate_limits = by_limit_id
        .get("codex")
        .cloned()
        .or_else(|| by_limit_id.values().next().cloned());
    CodexUsageSnapshot {
        rate_limits,
        rate_limits_by_limit_id: by_limit_id,
        fetched_at: fetched_at_unix_ms,
    }
}

fn looks_like_rate_limit(value: &Value) -> bool {
    [
        "primary",
        "primary_window",
        "primaryWindow",
        "secondary",
        "secondary_window",
        "secondaryWindow",
    ]
    .iter()
    .any(|key| value.get(key).is_some())
}

fn parse_rate_limits(
    value: &Value,
    fallback_limit_id: Option<&str>,
    fallback_plan_type: Option<&str>,
    fetched_at_unix_ms: i64,
) -> Option<CodexRateLimits> {
    let outer = value;
    let value = outer
        .get("rate_limit")
        .or_else(|| value.get("rateLimit"))
        .unwrap_or(value);
    let primary = value
        .get("primary")
        .or_else(|| value.get("primary_window"))
        .or_else(|| value.get("primaryWindow"))
        .and_then(|window| parse_rate_limit_window(window, fetched_at_unix_ms));
    let secondary = value
        .get("secondary")
        .or_else(|| value.get("secondary_window"))
        .or_else(|| value.get("secondaryWindow"))
        .and_then(|window| parse_rate_limit_window(window, fetched_at_unix_ms));
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    Some(CodexRateLimits {
        primary,
        secondary,
        limit_id: string_at(value, &["limit_id", "limitId"])
            .or_else(|| {
                string_at(
                    outer,
                    &["limit_id", "limitId", "metered_feature", "meteredFeature"],
                )
            })
            .or_else(|| fallback_limit_id.map(ToOwned::to_owned)),
        limit_name: string_at(outer, &["limit_name", "limitName"])
            .or_else(|| string_at(value, &["limit_name", "limitName"])),
        plan_type: string_at(value, &["plan_type", "planType"])
            .or_else(|| fallback_plan_type.map(ToOwned::to_owned)),
    })
}

fn parse_rate_limit_window(value: &Value, fetched_at_unix_ms: i64) -> Option<CodexRateLimitWindow> {
    let mut used_percent = number_at(value, &["used_percent", "usedPercent"]);
    if used_percent.is_none() {
        used_percent = number_at(value, &["remaining_percent", "remainingPercent"])
            .map(|remaining| 100.0 - remaining);
    }
    used_percent = used_percent.map(|used| used.clamp(0.0, 100.0));

    let window_duration_mins = integer_at(
        value,
        &[
            "window_duration_mins",
            "windowDurationMins",
            "window_minutes",
            "windowMinutes",
        ],
    )
    .or_else(|| {
        integer_at(
            value,
            &[
                "limit_window_seconds",
                "limitWindowSeconds",
                "window_seconds",
                "windowSeconds",
            ],
        )
        .map(|seconds| seconds.saturating_add(59) / 60)
    });
    let resets_at = timestamp_at(
        value,
        &["resets_at", "resetsAt", "reset_at", "resetAt", "reset_time"],
    )
    .or_else(|| {
        integer_at(value, &["resets_in_seconds", "resetsInSeconds"])
            .map(|seconds| fetched_at_unix_ms / 1000 + seconds as i64)
    });

    if used_percent.is_none() && window_duration_mins.is_none() && resets_at.is_none() {
        return None;
    }
    Some(CodexRateLimitWindow {
        used_percent,
        window_duration_mins,
        resets_at,
    })
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(128).collect())
}

fn number_at(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|item| item.as_f64().or_else(|| item.as_str()?.parse().ok()))
    })
}

fn integer_at(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(value_as_u64))
}

fn timestamp_at(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_i64()
            .or_else(|| value.as_str()?.parse::<i64>().ok())
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                    .map(|time| time.timestamp())
            })
    })
}

fn expiry_from_response(now_unix_ms: i64, expires_in: Option<i64>) -> i64 {
    let seconds = expires_in
        .unwrap_or(DEFAULT_TOKEN_LIFETIME_SECONDS)
        .clamp(MIN_TOKEN_LIFETIME_SECONDS, MAX_TOKEN_LIFETIME_SECONDS);
    now_unix_ms.saturating_add(seconds.saturating_mul(1000))
}

fn oauth_rejection(
    stage: &'static str,
    status: reqwest::StatusCode,
    body: &Value,
) -> CodexAuthError {
    let mut code = oauth_error_code(body);
    if code == "http_error" {
        code = format!("http_{}", status.as_u16());
    }
    let reauth_required = stage == "refresh"
        && matches!(
            code.as_str(),
            "invalid_grant" | "invalid_token" | "unauthorized"
        );
    let rate_limited = matches!(
        code.as_str(),
        "usage_limit_reached" | "usage_not_included" | "rate_limit_exceeded" | "slow_down"
    );
    let permanent = reauth_required
        || status.is_client_error()
            && status.as_u16() != 408
            && status.as_u16() != 429
            && !rate_limited
            && code != "temporarily_unavailable";
    CodexAuthError::OAuthRejected {
        stage,
        code,
        permanent,
        reauth_required,
    }
}

fn oauth_error_code(body: &Value) -> String {
    body.pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .or_else(|| body.get("code").and_then(Value::as_str))
        .or_else(|| body.pointer("/detail/code").and_then(Value::as_str))
        .or_else(|| body.pointer("/error/type").and_then(Value::as_str))
        .map(sanitize_oauth_code)
        .unwrap_or_else(|| "http_error".to_string())
}

fn parse_error_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

async fn read_response_body_limited(
    response: reqwest::Response,
    stage: &'static str,
) -> Result<Vec<u8>, CodexAuthError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_OAUTH_RESPONSE_BODY_BYTES as u64)
    {
        return Err(CodexAuthError::ResponseTooLarge { stage });
    }

    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(MAX_OAUTH_RESPONSE_BODY_BYTES);
    let mut body = Vec::with_capacity(capacity);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| CodexAuthError::Network { stage })?;
        if body.len().saturating_add(chunk.len()) > MAX_OAUTH_RESPONSE_BODY_BYTES {
            return Err(CodexAuthError::ResponseTooLarge { stage });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn sanitize_oauth_code(value: &str) -> String {
    let filtered: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .take(64)
        .collect();
    if filtered.is_empty() {
        "oauth_error".to_string()
    } else {
        filtered
    }
}

fn required_string(value: &Value, field: &'static str) -> Result<String, CodexAuthError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(CodexAuthError::MalformedResponse { field })
}

fn required_string_alias(
    value: &Value,
    fields: &[&str],
    error_field: &'static str,
) -> Result<String, CodexAuthError> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(CodexAuthError::MalformedResponse { field: error_field })
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn base_phase(state: &RuntimeState) -> CodexAuthPhase {
    if state.session.is_some() {
        CodexAuthPhase::Authenticated
    } else {
        CodexAuthPhase::SignedOut
    }
}

fn requires_reauthentication(state: &RuntimeState) -> bool {
    state.phase == CodexAuthPhase::ReauthenticationRequired
        || state
            .active_attempt
            .as_ref()
            .and_then(|attempt| attempt.previous_phase)
            == Some(CodexAuthPhase::ReauthenticationRequired)
}

fn set_stable_phase_preserving_login(state: &mut RuntimeState, phase: CodexAuthPhase) {
    if let Some(attempt) = state.active_attempt.as_mut() {
        attempt.previous_phase = Some(phase);
        state.phase = CodexAuthPhase::Authorizing;
    } else {
        state.phase = phase;
    }
}

fn restore_phase_after_login_attempt(
    state: &RuntimeState,
    previous_phase: Option<CodexAuthPhase>,
) -> CodexAuthPhase {
    match previous_phase {
        Some(CodexAuthPhase::ReauthenticationRequired) => CodexAuthPhase::ReauthenticationRequired,
        Some(CodexAuthPhase::Error) if state.session.is_none() => CodexAuthPhase::Error,
        _ => base_phase(state),
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai_codex::store::test_support::MemoryCodexCredentialStore;
    use hyper::service::{make_service_fn, service_fn};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex as StdMutex};
    use tokio::sync::Notify;
    use url::Url;

    struct BlockingSaveStore {
        value: StdMutex<Option<StoredCodexSession>>,
        save_started: Notify,
        save_released: StdMutex<bool>,
        save_release: Condvar,
        save_count: AtomicUsize,
        fail_save: AtomicBool,
    }

    impl Default for BlockingSaveStore {
        fn default() -> Self {
            Self {
                value: StdMutex::new(None),
                save_started: Notify::new(),
                save_released: StdMutex::new(false),
                save_release: Condvar::new(),
                save_count: AtomicUsize::new(0),
                fail_save: AtomicBool::new(false),
            }
        }
    }

    impl BlockingSaveStore {
        fn release_save(&self) {
            *self.save_released.lock().unwrap() = true;
            self.save_release.notify_all();
        }

        fn fail_on_save(&self) {
            self.fail_save.store(true, Ordering::SeqCst);
        }

        fn set_session(&self, session: StoredCodexSession) {
            *self.value.lock().unwrap() = Some(session);
        }
    }

    impl CodexCredentialStore for BlockingSaveStore {
        fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError> {
            self.save_count.fetch_add(1, Ordering::SeqCst);
            self.save_started.notify_one();
            let mut released = self.save_released.lock().unwrap();
            while !*released {
                let (next, timeout) = self
                    .save_release
                    .wait_timeout(released, Duration::from_secs(10))
                    .unwrap();
                released = next;
                if timeout.timed_out() {
                    return Err(CodexAuthError::CredentialStore);
                }
            }
            if self.fail_save.load(Ordering::SeqCst) {
                return Err(CodexAuthError::CredentialStore);
            }
            *self.value.lock().unwrap() = Some(session.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), CodexAuthError> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FailingDeleteStore {
        value: StdMutex<Option<StoredCodexSession>>,
    }

    impl CodexCredentialStore for FailingDeleteStore {
        fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError> {
            *self.value.lock().unwrap() = Some(session.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), CodexAuthError> {
            Err(CodexAuthError::CredentialStore)
        }
    }

    struct BlockingDeleteStore {
        value: StdMutex<Option<StoredCodexSession>>,
        delete_started: Notify,
        delete_released: StdMutex<bool>,
        delete_release: Condvar,
    }

    impl BlockingDeleteStore {
        fn new(session: StoredCodexSession) -> Self {
            Self {
                value: StdMutex::new(Some(session)),
                delete_started: Notify::new(),
                delete_released: StdMutex::new(false),
                delete_release: Condvar::new(),
            }
        }

        fn release_delete(&self) {
            *self.delete_released.lock().unwrap() = true;
            self.delete_release.notify_all();
        }
    }

    impl CodexCredentialStore for BlockingDeleteStore {
        fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError> {
            *self.value.lock().unwrap() = Some(session.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), CodexAuthError> {
            self.delete_started.notify_one();
            let mut released = self.delete_released.lock().unwrap();
            while !*released {
                let (next, timeout) = self
                    .delete_release
                    .wait_timeout(released, Duration::from_secs(10))
                    .unwrap();
                released = next;
                if timeout.timed_out() {
                    return Err(CodexAuthError::CredentialStore);
                }
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    fn jwt(payload: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("{}.{}.sig", header, payload)
    }

    fn token_response(
        account_id: Option<&str>,
        access_token: &str,
        refresh_token: Option<&str>,
    ) -> OAuthTokenResponse {
        OAuthTokenResponse {
            access_token: access_token.to_string(),
            refresh_token: refresh_token.map(ToOwned::to_owned),
            id_token: account_id.map(|id| jwt(json!({ "chatgpt_account_id": id }))),
            expires_in: Some(3600),
        }
    }

    fn stored_session(account_id: &str, access_token: &str) -> StoredCodexSession {
        StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: access_token.to_string(),
            refresh_token: "refresh-secret".to_string(),
            id_token: None,
            expires_at_unix_ms: now_ms() + 3_600_000,
            account_id: account_id.to_string(),
            email: None,
            plan_type: Some("plus".to_string()),
            is_fedramp: false,
            last_refresh_at: Some(now_ms()),
        }
    }

    fn active_attempt(id: &str, kind: CodexLoginKind) -> ActiveAttempt {
        ActiveAttempt {
            id: id.to_string(),
            kind,
            expires_at_unix_ms: now_ms() + 60_000,
            authorization_url: None,
            verification_url: None,
            user_code: None,
            poll_interval_seconds: None,
            previous_phase: None,
            cancel: CancellationToken::new(),
        }
    }

    #[test]
    fn pkce_uses_s256_and_rfc_length_verifier() {
        let pkce = generate_pkce();
        assert!((43..=128).contains(&pkce.verifier.len()));
        assert_eq!(
            pkce.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(pkce.verifier.as_bytes()))
        );
        assert!(!pkce.challenge.contains('='));
    }

    #[test]
    fn jwt_claims_use_root_then_namespaced_then_organization() {
        let root = parse_jwt_claims(&jwt(json!({
            "chatgpt_account_id": "root",
            "https://api.openai.com/auth": {"chatgpt_account_id": "nested"}
        })))
        .unwrap();
        assert_eq!(account_id_from_claims(&root).as_deref(), Some("root"));

        let nested = parse_jwt_claims(&jwt(json!({
            "https://api.openai.com/auth": {"chatgpt_account_id": "nested"}
        })))
        .unwrap();
        assert_eq!(account_id_from_claims(&nested).as_deref(), Some("nested"));

        let organization = parse_jwt_claims(&jwt(json!({
            "organizations": [{"id": "org-1"}]
        })))
        .unwrap();
        assert_eq!(
            account_id_from_claims(&organization).as_deref(),
            Some("org-1")
        );
    }

    #[test]
    fn malformed_jwt_is_rejected() {
        assert!(parse_jwt_claims("not-a-jwt").is_none());
        assert!(parse_jwt_claims("a.b.c.d").is_none());
    }

    #[test]
    fn initial_tokens_require_account_id() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        assert!(matches!(
            manager.session_from_initial_tokens(token_response(
                None,
                "new-access",
                Some("new-refresh")
            )),
            Err(CodexAuthError::MissingAccountId)
        ));
    }

    #[test]
    fn refresh_merge_retains_rotating_fields_when_omitted() {
        let current = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "old-access".to_string(),
            refresh_token: "old-refresh".to_string(),
            id_token: Some("old-id".to_string()),
            expires_at_unix_ms: 1,
            account_id: "account-1".to_string(),
            email: Some("old@example.com".to_string()),
            plan_type: Some("plus".to_string()),
            is_fedramp: true,
            last_refresh_at: None,
        };
        let merged =
            merge_refresh_session(&current, token_response(None, "new-access", None), 1_000)
                .unwrap();
        assert_eq!(merged.refresh_token, "old-refresh");
        assert_eq!(merged.account_id, "account-1");
        assert_eq!(merged.access_token, "new-access");
        assert_eq!(merged.id_token.as_deref(), Some("old-id"));
        assert_eq!(merged.email.as_deref(), Some("old@example.com"));
        assert_eq!(merged.plan_type.as_deref(), Some("plus"));
        assert!(merged.is_fedramp);
        assert_eq!(merged.last_refresh_at, Some(1_000));
    }

    #[test]
    fn refresh_merge_rejects_account_switch() {
        let current = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "old-access".to_string(),
            refresh_token: "old-refresh".to_string(),
            id_token: None,
            expires_at_unix_ms: 1,
            account_id: "account-1".to_string(),
            email: None,
            plan_type: None,
            is_fedramp: false,
            last_refresh_at: None,
        };
        let error = merge_refresh_session(
            &current,
            token_response(Some("account-2"), "new-access", Some("new-refresh")),
            1_000,
        )
        .unwrap_err();
        assert!(matches!(error, CodexAuthError::AccountChanged));
    }

    #[test]
    fn refresh_commit_rejects_live_account_change_or_missing_identity() {
        let requested = stored_session("account-1", "old-access");
        let refreshed = stored_session("account-1", "new-access");
        let different_live = stored_session("account-2", "newer-access");
        assert!(matches!(
            validate_refresh_identity(&different_live, &requested, &refreshed),
            Err(CodexAuthError::AccountChanged)
        ));

        let missing_identity = stored_session(" ", "new-access");
        assert!(matches!(
            validate_refresh_identity(&requested, &requested, &missing_identity),
            Err(CodexAuthError::MissingAccountId)
        ));
    }

    #[test]
    fn nested_usage_limit_error_is_safely_mapped_as_transient() {
        let body = json!({
            "error": {
                "code": "usage_limit_reached",
                "message": "sensitive upstream detail"
            }
        });
        let error = oauth_rejection("usage", reqwest::StatusCode::NOT_FOUND, &body);
        assert!(matches!(
            &error,
            CodexAuthError::OAuthRejected {
                code,
                permanent: false,
                reauth_required: false,
                ..
            } if code == "usage_limit_reached"
        ));
        assert!(!error.to_dto().message.contains("sensitive upstream detail"));
    }

    #[test]
    fn authorization_url_contains_exact_openai_flow_fields() {
        let endpoints = CodexEndpointConfig::for_test("http://127.0.0.1:9999/");
        let url = build_authorization_url(
            &endpoints,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let query: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(query["scope"], OPENAI_OAUTH_SCOPE);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["codex_cli_simplified_flow"], "true");
        assert_eq!(query["id_token_add_organizations"], "true");
        assert_eq!(query["originator"], CODEX_ORIGINATOR);
    }

    #[test]
    fn device_user_code_accepts_both_server_spellings() {
        assert_eq!(
            required_string_alias(
                &json!({"user_code": "ABCD-EFGH"}),
                &["user_code", "usercode"],
                "user_code"
            )
            .unwrap(),
            "ABCD-EFGH"
        );
        assert_eq!(
            required_string_alias(
                &json!({"usercode": "WXYZ-1234"}),
                &["user_code", "usercode"],
                "user_code"
            )
            .unwrap(),
            "WXYZ-1234"
        );
    }

    #[tokio::test]
    async fn cancelled_or_failed_reauthentication_login_preserves_required_phase() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&StoredCodexSession {
                schema_version: SESSION_SCHEMA_VERSION,
                access_token: "access-secret".to_string(),
                refresh_token: "refresh-secret".to_string(),
                id_token: None,
                expires_at_unix_ms: now_ms() + 3_600_000,
                account_id: "account-1".to_string(),
                email: None,
                plan_type: Some("plus".to_string()),
                is_fedramp: false,
                last_refresh_at: Some(now_ms()),
            })
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        assert!(manager.mark_reauthentication_required(1).await);

        let attempt = |id: &str| ActiveAttempt {
            id: id.to_string(),
            kind: CodexLoginKind::Browser,
            expires_at_unix_ms: now_ms() + 60_000,
            authorization_url: Some("https://example.invalid/authorize".to_string()),
            verification_url: None,
            user_code: None,
            poll_interval_seconds: None,
            previous_phase: None,
            cancel: CancellationToken::new(),
        };

        manager.install_attempt(attempt("cancelled")).await.unwrap();
        manager.cancel_login("cancelled").await.unwrap();
        assert_eq!(
            manager.status().await.phase,
            CodexAuthPhase::ReauthenticationRequired
        );

        manager.install_attempt(attempt("failed")).await.unwrap();
        manager
            .finish_attempt_error("failed", &CodexAuthError::Timeout)
            .await;
        assert_eq!(
            manager.status().await.phase,
            CodexAuthPhase::ReauthenticationRequired
        );
    }

    #[tokio::test]
    async fn authorizing_status_reports_if_the_existing_session_remains_usable() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "access-secret"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );

        manager
            .install_attempt(active_attempt("relogin", CodexLoginKind::Browser))
            .await
            .unwrap();
        let usable_relogin = manager.status().await;
        assert_eq!(usable_relogin.phase, CodexAuthPhase::Authorizing);
        assert!(usable_relogin.has_usable_session);

        assert!(
            manager
                .mark_reauthentication_required(usable_relogin.generation)
                .await
        );
        let required_relogin = manager.status().await;
        assert_eq!(required_relogin.phase, CodexAuthPhase::Authorizing);
        assert!(!required_relogin.has_usable_session);
    }

    #[tokio::test]
    async fn stale_cancel_id_does_not_cancel_new_attempt() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        manager
            .install_attempt(active_attempt("new-attempt", CodexLoginKind::Device))
            .await
            .unwrap();

        assert!(matches!(
            manager.cancel_login("stale-attempt").await,
            Err(CodexAuthError::AttemptNotFound)
        ));
        assert_eq!(
            manager.status().await.active_attempt_id.as_deref(),
            Some("new-attempt")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn completed_save_wins_over_concurrent_cancel() {
        let store = Arc::new(BlockingSaveStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store.clone(),
        );
        manager
            .install_attempt(active_attempt("saving", CodexLoginKind::Browser))
            .await
            .unwrap();

        let persist_manager = manager.clone();
        let persist_task = tokio::spawn(async move {
            persist_manager
                .persist_and_install("saving", stored_session("account-1", "new-access"))
                .await
        });
        let save_started =
            tokio::time::timeout(Duration::from_secs(2), store.save_started.notified()).await;
        if save_started.is_err() {
            store.release_save();
            persist_task.abort();
        }
        save_started.expect("credential save started");

        let readable_status =
            tokio::time::timeout(Duration::from_millis(100), manager.status()).await;
        if readable_status.is_err() {
            store.release_save();
            persist_task.abort();
        }
        assert_eq!(
            readable_status
                .expect("state remains readable during credential save")
                .phase,
            CodexAuthPhase::Authorizing
        );

        let cancel_manager = manager.clone();
        let mut cancel_task =
            tokio::spawn(async move { cancel_manager.cancel_login("saving").await });
        let cancel_waited_for_save =
            tokio::time::timeout(Duration::from_millis(50), &mut cancel_task)
                .await
                .is_err();

        store.release_save();
        persist_task.await.unwrap().unwrap();
        assert!(
            cancel_waited_for_save,
            "cancel must wait for the in-flight save"
        );
        assert!(matches!(
            cancel_task.await.unwrap(),
            Err(CodexAuthError::AttemptNotFound)
        ));
        assert_eq!(store.save_count.load(Ordering::SeqCst), 1);
        assert_eq!(store.load().unwrap().unwrap().access_token, "new-access");
        let status = manager.status().await;
        assert_eq!(status.phase, CodexAuthPhase::Authenticated);
        assert!(status.active_attempt_id.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_persist_waiter_still_cleans_up_a_failed_save() {
        let store = Arc::new(BlockingSaveStore::default());
        store.fail_on_save();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store.clone(),
        );
        manager
            .install_attempt(active_attempt("failed-save", CodexLoginKind::Browser))
            .await
            .unwrap();

        let persist_manager = manager.clone();
        let persist_waiter = tokio::spawn(async move {
            persist_manager
                .persist_and_install(
                    "failed-save",
                    stored_session("account-1", "must-not-install"),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), store.save_started.notified())
            .await
            .expect("credential save started");
        persist_waiter.abort();
        assert!(persist_waiter.await.unwrap_err().is_cancelled());
        store.release_save();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let status = manager.status().await;
                if status.active_attempt_id.is_none() {
                    assert_eq!(status.phase, CodexAuthPhase::SignedOut);
                    assert_eq!(
                        status.last_error.as_ref().map(|error| error.code.as_str()),
                        Some("credential_store_failed")
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached persistence failure cleaned up the attempt");
        assert!(store.load().unwrap().is_none());
    }

    #[tokio::test]
    async fn failed_logout_delete_preserves_memory_and_persisted_session() {
        let store = Arc::new(FailingDeleteStore::default());
        store
            .save(&stored_session("account-1", "still-authenticated"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9/"),
            store.clone(),
        );
        let before = manager.status().await;

        assert!(matches!(
            manager.logout().await,
            Err(CodexAuthError::CredentialStore)
        ));

        let after = manager.status().await;
        assert_eq!(after.phase, CodexAuthPhase::Authenticated);
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.account_hint, before.account_hint);
        assert_eq!(
            store.load().unwrap().unwrap().access_token,
            "still-authenticated"
        );
        assert_eq!(
            manager.request_auth(false).await.unwrap().generation(),
            before.generation
        );
    }

    #[tokio::test]
    async fn logout_cancels_attempt_installed_before_transaction_gets_gate() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        let gate = manager.inner.refresh_gate.lock().await;
        let logout_manager = manager.clone();
        let logout_task = tokio::spawn(async move { logout_manager.logout_transaction().await });

        let attempt = active_attempt("early-login", CodexLoginKind::Browser);
        let attempt_cancel = attempt.cancel.clone();
        manager.install_attempt(attempt).await.unwrap();
        assert!(!attempt_cancel.is_cancelled());
        drop(gate);

        logout_task.await.unwrap().unwrap();
        assert!(attempt_cancel.is_cancelled());
        let status = manager.status().await;
        assert_eq!(status.phase, CodexAuthPhase::SignedOut);
        assert!(status.active_attempt_id.is_none());
    }

    #[tokio::test]
    async fn logout_cancels_attempt_installed_while_delete_is_blocked() {
        let store = Arc::new(BlockingDeleteStore::new(stored_session(
            "account-1",
            "old-access",
        )));
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9/"),
            store.clone(),
        );
        let delete_seen = store.delete_started.notified();
        let logout_manager = manager.clone();
        let logout_task = tokio::spawn(async move { logout_manager.logout().await });
        tokio::time::timeout(Duration::from_secs(2), delete_seen)
            .await
            .expect("credential delete started after the first attempt take");

        let attempt = active_attempt("login-during-delete", CodexLoginKind::Device);
        let attempt_cancel = attempt.cancel.clone();
        manager.install_attempt(attempt).await.unwrap();
        assert!(!attempt_cancel.is_cancelled());
        store.release_delete();

        logout_task.await.unwrap().unwrap();
        assert!(attempt_cancel.is_cancelled());
        assert!(store.load().unwrap().is_none());
        let status = manager.status().await;
        assert_eq!(status.phase, CodexAuthPhase::SignedOut);
        assert!(status.active_attempt_id.is_none());
    }

    #[tokio::test]
    async fn logout_holds_commit_gate_until_old_token_revocation_finishes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let revoke_started = Arc::new(Notify::new());
        let release_revoke = Arc::new(Notify::new());
        let revoke_started_for_server = revoke_started.clone();
        let release_revoke_for_server = release_revoke.clone();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let revoke_started = revoke_started_for_server.clone();
                let release_revoke = release_revoke_for_server.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let revoke_started = revoke_started.clone();
                        let release_revoke = release_revoke.clone();
                        async move {
                            if request.uri().path() == "/oauth/revoke" {
                                revoke_started.notify_one();
                                release_revoke.notified().await;
                                Ok::<_, Infallible>(Response::new(Body::from("{}")))
                            } else {
                                Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::NOT_FOUND)
                                        .body(Body::empty())
                                        .unwrap(),
                                )
                            }
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "old-access"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store.clone(),
        );
        let revoke_seen = revoke_started.notified();
        let logout_manager = manager.clone();
        let logout_task = tokio::spawn(async move { logout_manager.logout().await });
        tokio::time::timeout(Duration::from_secs(2), revoke_seen)
            .await
            .expect("old token revocation started");

        manager
            .install_attempt(active_attempt("new-login", CodexLoginKind::Browser))
            .await
            .unwrap();
        let persist_manager = manager.clone();
        let mut persist_task = tokio::spawn(async move {
            persist_manager
                .persist_and_install("new-login", stored_session("account-1", "new-login-access"))
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut persist_task)
                .await
                .is_err(),
            "new login persistence must wait for old-token revocation"
        );

        release_revoke.notify_one();
        logout_task.await.unwrap().unwrap();
        persist_task.await.unwrap().unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().access_token,
            "new-login-access"
        );
        assert_eq!(manager.status().await.phase, CodexAuthPhase::Authenticated);
        server_task.abort();
    }

    #[tokio::test]
    async fn stale_reauthentication_signal_cannot_poison_newer_session() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "old-access"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        let stale_generation = manager.request_auth(false).await.unwrap().generation();
        {
            let mut state = manager.inner.state.write().await;
            state.session = Some(stored_session("account-1", "new-access"));
            state.generation = stale_generation + 1;
            state.phase = CodexAuthPhase::Authenticated;
        }

        assert!(
            !manager
                .mark_reauthentication_required(stale_generation)
                .await
        );
        assert_eq!(manager.status().await.phase, CodexAuthPhase::Authenticated);

        manager
            .install_attempt(active_attempt("reauth-login", CodexLoginKind::Browser))
            .await
            .unwrap();
        assert!(
            manager
                .mark_reauthentication_required(stale_generation + 1)
                .await
        );
        assert_eq!(manager.status().await.phase, CodexAuthPhase::Authorizing);
        manager.cancel_login("reauth-login").await.unwrap();
        assert_eq!(
            manager.status().await.phase,
            CodexAuthPhase::ReauthenticationRequired
        );
    }

    #[tokio::test]
    async fn cancel_winning_refresh_gate_prevents_persistence() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store.clone(),
        );
        manager
            .install_attempt(active_attempt("cancelling", CodexLoginKind::Device))
            .await
            .unwrap();

        let gate = manager.inner.refresh_gate.lock().await;
        let cancel = manager.cancel_login("cancelling");
        tokio::pin!(cancel);
        tokio::select! {
            biased;
            result = &mut cancel => panic!("cancel unexpectedly completed: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }

        let persist =
            manager.persist_and_install("cancelling", stored_session("account-1", "must-not-save"));
        tokio::pin!(persist);
        tokio::select! {
            biased;
            result = &mut persist => panic!("persistence unexpectedly completed: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(gate);

        cancel.await.unwrap();
        assert!(matches!(persist.await, Err(CodexAuthError::Cancelled)));
        assert!(store.load().unwrap().is_none());
        let status = manager.status().await;
        assert_eq!(status.phase, CodexAuthPhase::SignedOut);
        assert!(status.active_attempt_id.is_none());
    }

    #[tokio::test]
    async fn successful_install_is_atomic_and_finish_success_is_idempotent() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store.clone(),
        );
        manager
            .install_attempt(active_attempt("success", CodexLoginKind::Browser))
            .await
            .unwrap();

        manager
            .persist_and_install("success", stored_session("account-1", "new-access"))
            .await
            .unwrap();
        let committed = manager.status().await;
        assert_eq!(committed.phase, CodexAuthPhase::Authenticated);
        assert_eq!(committed.generation, 2);
        assert!(committed.active_attempt_id.is_none());
        assert!(committed.last_error.is_none());

        manager.finish_attempt_success("success").await;
        manager.finish_attempt_success("success").await;
        let finished = manager.status().await;
        assert_eq!(finished.phase, committed.phase);
        assert_eq!(finished.generation, committed.generation);
        assert_eq!(finished.account_hint, committed.account_hint);
        assert!(finished.active_attempt_id.is_none());
        assert_eq!(store.load().unwrap().unwrap().access_token, "new-access");
    }

    #[tokio::test]
    async fn device_start_cancelled_during_initial_request_does_not_resurrect_attempt() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let request_started = Arc::new(Notify::new());
        let request_started_for_server = request_started.clone();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let request_started = request_started_for_server.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let request_started = request_started.clone();
                        async move {
                            request_started.notify_one();
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            Ok::<_, Infallible>(Response::new(Body::from("{}")))
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store,
        );
        let request_seen = request_started.notified();
        let start_manager = manager.clone();
        let start_task = tokio::spawn(async move { start_manager.start_device_login().await });
        tokio::time::timeout(Duration::from_secs(2), request_seen)
            .await
            .expect("device authorization request started");
        let attempt_id = manager
            .status()
            .await
            .active_attempt_id
            .expect("active attempt");
        manager.cancel_login(&attempt_id).await.unwrap();

        let error = tokio::time::timeout(Duration::from_secs(2), start_task)
            .await
            .expect("start task stopped after cancellation")
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, CodexAuthError::Cancelled));
        assert!(manager.status().await.active_attempt_id.is_none());
        server_task.abort();
    }

    #[tokio::test]
    async fn refresh_generation_is_rechecked_before_persisting_tokens() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let request_started = Arc::new(Notify::new());
        let release_response = Arc::new(Notify::new());
        let request_started_for_server = request_started.clone();
        let release_response_for_server = release_response.clone();
        let id_token = jwt(json!({ "chatgpt_account_id": "account-1" }));
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let request_started = request_started_for_server.clone();
                let release_response = release_response_for_server.clone();
                let id_token = id_token.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let request_started = request_started.clone();
                        let release_response = release_response.clone();
                        let id_token = id_token.clone();
                        async move {
                            request_started.notify_one();
                            release_response.notified().await;
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .header("content-type", "application/json")
                                    .body(Body::from(
                                        json!({
                                            "access_token": "refreshed-access",
                                            "refresh_token": "refreshed-refresh",
                                            "id_token": id_token,
                                            "expires_in": 3600
                                        })
                                        .to_string(),
                                    ))
                                    .unwrap(),
                            )
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "old-access"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store.clone(),
        );
        let request_seen = request_started.notified();
        let refresh_manager = manager.clone();
        let refresh_task =
            tokio::spawn(async move { refresh_manager.refresh_internal(1, true, false).await });
        tokio::time::timeout(Duration::from_secs(2), request_seen)
            .await
            .expect("refresh request started");

        {
            let mut state = manager.inner.state.write().await;
            state.generation = 2;
            state.phase = CodexAuthPhase::Authenticated;
            state.session.as_mut().unwrap().access_token = "newer-access".to_string();
        }
        release_response.notify_one();

        let auth = tokio::time::timeout(Duration::from_secs(2), refresh_task)
            .await
            .expect("refresh completed")
            .unwrap()
            .unwrap();
        assert_eq!(auth.generation(), 2);
        assert_eq!(store.load().unwrap().unwrap().access_token, "old-access");
        server_task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_refresh_waiter_still_commits_without_hiding_active_login() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let request_started = Arc::new(Notify::new());
        let release_response = Arc::new(Notify::new());
        let request_started_for_server = request_started.clone();
        let release_response_for_server = release_response.clone();
        let id_token = jwt(json!({ "chatgpt_account_id": "account-1" }));
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let request_started = request_started_for_server.clone();
                let release_response = release_response_for_server.clone();
                let id_token = id_token.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let request_started = request_started.clone();
                        let release_response = release_response.clone();
                        let id_token = id_token.clone();
                        async move {
                            request_started.notify_one();
                            release_response.notified().await;
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .header("content-type", "application/json")
                                    .body(Body::from(
                                        json!({
                                            "access_token": "rotated-access",
                                            "refresh_token": "rotated-refresh",
                                            "id_token": id_token,
                                            "expires_in": 3600
                                        })
                                        .to_string(),
                                    ))
                                    .unwrap(),
                            )
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "old-access"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store.clone(),
        );
        let request_seen = request_started.notified();
        let refresh_manager = manager.clone();
        let refresh_waiter =
            tokio::spawn(async move { refresh_manager.refresh_internal(1, true, false).await });
        tokio::time::timeout(Duration::from_secs(2), request_seen)
            .await
            .expect("refresh request started");

        manager
            .install_attempt(active_attempt(
                "login-during-refresh",
                CodexLoginKind::Device,
            ))
            .await
            .unwrap();
        assert_eq!(manager.status().await.phase, CodexAuthPhase::Authorizing);

        refresh_waiter.abort();
        assert!(refresh_waiter.await.unwrap_err().is_cancelled());
        release_response.notify_one();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let persisted = store
                    .load()
                    .unwrap()
                    .map(|session| session.access_token == "rotated-access")
                    .unwrap_or(false);
                let status = manager.status().await;
                if persisted && status.generation == 2 {
                    assert_eq!(status.phase, CodexAuthPhase::Authorizing);
                    assert_eq!(
                        status.active_attempt_id.as_deref(),
                        Some("login-during-refresh")
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached refresh committed");

        manager.cancel_login("login-during-refresh").await.unwrap();
        assert_eq!(manager.status().await.phase, CodexAuthPhase::Authenticated);
        server_task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_refresh_persistence_requires_reauth_without_hiding_active_login() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let id_token = jwt(json!({ "chatgpt_account_id": "account-1" }));
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let id_token = id_token.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let id_token = id_token.clone();
                        async move {
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .header("content-type", "application/json")
                                    .body(Body::from(
                                        json!({
                                            "access_token": "rotated-access",
                                            "refresh_token": "rotated-refresh",
                                            "id_token": id_token,
                                            "expires_in": 3600
                                        })
                                        .to_string(),
                                    ))
                                    .unwrap(),
                            )
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(BlockingSaveStore::default());
        store.set_session(stored_session("account-1", "old-access"));
        store.fail_on_save();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store.clone(),
        );

        let refresh_manager = manager.clone();
        let refresh_task =
            tokio::spawn(async move { refresh_manager.refresh_internal(1, true, false).await });
        tokio::time::timeout(Duration::from_secs(2), store.save_started.notified())
            .await
            .expect("refresh persistence started");
        let install_result = tokio::time::timeout(
            Duration::from_millis(100),
            manager.install_attempt(active_attempt("active-login", CodexLoginKind::Device)),
        )
        .await;
        if install_result.is_err() {
            store.release_save();
            refresh_task.abort();
        }
        install_result
            .expect("refresh persistence does not hold the state lock")
            .unwrap();
        store.release_save();

        assert!(matches!(
            refresh_task.await.unwrap(),
            Err(CodexAuthError::CredentialStore)
        ));
        let status = manager.status().await;
        assert_eq!(status.phase, CodexAuthPhase::Authorizing);
        assert_eq!(status.active_attempt_id.as_deref(), Some("active-login"));
        assert_eq!(
            status.last_error.as_ref().map(|error| error.code.as_str()),
            Some("credential_store_failed")
        );
        assert_eq!(store.load().unwrap().unwrap().access_token, "old-access");
        assert!(matches!(
            manager.request_auth(false).await,
            Err(CodexAuthError::ReauthenticationRequired)
        ));

        manager.cancel_login("active-login").await.unwrap();
        assert_eq!(
            manager.status().await.phase,
            CodexAuthPhase::ReauthenticationRequired
        );
        assert!(matches!(
            manager.request_auth(false).await,
            Err(CodexAuthError::ReauthenticationRequired)
        ));
        server_task.abort();
    }

    #[tokio::test]
    async fn status_never_exposes_tokens() {
        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&StoredCodexSession {
                schema_version: SESSION_SCHEMA_VERSION,
                access_token: "access-secret".to_string(),
                refresh_token: "refresh-secret".to_string(),
                id_token: Some("id-secret".to_string()),
                expires_at_unix_ms: now_ms() + 3_600_000,
                account_id: "account-123456789".to_string(),
                email: Some("user@example.com".to_string()),
                plan_type: Some("plus".to_string()),
                is_fedramp: false,
                last_refresh_at: Some(now_ms()),
            })
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test("http://127.0.0.1:9999/"),
            store,
        );
        let serialized = serde_json::to_string(&manager.status().await).unwrap();
        assert!(!serialized.contains("access-secret"));
        assert!(!serialized.contains("refresh-secret"));
        assert!(!serialized.contains("id-secret"));
        assert!(!serialized.contains("account-123456789"));
        assert!(serialized.contains("***456789"));
    }

    #[test]
    fn usage_fixture_is_parsed_into_frontend_shape() {
        let fixture = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25,
                    "limit_window_seconds": 18000,
                    "reset_at": 2_000_000_000
                },
                "secondary_window": {
                    "remaining_percent": "58",
                    "window_seconds": 604800,
                    "resets_in_seconds": 60
                }
            },
            "code_review_rate_limit": {
                "primary_window": {
                    "usedPercent": 9,
                    "windowDurationMins": 1440,
                    "resetsAt": "2030-01-01T00:00:00Z"
                }
            },
            "additional_rate_limits": [{
                "limit_name": "Deep review",
                "metered_feature": "codex_review_deep",
                "rate_limit": {
                    "primary_window": {"used_percent": 12, "window_seconds": 3600}
                }
            }]
        });
        let parsed = parse_usage_snapshot(&fixture, 1_000_000);
        let primary = parsed.rate_limits.as_ref().unwrap();
        assert_eq!(primary.limit_id.as_deref(), Some("codex"));
        assert_eq!(primary.plan_type.as_deref(), Some("pro"));
        assert_eq!(primary.primary.as_ref().unwrap().used_percent, Some(25.0));
        assert_eq!(
            primary.primary.as_ref().unwrap().window_duration_mins,
            Some(300)
        );
        assert_eq!(primary.secondary.as_ref().unwrap().used_percent, Some(42.0));
        assert!(parsed.rate_limits_by_limit_id.contains_key("codex_review"));
        let additional = parsed
            .rate_limits_by_limit_id
            .get("codex_review_deep")
            .expect("additional limit");
        assert_eq!(additional.limit_name.as_deref(), Some("Deep review"));
    }

    #[tokio::test]
    async fn usage_snapshot_uses_oauth_headers_over_http() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let saw_auth = Arc::new(AtomicBool::new(false));
        let saw_auth_for_server = saw_auth.clone();
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let saw_auth = saw_auth_for_server.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let saw_auth = saw_auth.clone();
                        async move {
                            if request.uri().path() == "/wham/usage"
                                && request.headers().get("authorization")
                                    == Some(&hyper::header::HeaderValue::from_static(
                                        "Bearer access-secret",
                                    ))
                                && request.headers().get("chatgpt-account-id")
                                    == Some(&hyper::header::HeaderValue::from_static("account-1"))
                            {
                                saw_auth.store(true, Ordering::SeqCst);
                            }
                            Ok::<_, Infallible>(Response::builder()
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    r#"{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":12,"limit_window_seconds":18000,"reset_at":2000000000}}}"#,
                                ))
                                .unwrap())
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&StoredCodexSession {
                schema_version: SESSION_SCHEMA_VERSION,
                access_token: "access-secret".to_string(),
                refresh_token: "refresh-secret".to_string(),
                id_token: None,
                expires_at_unix_ms: now_ms() + 3_600_000,
                account_id: "account-1".to_string(),
                email: None,
                plan_type: Some("plus".to_string()),
                is_fedramp: false,
                last_refresh_at: Some(now_ms()),
            })
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{}/", address)),
            store,
        );
        let usage = manager.usage_snapshot().await.unwrap();
        assert!(saw_auth.load(Ordering::SeqCst));
        assert_eq!(
            usage
                .rate_limits
                .as_ref()
                .and_then(|limits| limits.primary.as_ref())
                .and_then(|window| window.used_percent),
            Some(12.0)
        );
        server_task.abort();
    }

    #[tokio::test]
    async fn usage_second_unauthorized_marks_the_refreshed_generation() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let usage_requests = Arc::new(AtomicUsize::new(0));
        let usage_requests_for_server = usage_requests.clone();
        let id_token = jwt(json!({ "chatgpt_account_id": "account-1" }));
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let usage_requests = usage_requests_for_server.clone();
                let id_token = id_token.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let usage_requests = usage_requests.clone();
                        let id_token = id_token.clone();
                        async move {
                            match request.uri().path() {
                                "/oauth/token" => Ok::<_, Infallible>(
                                    Response::builder()
                                        .header("content-type", "application/json")
                                        .body(Body::from(
                                            json!({
                                                "access_token": "refreshed-access",
                                                "refresh_token": "refreshed-refresh",
                                                "id_token": id_token,
                                                "expires_in": 3600
                                            })
                                            .to_string(),
                                        ))
                                        .unwrap(),
                                ),
                                "/wham/usage" => {
                                    usage_requests.fetch_add(1, Ordering::SeqCst);
                                    Ok::<_, Infallible>(
                                        Response::builder()
                                            .status(StatusCode::UNAUTHORIZED)
                                            .header("content-type", "application/json")
                                            .body(Body::from(
                                                r#"{"error":{"code":"invalid_token"}}"#,
                                            ))
                                            .unwrap(),
                                    )
                                }
                                _ => Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::NOT_FOUND)
                                        .body(Body::empty())
                                        .unwrap(),
                                ),
                            }
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "old-access"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store,
        );

        assert!(matches!(
            manager.usage_snapshot().await,
            Err(CodexAuthError::OAuthRejected {
                stage: "usage",
                reauth_required: true,
                ..
            })
        ));
        let status = manager.status().await;
        assert_eq!(usage_requests.load(Ordering::SeqCst), 2);
        assert_eq!(status.generation, 2);
        assert_eq!(status.phase, CodexAuthPhase::ReauthenticationRequired);
        server_task.abort();
    }

    #[tokio::test]
    async fn usage_snapshot_rejects_oversized_body() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let oversized_body = vec![b'x'; MAX_OAUTH_RESPONSE_BODY_BYTES + 1];
        let server = hyper::Server::from_tcp(listener)
            .unwrap()
            .serve(make_service_fn(move |_| {
                let oversized_body = oversized_body.clone();
                async move {
                    Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                        let oversized_body = oversized_body.clone();
                        async move {
                            Ok::<_, Infallible>(Response::new(Body::from(oversized_body)))
                        }
                    }))
                }
            }));
        let server_task = tokio::spawn(server);

        let store = Arc::new(MemoryCodexCredentialStore::default());
        store
            .save(&stored_session("account-1", "access-secret"))
            .unwrap();
        let manager = CodexAuthManager::new_for_test(
            CodexEndpointConfig::for_test(&format!("http://{address}/")),
            store,
        );
        assert!(matches!(
            manager.usage_snapshot().await,
            Err(CodexAuthError::ResponseTooLarge { stage: "usage" })
        ));
        server_task.abort();
    }
}
