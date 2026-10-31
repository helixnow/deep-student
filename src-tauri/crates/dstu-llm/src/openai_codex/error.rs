use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexErrorClass {
    Cancelled,
    Transient,
    Permanent,
    ReauthenticationRequired,
    Security,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthErrorDto {
    pub code: String,
    pub message: String,
    pub class: CodexErrorClass,
}

#[derive(Debug, thiserror::Error)]
pub enum CodexAuthError {
    #[error("another Codex login is already in progress")]
    LoginBusy,
    #[error("Codex login attempt was not found")]
    AttemptNotFound,
    #[error("Codex login was cancelled")]
    Cancelled,
    #[error("Codex login timed out")]
    Timeout,
    #[error("failed to bind the local OAuth callback listener")]
    CallbackBind,
    #[error("OAuth callback state did not match")]
    InvalidState,
    #[error("OAuth callback did not contain an authorization code")]
    MissingAuthorizationCode,
    #[error("authorization was denied: {code}")]
    AuthorizationDenied { code: String },
    #[error("OAuth network request failed during {stage}")]
    Network { stage: &'static str },
    #[error("OAuth server rejected {stage}: {code}")]
    OAuthRejected {
        stage: &'static str,
        code: String,
        permanent: bool,
        reauth_required: bool,
    },
    #[error("OAuth response was malformed: {field}")]
    MalformedResponse { field: &'static str },
    #[error("OAuth response exceeded the size limit during {stage}")]
    ResponseTooLarge { stage: &'static str },
    #[error("OAuth token did not contain a ChatGPT account id")]
    MissingAccountId,
    #[error("OAuth refresh returned a different ChatGPT account")]
    AccountChanged,
    #[error("Codex credentials are not available")]
    SignedOut,
    #[error("Codex credentials must be renewed by signing in again")]
    ReauthenticationRequired,
    #[error("Codex credential storage failed")]
    CredentialStore,
    #[error("Codex request headers could not be constructed")]
    InvalidHeader,
    #[error("Codex request body is invalid: {0}")]
    InvalidRequestBody(&'static str),
}

impl CodexAuthError {
    pub fn class(&self) -> CodexErrorClass {
        match self {
            Self::Cancelled => CodexErrorClass::Cancelled,
            Self::Timeout | Self::Network { .. } => CodexErrorClass::Transient,
            Self::InvalidState => CodexErrorClass::Security,
            Self::ReauthenticationRequired | Self::AccountChanged => {
                CodexErrorClass::ReauthenticationRequired
            }
            Self::OAuthRejected {
                reauth_required: true,
                ..
            } => CodexErrorClass::ReauthenticationRequired,
            Self::OAuthRejected {
                permanent: false, ..
            } => CodexErrorClass::Transient,
            _ => CodexErrorClass::Permanent,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::LoginBusy => "login_busy",
            Self::AttemptNotFound => "attempt_not_found",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::CallbackBind => "callback_bind_failed",
            Self::InvalidState => "invalid_state",
            Self::MissingAuthorizationCode => "missing_authorization_code",
            Self::AuthorizationDenied { .. } => "authorization_denied",
            Self::Network { .. } => "network_error",
            Self::OAuthRejected { .. } => "oauth_rejected",
            Self::MalformedResponse { .. } => "malformed_response",
            Self::ResponseTooLarge { .. } => "response_too_large",
            Self::MissingAccountId => "missing_account_id",
            Self::AccountChanged => "account_changed",
            Self::SignedOut => "signed_out",
            Self::ReauthenticationRequired => "reauthentication_required",
            Self::CredentialStore => "credential_store_failed",
            Self::InvalidHeader => "invalid_header",
            Self::InvalidRequestBody(_) => "invalid_request_body",
        }
    }

    pub fn to_dto(&self) -> CodexAuthErrorDto {
        CodexAuthErrorDto {
            code: self.code().to_string(),
            message: self.to_string(),
            class: self.class(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_refresh_errors_require_reauthentication() {
        let error = CodexAuthError::OAuthRejected {
            stage: "refresh",
            code: "invalid_grant".to_string(),
            permanent: true,
            reauth_required: true,
        };
        assert_eq!(error.class(), CodexErrorClass::ReauthenticationRequired);
        assert!(!error.to_dto().message.contains("token"));
    }

    #[test]
    fn network_errors_are_transient() {
        assert_eq!(
            CodexAuthError::Network { stage: "refresh" }.class(),
            CodexErrorClass::Transient
        );
    }
}
