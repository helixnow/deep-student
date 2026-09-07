//! First-class connector registry and object-operation bridge.
//!
//! G04-P0：操作状态持久化到 chat_v2 库 `connector_operations` 账本
//! （[`crate::chat_v2::connector_ledger`]），替代旧的进程内 Map——
//! submitting 先于 provider 调用落库，重启后遗留 submitting 由启动对账
//! 收敛为 outcome_unknown；幂等键由系统在 draft 时生成
//! （`sha256(operation_id || preview_sha256)`），不再接受模型提供的键。
//!
//! G04-P1：第一个真实 provider（generic webhook，
//! [`crate::chat_v2::connector_providers`]）纵向打通——commit 按 registry
//! 中 connector 的 `provider` 字段分发：webhook 经 HTTPS + HMAC 签名真实
//! 投递（瞬时错误限次重试，耗尽收敛 outcome_unknown），其余 provider 维持
//! MCP 工具桥；启动对账升级为 provider lookup 核销（见
//! [`reconcile_connector_operations_with_lookup`]）。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::connector_ledger::{
    system_idempotency_key, ConnectorLedger, ConnectorOperation, ConnectorOperationState,
    NewConnectorOperation,
};
use crate::chat_v2::connector_providers::webhook::{WebhookConfig, WebhookProvider};
use crate::chat_v2::connector_providers::{
    extract_external_operation_id, ConnectorProvider, ProviderError, ProviderErrorKind,
    ProviderOperation, WEBHOOK_PROVIDER_KIND,
};
use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::task_objects::{
    ConnectorOperationReceipt, DerivedEdge, ObjectCapabilities, ObjectProvenance, OperationState,
    ProviderObjectRef, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::database::Database;
use crate::tools::ToolContext;

const CONNECTOR_REGISTRY_KEY: &str = "connectors.registry.v1";
const DEFAULT_CONFIRM_TTL_SECS: u64 = 600;
const MAX_CONFIRM_TTL_SECS: u64 = 3600;

/// webhook 提交的最大尝试次数（1 次首发 + 2 次瞬时重试，同一幂等键）。
const WEBHOOK_SUBMIT_MAX_ATTEMPTS: u32 = 3;

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
    /// G04-P1：provider = "webhook" 时的通道配置（endpoint + secret 键名；
    /// secret 本体只存 settings 安全通道，见 connector_providers::webhook）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    webhook: Option<WebhookConfig>,
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn require_same_session(expected: &str, actual: &str) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err("connector operation belongs to a different session".to_string())
    }
}

