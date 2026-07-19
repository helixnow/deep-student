//! First-class connector registry and object-operation bridge.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::task_objects::{
    ConnectorOperationReceipt, ObjectCapabilities, ObjectProvenance, OperationState,
    ProviderObjectRef, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::tools::ToolContext;

const CONNECTOR_REGISTRY_KEY: &str = "connectors.registry.v1";
const DEFAULT_CONFIRM_TTL_SECS: u64 = 600;
const MAX_CONFIRM_TTL_SECS: u64 = 3600;
const MAX_DRAFTS: usize = 512;

pub mod tool_names {
    pub const REGISTRY: &str = "connector_registry";
    pub const DRAFT: &str = "connector_operation_draft";
    pub const CONFIRM: &str = "connector_operation_confirm";
    pub const COMMIT: &str = "connector_operation_commit";
}

const SUPPORTED_CAPABILITIES: &[&str] =
    &["mail", "calendar", "meeting", "drive", "comments", "share"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthSnapshot {
    connected: bool,
    #[serde(default)]
    granted_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitySnapshot {
    version: String,
    observed_at: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityConfig {
    name: String,
    #[serde(default)]
    required_scopes: Vec<String>,
    mcp_server_id: String,
    #[serde(default)]
    mcp_tools: BTreeMap<String, String>,
    snapshot: CapabilitySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorConfig {
    id: String,
    provider: String,
    oauth: OAuthSnapshot,
    #[serde(default)]
    capabilities: Vec<CapabilityConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftPreview {
    provider_id: String,
    capability: String,
    action: String,
    recipients: Vec<String>,
    timezone: String,
    conflicts: Vec<Value>,
    destination: Option<String>,
    acl: Value,
    attachments: Vec<TaskObjectHandle>,
    payload: Value,
}

#[derive(Debug, Clone)]
struct PendingOperation {
    session_id: String,
    receipt: ConnectorOperationReceipt,
    preview: DraftPreview,
    capability_fingerprint: String,
    expires_at_ms: u64,
}

#[derive(Debug, Clone)]
struct CommittedOperation {
    session_id: String,
    operation_id: String,
    preview_sha256: String,
    output: Option<Value>,
}

static PENDING: OnceLock<Mutex<HashMap<String, PendingOperation>>> = OnceLock::new();
static COMMITTED: OnceLock<Mutex<HashMap<String, CommittedOperation>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, PendingOperation>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn committed() -> &'static Mutex<HashMap<String, CommittedOperation>> {
    COMMITTED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn require_same_session(expected: &str, actual: &str) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err("connector operation belongs to a different session".to_string())
    }
}

fn idempotency_store_key(session_id: &str, idempotency_key: &str) -> String {
    format!("{}:{}", session_id, idempotency_key)
}

fn sha256_json<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to serialize connector preview: {}", error))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn capability_fingerprint(
    config: &ConnectorConfig,
    capability: &CapabilityConfig,
) -> Result<String, String> {
    sha256_json(&(config.id.as_str(), &config.oauth, capability))
}

fn read_registry(ctx: &ExecutionContext) -> Result<Vec<ConnectorConfig>, String> {
    let db = ctx.main_db.as_ref().ok_or("Main database not available")?;
    let raw = db
        .get_secret(CONNECTOR_REGISTRY_KEY)
        .map_err(|error| format!("failed to read connector registry: {}", error))?;
    parse_registry(raw.as_deref())
}

fn parse_registry(raw: Option<&str>) -> Result<Vec<ConnectorConfig>, String> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(Vec::new());
    };
    let registry: Vec<ConnectorConfig> = serde_json::from_str(raw)
        .map_err(|error| format!("invalid connector registry JSON: {}", error))?;
    validate_registry(&registry)?;
    Ok(registry)
}

fn validate_registry(registry: &[ConnectorConfig]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for connector in registry {
        if connector.id.trim().is_empty() || connector.provider.trim().is_empty() {
            return Err("connector id and provider are required".to_string());
        }
        if !ids.insert(connector.id.as_str()) {
            return Err(format!("duplicate connector id '{}'", connector.id));
        }
        for capability in &connector.capabilities {
            if !SUPPORTED_CAPABILITIES.contains(&capability.name.as_str()) {
                return Err(format!(
                    "unsupported connector capability '{}'",
                    capability.name
                ));
            }
            if capability.mcp_server_id.trim().is_empty() {
                return Err(format!(
                    "connector capability '{}' lacks mcpServerId",
                    capability.name
                ));
            }
            for tool in capability.mcp_tools.values() {
                if tool.trim().is_empty() {
                    return Err("connector MCP tool mapping must not be empty".to_string());
                }
            }
        }
    }
    Ok(())
}

