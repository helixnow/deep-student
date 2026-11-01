use crate::database::Database;
use crate::openai_codex::error::CodexAuthError;
use crate::openai_codex::protocol::CODEX_CREDENTIAL_KEY;
use crate::openai_codex::types::StoredCodexSession;
use std::sync::Arc;

pub(crate) trait CodexCredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError>;
    fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError>;
    fn delete(&self) -> Result<(), CodexAuthError>;
}

pub(crate) struct DatabaseCodexCredentialStore {
    database: Arc<Database>,
}

impl DatabaseCodexCredentialStore {
    pub(crate) fn new(database: Arc<Database>) -> Result<Self, CodexAuthError> {
        Ok(Self { database })
    }
}

impl CodexCredentialStore for DatabaseCodexCredentialStore {
    fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
        let raw = self
            .database
            .get_secret(CODEX_CREDENTIAL_KEY)
            .map_err(|_| CodexAuthError::CredentialStore)?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let session: StoredCodexSession =
            serde_json::from_str(&raw).map_err(|_| CodexAuthError::CredentialStore)?;
        if !session.is_valid() {
            return Err(CodexAuthError::CredentialStore);
        }
        Ok(Some(session))
    }

    fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError> {
        if !session.is_valid() {
            return Err(CodexAuthError::CredentialStore);
        }
        let raw = serde_json::to_string(session).map_err(|_| CodexAuthError::CredentialStore)?;
        self.database
            .save_secret(CODEX_CREDENTIAL_KEY, &raw)
            .map_err(|_| CodexAuthError::CredentialStore)?;
        Ok(())
    }

    fn delete(&self) -> Result<(), CodexAuthError> {
        self.database
            .delete_secret(CODEX_CREDENTIAL_KEY)
            .map_err(|_| CodexAuthError::CredentialStore)?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct MemoryCodexCredentialStore {
        value: Mutex<Option<StoredCodexSession>>,
    }

    impl CodexCredentialStore for MemoryCodexCredentialStore {
        fn load(&self) -> Result<Option<StoredCodexSession>, CodexAuthError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, session: &StoredCodexSession) -> Result<(), CodexAuthError> {
            *self.value.lock().unwrap() = Some(session.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), CodexAuthError> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
}
