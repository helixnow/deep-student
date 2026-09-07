//! Shared object, provenance, and delivery contracts for agent tasks.
//!
//! A model being able to see content is not the same as an executor being able
//! to operate on it. `TaskObjectHandle` keeps those concerns explicit across
//! chat attachments, browser downloads, MCP resources, and future connectors.

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

/// schema v2：`ObjectProvenance.derived_from` 由 `Vec<String>` 升级为
/// `Vec<DerivedEdge>`（带 transform_id / 参数指纹 / 观测时间）。
const TASK_OBJECT_SCHEMA_VERSION: u16 = 2;
/// 持久化的 v1 数据（derived_from 为字符串数组）仍可反序列化并通过校验。
const MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION: u16 = 1;

/// 旧格式 `derived_from` 字符串升级后的占位 transform 标识。
pub const LEGACY_DERIVED_TRANSFORM_ID: &str = "legacy_unknown";

/// 计算 transform 参数的确定性 sha256 指纹。
///
/// `params` 必须由调用方以 `serde_json::json!` 字面量显式构造（字段固定、
/// 顺序固定）。**严禁**把含 `HashMap` 的结构序列化后传入——HashMap 迭代序
/// 随机，同一内容哈希逐次不同（见项目 AGENTS.md 红线）。
pub fn hash_transform_params(params: &serde_json::Value) -> String {
    hex::encode(Sha256::digest(params.to_string().as_bytes()))
}

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

/// 一条血缘边：本对象由哪个来源对象经哪次变换而来。
///
/// 序列化恒为 v2 对象格式；反序列化兼容 v1 纯字符串格式（自动升级为
/// `transform_id = legacy_unknown`、无参数指纹、空观测时间）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedEdge {
    /// 来源标识：上游 handle_id / URL / VFS resource id / 运行时路径等。
    pub source_handle_id: String,
    /// 产生本对象的变换标识，如 `fetch.binary`、`xlsx.edit_cells`。
    pub transform_id: String,
    /// 变换参数的确定性 sha256（见 `hash_transform_params`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform_params_hash: Option<String>,
    pub observed_at: String,
}

