//! Agent-facing backup and sync tools.
//!
//! The executor calls data-governance services directly. Cloud credentials are
//! never accepted as tool arguments: `sync_run` loads the reviewed non-secret
//! configuration from the backend SSOT and hydrates credentials from
//! `secure_store` immediately before the real sync call.

use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::backup_job_manager::{
    BackupJobManagerState, BackupJobPhase, BackupJobStatus, BackupJobSummary,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::cloud_config_commands::{
    load_cloud_config_ssot, load_hydrated_cloud_config_ssot, CloudConfigSsotError,
};

const BACKUP_STATUS_TOOL: &str = "backup_status";
const BACKUP_JOB_STATUS_TOOL: &str = "backup_job_status";
const BACKUP_CREATE_TOOL: &str = "backup_create";
const SYNC_STATUS_TOOL: &str = "sync_status";
const SYNC_RUN_TOOL: &str = "sync_run";

const MAX_PAGE_SIZE: usize = 20;
const MAX_TOOL_TEXT_CHARS: usize = 2_000;
const MAX_ASSET_TYPES: usize = 10;
const SYNC_TIMEOUT: Duration = Duration::from_secs(600);
const JOB_RECEIPT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_JOB_RECEIPTS: usize = 256;

const ALLOWED_ASSET_TYPES: &[&str] = &[
    "images",
    "notes_assets",
    "documents",
    "vfs_blobs",
    "subjects",
    "workspaces",
    "audio",
    "videos",
    "textbooks",
    "pdf_ocr_sessions",
];

const ALLOWED_SYNC_DIRECTIONS: &[&str] = &["upload", "download", "bidirectional"];
const ALLOWED_SYNC_STRATEGIES: &[&str] = &["keep_local", "use_cloud", "keep_latest"];

#[derive(Debug, Clone)]
struct BackupJobReceipt {
    job_id: String,
    created_at: Instant,
}

static BACKUP_JOB_RECEIPTS: LazyLock<Mutex<VecDeque<BackupJobReceipt>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

pub struct DataGovernanceToolExecutor;

impl DataGovernanceToolExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_backup_status(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments)?;
        ensure_allowed_keys(arguments, &["page", "page_size"])?;
        let (page, page_size, offset) = pagination(arguments)?;

        let app = ctx.window_ref().app_handle().clone();
        let mut backups =
            crate::data_governance::commands_backup::data_governance_get_backup_list(app)
                .await
                .map_err(|error| {
                    governance_error(
                        "BACKUP_STATUS_FAILED",
                        error,
                        "Open Settings > Data Governance to inspect the backup catalog.",
                        true,
                    )
                })?;
        backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));

        let total = backups.len();
        let items = backups
            .into_iter()
            .skip(offset)
            .take(page_size)
            .map(|backup| {
                json!({
                    "backup_id": bounded_text(&backup.path),
                    "created_at": bounded_text(&backup.created_at),
                    "size_bytes": backup.size,
                    "backup_type": bounded_text(&backup.backup_type),
                    "databases": backup
                        .databases
                        .iter()
                        .map(|database| bounded_text(database))
                        .collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        let count = items.len();

        Ok(json!({
            "success": true,
            "scope": "local_backup_catalog",
            "backups": items,
            "count": count,
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": offset.saturating_add(count) < total,
        }))
    }

    async fn execute_backup_create(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments)?;
        ensure_allowed_keys(arguments, &["include_assets", "asset_types"])?;
        let include_assets = optional_bool(arguments, "include_assets")?.unwrap_or(false);
        let asset_types = parse_asset_types(arguments, include_assets)?;

        let app = ctx.window_ref().app_handle().clone();
        let backup_job_state = app.try_state::<BackupJobManagerState>().ok_or_else(|| {
            governance_error(
                "BACKUP_SERVICE_UNAVAILABLE",
                "The backup job manager is not initialized.",
                "Wait for application startup to finish and retry.",
                true,
            )
        })?;

        let response = crate::data_governance::commands_backup::data_governance_run_backup(
            app.clone(),
            backup_job_state,
            Some("full".to_string()),
            None,
            Some(include_assets),
            asset_types,
        )
        .await
        .map_err(|error| {
            governance_error(
                "BACKUP_CREATE_FAILED",
                error,
                "Check Data Governance maintenance state and retry.",
                true,
            )
        })?;

        remember_backup_job(&response.job_id, Instant::now());

        // Deliberately return only the asynchronous receipt. Completion must be
        // observed through backup_job_status; queued is never reported as done.
        Ok(json!({
            "status": "queued",
            "job_id": response.job_id,
        }))
    }

    fn execute_backup_job_status(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments)?;
        ensure_allowed_keys(arguments, &["job_id"])?;
        let job_id = required_job_id(arguments)?;

        let app = ctx.window_ref().app_handle().clone();
        let manager = app.try_state::<BackupJobManagerState>().ok_or_else(|| {
            governance_error(
                "BACKUP_SERVICE_UNAVAILABLE",
                "The backup job manager is not initialized.",
                "Wait for application startup to finish and retry.",
                true,
            )
        })?;

        if let Some(summary) = manager.inner().inner().get_job(&job_id) {
            return Ok(json!({
                "success": true,
                "lookup": "found",
                "job": backup_job_summary_json(summary),
            }));
        }

        let lookup = if was_agent_backup_job(&job_id, Instant::now()) {
            "expired"
        } else {
            "not_found"
        };
        Ok(json!({
            "success": true,
            "lookup": lookup,
            "job_id": job_id,
            "terminal_result_retention_seconds": 60,
        }))
    }

    async fn execute_sync_status(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments)?;
        ensure_allowed_keys(arguments, &[])?;

        let status = crate::data_governance::commands_sync::data_governance_get_sync_status(
            ctx.window_ref().app_handle().clone(),
        )
        .await
        .map_err(|error| {
            governance_error(
                "SYNC_STATUS_FAILED",
                error,
                "Wait for maintenance or migration work to finish and retry.",
                true,
            )
        })?;

        let (cloud_configured, config_warning) = match ctx.main_db.as_deref() {
            Some(database) => {
                match load_cloud_config_ssot(database) {
                    Ok(_) => (true, None),
                    Err(CloudConfigSsotError::NotConfigured) => (
                        false,
                        Some(
                            "Cloud sync is not configured in the backend SSOT; configure it in Settings."
                                .to_string(),
                        ),
                    ),
                    Err(_) => (
                        false,
                        Some(
                            "The backend cloud configuration could not be validated; sync_run will fail closed."
                                .to_string(),
                        ),
                    ),
                }
            }
            None => (
                false,
                Some(
                    "The settings database is unavailable; cloud configuration cannot be observed."
                        .to_string(),
                ),
            ),
        };

        let mut warnings = vec![
            "This status reads local change logs only; it does not probe the cloud endpoint or prove cross-device consistency."
                .to_string(),
            "A global last-sync timestamp is not currently available; per-database timestamps are best-effort local observations."
                .to_string(),
        ];
        if let Some(warning) = config_warning {
            warnings.push(warning);
        }
        let missing_change_logs = status
            .databases
            .iter()
            .filter(|database| !database.has_change_log)
            .count();
        if missing_change_logs > 0 {
            warnings.push(format!(
                "{missing_change_logs} local database(s) do not expose a change log and are not represented in pending counts."
            ));
        }

        Ok(json!({
            "success": true,
            "observation_scope": "local_change_logs_only",
            "cloud_probed": false,
            "cloud_configured": cloud_configured,
            "has_pending_changes": status.has_pending_changes,
            "total_pending_changes": status.total_pending_changes,
            "total_synced_changes": status.total_synced_changes,
            "last_sync_at": status.last_sync_at,
            "databases": status.databases.into_iter().map(|database| json!({
                "id": bounded_text(&database.id),
                "has_change_log": database.has_change_log,
                "pending_changes": database.pending_changes,
                "synced_changes": database.synced_changes,
                "last_sync_at": database.last_sync_at,
            })).collect::<Vec<_>>(),
            "warnings": warnings,
        }))
    }

    async fn execute_sync_run(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments)?;
        ensure_allowed_keys(arguments, &["direction", "strategy"])?;
        let direction = required_enum(arguments, "direction", ALLOWED_SYNC_DIRECTIONS)?;
        let strategy = optional_enum(arguments, "strategy", ALLOWED_SYNC_STRATEGIES)?
            .unwrap_or_else(|| "keep_latest".to_string());

        let database = ctx.main_db.as_deref().ok_or_else(|| {
            governance_error(
                "CLOUD_CONFIG_UNAVAILABLE",
                "The settings database is unavailable.",
                "Retry after application startup completes.",
                true,
            )
        })?;
        let app = ctx.window_ref().app_handle().clone();
        let config =
            load_hydrated_cloud_config_ssot(&app, database).map_err(cloud_config_tool_error)?;

        let sync = crate::data_governance::commands_sync::data_governance_run_sync(
            app,
            direction.clone(),
            Some(config),
            Some(strategy.clone()),
        );
        let timed_sync = tokio::time::timeout(SYNC_TIMEOUT, sync);
        let response = if let Some(token) = ctx.cancellation_token() {
            tokio::select! {
                result = timed_sync => result.map_err(|_| sync_timeout_error())?,
                _ = token.cancelled() => {
                    return Err(governance_error(
                        "SYNC_CANCELLED",
                        "Cloud sync was cancelled before a terminal result was returned.",
                        "Check sync_status before deciding whether to retry; partial side effects may exist.",
                        false,
                    ));
                }
            }
        } else {
            timed_sync.await.map_err(|_| sync_timeout_error())?
        }
        .map_err(|error| {
            governance_error(
                "SYNC_FAILED",
                error,
                "Check cloud configuration and Data Governance status, then retry deliberately.",
                true,
            )
        })?;

        sync_execution_json(response, &strategy)
    }
}