fn capability_available(config: &ConnectorConfig, capability: &CapabilityConfig) -> bool {
    config.oauth.connected
        && capability.required_scopes.iter().all(|scope| {
            config
                .oauth
                .granted_scopes
                .iter()
                .any(|granted| granted == scope)
        })
        && !capability.mcp_tools.is_empty()
}

fn find_capability<'a>(
    registry: &'a [ConnectorConfig],
    provider_id: &str,
    capability_name: &str,
) -> Result<(&'a ConnectorConfig, &'a CapabilityConfig), String> {
    let connector = registry
        .iter()
        .find(|entry| entry.id == provider_id)
        .ok_or_else(|| {
            format!(
                "capability_unavailable: connector '{}' is not configured",
                provider_id
            )
        })?;
    let capability = connector
        .capabilities
        .iter()
        .find(|entry| entry.name == capability_name)
        .ok_or_else(|| {
            format!(
                "capability_unavailable: '{}' does not provide '{}'",
                provider_id, capability_name
            )
        })?;
    if !capability_available(connector, capability) {
        return Err(format!(
            "capability_unavailable: '{}' lacks OAuth scopes or an MCP tool mapping for '{}'",
            provider_id, capability_name
        ));
    }
    Ok((connector, capability))
}

fn required_value<'a>(args: &'a Value, key: &str) -> Result<&'a Value, String> {
    args.get(key)
        .ok_or_else(|| format!("draft field '{}' is required", key))
}

fn parse_string_array(value: &Value, field: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{} must be an array", field))?
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("{} entries must be non-empty strings", field))
        })
        .collect()
}

fn parse_attachments(value: &Value) -> Result<Vec<TaskObjectHandle>, String> {
    value
        .as_array()
        .ok_or("attachments must be an array")?
        .iter()
        .map(|entry| {
            let handle: TaskObjectHandle = serde_json::from_value(entry.clone())
                .map_err(|error| format!("invalid attachment TaskObjectHandle: {}", error))?;
            handle.validate()?;
            Ok(handle)
        })
        .collect()
}

fn parse_draft(args: &Value) -> Result<DraftPreview, String> {
    let provider_id = required_value(args, "provider_id")?
        .as_str()
        .ok_or("provider_id must be a string")?
        .trim()
        .to_string();
    let capability = required_value(args, "capability")?
        .as_str()
        .ok_or("capability must be a string")?
        .trim()
        .to_string();
    if !SUPPORTED_CAPABILITIES.contains(&capability.as_str()) {
        return Err(format!("unsupported connector capability '{}'", capability));
    }
    let action = required_value(args, "action")?
        .as_str()
        .ok_or("action must be a string")?
        .trim()
        .to_string();
    let recipients = parse_string_array(required_value(args, "recipients")?, "recipients")?;
    let timezone = required_value(args, "timezone")?
        .as_str()
        .ok_or("timezone must be a string")?
        .trim()
        .to_string();
    if timezone.is_empty() {
        return Err(
            "timezone must not be empty; use 'not_applicable' when appropriate".to_string(),
        );
    }
    let conflicts = required_value(args, "conflicts")?
        .as_array()
        .ok_or("conflicts must be an array")?
        .clone();
    let destination = match required_value(args, "destination")? {
        Value::Null => None,
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => return Err("destination must be a non-empty string or null".to_string()),
    };
    let acl = required_value(args, "acl")?.clone();
    if !acl.is_object() {
        return Err("acl must be an object".to_string());
    }
    let attachments = parse_attachments(required_value(args, "attachments")?)?;
    let payload = required_value(args, "payload")?.clone();
    if !payload.is_object() {
        return Err("payload must be an object".to_string());
    }
    Ok(DraftPreview {
        provider_id,
        capability,
        action,
        recipients,
        timezone,
        conflicts,
        destination,
        acl,
        attachments,
        payload,
    })
}