impl DerivedEdge {
    pub fn new(source_handle_id: impl Into<String>, transform_id: impl Into<String>) -> Self {
        Self {
            source_handle_id: source_handle_id.into(),
            transform_id: transform_id.into(),
            transform_params_hash: None,
            observed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    pub fn with_params_hash(mut self, hash: impl Into<String>) -> Self {
        self.transform_params_hash = Some(hash.into());
        self
    }

    pub fn observed_at(mut self, observed_at: impl Into<String>) -> Self {
        self.observed_at = observed_at.into();
        self
    }
}

impl<'de> Deserialize<'de> for DerivedEdge {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DerivedEdgeV2 {
            source_handle_id: String,
            transform_id: String,
            #[serde(default)]
            transform_params_hash: Option<String>,
            #[serde(default)]
            observed_at: String,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            V2(DerivedEdgeV2),
            Legacy(String),
        }

        match Wire::deserialize(deserializer)? {
            Wire::V2(edge) => Ok(Self {
                source_handle_id: edge.source_handle_id,
                transform_id: edge.transform_id,
                transform_params_hash: edge.transform_params_hash,
                observed_at: edge.observed_at,
            }),
            Wire::Legacy(source) => Ok(Self {
                source_handle_id: source,
                transform_id: LEGACY_DERIVED_TRANSFORM_ID.to_string(),
                transform_params_hash: None,
                observed_at: String::new(),
            }),
        }
    }
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
    pub derived_from: Vec<DerivedEdge>,
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
        // v1（字符串 derived_from）与 v2（DerivedEdge）均可通过校验；
        // 拒绝未知的新版本与非法的 0。
        if self.schema_version < MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION
            || self.schema_version > TASK_OBJECT_SCHEMA_VERSION
        {
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

/// `TaskObjectHandle` 的统一构造入口（G11-P1）。
///
/// - `handle_id` / `kind` / `display_name` / `provenance.source` 为必填；
/// - 血缘必须显式：调用 `derived_edge(s)` 填来源，或 `origin_unknown(reason)`
///   声明无来源（落 debug log），否则 `build()` 报错；
/// - `build()` 内部调用 `TaskObjectHandle::validate()`。
#[derive(Debug, Clone)]
pub struct TaskObjectHandleBuilder {
    handle_id: String,
    kind: TaskObjectKind,
    display_name: String,
    source: String,
    source_uri: Option<String>,
    server: Option<String>,
    tool: Option<String>,
    derived_from: Option<Vec<DerivedEdge>>,
    origin_unknown_reason: Option<String>,
    media_type: Option<String>,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    locator: Option<ManagedLocator>,
    provider_ref: Option<ProviderObjectRef>,
    acl: Option<ObjectAcl>,
    capabilities: ObjectCapabilities,
    expires_at: Option<String>,
    observed_at: Option<String>,
}

impl TaskObjectHandleBuilder {
    pub fn new(
        handle_id: impl Into<String>,
        kind: TaskObjectKind,
        display_name: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            handle_id: handle_id.into(),
            kind,
            display_name: display_name.into(),
            source: source.into(),
            source_uri: None,
            server: None,
            tool: None,
            derived_from: None,
            origin_unknown_reason: None,
            media_type: None,
            size_bytes: None,
            sha256: None,
            locator: None,
            provider_ref: None,
            acl: None,
            capabilities: ObjectCapabilities::default(),
            expires_at: None,
            observed_at: None,
        }
    }

    pub fn source_uri(mut self, value: Option<impl Into<String>>) -> Self {
        self.source_uri = value.map(Into::into);
        self
    }

    pub fn server(mut self, value: Option<impl Into<String>>) -> Self {
        self.server = value.map(Into::into);
        self
    }

    pub fn tool(mut self, value: Option<impl Into<String>>) -> Self {
        self.tool = value.map(Into::into);
        self
    }

    /// 追加一条血缘边（可多次调用）。
    pub fn derived_edge(mut self, edge: DerivedEdge) -> Self {
        self.derived_from.get_or_insert_with(Vec::new).push(edge);
        self
    }

    /// 一次性设置全部血缘边。
    pub fn derived_edges(mut self, edges: Vec<DerivedEdge>) -> Self {
        self.derived_from = Some(edges);
        self
    }

    /// 显式声明"无可靠来源"的逃生门：血缘留空并落 debug log。
    pub fn origin_unknown(mut self, reason: impl Into<String>) -> Self {
        self.origin_unknown_reason = Some(reason.into());
        self.derived_from = Some(Vec::new());
        self
    }

    pub fn media_type(mut self, value: Option<impl Into<String>>) -> Self {
        self.media_type = value.map(Into::into);
        self
    }

    pub fn size_bytes(mut self, value: Option<u64>) -> Self {
        self.size_bytes = value;
        self
    }

    pub fn sha256(mut self, value: Option<impl Into<String>>) -> Self {
        self.sha256 = value.map(Into::into);
        self
    }

    pub fn locator(mut self, value: Option<ManagedLocator>) -> Self {
        self.locator = value;
        self
    }

    pub fn provider_ref(mut self, value: Option<ProviderObjectRef>) -> Self {
        self.provider_ref = value;
        self
    }

    pub fn acl(mut self, value: Option<ObjectAcl>) -> Self {
        self.acl = value;
        self
    }

    pub fn capabilities(mut self, value: ObjectCapabilities) -> Self {
        self.capabilities = value;
        self
    }

    pub fn expires_at(mut self, value: Option<impl Into<String>>) -> Self {
        self.expires_at = value.map(Into::into);
        self
    }

    /// 缺省为 `build()` 时刻的 UTC now（与历史产出点行为一致）。
    pub fn observed_at(mut self, value: impl Into<String>) -> Self {
        self.observed_at = Some(value.into());
        self
    }

    pub fn build(self) -> Result<TaskObjectHandle, String> {
        let derived_from = match self.derived_from {
            Some(edges) => edges,
            None => {
                return Err(format!(
                    "derived_from lineage must be explicit for handle {} \
                     (use derived_edge(s) or origin_unknown)",
                    self.handle_id
                ))
            }
        };
        if let Some(reason) = &self.origin_unknown_reason {
            log::debug!(
                "[task_objects] handle {} built with origin_unknown lineage: {}",
                self.handle_id,
                reason
            );
        }
        let provenance = ObjectProvenance {
            source: self.source,
            source_uri: self.source_uri,
            server: self.server,
            tool: self.tool,
            derived_from,
            observed_at: self
                .observed_at
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        };
        let mut handle =
            TaskObjectHandle::new(self.handle_id, self.kind, self.display_name, provenance);
        handle.media_type = self.media_type;
        handle.size_bytes = self.size_bytes;
        handle.sha256 = self.sha256;
        handle.locator = self.locator;
        handle.provider_ref = self.provider_ref;
        handle.acl = self.acl;
        handle.capabilities = self.capabilities;
        handle.expires_at = self.expires_at;
        handle.validate()?;
        Ok(handle)
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

    #[test]
    fn derived_edge_serializes_v2_and_reads_legacy_string() {
        let edge = DerivedEdge::new("obj_src", "fetch.binary")
            .with_params_hash("ab".repeat(32))
            .observed_at("2026-09-07T00:00:00Z");
        let value = serde_json::to_value(&edge).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "sourceHandleId": "obj_src",
                "transformId": "fetch.binary",
                "transformParamsHash": "ab".repeat(32),
                "observedAt": "2026-09-07T00:00:00Z",
            })
        );
        // v2 对象 roundtrip
        let parsed: DerivedEdge = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, edge);
        // v1 纯字符串自动升级为 legacy_unknown
        let legacy: DerivedEdge = serde_json::from_value(serde_json::json!("obj_src")).unwrap();
        assert_eq!(legacy.source_handle_id, "obj_src");
        assert_eq!(legacy.transform_id, LEGACY_DERIVED_TRANSFORM_ID);
        assert_eq!(legacy.transform_params_hash, None);
        assert!(legacy.observed_at.is_empty());
    }

    #[test]
    fn schema_v1_handle_with_string_lineage_still_validates() {
        let legacy_json = serde_json::json!({
            "schemaVersion": 1,
            "handleId": "obj_old",
            "kind": "file",
            "displayName": "old.png",
            "capabilities": {
                "readable": true,
                "materializable": false,
                "writable": false,
                "shareable": false,
                "sendable": false,
                "deletable": false,
            },
            "provenance": {
                "source": "url_download",
                "derivedFrom": ["https://example.com/a.png"],
                "observedAt": "2026-07-19T00:00:00Z",
            },
        });
        let handle: TaskObjectHandle = serde_json::from_value(legacy_json).unwrap();
        assert_eq!(handle.schema_version, 1);
        assert_eq!(handle.provenance.derived_from.len(), 1);
        assert_eq!(
            handle.provenance.derived_from[0].transform_id,
            LEGACY_DERIVED_TRANSFORM_ID
        );
        assert!(handle.validate().is_ok());
        // 未来版本仍被拒绝
        let mut future = handle.clone();
        future.schema_version = TASK_OBJECT_SCHEMA_VERSION + 1;
        assert!(future.validate().is_err());
    }

    #[test]
    fn builder_requires_explicit_lineage() {
        let result = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .build();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("derived_from"));
    }

    #[test]
    fn builder_origin_unknown_builds_with_empty_lineage() {
        let handle = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .origin_unknown("test_no_referrer")
            .build()
            .unwrap();
        assert!(handle.provenance.derived_from.is_empty());
        assert_eq!(handle.schema_version, TASK_OBJECT_SCHEMA_VERSION);
    }

    #[test]
    fn builder_build_runs_validation() {
        // 非法 sha256 必须被 validate 拦截
        let result = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .derived_edge(DerivedEdge::new("src", "test.op"))
            .sha256(Some("not-a-hash"))
            .build();
        assert!(result.is_err());
        // 合法构造
        let handle = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .derived_edge(
                DerivedEdge::new("src", "test.op")
                    .with_params_hash(hash_transform_params(&serde_json::json!({"k": "v"}))),
            )
            .sha256(Some("a".repeat(64)))
            .build()
            .unwrap();
        assert_eq!(handle.provenance.derived_from.len(), 1);
        assert_eq!(
            handle.provenance.derived_from[0].transform_id,
            "test.op"
        );
        assert!(handle.provenance.derived_from[0].transform_params_hash.is_some());
    }
}