impl Default for DataGovernanceToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for DataGovernanceToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            BACKUP_STATUS_TOOL
                | BACKUP_JOB_STATUS_TOOL
                | BACKUP_CREATE_TOOL
                | SYNC_STATUS_TOOL
                | SYNC_RUN_TOOL
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let output = match tool_name {
            BACKUP_STATUS_TOOL => self.execute_backup_status(&call.arguments, ctx).await,
            BACKUP_JOB_STATUS_TOOL => self.execute_backup_job_status(&call.arguments, ctx),
            BACKUP_CREATE_TOOL => self.execute_backup_create(&call.arguments, ctx).await,
            SYNC_STATUS_TOOL => self.execute_sync_status(&call.arguments, ctx).await,
            SYNC_RUN_TOOL => self.execute_sync_run(&call.arguments, ctx).await,
            _ => Err(governance_error(
                "UNKNOWN_TOOL",
                format!("Unsupported data-governance tool: {tool_name}"),
                "Use a registered backup_* or sync_* tool.",
                false,
            )),
        };
        let duration_ms = started.elapsed().as_millis() as u64;

        let result = match output {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
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

        if let Err(error) = ctx.save_tool_block(&result) {
            log::warn!(
                "[DataGovernanceToolExecutor] failed to persist tool block: {}",
                error
            );
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            BACKUP_CREATE_TOOL | SYNC_RUN_TOOL => ToolSensitivity::High,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            BACKUP_STATUS_TOOL | BACKUP_JOB_STATUS_TOOL | SYNC_STATUS_TOOL => {
                ToolConcurrency::ReadOnly
            }
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "DataGovernanceToolExecutor"
    }
}

