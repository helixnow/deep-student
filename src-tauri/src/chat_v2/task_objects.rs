//! Shared object, provenance, and delivery contracts for agent tasks.
//!
//! A model being able to see content is not the same as an executor being able
//! to operate on it. `TaskObjectHandle` keeps those concerns explicit across
//! chat attachments, browser downloads, MCP resources, and future connectors.

use serde::{Deserialize, Serialize};

const TASK_OBJECT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskObjectKind {
    File,
    Folder,
    Message,
    Event,
    Record,
    Page,
    Artifact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLocator {
    pub root_id: String,
    pub relative_path: String,
}

impl ManagedLocator {
    pub fn new(
        root_id: impl Into<String>,
        relative_path: impl Into<String>,
    ) -> Result<Self, String> {
        let locator = Self {
            root_id: root_id.into(),
            relative_path: relative_path.into(),
        };
        locator.validate()?;
        Ok(locator)
    }

    pub fn validate(&self) -> Result<(), String> {
        let root = self.root_id.trim();
        if root.is_empty() || root.contains('/') || root.contains('\\') {
            return Err("root_id must be a non-empty runtime-root identifier".to_string());
        }

        let path = self.relative_path.trim();
        if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
            return Err("relative_path must be a non-empty relative path".to_string());
        }
        if path == "." {
            return Ok(());
        }
        if path.contains('\\') {
            return Err("relative_path must use forward slashes".to_string());
        }
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("relative_path contains an unsafe path segment".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderObjectRef {
    pub provider: String,
    pub external_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCapabilities {
    pub readable: bool,
    pub materializable: bool,
    pub writable: bool,
    pub shareable: bool,
    pub sendable: bool,
    pub deletable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectAcl {
    pub access: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub principal_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectProvenance {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_from: Vec<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskObjectHandle {
    pub schema_version: u16,
    pub handle_id: String,
    pub kind: TaskObjectKind,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<ManagedLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_ref: Option<ProviderObjectRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acl: Option<ObjectAcl>,
    pub capabilities: ObjectCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub provenance: ObjectProvenance,
}

impl TaskObjectHandle {
    pub fn new(
        handle_id: impl Into<String>,
        kind: TaskObjectKind,
        display_name: impl Into<String>,
        provenance: ObjectProvenance,
    ) -> Self {
        Self {
            schema_version: TASK_OBJECT_SCHEMA_VERSION,
            handle_id: handle_id.into(),
            kind,
            display_name: display_name.into(),
            media_type: None,
            size_bytes: None,
            sha256: None,
            locator: None,
            provider_ref: None,
            acl: None,
            capabilities: ObjectCapabilities::default(),
            expires_at: None,
            provenance,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != TASK_OBJECT_SCHEMA_VERSION {
            return Err(format!(
                "unsupported task object schema version: {}",
                self.schema_version
            ));
        }
        if self.handle_id.trim().is_empty() || self.display_name.trim().is_empty() {
            return Err("handle_id and display_name are required".to_string());
        }
        if let Some(locator) = &self.locator {
            locator.validate()?;
        }
        if let Some(hash) = &self.sha256 {
            if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("sha256 must be a 64-character hexadecimal digest".to_string());
            }
        }
        if self.capabilities.materializable && self.locator.is_none() {
            return Err("materializable objects require a managed locator".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BatchItemStatus {
    Pending,
    Succeeded,
    Failed,
    Skipped,
    Compensated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchManifestItem {
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_handle_id: Option<String>,
    pub status: BatchItemStatus,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchManifest {
    pub manifest_id: String,
    pub expected_items: u64,
    pub observed_items: u64,
    pub coverage_complete: bool,
    pub truncated: bool,
    pub items: Vec<BatchManifestItem>,
}

impl BatchManifest {
    pub fn can_claim_complete_success(&self) -> bool {
        self.coverage_complete
            && !self.truncated
            && self.observed_items == self.expected_items
            && self.items.len() as u64 == self.expected_items
            && self
                .items
                .iter()
                .all(|item| item.status == BatchItemStatus::Succeeded)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Draft,
    Confirmed,
    Committed,
    Failed,
    Compensated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOperationReceipt {
    pub operation_id: String,
    pub idempotency_key: String,
    pub provider: String,
    pub action: String,
    pub state: OperationState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_handle_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipient_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub irreversible: bool,
    pub preview_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConnectorOperationReceipt {
    pub fn confirm(&mut self, observed_preview_sha256: &str) -> Result<(), String> {
        if self.state != OperationState::Draft {
            return Err("only a draft operation can be confirmed".to_string());
        }
        if observed_preview_sha256 != self.preview_sha256 {
            return Err(
                "operation preview changed; review the latest target and payload".to_string(),
            );
        }
        self.state = OperationState::Confirmed;
        Ok(())
    }

    pub fn commit(&mut self, committed_at: impl Into<String>) -> Result<(), String> {
        if self.state != OperationState::Confirmed {
            return Err("operation must be confirmed before commit".to_string());
        }
        self.state = OperationState::Committed;
        self.committed_at = Some(committed_at.into());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> ObjectProvenance {
        ObjectProvenance {
            source: "chat_attachment".to_string(),
            source_uri: None,
            server: None,
            tool: None,
            derived_from: Vec::new(),
            observed_at: "2026-07-19T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn managed_locator_rejects_escape_and_absolute_paths() {
        assert!(ManagedLocator::new("temp", "attachments/image.png").is_ok());
        assert!(ManagedLocator::new("temp", "../secret").is_err());
        assert!(ManagedLocator::new("temp", "/etc/passwd").is_err());
        assert!(ManagedLocator::new("temp", "a\\b.txt").is_err());
    }

    #[test]
    fn materializable_handle_requires_managed_locator() {
        let mut handle =
            TaskObjectHandle::new("obj_1", TaskObjectKind::File, "image.png", provenance());
        handle.capabilities.materializable = true;
        assert!(handle.validate().is_err());
        handle.locator = Some(ManagedLocator::new("temp", "attachments/image.png").unwrap());
        assert!(handle.validate().is_ok());
    }

    #[test]
    fn incomplete_batch_cannot_claim_complete_success() {
        let manifest = BatchManifest {
            manifest_id: "batch_1".to_string(),
            expected_items: 2,
            observed_items: 1,
            coverage_complete: false,
            truncated: true,
            items: vec![BatchManifestItem {
                item_id: "one".to_string(),
                object_handle_id: None,
                status: BatchItemStatus::Succeeded,
                attempts: 1,
                error: None,
            }],
        };
        assert!(!manifest.can_claim_complete_success());
    }

    #[test]
    fn connector_commit_requires_matching_preview_confirmation() {
        let mut receipt = ConnectorOperationReceipt {
            operation_id: "op_1".to_string(),
            idempotency_key: "idem_1".to_string(),
            provider: "mail".to_string(),
            action: "send".to_string(),
            state: OperationState::Draft,
            object_handle_ids: vec!["obj_1".to_string()],
            recipient_ids: vec!["user@example.com".to_string()],
            destination: None,
            irreversible: true,
            preview_sha256: "a".repeat(64),
            committed_at: None,
            error: None,
        };
        assert!(receipt.commit("2026-07-19T00:00:00Z").is_err());
        assert!(receipt.confirm(&"b".repeat(64)).is_err());
        receipt.confirm(&"a".repeat(64)).unwrap();
        receipt.commit("2026-07-19T00:00:00Z").unwrap();
        assert_eq!(receipt.state, OperationState::Committed);
    }
}