fn cleanup_pending_locked(entries: &mut HashMap<String, PendingOperation>, now: u64) {
    entries.retain(|_, operation| operation.expires_at_ms > now);
    if entries.len() > MAX_DRAFTS {
        let mut ordered = entries
            .iter()
            .map(|(id, operation)| (id.clone(), operation.expires_at_ms))
            .collect::<Vec<_>>();
        ordered.sort_by_key(|(_, expires)| *expires);
        for (id, _) in ordered.into_iter().take(entries.len() - MAX_DRAFTS) {
            entries.remove(&id);
        }
    }
}

fn registry_output(registry: &[ConnectorConfig]) -> Value {
    let providers = registry
        .iter()
        .map(|connector| {
            let capabilities = connector
                .capabilities
                .iter()
                .map(|capability| {
                    json!({
                        "name": capability.name,
                        "available": capability_available(connector, capability),
                        "required_scopes": capability.required_scopes,
                        "mcp_server_id": capability.mcp_server_id,
                        "mapped_actions": capability.mcp_tools.keys().collect::<Vec<_>>(),
                        "snapshot": capability.snapshot,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": connector.id,
                "provider": connector.provider,
                "oauth": connector.oauth,
                "capabilities": capabilities,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "success": true,
        "supported_capabilities": SUPPORTED_CAPABILITIES,
        "providers": providers,
        "configured": !registry.is_empty(),
        "unavailable_code": "capability_unavailable",
    })
}

pub struct ConnectorToolExecutor;

impl ConnectorToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn execute_registry(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        Ok(registry_output(&read_registry(ctx)?))
    }

    fn execute_draft(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let registry =
            read_registry(ctx).map_err(|error| format!("capability_unavailable: {}", error))?;
        let preview = parse_draft(args)?;
        let (connector, capability) =
            find_capability(&registry, &preview.provider_id, &preview.capability)?;
        let mapped_tool = capability.mcp_tools.get(&preview.action).ok_or_else(|| {
            format!(
                "capability_unavailable: action '{}' is not mapped for '{}'",
                preview.action, preview.capability
            )
        })?;
        if mapped_tool.trim().is_empty() {
            return Err("capability_unavailable: mapped MCP tool is empty".to_string());
        }
        let preview_sha256 = sha256_json(&preview)?;
        let operation_id = format!("connector-op-{}", uuid::Uuid::new_v4());
        let ttl_secs = args
            .get("confirm_ttl_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CONFIRM_TTL_SECS)
            .clamp(30, MAX_CONFIRM_TTL_SECS);
        let expires_at_ms = now_ms().saturating_add(ttl_secs.saturating_mul(1000));
        let receipt = ConnectorOperationReceipt {
            operation_id: operation_id.clone(),
            idempotency_key: String::new(),
            provider: connector.id.clone(),
            action: format!("{}:{}", preview.capability, preview.action),
            state: OperationState::Draft,
            object_handle_ids: preview
                .attachments
                .iter()
                .map(|handle| handle.handle_id.clone())
                .collect(),
            recipient_ids: preview.recipients.clone(),
            destination: preview.destination.clone(),
            irreversible: true,
            preview_sha256: preview_sha256.clone(),
            committed_at: None,
            error: None,
        };
        let operation = PendingOperation {
            session_id: ctx.session_id.clone(),
            receipt: receipt.clone(),
            preview: preview.clone(),
            capability_fingerprint: capability_fingerprint(connector, capability)?,
            expires_at_ms,
        };
        let mut entries = pending()
            .lock()
            .map_err(|_| "connector draft store is unavailable")?;
        cleanup_pending_locked(&mut entries, now_ms());
        entries.insert(operation_id.clone(), operation);
        Ok(json!({
            "success": true,
            "state": "draft",
            "operation_id": operation_id,
            "preview_sha256": preview_sha256,
            "expires_at_ms": expires_at_ms,
            "preview": preview,
            "receipt": receipt,
            "requires_confirmation": true,
        }))
    }

    fn execute_confirm(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let operation_id = args
            .get("operation_id")
            .and_then(Value::as_str)
            .ok_or("operation_id is required")?;
        let preview_sha256 = args
            .get("preview_sha256")
            .and_then(Value::as_str)
            .ok_or("preview_sha256 is required")?;
        let mut entries = pending()
            .lock()
            .map_err(|_| "connector draft store is unavailable")?;
        cleanup_pending_locked(&mut entries, now_ms());
        let operation = entries
            .get_mut(operation_id)
            .ok_or("connector draft is missing or expired")?;
        require_same_session(&operation.session_id, &ctx.session_id)?;
        operation.receipt.confirm(preview_sha256)?;
        Ok(json!({
            "success": true,
            "state": "confirmed",
            "operation_id": operation_id,
            "preview_sha256": preview_sha256,
            "expires_at_ms": operation.expires_at_ms,
            "receipt": operation.receipt,
        }))
    }

    async fn execute_commit(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let operation_id = args
            .get("operation_id")
            .and_then(Value::as_str)
            .ok_or("operation_id is required")?
            .to_string();
        let preview_sha256 = args
            .get("preview_sha256")
            .and_then(Value::as_str)
            .ok_or("preview_sha256 is required")?
            .to_string();
        let idempotency_key = args
            .get("idempotency_key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("idempotency_key is required")?
            .to_string();
        let store_key = idempotency_store_key(&ctx.session_id, &idempotency_key);

        if let Some(existing) = committed()
            .lock()
            .map_err(|_| "connector idempotency store is unavailable")?
            .get(&store_key)
            .cloned()
        {
            require_same_session(&existing.session_id, &ctx.session_id)?;
            if existing.operation_id != operation_id || existing.preview_sha256 != preview_sha256 {
                return Err("idempotency_key is already bound to a different operation".to_string());
            }
            let Some(mut output) = existing.output else {
                return Err(
                    "connector operation with this idempotency_key is already in progress"
                        .to_string(),
                );
            };
            output["idempotent_replay"] = json!(true);
            return Ok(output);
        }

        let operation = {
            let mut entries = pending()
                .lock()
                .map_err(|_| "connector draft store is unavailable")?;
            cleanup_pending_locked(&mut entries, now_ms());
            entries
                .get(&operation_id)
                .cloned()
                .ok_or("connector draft is missing or expired")?
        };
        if operation.receipt.state != OperationState::Confirmed {
            return Err("connector operation must be confirmed before commit".to_string());
        }
        require_same_session(&operation.session_id, &ctx.session_id)?;
        if operation.receipt.preview_sha256 != preview_sha256 {
            return Err("preview_sha256 does not match the confirmed operation".to_string());
        }

        let registry =
            read_registry(ctx).map_err(|error| format!("capability_unavailable: {}", error))?;
        let (connector, capability) = find_capability(
            &registry,
            &operation.preview.provider_id,
            &operation.preview.capability,
        )?;
        if capability_fingerprint(connector, capability)? != operation.capability_fingerprint {
            return Err(
                "capability snapshot changed; create and confirm a new operation draft".to_string(),
            );
        }
        let mapped_tool = capability
            .mcp_tools
            .get(&operation.preview.action)
            .ok_or_else(|| "capability_unavailable: MCP action mapping was removed".to_string())?;
        let external_tool = if mapped_tool.starts_with("mcp_") {
            mapped_tool.clone()
        } else {
            format!("mcp_{}", mapped_tool)
        };
        let provider_args = json!({
            "_serverId": capability.mcp_server_id.clone(),
            "idempotency_key": idempotency_key.clone(),
            "recipients": operation.preview.recipients.clone(),
            "timezone": operation.preview.timezone.clone(),
            "conflicts": operation.preview.conflicts.clone(),
            "destination": operation.preview.destination.clone(),
            "acl": operation.preview.acl.clone(),
            "attachments": operation.preview.attachments.clone(),
            "payload": operation.preview.payload.clone(),
            "expected_object_version": capability.snapshot.object_version.clone(),
        });
        committed()
            .lock()
            .map_err(|_| "connector idempotency store is unavailable")?
            .insert(
                store_key.clone(),
                CommittedOperation {
                    session_id: ctx.session_id.clone(),
                    operation_id: operation_id.clone(),
                    preview_sha256: preview_sha256.clone(),
                    output: None,
                },
            );
        let tool_ctx = ToolContext {
            db: ctx.main_db.as_ref().map(|db| db.as_ref()),
            mcp_client: None,
            supports_tools: true,
            window: Some(ctx.window_ref()),
            stream_event: None,
            stage: Some("connector_commit"),
            memory_enabled: None,
            llm_manager: ctx.llm_manager.clone(),
        };
        let (ok, data, error, _usage, _citations, _inject) = ctx
            .tool_registry
            .call_tool(&external_tool, &provider_args, &tool_ctx)
            .await;
        if !ok {
            committed()
                .lock()
                .map_err(|_| "connector idempotency store is unavailable")?
                .remove(&store_key);
            return Err(format!(
                "connector provider commit failed: {}",
                error.unwrap_or_else(|| "unknown provider error".to_string())
            ));
        }
        let provider_result = data.unwrap_or(Value::Null);
        let object_handle = match provider_object_handle(
            connector,
            capability,
            &operation.preview,
            &operation_id,
            &provider_result,
        ) {
            Ok(handle) => handle,
            Err(error) => {
                committed()
                    .lock()
                    .map_err(|_| "connector idempotency store is unavailable")?
                    .remove(&store_key);
                return Err(error);
            }
        };
        let mut receipt = operation.receipt.clone();
        receipt.idempotency_key = idempotency_key.clone();
        receipt
            .object_handle_ids
            .push(object_handle.handle_id.clone());
        receipt.commit(chrono::Utc::now().to_rfc3339())?;
        let output = json!({
            "success": true,
            "state": "committed",
            "operation_id": operation_id.clone(),
            "preview_sha256": preview_sha256.clone(),
            "object_handle": object_handle,
            "receipt": receipt,
            "provider_result": provider_result,
            "idempotent_replay": false,
        });
        committed()
            .lock()
            .map_err(|_| "connector idempotency store is unavailable")?
            .insert(
                store_key,
                CommittedOperation {
                    session_id: ctx.session_id.clone(),
                    operation_id: operation_id.clone(),
                    preview_sha256,
                    output: Some(output.clone()),
                },
            );
        pending()
            .lock()
            .map_err(|_| "connector draft store is unavailable")?
            .remove(&operation_id);
        Ok(output)
    }
}

fn provider_object_handle(
    connector: &ConnectorConfig,
    capability: &CapabilityConfig,
    preview: &DraftPreview,
    operation_id: &str,
    provider_result: &Value,
) -> Result<TaskObjectHandle, String> {
    let external_id = [
        "id",
        "object_id",
        "objectId",
        "event_id",
        "eventId",
        "message_id",
        "messageId",
    ]
    .iter()
    .find_map(|key| provider_result.get(key).and_then(Value::as_str))
    .map(str::to_string);
    let display_name = ["name", "title", "subject"]
        .iter()
        .find_map(|key| provider_result.get(key).and_then(Value::as_str))
        .unwrap_or(&preview.action)
        .to_string();
    let kind = match preview.capability.as_str() {
        "mail" => TaskObjectKind::Message,
        "calendar" | "meeting" => TaskObjectKind::Event,
        "drive" => TaskObjectKind::File,
        _ => TaskObjectKind::Record,
    };
    let mut handle = TaskObjectHandle::new(
        match &external_id {
            Some(external_id) => format!("connector:{}:{}", connector.id, external_id),
            None => format!("connector-operation:{}", operation_id),
        },
        kind,
        display_name,
        ObjectProvenance {
            source: connector.provider.clone(),
            source_uri: provider_result
                .get("uri")
                .or_else(|| provider_result.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string),
            server: Some(capability.mcp_server_id.clone()),
            tool: capability.mcp_tools.get(&preview.action).cloned(),
            derived_from: preview
                .attachments
                .iter()
                .map(|attachment| attachment.handle_id.clone())
                .collect(),
            observed_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    handle.provider_ref = external_id.map(|external_id| ProviderObjectRef {
        provider: connector.id.clone(),
        external_id,
        container_id: preview.destination.clone(),
        thread_id: provider_result
            .get("thread_id")
            .or_else(|| provider_result.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        version: capability.snapshot.object_version.clone(),
        etag: provider_result
            .get("etag")
            .and_then(Value::as_str)
            .map(str::to_string),
    });
    handle.capabilities = ObjectCapabilities {
        readable: true,
        materializable: false,
        writable: capability
            .snapshot
            .permissions
            .iter()
            .any(|value| value == "write"),
        shareable: capability
            .snapshot
            .permissions
            .iter()
            .any(|value| value == "share"),
        sendable: capability
            .snapshot
            .permissions
            .iter()
            .any(|value| value == "send"),
        deletable: capability
            .snapshot
            .permissions
            .iter()
            .any(|value| value == "delete"),
    };
    handle.validate()?;
    Ok(handle)
}

impl Default for ConnectorToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for ConnectorToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::REGISTRY | tool_names::DRAFT | tool_names::CONFIRM | tool_names::COMMIT
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = std::time::Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match strip_tool_namespace(&call.name) {
            tool_names::REGISTRY => self.execute_registry(ctx),
            tool_names::DRAFT => self.execute_draft(&call.arguments, ctx),
            tool_names::CONFIRM => self.execute_confirm(&call.arguments, ctx),
            tool_names::COMMIT => self.execute_commit(&call.arguments, ctx).await,
            _ => Err("Unknown connector tool".to_string()),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let info = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({"result": output, "durationMs": duration_ms})));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&info) {
            log::warn!(
                "[ConnectorToolExecutor] Failed to save tool block: {}",
                error
            );
        }
        Ok(info)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            tool_names::REGISTRY => ToolSensitivity::Low,
            tool_names::DRAFT => ToolSensitivity::Medium,
            tool_names::CONFIRM | tool_names::COMMIT => ToolSensitivity::High,
            _ => ToolSensitivity::High,
        }
    }

    fn name(&self) -> &'static str {
        "ConnectorToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_registry() -> Vec<ConnectorConfig> {
        parse_registry(Some(r#"[{
          "id":"google-work","provider":"google","oauth":{"connected":true,"grantedScopes":["mail.send","drive.write"]},
          "capabilities":[{
            "name":"mail","requiredScopes":["mail.send"],"mcpServerId":"google-mcp",
            "mcpTools":{"send":"gmail_send"},
            "snapshot":{"version":"v1","observedAt":"2026-07-19T00:00:00Z","permissions":["send"],"objectVersion":"etag-1"}
          }]
        }]"#)).unwrap()
    }

    #[test]
    fn con_02_registry_is_data_driven_and_reports_capability_snapshot() {
        let output = registry_output(&configured_registry());
        assert_eq!(output["providers"][0]["capabilities"][0]["available"], true);
        assert_eq!(
            output["providers"][0]["capabilities"][0]["snapshot"]["version"],
            "v1"
        );
    }

    #[test]
    fn con_03_missing_oauth_or_mapping_is_capability_unavailable() {
        let mut registry = configured_registry();
        registry[0].oauth.connected = false;
        assert!(find_capability(&registry, "google-work", "mail")
            .unwrap_err()
            .contains("capability_unavailable"));
        assert!(find_capability(&[], "missing", "mail")
            .unwrap_err()
            .contains("capability_unavailable"));
    }

    #[test]
    fn con_04_draft_requires_all_risk_preview_fields() {
        for field in [
            "recipients",
            "timezone",
            "conflicts",
            "destination",
            "acl",
            "attachments",
        ] {
            let mut args = json!({
                "provider_id":"google-work","capability":"mail","action":"send",
                "recipients":[],"timezone":"UTC","conflicts":[],"destination":null,
                "acl":{},"attachments":[],"payload":{}
            });
            args.as_object_mut().unwrap().remove(field);
            assert!(parse_draft(&args).unwrap_err().contains(field));
        }
    }

    #[test]
    fn con_05_preview_hash_binds_acl_destination_and_attachments() {
        let base = parse_draft(&json!({
            "provider_id":"google-work","capability":"mail","action":"send",
            "recipients":["a@example.com"],"timezone":"UTC","conflicts":[],
            "destination":"inbox","acl":{"access":"private"},"attachments":[],"payload":{"subject":"Hi"}
        })).unwrap();
        let mut changed = base.clone();
        changed.acl = json!({"access":"public"});
        assert_ne!(sha256_json(&base).unwrap(), sha256_json(&changed).unwrap());
    }

    #[test]
    fn con_06_confirm_requires_matching_hash_and_draft_state() {
        let mut receipt = ConnectorOperationReceipt {
            operation_id: "op".into(),
            idempotency_key: String::new(),
            provider: "p".into(),
            action: "mail:send".into(),
            state: OperationState::Draft,
            object_handle_ids: vec![],
            recipient_ids: vec![],
            destination: None,
            irreversible: true,
            preview_sha256: "a".repeat(64),
            committed_at: None,
            error: None,
        };
        assert!(receipt.confirm(&"b".repeat(64)).is_err());
        receipt.confirm(&"a".repeat(64)).unwrap();
        assert!(receipt.confirm(&"a".repeat(64)).is_err());
    }

    #[test]
    fn con_06_operations_are_bound_to_the_originating_session() {
        assert!(require_same_session("session-a", "session-a").is_ok());
        assert!(require_same_session("session-a", "session-b").is_err());
        assert_ne!(
            idempotency_store_key("session-a", "idem"),
            idempotency_store_key("session-b", "idem")
        );
    }

    #[test]
    fn con_06_expired_drafts_are_removed_before_confirmation() {
        let mut entries = HashMap::new();
        entries.insert(
            "expired".to_string(),
            PendingOperation {
                session_id: "session-a".to_string(),
                receipt: ConnectorOperationReceipt {
                    operation_id: "expired".into(),
                    idempotency_key: String::new(),
                    provider: "p".into(),
                    action: "mail:send".into(),
                    state: OperationState::Draft,
                    object_handle_ids: vec![],
                    recipient_ids: vec![],
                    destination: None,
                    irreversible: true,
                    preview_sha256: "a".repeat(64),
                    committed_at: None,
                    error: None,
                },
                preview: parse_draft(&json!({
                    "provider_id":"p","capability":"mail","action":"send",
                    "recipients":[],"timezone":"UTC","conflicts":[],"destination":null,
                    "acl":{},"attachments":[],"payload":{}
                }))
                .unwrap(),
                capability_fingerprint: "f".repeat(64),
                expires_at_ms: 10,
            },
        );
        cleanup_pending_locked(&mut entries, 11);
        assert!(entries.is_empty());
    }

    #[test]
    fn con_07_capability_fingerprint_changes_with_scope_or_version() {
        let registry = configured_registry();
        let original = capability_fingerprint(&registry[0], &registry[0].capabilities[0]).unwrap();
        let mut changed = registry.clone();
        changed[0].capabilities[0].snapshot.version = "v2".into();
        assert_ne!(
            original,
            capability_fingerprint(&changed[0], &changed[0].capabilities[0]).unwrap()
        );
    }

    #[test]
    fn con_08_registry_rejects_unknown_capabilities() {
        let raw = r#"[{"id":"p","provider":"p","oauth":{"connected":true,"grantedScopes":[]},"capabilities":[{"name":"payments","requiredScopes":[],"mcpServerId":"m","mcpTools":{"pay":"x"},"snapshot":{"version":"1","observedAt":"now","permissions":[]}}]}]"#;
        assert!(parse_registry(Some(raw)).is_err());
    }

    #[test]
    fn col_02_attachment_handles_are_validated() {
        assert!(parse_attachments(&json!([{"handleId":"x"}])).is_err());
    }

    #[test]
    fn col_03_provider_object_kind_matches_capability() {
        let registry = configured_registry();
        let preview = parse_draft(&json!({
            "provider_id":"google-work","capability":"mail","action":"send",
            "recipients":[],"timezone":"UTC","conflicts":[],"destination":null,
            "acl":{},"attachments":[],"payload":{}
        }))
        .unwrap();
        let handle = provider_object_handle(
            &registry[0],
            &registry[0].capabilities[0],
            &preview,
            "op",
            &json!({"id":"msg-1"}),
        )
        .unwrap();
        assert_eq!(handle.kind, TaskObjectKind::Message);
        assert_eq!(handle.provider_ref.unwrap().external_id, "msg-1");
    }

    #[test]
    fn col_04_commit_receipt_cannot_skip_confirmation() {
        let mut receipt = ConnectorOperationReceipt {
            operation_id: "op".into(),
            idempotency_key: "idem".into(),
            provider: "p".into(),
            action: "share:create".into(),
            state: OperationState::Draft,
            object_handle_ids: vec![],
            recipient_ids: vec![],
            destination: None,
            irreversible: true,
            preview_sha256: "a".repeat(64),
            committed_at: None,
            error: None,
        };
        assert!(receipt.commit("now").is_err());
    }
}