fn governance_error(code: &str, message: impl Into<String>, hint: &str, retryable: bool) -> String {
    json!({
        "code": code,
        "message": bounded_text(&message.into()),
        "message_key": format!("chat.tools.data_governance.errors.{}", code.to_ascii_lowercase()),
        "hint": hint,
        "retryable": retryable,
    })
    .to_string()
}

fn sync_timeout_error() -> String {
    governance_error(
        "SYNC_TIMEOUT",
        "Cloud sync did not return a terminal result within 600 seconds.",
        "Check sync_status before retrying; the backend may have applied partial changes.",
        true,
    )
}

fn cloud_config_tool_error(error: CloudConfigSsotError) -> String {
    match error {
        CloudConfigSsotError::NotConfigured => governance_error(
            "CLOUD_CONFIG_NOT_CONFIGURED",
            "Cloud sync is not configured in the backend SSOT.",
            "Configure Cloud Storage in Settings; credentials cannot be supplied to this tool.",
            false,
        ),
        CloudConfigSsotError::Invalid(_) => governance_error(
            "CLOUD_CONFIG_INVALID",
            "The backend non-secret cloud configuration failed validation.",
            "Open Cloud Storage Settings and save the configuration again.",
            false,
        ),
        CloudConfigSsotError::Storage(_) => governance_error(
            "CLOUD_CONFIG_UNAVAILABLE",
            "The backend cloud configuration could not be read.",
            "Retry after application storage becomes available.",
            true,
        ),
        CloudConfigSsotError::CredentialsUnavailable(_) => governance_error(
            "CLOUD_CREDENTIALS_UNAVAILABLE",
            "The secure credential store does not contain complete credentials for the configured provider.",
            "Re-enter cloud credentials in Settings; credentials cannot be supplied to this tool.",
            false,
        ),
    }
}

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_TOOL_TEXT_CHARS).collect()
}