/// 账本句柄：DB 为权威，无 chat_v2 库时连接器操作直接不可用（fail-close）。
fn ledger(ctx: &ExecutionContext) -> Result<ConnectorLedger, String> {
    let db = ctx
        .chat_v2_db
        .as_ref()
        .ok_or("connector operation ledger is unavailable (chat_v2 database not attached)")?;
    Ok(ConnectorLedger::new(db.clone()))
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
    // 只覆盖权限语义字段：`oauth.expires_at` 会随 token 刷新变化、
    // `snapshot.observed_at` 会随重新观测变化，但权限域未变——纳入它们会
    // 误杀已确认的 commit（draft→confirm 被迫重来）。scope/permission 列表
    // 是集合语义，先排序消除提供方返回序差异。
    let mut granted_scopes = config.oauth.granted_scopes.clone();
    granted_scopes.sort_unstable();
    let mut required_scopes = capability.required_scopes.clone();
    required_scopes.sort_unstable();
    let mut permissions = capability.snapshot.permissions.clone();
    permissions.sort_unstable();
    sha256_json(&(
        config.id.as_str(),
        config.oauth.connected,
        granted_scopes,
        config.oauth.account_id.as_deref(),
        capability.name.as_str(),
        required_scopes,
        capability.mcp_server_id.as_str(),
        &capability.mcp_tools,
        capability.snapshot.version.as_str(),
        permissions,
        capability.snapshot.object_version.as_deref(),
    ))
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
        let is_webhook = connector.provider == WEBHOOK_PROVIDER_KIND;
        if is_webhook {
            // webhook 通道配置的形状校验（shape-only：白名单/secret 存在性
            // 在 commit / reconcile 时经 settings 严格解析，fail-closed）。
            let webhook = connector.webhook.as_ref().ok_or_else(|| {
                format!(
                    "webhook connector '{}' requires a 'webhook' config section",
                    connector.id
                )
            })?;
            if webhook.endpoint.trim().is_empty() {
                return Err(format!(
                    "webhook connector '{}' has an empty endpoint",
                    connector.id
                ));
            }
            if webhook.secret_setting_key.trim().is_empty() {
                return Err(format!(
                    "webhook connector '{}' has an empty secretSettingKey",
                    connector.id
                ));
            }
        } else if connector.webhook.is_some() {
            return Err(format!(
                "connector '{}' carries a webhook section but provider is not 'webhook'",
                connector.id
            ));
        }
        for capability in &connector.capabilities {
            if !SUPPORTED_CAPABILITIES.contains(&capability.name.as_str()) {
                return Err(format!(
                    "unsupported connector capability '{}'",
                    capability.name
                ));
            }
            // webhook provider 不经 MCP 桥，mcpServerId 无意义（允许留空）；
            // mcpTools 对 webhook 而言是 action 白名单（键 = action 名）。
            if !is_webhook && capability.mcp_server_id.trim().is_empty() {
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
    let channel_ready = if config.provider == WEBHOOK_PROVIDER_KIND {
        // webhook 通道：registry 携带配置段即可（settings 解析在 commit 时严格进行）
        config.webhook.is_some()
    } else {
        true
    };
    config.oauth.connected
        && capability.required_scopes.iter().all(|scope| {
            config
                .oauth
                .granted_scopes
                .iter()
                .any(|granted| granted == scope)
        })
        && !capability.mcp_tools.is_empty()
        && channel_ready
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

/// 账本状态 → 对外 receipt 状态（task_objects::OperationState 没有
/// submitting/outcome_unknown；submitting 对模型呈现为已确认未提交，
/// outcome_unknown 呈现为 failed 并在 error 中保留语义）。
fn receipt_state(state: ConnectorOperationState) -> OperationState {
    match state {
        ConnectorOperationState::Draft => OperationState::Draft,
        ConnectorOperationState::Confirmed | ConnectorOperationState::Submitting => {
            OperationState::Confirmed
        }
        ConnectorOperationState::Committed => OperationState::Committed,
        ConnectorOperationState::OutcomeUnknown | ConnectorOperationState::Failed => {
            OperationState::Failed
        }
    }
}

/// 从账本行重建对外 receipt（committed 的 object_handle_ids 在 commit 流程内补齐）。
fn receipt_of(row: &ConnectorOperation, preview: &DraftPreview) -> ConnectorOperationReceipt {
    ConnectorOperationReceipt {
        operation_id: row.operation_id.clone(),
        idempotency_key: row.idempotency_key.clone(),
        provider: row.provider_id.clone(),
        action: format!("{}:{}", preview.capability, preview.action),
        state: receipt_state(row.state),
        object_handle_ids: Vec::new(),
        recipient_ids: preview.recipients.clone(),
        destination: preview.destination.clone(),
        irreversible: true,
        preview_sha256: row.preview_sha256.clone().unwrap_or_default(),
        committed_at: if row.state == ConnectorOperationState::Committed {
            row.resolved_at.clone()
        } else {
            None
        },
        error: row.error.clone(),
    }
}

fn parse_stored_preview(row: &ConnectorOperation) -> Result<DraftPreview, String> {
    let raw = row
        .preview_json
        .as_deref()
        .ok_or("connector operation is missing its stored preview")?;
    serde_json::from_str(raw)
        .map_err(|error| format!("failed to parse stored connector preview: {}", error))
}

fn operation_expired(row: &ConnectorOperation, now: u64) -> bool {
    row.expires_at_ms
        .map(|expires| expires >= 0 && expires as u64 <= now)
        .unwrap_or(false)
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
        // 账本为权威：无 chat_v2 库时 fail-close，不创建任何瞬态草稿
        let ledger = ledger(ctx)?;
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
        // 系统幂等键：draft 时生成并持久化，confirm/commit 不接受模型提供的键
        let idempotency_key = system_idempotency_key(&operation_id, &preview_sha256);
        let ttl_secs = args
            .get("confirm_ttl_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CONFIRM_TTL_SECS)
            .clamp(30, MAX_CONFIRM_TTL_SECS);
        let expires_at_ms = now_ms().saturating_add(ttl_secs.saturating_mul(1000));
        let preview_json = serde_json::to_string(&preview)
            .map_err(|error| format!("failed to persist connector preview: {}", error))?;
        ledger.insert_draft(&NewConnectorOperation {
            operation_id: operation_id.clone(),
            session_id: ctx.session_id.clone(),
            provider_id: connector.id.clone(),
            capability: Some(preview.capability.clone()),
            action: preview.action.clone(),
            preview_sha256: preview_sha256.clone(),
            idempotency_key: idempotency_key.clone(),
            account_id: connector.oauth.account_id.clone(),
            capability_fingerprint: Some(capability_fingerprint(connector, capability)?),
            preview_json,
            expires_at_ms: Some(expires_at_ms as i64),
            created_at: now_rfc3339(),
        })?;
        let receipt = ConnectorOperationReceipt {
            operation_id: operation_id.clone(),
            idempotency_key,
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
        let ledger = ledger(ctx)?;
        let row = ledger
            .get(operation_id)?
            .ok_or("connector draft is missing or expired")?;
        require_same_session(&row.session_id, &ctx.session_id)?;
        if operation_expired(&row, now_ms()) {
            return Err("connector draft is missing or expired".to_string());
        }
        let preview = parse_stored_preview(&row)?;
        // 保留 receipt.confirm 的状态/哈希语义校验（精确错误消息）；
        // 账本的原子 UPDATE 是并发守卫（前驱 + 哈希双重条件）。
        let mut receipt = receipt_of(&row, &preview);
        receipt.confirm(preview_sha256)?;
        ledger.mark_confirmed(operation_id, preview_sha256, &now_rfc3339())?;
        Ok(json!({
            "success": true,
            "state": "confirmed",
            "operation_id": operation_id,
            "preview_sha256": preview_sha256,
            "expires_at_ms": row.expires_at_ms,
            "receipt": receipt,
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
        // 向后兼容：模型仍可能携带旧约定的幂等键——忽略并 warn，
        // 权威键是 draft 时系统生成并持久化的那把。
        if let Some(model_key) = args
            .get("idempotency_key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            log::warn!(
                "[ConnectorToolExecutor] ignoring model-provided idempotency_key '{}' for {}; \
                 the system-generated key from draft is authoritative",
                model_key,
                operation_id
            );
        }

        let ledger = ledger(ctx)?;
        let row = ledger
            .get(&operation_id)?
            .ok_or("connector draft is missing or expired")?;
        require_same_session(&row.session_id, &ctx.session_id)?;
        if row.preview_sha256.as_deref() != Some(preview_sha256.as_str()) {
            return Err("preview_sha256 does not match the confirmed operation".to_string());
        }

        match row.state {
            ConnectorOperationState::Committed => {
                // 幂等重放：直接返回既有结果，不重复调 provider
                let evidence = row
                    .evidence_json
                    .as_deref()
                    .ok_or("committed connector operation is missing its evidence")?;
                let mut output: Value = serde_json::from_str(evidence).map_err(|error| {
                    format!("failed to parse committed operation evidence: {}", error)
                })?;
                output["idempotent_replay"] = json!(true);
                return Ok(output);
            }
            ConnectorOperationState::Submitting => {
                return Err(
                    "connector operation with this idempotency_key is already in progress"
                        .to_string(),
                );
            }
            ConnectorOperationState::OutcomeUnknown => {
                return Err(
                    "connector operation outcome is unknown after a restart; \
                     it must be reconciled before any retry"
                        .to_string(),
                );
            }
            ConnectorOperationState::Failed => {
                return Err(format!(
                    "connector operation already failed: {}",
                    row.error.unwrap_or_else(|| "unknown provider error".to_string())
                ));
            }
            ConnectorOperationState::Draft => {
                return Err("connector operation must be confirmed before commit".to_string());
            }
            ConnectorOperationState::Confirmed => {}
        }

        if operation_expired(&row, now_ms()) {
            return Err("connector draft is missing or expired".to_string());
        }
        let preview = parse_stored_preview(&row)?;

        let registry =
            read_registry(ctx).map_err(|error| format!("capability_unavailable: {}", error))?;
        let (connector, capability) =
            find_capability(&registry, &preview.provider_id, &preview.capability)?;
        if row.capability_fingerprint.as_deref()
            != Some(capability_fingerprint(connector, capability)?.as_str())
        {
            return Err(
                "capability snapshot changed; create and confirm a new operation draft".to_string(),
            );
        }
        let mapped_tool = capability
            .mcp_tools
            .get(&preview.action)
            .ok_or_else(|| "capability_unavailable: action mapping was removed".to_string())?;

        // G04-P1：按 provider 类型构建投递通道。webhook 通道的 settings 解析
        // （白名单/secret，N06 strict、fail-closed）必须先于 submitting 落库——
        // 配置类错误属于 Permanent，不应把操作推进 submitting。
        let channel = if connector.provider == WEBHOOK_PROVIDER_KIND {
            let webhook_cfg = connector.webhook.as_ref().ok_or_else(|| {
                "capability_unavailable: webhook connector is missing its webhook config"
                    .to_string()
            })?;
            let main_db = ctx.main_db.as_ref().ok_or("Main database not available")?;
            let provider = WebhookProvider::from_settings(webhook_cfg, main_db)
                .map_err(|error| format!("connector provider is not ready: {}", error))?;
            let body = json!({
                "operation_id": operation_id.clone(),
                "idempotency_key": row.idempotency_key.clone(),
                "action": format!("{}:{}", preview.capability, preview.action),
                "recipients": preview.recipients.clone(),
                "timezone": preview.timezone.clone(),
                "conflicts": preview.conflicts.clone(),
                "destination": preview.destination.clone(),
                "acl": preview.acl.clone(),
                "attachments": preview.attachments.clone(),
                "payload": preview.payload.clone(),
                "expected_object_version": capability.snapshot.object_version.clone(),
            });
            CommitChannel::Webhook {
                provider,
                op: ProviderOperation {
                    operation_id: operation_id.clone(),
                    idempotency_key: row.idempotency_key.clone(),
                    action: format!("{}:{}", preview.capability, preview.action),
                    body,
                },
            }
        } else {
            let external_tool = if mapped_tool.starts_with("mcp_") {
                mapped_tool.clone()
            } else {
                format!("mcp_{}", mapped_tool)
            };
            let provider_args = json!({
                "_serverId": capability.mcp_server_id.clone(),
                "idempotency_key": row.idempotency_key.clone(),
                "recipients": preview.recipients.clone(),
                "timezone": preview.timezone.clone(),
                "conflicts": preview.conflicts.clone(),
                "destination": preview.destination.clone(),
                "acl": preview.acl.clone(),
                "attachments": preview.attachments.clone(),
                "payload": preview.payload.clone(),
                "expected_object_version": capability.snapshot.object_version.clone(),
            });
            CommitChannel::McpTool {
                external_tool,
                provider_args,
            }
        };
        let request_payload_hash = sha256_json(channel.payload_body())?;

        // 先落库再调用：submitting 持久化成功后才允许触达 provider。
        // 进程在此之后崩溃 → 重启对账收敛为 outcome_unknown。
        ledger
            .mark_submitting(&operation_id, &now_rfc3339(), &request_payload_hash)
            .map_err(|_| {
                "connector operation with this idempotency_key is already in progress".to_string()
            })?;

        let provider_result: Value = match channel {
            CommitChannel::McpTool {
                external_tool,
                provider_args,
            } => {
                let tool_ctx = ToolContext {
                    db: ctx.main_db.as_ref().map(|db| db.as_ref()),
                    mcp_client: None,
                    supports_tools: true,
                    window: ctx.tauri_window.as_ref(),
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
                    let message = format!(
                        "connector provider commit failed: {}",
                        error.unwrap_or_else(|| "unknown provider error".to_string())
                    );
                    if let Err(ledger_error) =
                        ledger.mark_failed(&operation_id, &now_rfc3339(), &message)
                    {
                        log::warn!(
                            "[ConnectorToolExecutor] failed to persist failed state for {}: {}",
                            operation_id,
                            ledger_error
                        );
                    }
                    return Err(message);
                }
                data.unwrap_or(Value::Null)
            }
            CommitChannel::Webhook { provider, op } => {
                match submit_webhook_with_retry(&provider, &op).await {
                    Ok(receipt) => receipt.result,
                    Err(error) => return Err(classify_submit_failure(&ledger, &operation_id, error)),
                }
            }
        };
        let object_handle = match provider_object_handle(
            connector,
            capability,
            &preview,
            &operation_id,
            &provider_result,
        ) {
            Ok(handle) => handle,
            Err(error) => {
                if let Err(ledger_error) =
                    ledger.mark_failed(&operation_id, &now_rfc3339(), &error)
                {
                    log::warn!(
                        "[ConnectorToolExecutor] failed to persist failed state for {}: {}",
                        operation_id,
                        ledger_error
                    );
                }
                return Err(error);
            }
        };
        let external_operation_id = provider_external_id(&provider_result);
        let resolved_at = now_rfc3339();
        let mut receipt = receipt_of(&row, &preview);
        receipt.object_handle_ids.push(object_handle.handle_id.clone());
        receipt.commit(resolved_at.clone())?;
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
        let evidence = serde_json::to_string(&output)
            .map_err(|error| format!("failed to persist connector evidence: {}", error))?;
        ledger.mark_committed(
            &operation_id,
            &resolved_at,
            external_operation_id.as_deref(),
            &evidence,
        )?;
        Ok(output)
    }
}

/// provider 返回值中的外部对象 id（committed 时持久化到账本
/// `external_operation_id`，供 provider lookup reconcile 使用）。
fn provider_external_id(provider_result: &Value) -> Option<String> {
    extract_external_operation_id(provider_result)
}

/// commit 的投递通道（G04-P1）：webhook = 真实 provider（HTTPS + HMAC），
/// 其余 provider 维持 MCP 工具桥。
enum CommitChannel {
    McpTool {
        external_tool: String,
        provider_args: Value,
    },
    Webhook {
        provider: WebhookProvider,
        op: ProviderOperation,
    },
}

impl CommitChannel {
    /// 实际发往 provider 的完整载荷（账本 `request_payload_hash` 的输入）。
    fn payload_body(&self) -> &Value {
        match self {
            Self::McpTool { provider_args, .. } => provider_args,
            Self::Webhook { op, .. } => &op.body,
        }
    }
}

/// webhook 提交：瞬时错误限次重试（同一幂等键，receiver 契约按键去重，
/// 重试不会二次执行）；永久/未知错误立即返回。
async fn submit_webhook_with_retry(
    provider: &WebhookProvider,
    op: &ProviderOperation,
) -> Result<crate::chat_v2::connector_providers::ProviderReceipt, ProviderError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match provider.submit(op).await {
            Err(error)
                if error.kind == ProviderErrorKind::Transient
                    && attempt < WEBHOOK_SUBMIT_MAX_ATTEMPTS =>
            {
                log::info!(
                    "[ConnectorToolExecutor] webhook submit for {} hit a transient error \
                     (attempt {}/{}); retrying with the same idempotency key",
                    op.operation_id,
                    attempt,
                    WEBHOOK_SUBMIT_MAX_ATTEMPTS
                );
                // 200ms / 400ms 短 backoff（提交路径是交互式工具调用）
                tokio::time::sleep(Duration::from_millis(200 * (1 << (attempt - 1)))).await;
            }
            other => break other,
        }
    }
}

/// submit 失败 → 账本收敛（G04-P1 分类语义）：
/// - Permanent：明确失败 → `failed`（终态，重试被拒绝）；
/// - Transient（重试耗尽）/ Unknown：请求可能已落地 → `outcome_unknown`，
///   禁止自动重试，由启动对账的 provider lookup 核销。
/// 返回给模型的错误消息已脱敏（provider 错误契约保证不含 secret）。
fn classify_submit_failure(
    ledger: &ConnectorLedger,
    operation_id: &str,
    error: ProviderError,
) -> String {
    match error.kind {
        ProviderErrorKind::Permanent => {
            let message = format!("connector provider commit failed: {}", error);
            if let Err(ledger_error) = ledger.mark_failed(operation_id, &now_rfc3339(), &message) {
                log::warn!(
                    "[ConnectorToolExecutor] failed to persist failed state for {}: {}",
                    operation_id,
                    ledger_error
                );
            }
            message
        }
        ProviderErrorKind::Transient | ProviderErrorKind::Unknown => {
            let note = format!(
                "submit outcome unknown ({}): {}",
                error.kind.as_str(),
                error.message
            );
            if let Err(ledger_error) = ledger.mark_outcome_unknown(operation_id, &note) {
                log::warn!(
                    "[ConnectorToolExecutor] failed to persist outcome_unknown for {}: {}",
                    operation_id,
                    ledger_error
                );
            }
            format!(
                "connector operation outcome is unknown ({}); \
                 it must be reconciled via provider lookup before any retry",
                error.message
            )
        }
    }
}

/// G04-P1 启动对账报告（全部计数来自账本原子迁移的实际影响行数）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// submitting → outcome_unknown 的崩溃收敛行数。
    pub converged_submitting: usize,
    /// lookup 命中远端记录 → committed 的行数。
    pub lookup_committed: usize,
    /// lookup 确认远端无记录 → failed(never_submitted) 的行数。
    pub lookup_never_submitted: usize,
    /// lookup 失败/不确定 → 保持 outcome_unknown 的行数（不误判）。
    pub still_unknown: usize,
    /// provider 无 lookup 能力（未配置/非真实 provider 类型）而跳过的行数。
    pub skipped_no_lookup: usize,
}

/// 启动对账（G04-P1 完整版）：先把遗留 submitting 收敛为 outcome_unknown，
/// 再逐行经 `provider.lookup(idempotency_key)` 查证真实结果：
///
/// | lookup 结果 | 账本迁移 | 语义 |
/// |---|---|---|
/// | `Ok(Some(outcome))` | → committed（补外部 id + lookup 证据） | 远端已执行 |
/// | `Ok(None)` | → failed("never_submitted: ...") | 远端确认无此记录 |
/// | `Err(Transient/Permanent/Unknown)` | 保持 outcome_unknown | 查询失败/不确定，绝不误判 |
///
/// 非 webhook provider（MCP 桥尚无 lookup 能力）与未配置 webhook 段的行
/// 跳过并保持原状。所有决策写 tracing/log 审计 + 账本行（状态/证据/错误）。
/// settings 读取为 N06 strict 语义：registry/白名单/secret 读失败即
/// fail-closed，不把"读失败"当"未配置"。
pub async fn reconcile_connector_operations_with_lookup(
    main_db: &Database,
    chat_v2_db: &Arc<ChatV2Database>,
) -> Result<ReconcileReport, String> {
    let ledger = ConnectorLedger::new(chat_v2_db.clone());
    let mut report = ReconcileReport {
        converged_submitting: ledger.reconcile_submitting_on_startup()?,
        ..Default::default()
    };
    let pending = ledger.list_pending_reconcile()?;
    if pending.is_empty() {
        return Ok(report);
    }
    let raw = main_db
        .get_secret(CONNECTOR_REGISTRY_KEY)
        .map_err(|error| format!("failed to read connector registry for reconcile: {}", error))?;
    let registry = parse_registry(raw.as_deref())?;

    for row in pending {
        let connector = registry
            .iter()
            .find(|entry| entry.id == row.provider_id && entry.provider == WEBHOOK_PROVIDER_KIND);
        let webhook_cfg = match connector.and_then(|entry| entry.webhook.as_ref()) {
            Some(cfg) => cfg,
            None => {
                // 无 lookup 能力的 provider（含 MCP 桥）：保持 outcome_unknown。
                report.skipped_no_lookup += 1;
                log::info!(
                    "[connector-reconcile] operation {} (provider '{}') skipped: \
                     no provider lookup capability",
                    row.operation_id,
                    row.provider_id
                );
                continue;
            }
        };
        let provider = match WebhookProvider::from_settings(webhook_cfg, main_db) {
            Ok(provider) => provider,
            Err(error) => {
                // 配置/secret 读取失败属于"不确定"：保持 outcome_unknown。
                report.still_unknown += 1;
                log::warn!(
                    "[connector-reconcile] operation {} (provider '{}') cannot build \
                     webhook provider ({}); left as outcome_unknown",
                    row.operation_id,
                    row.provider_id,
                    error
                );
                continue;
            }
        };
        match provider.lookup(&row.idempotency_key).await {
            Ok(Some(outcome)) => {
                let evidence = json!({
                    "reconciled_via": "provider_lookup",
                    "provider": provider.name(),
                    "operation_id": row.operation_id,
                    "external_operation_id": outcome.external_operation_id,
                    "receipt": outcome.receipt,
                });
                match ledger.mark_committed(
                    &row.operation_id,
                    &now_rfc3339(),
                    outcome.external_operation_id.as_deref(),
                    &evidence.to_string(),
                ) {
                    Ok(()) => {
                        report.lookup_committed += 1;
                        log::info!(
                            "[connector-reconcile] operation {} reconciled to committed \
                             via provider lookup (external id present: {})",
                            row.operation_id,
                            outcome.external_operation_id.is_some()
                        );
                    }
                    Err(ledger_error) => {
                        report.still_unknown += 1;
                        log::warn!(
                            "[connector-reconcile] operation {} lookup hit but commit failed: {}",
                            row.operation_id,
                            ledger_error
                        );
                    }
                }
            }
            Ok(None) => {
                let note = format!(
                    "never_submitted: provider '{}' has no record of this idempotency key",
                    provider.name()
                );
                match ledger.mark_failed(&row.operation_id, &now_rfc3339(), &note) {
                    Ok(()) => {
                        report.lookup_never_submitted += 1;
                        log::info!(
                            "[connector-reconcile] operation {} reconciled to failed: {}",
                            row.operation_id,
                            note
                        );
                    }
                    Err(ledger_error) => {
                        report.still_unknown += 1;
                        log::warn!(
                            "[connector-reconcile] operation {} lookup miss but fail-mark \
                             failed: {}",
                            row.operation_id,
                            ledger_error
                        );
                    }
                }
            }
            Err(error) => {
                // 查询失败/不确定：保持 outcome_unknown，绝不误判。
                report.still_unknown += 1;
                log::warn!(
                    "[connector-reconcile] operation {} lookup failed ({}: {}); \
                     left as outcome_unknown",
                    row.operation_id,
                    error.kind.as_str(),
                    error.message
                );
            }
        }
    }
    Ok(report)
}

fn provider_object_handle(
    connector: &ConnectorConfig,
    capability: &CapabilityConfig,
    preview: &DraftPreview,
    operation_id: &str,
    provider_result: &Value,
) -> Result<TaskObjectHandle, String> {
    let external_id = provider_external_id(provider_result);
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
                .map(|attachment| {
                    DerivedEdge::new(attachment.handle_id.clone(), "connector.deliver")
                })
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
    use std::sync::{Arc, Mutex};

    use crate::chat_v2::connector_ledger::reconcile_on_startup;
    use crate::chat_v2::database::ChatV2Database;
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use crate::tools::{Tool, ToolRegistry};

    const TEST_REGISTRY_JSON: &str = r#"[{
      "id":"google-work","provider":"google","oauth":{"connected":true,"grantedScopes":["mail.send","drive.write"],"accountId":"acct-1"},
      "capabilities":[{
        "name":"mail","requiredScopes":["mail.send"],"mcpServerId":"google-mcp",
        "mcpTools":{"send":"gmail_send"},
        "snapshot":{"version":"v1","observedAt":"2026-07-19T00:00:00Z","permissions":["send"],"objectVersion":"etag-1"}
      }]
    }]"#;

    fn configured_registry() -> Vec<ConnectorConfig> {
        parse_registry(Some(TEST_REGISTRY_JSON)).unwrap()
    }

    /// 主库（registry 经非敏感 settings 存储）+ 已迁移 chat_v2 库。
    fn setup_dbs() -> (
        tempfile::TempDir,
        Arc<crate::database::Database>,
        Arc<ChatV2Database>,
    ) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let main_db = crate::database::Database::new(&dir.path().join("main.db")).expect("main db");
        main_db
            .get_conn_safe()
            .expect("main conn")
            .execute_batch(
                "CREATE TABLE settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .expect("settings table");
        main_db
            .save_setting(CONNECTOR_REGISTRY_KEY, TEST_REGISTRY_JSON)
            .expect("seed connector registry");

        let mut coordinator =
            MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat_v2 migrations");
        let chat_db = ChatV2Database::new(dir.path()).expect("chat_v2 db");
        (dir, Arc::new(main_db), Arc::new(chat_db))
    }

    fn make_ctx(
        session_id: &str,
        main_db: &Arc<crate::database::Database>,
        chat_v2_db: &Arc<ChatV2Database>,
        tools: Vec<Arc<dyn Tool>>,
    ) -> ExecutionContext {
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            session_id.to_string(),
        ));
        ExecutionContext::new(
            session_id.to_string(),
            "msg-1".to_string(),
            "block-1".to_string(),
            emitter,
            Arc::new(ToolRegistry::new_with(tools)),
            None,
        )
        .with_main_db(Some(main_db.clone()))
        .with_chat_v2_db(Some(chat_v2_db.clone()))
    }

    fn draft_args() -> Value {
        json!({
            "provider_id":"google-work","capability":"mail","action":"send",
            "recipients":["a@example.com"],"timezone":"UTC","conflicts":[],
            "destination":null,"acl":{"access":"private"},"attachments":[],
            "payload":{"subject":"Hi"}
        })
    }

    fn ledger_row_for_test(expires_at_ms: i64) -> ConnectorOperation {
        ConnectorOperation {
            operation_id: "op".to_string(),
            session_id: "session-a".to_string(),
            provider_id: "p".to_string(),
            capability: Some("mail".to_string()),
            action: "send".to_string(),
            preview_sha256: Some("a".repeat(64)),
            request_payload_hash: None,
            idempotency_key: "k".to_string(),
            state: ConnectorOperationState::Draft,
            external_operation_id: None,
            account_id: None,
            capability_fingerprint: None,
            preview_json: None,
            expires_at_ms: Some(expires_at_ms),
            created_at: "2026-09-07T00:00:00Z".to_string(),
            confirmed_at: None,
            submitted_at: None,
            resolved_at: None,
            error: None,
            evidence_json: None,
        }
    }

    /// Mock provider 工具：记录调用到账本状态/幂等键，按配置返回成功或失败。
    struct MockProviderTool {
        chat_v2_db: Arc<ChatV2Database>,
        operation_id: String,
        observed_states: Arc<Mutex<Vec<String>>>,
        seen_idempotency_keys: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    #[async_trait]
    impl Tool for MockProviderTool {
        fn name(&self) -> &'static str {
            "mcp_gmail_send"
        }

        fn schema(&self) -> Value {
            json!({"type": "object"})
        }

        async fn invoke(
            &self,
            args: &Value,
            _ctx: &ToolContext<'_>,
        ) -> (
            bool,
            Option<Value>,
            Option<String>,
            Option<Value>,
            Option<Vec<crate::models::RagSourceInfo>>,
            Option<String>,
        ) {
            let state = ConnectorLedger::new(self.chat_v2_db.clone())
                .get(&self.operation_id)
                .ok()
                .flatten()
                .map(|row| row.state.as_str().to_string())
                .unwrap_or_else(|| "missing".to_string());
            self.observed_states.lock().unwrap().push(state);
            self.seen_idempotency_keys.lock().unwrap().push(
                args.get("idempotency_key")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
            if self.fail {
                (false, None, Some("mock provider boom".to_string()), None, None, None)
            } else {
                (
                    true,
                    Some(json!({"id": "msg-1", "thread_id": "thread-1"})),
                    None,
                    None,
                    None,
                    None,
                )
            }
        }
    }

    fn draft_and_confirm(
        executor: &ConnectorToolExecutor,
        ctx: &ExecutionContext,
    ) -> (String, String) {
        let draft = executor
            .execute_draft(&draft_args(), ctx)
            .expect("draft should succeed");
        let operation_id = draft["operation_id"].as_str().unwrap().to_string();
        let preview_sha256 = draft["preview_sha256"].as_str().unwrap().to_string();
        executor
            .execute_confirm(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                ctx,
            )
            .expect("confirm should succeed");
        (operation_id, preview_sha256)
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
        // 系统幂等键绑定 operation_id + preview_sha256，跨操作不可复用
        assert_ne!(
            system_idempotency_key("op-a", &"a".repeat(64)),
            system_idempotency_key("op-b", &"a".repeat(64))
        );
    }

    #[test]
    fn con_06_expired_drafts_are_rejected() {
        let mut row = ledger_row_for_test(1_000);
        assert!(operation_expired(&row, 1_000));
        assert!(operation_expired(&row, 1_001));
        assert!(!operation_expired(&row, 999));
        row.expires_at_ms = None;
        assert!(!operation_expired(&row, u64::MAX), "no TTL means no expiry");
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

    // ========================================================================
    // G04-P0：持久账本 + 状态机 + 系统幂等键 + outcome_unknown
    // ========================================================================

    #[test]
    fn g04_draft_persists_to_ledger_with_system_idempotency_key() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let executor = ConnectorToolExecutor::new();

        let draft = executor.execute_draft(&draft_args(), &ctx).expect("draft");
        assert_eq!(draft["state"], json!("draft"));
        let operation_id = draft["operation_id"].as_str().unwrap();
        let preview_sha256 = draft["preview_sha256"].as_str().unwrap();

        let ledger = ConnectorLedger::new(chat_db.clone());
        let row = ledger.get(operation_id).unwrap().expect("ledger row");
        assert_eq!(row.state, ConnectorOperationState::Draft);
        assert_eq!(row.session_id, "session-a");
        assert_eq!(row.provider_id, "google-work");
        assert_eq!(row.account_id.as_deref(), Some("acct-1"));
        assert_eq!(
            row.idempotency_key,
            system_idempotency_key(operation_id, preview_sha256),
            "draft 时系统生成确定性幂等键"
        );
        assert_eq!(
            draft["receipt"]["idempotencyKey"].as_str().unwrap(),
            row.idempotency_key,
            "receipt 携带系统幂等键"
        );
        assert!(row.capability_fingerprint.is_some());
        assert!(row.preview_json.is_some());
    }

    #[tokio::test]
    async fn g04_commit_persists_submitting_before_provider_call() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);

        let observed_states = Arc::new(Mutex::new(Vec::new()));
        let seen_keys = Arc::new(Mutex::new(Vec::new()));
        let mock = Arc::new(MockProviderTool {
            chat_v2_db: chat_db.clone(),
            operation_id: operation_id.clone(),
            observed_states: observed_states.clone(),
            seen_idempotency_keys: seen_keys.clone(),
            fail: false,
        });
        let commit_ctx = make_ctx("session-a", &main_db, &chat_db, vec![mock]);
        let output = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &commit_ctx,
            )
            .await
            .expect("commit should succeed");

        assert_eq!(output["state"], json!("committed"));
        assert_eq!(output["idempotent_replay"], json!(false));
        // 关键不变量：provider 被调用时，账本已处于 submitting
        assert_eq!(
            observed_states.lock().unwrap().as_slice(),
            &["submitting".to_string()],
            "submitting 必须先于 provider 调用落库"
        );

        let row = ConnectorLedger::new(chat_db.clone())
            .get(&operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.state, ConnectorOperationState::Committed);
        assert_eq!(row.external_operation_id.as_deref(), Some("msg-1"));
        assert!(row.submitted_at.is_some());
        assert!(row.resolved_at.is_some());
        assert!(row.request_payload_hash.is_some());
        assert!(row.evidence_json.is_some());
    }

    #[tokio::test]
    async fn g04_duplicate_commit_replays_without_second_provider_call() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);

        let observed_states = Arc::new(Mutex::new(Vec::new()));
        let mock = Arc::new(MockProviderTool {
            chat_v2_db: chat_db.clone(),
            operation_id: operation_id.clone(),
            observed_states: observed_states.clone(),
            seen_idempotency_keys: Arc::new(Mutex::new(Vec::new())),
            fail: false,
        });
        let commit_ctx = make_ctx("session-a", &main_db, &chat_db, vec![mock]);
        let first = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &commit_ctx,
            )
            .await
            .expect("first commit");

        // 重复 commit（模型甚至带了不同的幂等键）→ 直接返回既有结果
        let second = executor
            .execute_commit(
                &json!({
                    "operation_id": operation_id,
                    "preview_sha256": preview_sha256,
                    "idempotency_key": "model-chosen-other-key"
                }),
                &commit_ctx,
            )
            .await
            .expect("replay should succeed");

        assert_eq!(first["idempotent_replay"], json!(false));
        assert_eq!(second["idempotent_replay"], json!(true));
        assert_eq!(second["operation_id"], first["operation_id"]);
        assert_eq!(second["object_handle"], first["object_handle"]);
        assert_eq!(
            observed_states.lock().unwrap().len(),
            1,
            "重复 commit 不得再次调用 provider"
        );
    }

    #[tokio::test]
    async fn g04_provider_failure_marks_failed_and_retry_blocked() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);

        let observed_states = Arc::new(Mutex::new(Vec::new()));
        let mock = Arc::new(MockProviderTool {
            chat_v2_db: chat_db.clone(),
            operation_id: operation_id.clone(),
            observed_states: observed_states.clone(),
            seen_idempotency_keys: Arc::new(Mutex::new(Vec::new())),
            fail: true,
        });
        let commit_ctx = make_ctx("session-a", &main_db, &chat_db, vec![mock]);
        let error = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &commit_ctx,
            )
            .await
            .expect_err("provider failure should propagate");
        assert!(error.contains("connector provider commit failed"));

        let ledger = ConnectorLedger::new(chat_db.clone());
        let row = ledger.get(&operation_id).unwrap().unwrap();
        assert_eq!(row.state, ConnectorOperationState::Failed);
        assert!(row.error.as_deref().unwrap().contains("mock provider boom"));
        assert!(row.resolved_at.is_some());

        // failed 是终态：重试被拒绝且不再调用 provider
        let retry = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &commit_ctx,
            )
            .await
            .expect_err("failed operation must not retry");
        assert!(retry.contains("already failed"));
        assert_eq!(observed_states.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn g04_submitting_survives_restart_as_outcome_unknown_and_commit_refused() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);

        // 模拟进程在 provider 调用期间崩溃：submitting 已落库，无后续更新
        let ledger = ConnectorLedger::new(chat_db.clone());
        ledger
            .mark_submitting(&operation_id, &now_rfc3339(), "payload-hash")
            .unwrap();

        // 重启对账：submitting → outcome_unknown
        assert_eq!(reconcile_on_startup(&chat_db).unwrap(), 1);
        assert_eq!(
            ledger.get(&operation_id).unwrap().unwrap().state,
            ConnectorOperationState::OutcomeUnknown
        );

        // outcome_unknown 禁止自动重试（重复执行比标记未知更危险）
        let error = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &ctx,
            )
            .await
            .expect_err("outcome_unknown must refuse commit");
        assert!(error.contains("outcome is unknown"));
    }

    #[tokio::test]
    async fn g04_model_idempotency_key_is_ignored() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);
        let system_key = ConnectorLedger::new(chat_db.clone())
            .get(&operation_id)
            .unwrap()
            .unwrap()
            .idempotency_key;

        let seen_keys = Arc::new(Mutex::new(Vec::new()));
        let mock = Arc::new(MockProviderTool {
            chat_v2_db: chat_db.clone(),
            operation_id: operation_id.clone(),
            observed_states: Arc::new(Mutex::new(Vec::new())),
            seen_idempotency_keys: seen_keys.clone(),
            fail: false,
        });
        let commit_ctx = make_ctx("session-a", &main_db, &chat_db, vec![mock]);
        executor
            .execute_commit(
                &json!({
                    "operation_id": operation_id,
                    "preview_sha256": preview_sha256,
                    "idempotency_key": "model-chosen-key"
                }),
                &commit_ctx,
            )
            .await
            .expect("commit should succeed");

        assert_eq!(
            seen_keys.lock().unwrap().as_slice(),
            &[system_key],
            "provider 必须收到系统幂等键，模型提供的键被忽略"
        );
    }

    #[tokio::test]
    async fn g04_capability_fingerprint_recheck_still_blocks_commit() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());
        let (operation_id, preview_sha256) = draft_and_confirm(&executor, &ctx);

        // 确认后能力快照变化（换账号/撤权/版本变化）→ commit 必须拒绝
        let changed_registry = TEST_REGISTRY_JSON.replace(r#""version":"v1""#, r#""version":"v2""#);
        main_db
            .save_setting(CONNECTOR_REGISTRY_KEY, &changed_registry)
            .expect("update registry");

        let error = executor
            .execute_commit(
                &json!({"operation_id": operation_id, "preview_sha256": preview_sha256}),
                &ctx,
            )
            .await
            .expect_err("stale capability fingerprint must block commit");
        assert!(error.contains("capability snapshot changed"));
        // 未进入 submitting：操作仍停在 confirmed，可修复后重试
        assert_eq!(
            ConnectorLedger::new(chat_db.clone())
                .get(&operation_id)
                .unwrap()
                .unwrap()
                .state,
            ConnectorOperationState::Confirmed
        );
    }

    #[tokio::test]
    async fn g04_expired_operation_cannot_confirm_or_commit() {
        let (_dir, main_db, chat_db) = setup_dbs();
        let executor = ConnectorToolExecutor::new();
        let ctx = make_ctx("session-a", &main_db, &chat_db, Vec::new());

        // 直接落库一个已过期的 draft（execute_draft 的 TTL clamp 最小 30s，
        // 测试经账本构造过期场景）
        let ledger = ConnectorLedger::new(chat_db.clone());
        let preview_sha256 = "a".repeat(64);
        ledger
            .insert_draft(&NewConnectorOperation {
                operation_id: "op-expired".to_string(),
                session_id: "session-a".to_string(),
                provider_id: "google-work".to_string(),
                capability: Some("mail".to_string()),
                action: "send".to_string(),
                preview_sha256: preview_sha256.clone(),
                idempotency_key: system_idempotency_key("op-expired", &preview_sha256),
                account_id: None,
                capability_fingerprint: None,
                preview_json: serde_json::to_string(&parse_draft(&draft_args()).unwrap()).unwrap(),
                expires_at_ms: Some(1),
                created_at: now_rfc3339(),
            })
            .unwrap();

        let error = executor
            .execute_confirm(
                &json!({"operation_id": "op-expired", "preview_sha256": preview_sha256}),
                &ctx,
            )
            .expect_err("expired draft must not confirm");
        assert!(error.contains("missing or expired"));

        // 已过期的 confirmed 操作同样不得 commit
        let mut row = ledger_row_for_test(1);
        row.operation_id = "op-expired-confirmed".to_string();
        row.state = ConnectorOperationState::Confirmed;
        row.preview_json = Some(
            serde_json::to_string(&parse_draft(&draft_args()).unwrap()).unwrap(),
        );
        ledger
            .insert_draft(&NewConnectorOperation {
                operation_id: row.operation_id.clone(),
                session_id: "session-a".to_string(),
                provider_id: "google-work".to_string(),
                capability: Some("mail".to_string()),
                action: "send".to_string(),
                preview_sha256: preview_sha256.clone(),
                idempotency_key: system_idempotency_key(&row.operation_id, &preview_sha256),
                account_id: None,
                capability_fingerprint: None,
                preview_json: row.preview_json.clone().unwrap(),
                expires_at_ms: Some(1),
                created_at: now_rfc3339(),
            })
            .unwrap();
        ledger
            .mark_confirmed(&row.operation_id, &preview_sha256, &now_rfc3339())
            .unwrap();
        let error = executor
            .execute_commit(
                &json!({"operation_id": row.operation_id, "preview_sha256": preview_sha256}),
                &ctx,
            )
            .await
            .expect_err("expired confirmed operation must not commit");
        assert!(error.contains("missing or expired"));
    }

    #[test]
    fn g04_draft_requires_ledger() {
        // 无 chat_v2 库时 fail-close（账本为权威，无库即不可用）
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            "session-a".to_string(),
        ));
        let ctx = ExecutionContext::new(
            "session-a".to_string(),
            "msg-1".to_string(),
            "block-1".to_string(),
            emitter,
            Arc::new(ToolRegistry::new_with(Vec::new())),
            None,
        );
        let executor = ConnectorToolExecutor::new();
        let error = executor
            .execute_draft(&draft_args(), &ctx)
            .expect_err("draft without ledger must fail");
        assert!(error.contains("ledger is unavailable"));
    }
}
