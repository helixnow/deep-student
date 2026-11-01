//! Ephemeral secret handles for native prompt surfaces.
//!
//! Secrets submitted here are never ChatV2 tools or tool arguments. The store is
//! memory-only, TTL-bound and one-shot when a future decryptor consumes a handle.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

const DEFAULT_TTL_SECONDS: u64 = 300;
const MAX_TTL_SECONDS: u64 = 600;

fn decryptor_integration_available() -> bool {
    false
}

pub struct SecretValue(String);

impl<'de> Deserialize<'de> for SecretValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPromptSubmitRequest {
    pub purpose: String,
    pub secret: SecretValue,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPromptHandle {
    pub handle_id: String,
    pub purpose: String,
    pub expires_in_seconds: u64,
    pub memory_only: bool,
    pub one_shot: bool,
    pub consumer_available: bool,
}

struct SecretEntry {
    purpose: String,
    secret: Zeroizing<String>,
    expires_at: Instant,
}

#[derive(Default)]
pub struct SecretPromptStore {
    entries: Mutex<HashMap<String, SecretEntry>>,
}

impl SecretPromptStore {
    fn prune(entries: &mut HashMap<String, SecretEntry>, now: Instant) {
        entries.retain(|_, entry| entry.expires_at > now);
    }

    fn insert(&self, purpose: String, secret: String, ttl: Duration) -> SecretPromptHandle {
        let now = Instant::now();
        let handle_id = format!("secret_prompt:{}", uuid::Uuid::new_v4());
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::prune(&mut entries, now);
        entries.insert(
            handle_id.clone(),
            SecretEntry {
                purpose: purpose.clone(),
                secret: Zeroizing::new(secret),
                expires_at: now + ttl,
            },
        );
        SecretPromptHandle {
            handle_id,
            purpose,
            expires_in_seconds: ttl.as_secs(),
            memory_only: true,
            one_shot: true,
            consumer_available: decryptor_integration_available(),
        }
    }

    pub(crate) fn consume(
        &self,
        handle_id: &str,
        expected_purpose: &str,
    ) -> Result<Zeroizing<String>, String> {
        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::prune(&mut entries, now);
        let entry = entries
            .remove(handle_id)
            .ok_or("SECRET_PROMPT_NOT_FOUND_OR_EXPIRED")?;
        if entry.purpose != expected_purpose {
            return Err("SECRET_PROMPT_PURPOSE_MISMATCH".into());
        }
        Ok(entry.secret)
    }

    fn discard(&self, handle_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(handle_id)
            .is_some()
    }

    fn contains(&self, handle_id: &str) -> bool {
        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::prune(&mut entries, now);
        entries.contains_key(handle_id)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn secret_prompt_submit(
    mut request: SecretPromptSubmitRequest,
    store: State<'_, SecretPromptStore>,
) -> Result<SecretPromptHandle, String> {
    if !decryptor_integration_available() {
        return Err("DECRYPTOR_INTEGRATION_UNAVAILABLE".into());
    }
    let purpose = request.purpose.trim().to_string();
    if purpose != "office_document_password" && purpose != "pdf_document_password" {
        return Err("SECRET_PROMPT_UNSUPPORTED_PURPOSE".into());
    }
    if request.secret.0.is_empty() {
        return Err("SECRET_PROMPT_EMPTY".into());
    }
    let ttl_seconds = request
        .ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECONDS)
        .clamp(30, MAX_TTL_SECONDS);
    let secret = std::mem::take(&mut request.secret.0);
    Ok(store.insert(purpose, secret, Duration::from_secs(ttl_seconds)))
}

#[tauri::command(rename_all = "camelCase")]
pub fn secret_prompt_status(
    handle_id: String,
    store: State<'_, SecretPromptStore>,
) -> serde_json::Value {
    serde_json::json!({
        "available": store.contains(&handle_id),
        "consumerAvailable": false,
        "reasonCode": "DECRYPTOR_INTEGRATION_UNAVAILABLE",
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn secret_prompt_discard(handle_id: String, store: State<'_, SecretPromptStore>) -> bool {
    store.discard(&handle_id)
}

#[tauri::command]
pub fn secret_prompt_capabilities() -> serde_json::Value {
    serde_json::json!({
        "memoryOnly": true,
        "oneShot": true,
        "defaultTtlSeconds": DEFAULT_TTL_SECONDS,
        "maxTtlSeconds": MAX_TTL_SECONDS,
        "chatToolAvailable": false,
        "decryptorIntegration": {
            "available": decryptor_integration_available(),
            "reasonCode": "DECRYPTOR_INTEGRATION_UNAVAILABLE"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_memory_only_ttl_bound_and_one_shot() {
        let store = SecretPromptStore::default();
        let handle = store.insert(
            "office_document_password".into(),
            "correct horse battery staple".into(),
            Duration::from_secs(60),
        );
        assert!(handle.memory_only);
        assert!(handle.one_shot);
        assert!(!handle.consumer_available);
        assert!(store.contains(&handle.handle_id));
        let secret = store
            .consume(&handle.handle_id, "office_document_password")
            .unwrap();
        assert_eq!(secret.as_str(), "correct horse battery staple");
        assert!(store
            .consume(&handle.handle_id, "office_document_password")
            .is_err());
    }

    #[test]
    fn purpose_mismatch_consumes_and_zeroizes_entry() {
        let store = SecretPromptStore::default();
        let handle = store.insert(
            "pdf_document_password".into(),
            "secret".into(),
            Duration::from_secs(60),
        );
        assert!(store
            .consume(&handle.handle_id, "office_document_password")
            .is_err());
        assert!(!store.contains(&handle.handle_id));
    }
}