fn arguments_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments.as_object().ok_or_else(|| {
        governance_error(
            "INVALID_ARGUMENT",
            "Tool arguments must be a JSON object.",
            "Correct the tool arguments and retry.",
            false,
        )
    })
}

fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(field) = arguments
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(governance_error(
            "INVALID_ARGUMENT",
            format!("Unknown field '{field}'; additional properties are not allowed."),
            "Remove unsupported fields. Cloud configuration and credentials must be configured in Settings.",
            false,
        ));
    }
    Ok(())
}

fn optional_bool(arguments: &Map<String, Value>, field: &str) -> Result<Option<bool>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(governance_error(
            "INVALID_ARGUMENT",
            format!("'{field}' must be a boolean."),
            "Correct the tool arguments and retry.",
            false,
        )),
    }
}

fn positive_integer(
    arguments: &Map<String, Value>,
    field: &str,
    default: usize,
    maximum: Option<usize>,
) -> Result<usize, String> {
    let value = match arguments.get(field) {
        None | Some(Value::Null) => default as u64,
        Some(value) => value.as_u64().ok_or_else(|| {
            governance_error(
                "INVALID_ARGUMENT",
                format!("'{field}' must be a positive integer."),
                "Correct the pagination arguments and retry.",
                false,
            )
        })?,
    };
    if value == 0 || maximum.is_some_and(|maximum| value > maximum as u64) {
        return Err(governance_error(
            "INVALID_ARGUMENT",
            format!("'{field}' must be in 1..={}", maximum.unwrap_or(usize::MAX)),
            "Correct the pagination arguments and retry.",
            false,
        ));
    }
    usize::try_from(value).map_err(|_| {
        governance_error(
            "INVALID_ARGUMENT",
            format!("'{field}' is out of range."),
            "Use a smaller pagination value.",
            false,
        )
    })
}

fn pagination(arguments: &Map<String, Value>) -> Result<(usize, usize, usize), String> {
    let page = positive_integer(arguments, "page", 1, None)?;
    let page_size = positive_integer(arguments, "page_size", MAX_PAGE_SIZE, Some(MAX_PAGE_SIZE))?;
    let offset = page
        .checked_sub(1)
        .and_then(|page| page.checked_mul(page_size))
        .ok_or_else(|| {
            governance_error(
                "INVALID_ARGUMENT",
                "Pagination offset is out of range.",
                "Use a smaller page number.",
                false,
            )
        })?;
    Ok((page, page_size, offset))
}

fn parse_asset_types(
    arguments: &Map<String, Value>,
    include_assets: bool,
) -> Result<Option<Vec<String>>, String> {
    let Some(value) = arguments.get("asset_types") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !include_assets {
        return Err(governance_error(
            "INVALID_ARGUMENT",
            "'asset_types' requires include_assets=true.",
            "Enable asset backup or omit asset_types.",
            false,
        ));
    }
    let values = value.as_array().ok_or_else(|| {
        governance_error(
            "INVALID_ARGUMENT",
            "'asset_types' must be an array of strings.",
            "Correct the tool arguments and retry.",
            false,
        )
    })?;
    if values.is_empty() || values.len() > MAX_ASSET_TYPES {
        return Err(governance_error(
            "INVALID_ARGUMENT",
            format!("'asset_types' must contain 1..={MAX_ASSET_TYPES} entries."),
            "Omit asset_types to include all supported assets.",
            false,
        ));
    }

    let mut seen = HashSet::with_capacity(values.len());
    let mut parsed = Vec::with_capacity(values.len());
    for value in values {
        let value = value.as_str().ok_or_else(|| {
            governance_error(
                "INVALID_ARGUMENT",
                "Every asset type must be a string.",
                "Use only documented asset type IDs.",
                false,
            )
        })?;
        if !ALLOWED_ASSET_TYPES.contains(&value) {
            return Err(governance_error(
                "INVALID_ARGUMENT",
                format!("Unsupported asset type '{value}'."),
                "Use one of the documented asset type IDs.",
                false,
            ));
        }
        if !seen.insert(value) {
            return Err(governance_error(
                "INVALID_ARGUMENT",
                format!("Duplicate asset type '{value}'."),
                "Remove duplicate entries and retry.",
                false,
            ));
        }
        parsed.push(value.to_string());
    }
    Ok(Some(parsed))
}

fn required_enum(
    arguments: &Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<String, String> {
    let value = arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            governance_error(
                "INVALID_ARGUMENT",
                format!("'{field}' is required and must be a string."),
                "Correct the tool arguments and retry.",
                false,
            )
        })?;
    if !allowed.contains(&value) {
        return Err(governance_error(
            "INVALID_ARGUMENT",
            format!("Unsupported {field} '{value}'."),
            "Use one of the documented enum values.",
            false,
        ));
    }
    Ok(value.to_string())
}

fn optional_enum(
    arguments: &Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_enum(arguments, field, allowed).map(Some),
    }
}

fn required_job_id(arguments: &Map<String, Value>) -> Result<String, String> {
    let value = arguments
        .get("job_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            governance_error(
                "INVALID_ARGUMENT",
                "'job_id' is required and must be a UUID string.",
                "Use the job_id returned by backup_create.",
                false,
            )
        })?;
    uuid::Uuid::parse_str(value).map_err(|_| {
        governance_error(
            "INVALID_ARGUMENT",
            "'job_id' must be a valid UUID.",
            "Use the job_id returned by backup_create.",
            false,
        )
    })?;
    Ok(value.to_string())
}

fn backup_status_name(status: BackupJobStatus) -> &'static str {
    match status {
        BackupJobStatus::Queued => "queued",
        BackupJobStatus::Running => "running",
        BackupJobStatus::Completed => "completed",
        BackupJobStatus::Failed => "failed",
        BackupJobStatus::Cancelled => "cancelled",
    }
}

fn backup_phase_name(phase: BackupJobPhase) -> &'static str {
    match phase {
        BackupJobPhase::Queued => "queued",
        BackupJobPhase::Scan => "scan",
        BackupJobPhase::Checkpoint => "checkpoint",
        BackupJobPhase::Compress => "compress",
        BackupJobPhase::Verify => "verify",
        BackupJobPhase::Extract => "extract",
        BackupJobPhase::Replace => "replace",
        BackupJobPhase::Cleanup => "cleanup",
        BackupJobPhase::Completed => "completed",
        BackupJobPhase::Failed => "failed",
        BackupJobPhase::Cancelled => "cancelled",
    }
}

fn backup_job_summary_json(summary: BackupJobSummary) -> Value {
    let terminal = summary.status.is_terminal();
    let result = summary.result.map(|result| {
        json!({
            "success": result.success,
            "message": result.message.as_deref().map(bounded_text),
            "error": result.error.as_deref().map(bounded_text),
            "duration_ms": result.duration_ms,
        })
    });
    let terminal_result_available = terminal && result.is_some();

    json!({
        "job_id": summary.job_id,
        "status": backup_status_name(summary.status),
        "phase": backup_phase_name(summary.phase),
        "progress": summary.progress,
        "terminal": terminal,
        "message": summary.message.as_deref().map(bounded_text),
        "created_at": summary.created_at,
        "started_at": summary.started_at,
        "finished_at": summary.finished_at,
        "result": result,
        "terminal_result_available": terminal_result_available,
    })
}

fn remember_backup_job(job_id: &str, now: Instant) {
    let mut receipts = BACKUP_JOB_RECEIPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    receipts.retain(|receipt| now.saturating_duration_since(receipt.created_at) < JOB_RECEIPT_TTL);
    if receipts.iter().any(|receipt| receipt.job_id == job_id) {
        return;
    }
    while receipts.len() >= MAX_JOB_RECEIPTS {
        receipts.pop_front();
    }
    receipts.push_back(BackupJobReceipt {
        job_id: job_id.to_string(),
        created_at: now,
    });
}

fn was_agent_backup_job(job_id: &str, now: Instant) -> bool {
    let mut receipts = BACKUP_JOB_RECEIPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    receipts.retain(|receipt| now.saturating_duration_since(receipt.created_at) < JOB_RECEIPT_TTL);
    receipts.iter().any(|receipt| receipt.job_id == job_id)
}

fn sync_execution_json(
    response: crate::data_governance::commands_sync::SyncExecutionResponse,
    strategy: &str,
) -> Result<Value, String> {
    let warning = response
        .error_message
        .as_deref()
        .map(bounded_text)
        .filter(|warning| !warning.trim().is_empty());
    let has_warning = warning.is_some();
    let affected = response
        .changes_uploaded
        .saturating_add(response.changes_downloaded);
    let partial = response.skipped_changes > 0
        || (!response.success && affected > 0)
        || (response.success && has_warning);

    if !response.success && !partial {
        return Err(governance_error(
            "SYNC_FAILED",
            warning.unwrap_or_else(|| "Cloud sync returned an unsuccessful result.".to_string()),
            "Inspect sync_status and cloud settings before retrying.",
            true,
        ));
    }

    let warnings = warning.into_iter().collect::<Vec<_>>();
    let success = response.success && !partial;
    Ok(json!({
        "success": success,
        "status": if partial { "partial" } else { "success" },
        "partial": partial,
        "direction": response.direction,
        "strategy": strategy,
        "changes_uploaded": response.changes_uploaded,
        "changes_downloaded": response.changes_downloaded,
        "conflicts_detected": response.conflicts_detected,
        "skipped_changes": response.skipped_changes,
        "duration_ms": response.duration_ms,
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::commands_sync::SyncExecutionResponse;

    #[test]
    fn handles_only_governance_tools_with_expected_policy() {
        let executor = DataGovernanceToolExecutor::new();
        for tool in [
            "builtin-backup_status",
            "builtin-backup_job_status",
            "builtin-backup_create",
            "builtin-sync_status",
            "builtin-sync_run",
        ] {
            assert!(executor.can_handle(tool), "must handle {tool}");
        }
        assert!(!executor.can_handle("builtin-backup_restore"));
        assert_eq!(
            executor.sensitivity_level("builtin-backup_create"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-sync_run"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.concurrency_class("builtin-sync_status"),
            ToolConcurrency::ReadOnly
        );
    }

    #[test]
    fn pagination_defaults_and_caps_at_twenty() {
        assert_eq!(
            pagination(json!({}).as_object().unwrap()).unwrap(),
            (1, 20, 0)
        );
        assert_eq!(
            pagination(json!({"page": 2, "page_size": 20}).as_object().unwrap()).unwrap(),
            (2, 20, 20)
        );
        assert!(pagination(json!({"page_size": 21}).as_object().unwrap()).is_err());
        assert!(pagination(json!({"page": 0}).as_object().unwrap()).is_err());
    }

    #[test]
    fn backup_create_rejects_incremental_and_unreviewed_asset_values() {
        let incremental = json!({"backup_type": "incremental"});
        assert!(ensure_allowed_keys(
            incremental.as_object().unwrap(),
            &["include_assets", "asset_types"]
        )
        .is_err());

        let without_flag = json!({"asset_types": ["images"]});
        assert!(parse_asset_types(without_flag.as_object().unwrap(), false).is_err());

        let invalid = json!({"asset_types": ["secrets"]});
        assert!(parse_asset_types(invalid.as_object().unwrap(), true).is_err());

        let valid = json!({"asset_types": ["images", "notes_assets"]});
        assert_eq!(
            parse_asset_types(valid.as_object().unwrap(), true).unwrap(),
            Some(vec!["images".to_string(), "notes_assets".to_string()])
        );
    }

    #[test]
    fn sync_args_reject_cloud_config_credentials_and_manual_policy() {
        for forbidden in ["cloud_config", "credentials", "token", "password"] {
            let mut args = Map::new();
            args.insert("direction".to_string(), json!("upload"));
            args.insert(forbidden.to_string(), json!("secret"));
            assert!(ensure_allowed_keys(&args, &["direction", "strategy"]).is_err());
        }

        let manual = json!({"strategy": "manual"});
        assert!(optional_enum(
            manual.as_object().unwrap(),
            "strategy",
            ALLOWED_SYNC_STRATEGIES
        )
        .is_err());
    }

    #[test]
    fn skipped_or_warning_sync_is_never_reported_as_success() {
        let skipped = SyncExecutionResponse {
            success: true,
            direction: "upload".into(),
            changes_uploaded: 2,
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms: 10,
            device_id: "not-returned".into(),
            error_message: None,
            skipped_changes: 1,
        };
        let output = sync_execution_json(skipped, "keep_latest").unwrap();
        assert_eq!(output["success"], false);
        assert_eq!(output["status"], "partial");
        assert_eq!(output["skipped_changes"], 1);
        assert!(!output.to_string().contains("not-returned"));

        let warning = SyncExecutionResponse {
            success: true,
            direction: "download".into(),
            changes_uploaded: 0,
            changes_downloaded: 1,
            conflicts_detected: 0,
            duration_ms: 10,
            device_id: "not-returned".into(),
            error_message: Some("one file was not copied".into()),
            skipped_changes: 0,
        };
        let output = sync_execution_json(warning, "keep_latest").unwrap();
        assert_eq!(output["success"], false);
        assert_eq!(output["status"], "partial");
    }

    #[test]
    fn clean_sync_result_is_success_and_failure_without_effects_is_error() {
        let clean = SyncExecutionResponse {
            success: true,
            direction: "bidirectional".into(),
            changes_uploaded: 0,
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms: 10,
            device_id: "not-returned".into(),
            error_message: None,
            skipped_changes: 0,
        };
        let output = sync_execution_json(clean, "keep_latest").unwrap();
        assert_eq!(output["success"], true);
        assert_eq!(output["status"], "success");

        let failed = SyncExecutionResponse {
            success: false,
            direction: "upload".into(),
            changes_uploaded: 0,
            changes_downloaded: 0,
            conflicts_detected: 0,
            duration_ms: 10,
            device_id: "not-returned".into(),
            error_message: Some("connection refused".into()),
            skipped_changes: 0,
        };
        assert!(sync_execution_json(failed, "keep_latest").is_err());
    }

    #[test]
    fn issued_job_receipt_distinguishes_expired_from_unknown() {
        let known = uuid::Uuid::new_v4().to_string();
        let unknown = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        remember_backup_job(&known, now);
        assert!(was_agent_backup_job(&known, now));
        assert!(!was_agent_backup_job(&unknown, now));
    }

    #[test]
    fn governance_errors_are_bounded_and_structured() {
        let error = governance_error("TEST", "译".repeat(2_100), "hint", false);
        let parsed: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(parsed["code"], "TEST");
        assert_eq!(parsed["message"].as_str().unwrap().chars().count(), 2_000);
        assert_eq!(parsed["retryable"], false);
    }
}
