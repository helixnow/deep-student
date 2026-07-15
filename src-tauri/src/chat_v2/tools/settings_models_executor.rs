//! Safe settings and model-assignment tools for Chat V2.
//!
//! The generic settings table also stores credentials, OAuth state, MCP policy,
//! and approval policy. This executor therefore uses two allow-list layers:
//! callers may request only a known public prefix, and every returned row must
//! also match an exact public key. Model configurations are projected to a
//! deliberately small DTO so runtime credentials never enter tool output.

use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::database::Database;
use crate::llm_manager::ApiConfig;
use crate::models::ModelAssignments;

const SETTINGS_GET_TOOL: &str = "settings_get";
const SETTINGS_SET_TOOL: &str = "settings_set";
const MODEL_ASSIGNMENTS_GET_TOOL: &str = "model_assignments_get";
const MODEL_ASSIGNMENTS_SET_TOOL: &str = "model_assignments_set";

pub const SETTINGS_CHANGED_EVENT: &str = "chat_v2://settings_changed";
pub const MODEL_ASSIGNMENTS_CHANGED_EVENT: &str = "chat_v2://model_assignments_changed";

const MAX_TOOL_STRING_CHARS: usize = 2_000;
const MAX_MODEL_CONFIG_ID_CHARS: usize = 200;
const MAX_SETTING_ROWS: usize = 20;

const SETTINGS_GET_FIELDS: &[&str] = &["prefix"];
const SETTINGS_SET_FIELDS: &[&str] = &["key", "value"];
const MODEL_ASSIGNMENTS_GET_FIELDS: &[&str] = &["page", "page_size"];
const MODEL_ASSIGNMENTS_SET_FIELDS: &[&str] = &["slot", "config_id", "expected_current_config_id"];

/// Prefixes are the only values accepted by `settings_get`. The rows returned
/// from the database are filtered once more through `SAFE_SETTING_KEYS`.
const SAFE_READ_PREFIXES: &[&str] = &[
    "theme",
    "language",
    "enableNotifications",
    "maxChatHistory",
    "markdownRendererMode",
    "auto_save",
    "macos.",
    "sidebar.",
    "ui.",
    "thinking.",
    "textbook.",
];

const SAFE_SETTING_KEYS: &[&str] = &[
    "theme",
    "theme_palette",
    "language",
    "enableNotifications",
    "maxChatHistory",
    "markdownRendererMode",
    "auto_save",
    "macos.native_font_smoothing",
    "sidebar.translucent",
    "ui.pointer_cursor",
    "thinking.auto_collapse",
    "textbook.max_pages",
];

/// Compact, separator-insensitive fragments. This check deliberately errs on
/// the side of denial; the exact allow-list remains the final authority.
const SENSITIVE_IDENTIFIER_FRAGMENTS: &[&str] = &[
    "apikey",
    "token",
    "secret",
    "oauth",
    "password",
    "credential",
    "private",
    "access",
    "authorization",
    "cookie",
    "session",
    "mcp",
    "cloudstorage",
    "toolapproval",
    "permission",
];

pub struct SettingsModelsToolExecutor;

impl SettingsModelsToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn database<'a>(ctx: &'a ExecutionContext) -> Result<&'a Database, String> {
        ctx.main_db.as_deref().ok_or_else(|| {
            tool_error(
                "DEPENDENCY_UNAVAILABLE",
                "The settings database is unavailable.",
                "Retry after the application finishes starting.",
                true,
            )
        })
    }

    async fn execute_settings_get(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments, SETTINGS_GET_FIELDS)?;
        let prefix = required_string(arguments, "prefix", 128)?;
        reject_sensitive_identifier("prefix", &prefix)?;
        if !SAFE_READ_PREFIXES.contains(&prefix.as_str()) {
            return Err(tool_error(
                "SETTING_PREFIX_NOT_ALLOWED",
                format!("Setting prefix '{}' is not readable by the agent.", prefix),
                "Use one of the public prefixes declared by the settings tool schema.",
                false,
            ));
        }

        let rows = Self::database(ctx)?
            .get_settings_by_prefix(&prefix)
            .map_err(|error| {
                tool_error(
                    "SETTINGS_READ_FAILED",
                    format!("Failed to read public settings: {error}"),
                    "Retry after checking the local database.",
                    true,
                )
            })?;

        let mut settings = Vec::new();
        for (key, value, updated_at) in rows {
            // Second boundary: never trust the prefix query alone.
            if !is_safe_setting_key(&key) || contains_sensitive_identifier(&key) {
                continue;
            }
            let (value, truncated) = bounded_string(&value);
            let (updated_at, updated_at_truncated) = bounded_string(&updated_at);
            settings.push(json!({
                "key": key,
                "value": value,
                "updated_at": updated_at,
                "truncated": truncated || updated_at_truncated,
            }));
            if settings.len() == MAX_SETTING_ROWS {
                break;
            }
        }

        Ok(json!({
            "prefix": prefix,
            "settings": settings,
            "count": settings.len(),
            "message_key": "chat.tools.settings_models.settings_get.success",
        }))
    }

    async fn execute_settings_set(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments, SETTINGS_SET_FIELDS)?;
        let key = required_string(arguments, "key", 128)?;
        reject_sensitive_identifier("key", &key)?;
        if !is_safe_setting_key(&key) {
            return Err(tool_error(
                "SETTING_WRITE_NOT_ALLOWED",
                format!("Setting '{}' cannot be changed by the agent.", key),
                "Open Settings for credentials, permissions, MCP, sync, and other protected values.",
                false,
            ));
        }

        let raw_value = arguments
            .get("value")
            .ok_or_else(|| invalid_argument("value", "field is required"))?;
        let value = validate_setting_value(&key, raw_value)?;
        let database = Self::database(ctx)?;
        let previous_value = database.get_setting(&key).map_err(|error| {
            tool_error(
                "SETTINGS_READ_FAILED",
                format!("Failed to read the current setting: {error}"),
                "Retry after checking the local database.",
                true,
            )
        })?;
        let changed = previous_value.as_deref() != Some(value.as_str());

        if changed {
            database.save_setting(&key, &value).map_err(|error| {
                tool_error(
                    "SETTINGS_WRITE_FAILED",
                    format!("Failed to save the setting: {error}"),
                    "Retry after checking local storage availability.",
                    true,
                )
            })?;
        }

        let event_emitted = ctx
            .window
            .app_handle()
            .emit(
                SETTINGS_CHANGED_EVENT,
                json!({
                    "action": "set",
                    "key": key,
                }),
            )
            .is_ok();

        let (previous_value, previous_value_truncated) = match previous_value {
            Some(previous_value) => {
                let (previous_value, truncated) = bounded_string(&previous_value);
                (Some(previous_value), truncated)
            }
            None => (None, false),
        };

        Ok(json!({
            "key": key,
            "value": value,
            "previous_value": previous_value,
            "previous_value_truncated": previous_value_truncated,
            "changed": changed,
            "event": SETTINGS_CHANGED_EVENT,
            "event_emitted": event_emitted,
            "runtime_sync": if event_emitted { "event_emitted" } else { "persisted_refresh_pending" },
            "message_key": if event_emitted {
                "chat.tools.settings_models.settings_set.success"
            } else {
                "chat.tools.settings_models.settings_set.saved_refresh_pending"
            },
        }))
    }

    async fn execute_model_assignments_get(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments, MODEL_ASSIGNMENTS_GET_FIELDS)?;
        let page = optional_positive_integer(arguments, "page", 1, usize::MAX)?;
        let page_size = optional_positive_integer(arguments, "page_size", 20, 20)?;
        let manager = ctx.llm_manager.as_ref().ok_or_else(|| {
            tool_error(
                "DEPENDENCY_UNAVAILABLE",
                "The model manager is unavailable.",
                "Retry after the application finishes starting.",
                true,
            )
        })?;

        let assignments = manager.get_model_assignments().await.map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_READ_FAILED",
                format!("Failed to read model assignments: {error}"),
                "Retry after checking the model settings.",
                true,
            )
        })?;
        let configs = manager.get_api_configs().await.map_err(|error| {
            tool_error(
                "MODEL_DIRECTORY_READ_FAILED",
                format!("Failed to read the model directory: {error}"),
                "Retry after checking the model settings.",
                true,
            )
        })?;

        let total_models = configs.len();
        let start = page.saturating_sub(1).saturating_mul(page_size);
        let end = start.saturating_add(page_size).min(total_models);
        let available_models: Vec<Value> = if start < total_models {
            configs[start..end].iter().map(safe_model_json).collect()
        } else {
            Vec::new()
        };
        let mut assignments_value = serde_json::to_value(assignments).map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_SERIALIZE_FAILED",
                format!("Failed to serialize model assignments: {error}"),
                "Retry after repairing the model assignment settings.",
                false,
            )
        })?;
        let assignments_truncated = bound_json_strings(&mut assignments_value);

        Ok(json!({
            "assignments": assignments_value,
            "assignments_truncated": assignments_truncated,
            "available_models": available_models,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total_models,
                "has_more": end < total_models,
            },
            "message_key": "chat.tools.settings_models.model_assignments_get.success",
        }))
    }

    async fn execute_model_assignments_set(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let arguments = arguments_object(arguments, MODEL_ASSIGNMENTS_SET_FIELDS)?;
        let slot_raw = required_string(arguments, "slot", 128)?;
        let slot = AssignmentSlot::parse(&slot_raw)?;
        let config_id = required_nullable_string(arguments, "config_id")?;
        let expected_current_config_id =
            required_nullable_string(arguments, "expected_current_config_id")?;

        if let Some(config_id) = config_id.as_deref() {
            let manager = ctx.llm_manager.as_ref().ok_or_else(|| {
                tool_error(
                    "DEPENDENCY_UNAVAILABLE",
                    "The model manager is unavailable.",
                    "Retry after the application finishes starting.",
                    true,
                )
            })?;
            let configs = manager.get_api_configs().await.map_err(|error| {
                tool_error(
                    "MODEL_DIRECTORY_READ_FAILED",
                    format!("Failed to read the model directory: {error}"),
                    "Retry after checking the model settings.",
                    true,
                )
            })?;
            let config = configs
                .iter()
                .find(|config| config.id == config_id)
                .ok_or_else(|| {
                    tool_error(
                        "MODEL_NOT_FOUND",
                        format!("Model configuration '{}' does not exist.", config_id),
                        "Call model_assignments_get and choose an available model id.",
                        false,
                    )
                })?;
            validate_model_for_slot(slot, &ModelCapabilities::from(config))?;
        }

        let database = Self::database(ctx)?;
        let update = update_model_assignment_atomic(
            database,
            slot,
            config_id.clone(),
            expected_current_config_id.as_deref(),
        )?;

        let (previous_config_id, assignments, changed) = match update {
            AtomicAssignmentUpdate::Updated {
                previous_config_id,
                assignments,
                changed,
            } => (previous_config_id, assignments, changed),
            AtomicAssignmentUpdate::Conflict { current_config_id } => {
                let (current_config_id, current_config_id_truncated) =
                    bounded_optional_string(current_config_id);
                return Err(tool_error_with_fields(
                    "MODEL_ASSIGNMENT_CONFLICT",
                    "The model assignment changed after it was read.",
                    "Call model_assignments_get, inspect the current slot, and retry with that value as expected_current_config_id.",
                    false,
                    json!({
                        "slot": slot.as_str(),
                        "current_config_id": current_config_id,
                        "current_config_id_truncated": current_config_id_truncated,
                        "expected_current_config_id": expected_current_config_id,
                    }),
                ));
            }
        };

        let event_emitted = ctx
            .window
            .app_handle()
            .emit(
                MODEL_ASSIGNMENTS_CHANGED_EVENT,
                json!({
                    "action": "set",
                    "slot": slot.as_str(),
                }),
            )
            .is_ok();
        let mut assignments_value = serde_json::to_value(assignments).map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_SERIALIZE_FAILED",
                format!("Failed to serialize model assignments: {error}"),
                "Retry after repairing the model assignment settings.",
                false,
            )
        })?;
        let assignments_truncated = bound_json_strings(&mut assignments_value);

        let (previous_config_id, previous_config_id_truncated) =
            bounded_optional_string(previous_config_id);
        Ok(json!({
            "slot": slot.as_str(),
            "previous_config_id": previous_config_id,
            "previous_config_id_truncated": previous_config_id_truncated,
            "config_id": config_id,
            "assignments": assignments_value,
            "assignments_truncated": assignments_truncated,
            "changed": changed,
            "event": MODEL_ASSIGNMENTS_CHANGED_EVENT,
            "event_emitted": event_emitted,
            "runtime_sync": if event_emitted { "event_emitted" } else { "persisted_refresh_pending" },
            "message_key": if event_emitted {
                "chat.tools.settings_models.model_assignments_set.success"
            } else {
                "chat.tools.settings_models.model_assignments_set.saved_refresh_pending"
            },
        }))
    }
}

impl Default for SettingsModelsToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for SettingsModelsToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            SETTINGS_GET_TOOL
                | SETTINGS_SET_TOOL
                | MODEL_ASSIGNMENTS_GET_TOOL
                | MODEL_ASSIGNMENTS_SET_TOOL
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
            SETTINGS_GET_TOOL => self.execute_settings_get(&call.arguments, ctx).await,
            SETTINGS_SET_TOOL => self.execute_settings_set(&call.arguments, ctx).await,
            MODEL_ASSIGNMENTS_GET_TOOL => {
                self.execute_model_assignments_get(&call.arguments, ctx)
                    .await
            }
            MODEL_ASSIGNMENTS_SET_TOOL => {
                self.execute_model_assignments_set(&call.arguments, ctx)
                    .await
            }
            _ => Err(tool_error(
                "UNKNOWN_TOOL",
                format!("Unknown settings/model tool '{}'.", call.name),
                "Use one of the registered settings/model tools.",
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
                "[SettingsModelsToolExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            SETTINGS_SET_TOOL | MODEL_ASSIGNMENTS_SET_TOOL => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            SETTINGS_GET_TOOL | MODEL_ASSIGNMENTS_GET_TOOL => ToolConcurrency::ReadOnly,
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "SettingsModelsToolExecutor"
    }
}

fn tool_error(code: &str, message: impl Into<String>, hint: &str, retryable: bool) -> String {
    tool_error_with_fields(code, message, hint, retryable, json!({}))
}

fn tool_error_with_fields(
    code: &str,
    message: impl Into<String>,
    hint: &str,
    retryable: bool,
    fields: Value,
) -> String {
    let (message, message_truncated) = bounded_string(&message.into());
    let mut error = json!({
        "code": code,
        "message": message,
        "message_truncated": message_truncated,
        "message_key": format!(
            "chat.tools.settings_models.errors.{}",
            code.to_ascii_lowercase()
        ),
        "hint": hint,
        "retryable": retryable,
    });
    if let (Some(target), Some(extra)) = (error.as_object_mut(), fields.as_object()) {
        target.extend(extra.clone());
    }
    error.to_string()
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    tool_error(
        "INVALID_ARGUMENT",
        format!("Invalid '{}': {}", field, reason.into()),
        "Correct the tool arguments and retry.",
        false,
    )
}

fn arguments_object<'a>(
    arguments: &'a Value,
    allowed_fields: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    reject_sensitive_argument_fields(arguments)?;
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed_fields.contains(&field.as_str()))
    {
        return Err(invalid_argument(
            field,
            "unknown field; additional properties are not allowed",
        ));
    }
    Ok(object)
}

fn required_string(
    arguments: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<String, String> {
    let value = arguments
        .get(field)
        .ok_or_else(|| invalid_argument(field, "field is required"))?
        .as_str()
        .ok_or_else(|| invalid_argument(field, "expected a string"))?
        .trim();
    if value.is_empty() {
        return Err(invalid_argument(field, "must not be blank"));
    }
    if value.chars().count() > max_chars {
        return Err(invalid_argument(
            field,
            format!("must contain at most {max_chars} characters"),
        ));
    }
    Ok(value.to_string())
}

fn required_nullable_string(
    arguments: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, String> {
    let value = arguments
        .get(field)
        .ok_or_else(|| invalid_argument(field, "field is required and may be null"))?;
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| invalid_argument(field, "expected a string or null"))?
        .trim();
    if value.is_empty() {
        return Err(invalid_argument(
            field,
            "use null instead of a blank string",
        ));
    }
    if value.chars().count() > MAX_MODEL_CONFIG_ID_CHARS {
        return Err(invalid_argument(
            field,
            format!("must contain at most {MAX_MODEL_CONFIG_ID_CHARS} characters"),
        ));
    }
    Ok(Some(value.to_string()))
}

fn optional_positive_integer(
    arguments: &Map<String, Value>,
    field: &str,
    default: usize,
    maximum: usize,
) -> Result<usize, String> {
    let Some(value) = arguments.get(field) else {
        return Ok(default);
    };
    let value = value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value <= maximum)
        .ok_or_else(|| {
            invalid_argument(
                field,
                format!("expected an integer between 1 and {maximum}"),
            )
        })?;
    Ok(value)
}

fn compact_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn contains_sensitive_identifier(value: &str) -> bool {
    let compact = compact_identifier(value);
    SENSITIVE_IDENTIFIER_FRAGMENTS
        .iter()
        .any(|fragment| compact.contains(fragment))
}

fn reject_sensitive_identifier(field: &str, value: &str) -> Result<(), String> {
    if contains_sensitive_identifier(value) {
        return Err(tool_error(
            "SENSITIVE_SETTING_REJECTED",
            format!("'{}' targets a protected setting namespace.", field),
            "Credentials, OAuth, MCP, sync credentials, sessions, permissions, and approval policy are available only in Settings.",
            false,
        ));
    }
    Ok(())
}

fn reject_sensitive_argument_fields(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (key, nested) in object {
                if contains_sensitive_identifier(key) {
                    return Err(tool_error(
                        "SENSITIVE_FIELD_REJECTED",
                        format!("Argument field '{}' is protected.", key),
                        "Do not pass credentials, tokens, sessions, permissions, or approval policy to this tool.",
                        false,
                    ));
                }
                reject_sensitive_argument_fields(nested)?;
            }
        }
        Value::Array(values) => {
            for nested in values {
                reject_sensitive_argument_fields(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_safe_setting_key(key: &str) -> bool {
    SAFE_SETTING_KEYS.contains(&key) && !contains_sensitive_identifier(key)
}

fn validate_setting_value(key: &str, value: &Value) -> Result<String, String> {
    match key {
        "theme" => validated_enum(value, key, &["light", "dark", "auto"]),
        "theme_palette" => validated_enum(
            value,
            key,
            &[
                "default", "purple", "green", "orange", "pink", "teal", "muted", "paper", "custom",
            ],
        ),
        "language" => validated_enum(value, key, &["zh-CN", "en-US"]),
        "markdownRendererMode" => validated_enum(value, key, &["legacy", "enhanced"]),
        "enableNotifications"
        | "auto_save"
        | "macos.native_font_smoothing"
        | "sidebar.translucent"
        | "ui.pointer_cursor"
        | "thinking.auto_collapse" => value
            .as_bool()
            .map(|value| value.to_string())
            .ok_or_else(|| invalid_argument("value", format!("'{}' expects a boolean", key))),
        "maxChatHistory" => validated_integer(value, key, 10, 1_000),
        "textbook.max_pages" => validated_integer(value, key, 1, 50),
        _ => Err(tool_error(
            "SETTING_WRITE_NOT_ALLOWED",
            format!("Setting '{}' cannot be changed by the agent.", key),
            "Open Settings to change protected or unsupported settings.",
            false,
        )),
    }
}

fn validated_enum(value: &Value, key: &str, allowed: &[&str]) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid_argument("value", format!("'{}' expects a string", key)))?;
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(invalid_argument(
            "value",
            format!("'{}' accepts only: {}", key, allowed.join(", ")),
        ))
    }
}

fn validated_integer(
    value: &Value,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> Result<String, String> {
    let value = value
        .as_i64()
        .ok_or_else(|| invalid_argument("value", format!("'{}' expects an integer", key)))?;
    if !(minimum..=maximum).contains(&value) {
        return Err(invalid_argument(
            "value",
            format!("'{}' must be between {} and {}", key, minimum, maximum),
        ));
    }
    Ok(value.to_string())
}

fn bounded_string(value: &str) -> (String, bool) {
    let truncated = value.chars().count() > MAX_TOOL_STRING_CHARS;
    (
        value.chars().take(MAX_TOOL_STRING_CHARS).collect(),
        truncated,
    )
}

fn bounded_optional_string(value: Option<String>) -> (Option<String>, bool) {
    match value {
        Some(value) => {
            let (value, truncated) = bounded_string(&value);
            (Some(value), truncated)
        }
        None => (None, false),
    }
}

fn bound_json_strings(value: &mut Value) -> bool {
    match value {
        Value::String(text) => {
            let (bounded, truncated) = bounded_string(text);
            if truncated {
                *text = bounded;
            }
            truncated
        }
        Value::Array(values) => {
            let mut truncated = false;
            for value in values {
                truncated |= bound_json_strings(value);
            }
            truncated
        }
        Value::Object(object) => {
            let mut truncated = false;
            for value in object.values_mut() {
                truncated |= bound_json_strings(value);
            }
            truncated
        }
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssignmentSlot {
    Model2,
    ReviewAnalysis,
    AnkiCard,
    QbankAiGrading,
    Reranker,
    ChatTitle,
    ExamSheetOcr,
    Translation,
    VlReranker,
    MemoryDecision,
    VoiceInputAsr,
    ImageGeneration,
}

impl AssignmentSlot {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "model2_config_id" => Ok(Self::Model2),
            "review_analysis_model_config_id" => Ok(Self::ReviewAnalysis),
            "anki_card_model_config_id" => Ok(Self::AnkiCard),
            "qbank_ai_grading_model_config_id" => Ok(Self::QbankAiGrading),
            "reranker_model_config_id" => Ok(Self::Reranker),
            "chat_title_model_config_id" => Ok(Self::ChatTitle),
            "exam_sheet_ocr_model_config_id" => Ok(Self::ExamSheetOcr),
            "translation_model_config_id" => Ok(Self::Translation),
            "vl_reranker_model_config_id" => Ok(Self::VlReranker),
            "memory_decision_model_config_id" => Ok(Self::MemoryDecision),
            "voice_input_asr_model_config_id" => Ok(Self::VoiceInputAsr),
            "image_generation_model_config_id" => Ok(Self::ImageGeneration),
            _ => Err(tool_error(
                "MODEL_ASSIGNMENT_SLOT_NOT_ALLOWED",
                format!(
                    "Model assignment slot '{}' is not writable by the agent.",
                    value
                ),
                "Use a model slot declared by the model assignments tool schema.",
                false,
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Model2 => "model2_config_id",
            Self::ReviewAnalysis => "review_analysis_model_config_id",
            Self::AnkiCard => "anki_card_model_config_id",
            Self::QbankAiGrading => "qbank_ai_grading_model_config_id",
            Self::Reranker => "reranker_model_config_id",
            Self::ChatTitle => "chat_title_model_config_id",
            Self::ExamSheetOcr => "exam_sheet_ocr_model_config_id",
            Self::Translation => "translation_model_config_id",
            Self::VlReranker => "vl_reranker_model_config_id",
            Self::MemoryDecision => "memory_decision_model_config_id",
            Self::VoiceInputAsr => "voice_input_asr_model_config_id",
            Self::ImageGeneration => "image_generation_model_config_id",
        }
    }

    fn current<'a>(self, assignments: &'a ModelAssignments) -> Option<&'a str> {
        match self {
            Self::Model2 => assignments.model2_config_id.as_deref(),
            Self::ReviewAnalysis => assignments.review_analysis_model_config_id.as_deref(),
            Self::AnkiCard => assignments.anki_card_model_config_id.as_deref(),
            Self::QbankAiGrading => assignments.qbank_ai_grading_model_config_id.as_deref(),
            Self::Reranker => assignments.reranker_model_config_id.as_deref(),
            Self::ChatTitle => assignments.chat_title_model_config_id.as_deref(),
            Self::ExamSheetOcr => assignments.exam_sheet_ocr_model_config_id.as_deref(),
            Self::Translation => assignments.translation_model_config_id.as_deref(),
            Self::VlReranker => assignments.vl_reranker_model_config_id.as_deref(),
            Self::MemoryDecision => assignments.memory_decision_model_config_id.as_deref(),
            Self::VoiceInputAsr => assignments.voice_input_asr_model_config_id.as_deref(),
            Self::ImageGeneration => assignments.image_generation_model_config_id.as_deref(),
        }
    }

    fn set(self, assignments: &mut ModelAssignments, value: Option<String>) {
        match self {
            Self::Model2 => assignments.model2_config_id = value,
            Self::ReviewAnalysis => assignments.review_analysis_model_config_id = value,
            Self::AnkiCard => assignments.anki_card_model_config_id = value,
            Self::QbankAiGrading => assignments.qbank_ai_grading_model_config_id = value,
            Self::Reranker => assignments.reranker_model_config_id = value,
            Self::ChatTitle => assignments.chat_title_model_config_id = value,
            Self::ExamSheetOcr => assignments.exam_sheet_ocr_model_config_id = value,
            Self::Translation => assignments.translation_model_config_id = value,
            Self::VlReranker => assignments.vl_reranker_model_config_id = value,
            Self::MemoryDecision => assignments.memory_decision_model_config_id = value,
            Self::VoiceInputAsr => assignments.voice_input_asr_model_config_id = value,
            Self::ImageGeneration => assignments.image_generation_model_config_id = value,
        }
    }

    fn required_capability(self) -> &'static str {
        match self {
            Self::Reranker | Self::VlReranker => "reranker",
            Self::ExamSheetOcr => "multimodal",
            Self::VoiceInputAsr => "audio_transcription",
            Self::ImageGeneration => "image_generation",
            _ => "text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelCapabilities {
    enabled: bool,
    multimodal: bool,
    embedding: bool,
    reranker: bool,
    image_generation: bool,
    audio_transcription: bool,
    provider_id: Option<String>,
}

impl From<&ApiConfig> for ModelCapabilities {
    fn from(config: &ApiConfig) -> Self {
        Self {
            enabled: config.enabled,
            multimodal: config.is_multimodal,
            embedding: config.is_embedding,
            reranker: config.is_reranker,
            image_generation: config.is_image_generation,
            audio_transcription: is_audio_transcription_model(config),
            provider_id: provider_id(config),
        }
    }
}

fn validate_model_for_slot(
    slot: AssignmentSlot,
    capabilities: &ModelCapabilities,
) -> Result<(), String> {
    if !capabilities.enabled {
        return Err(tool_error(
            "MODEL_DISABLED",
            "The selected model configuration is disabled or has no usable authentication.",
            "Choose an enabled model from model_assignments_get.",
            false,
        ));
    }

    let compatible = match slot {
        AssignmentSlot::Reranker | AssignmentSlot::VlReranker => capabilities.reranker,
        AssignmentSlot::ExamSheetOcr => capabilities.multimodal,
        AssignmentSlot::VoiceInputAsr => {
            capabilities.audio_transcription
                && capabilities.provider_id.as_deref() == Some("siliconflow")
        }
        AssignmentSlot::ImageGeneration => capabilities.image_generation,
        _ => !capabilities.embedding && !capabilities.reranker,
    };
    if compatible {
        Ok(())
    } else {
        Err(tool_error(
            "MODEL_CAPABILITY_MISMATCH",
            format!(
                "The selected model does not provide the '{}' capability required by '{}'.",
                slot.required_capability(),
                slot.as_str()
            ),
            "Choose a compatible enabled model from model_assignments_get.",
            false,
        ))
    }
}

fn provider_id(config: &ApiConfig) -> Option<String> {
    config
        .provider_scope
        .as_deref()
        .or(config.provider_type.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn is_audio_transcription_model(config: &ApiConfig) -> bool {
    if config.is_embedding || config.is_reranker {
        return false;
    }
    let descriptor = format!("{} {}", config.model, config.name).to_ascii_lowercase();
    let excluded = [
        "tts",
        "text-to-speech",
        "text_to_speech",
        "speech-synthesis",
        "speech_synthesis",
        "speech-generation",
        "speech_generation",
    ]
    .iter()
    .any(|needle| descriptor.contains(needle));
    if excluded {
        return false;
    }

    let separated = descriptor.replace(['/', '_'], "-");
    let parts: Vec<&str> = separated.split('-').collect();
    parts.iter().any(|part| matches!(*part, "asr" | "stt"))
        || [
            "transcrib",
            "whisper",
            "sensevoice",
            "telespeechasr",
            "speech-to-text",
            "speechasr",
            "gpt-4o-transcribe",
            "gpt-4o-mini-transcribe",
            "qwen3-asr",
            "scribe-v",
        ]
        .iter()
        .any(|needle| separated.contains(needle))
}

fn safe_model_json(config: &ApiConfig) -> Value {
    let capabilities = ModelCapabilities::from(config);
    let provider = config
        .vendor_name
        .as_deref()
        .or(config.provider_type.as_deref())
        .or(config.provider_scope.as_deref())
        .unwrap_or("unknown");
    let (id, id_truncated) = bounded_string(&config.id);
    let (name, name_truncated) = bounded_string(&config.name);
    let (provider, provider_truncated) = bounded_string(provider);
    let model_type = if capabilities.audio_transcription {
        "audio_transcription"
    } else if capabilities.image_generation {
        "image_generation"
    } else if capabilities.reranker {
        "reranker"
    } else if capabilities.embedding {
        "embedding"
    } else if capabilities.multimodal {
        "multimodal_text"
    } else {
        "text"
    };

    json!({
        "id": id,
        "name": name,
        "provider": provider,
        "model_type": model_type,
        "enabled": config.enabled,
        "truncated": id_truncated || name_truncated || provider_truncated,
        "capabilities": {
            "multimodal": config.is_multimodal,
            "reasoning": config.is_reasoning,
            "embedding": config.is_embedding,
            "reranker": config.is_reranker,
            "image_generation": config.is_image_generation,
            "supports_tools": config.supports_tools,
            "supports_reasoning": config.supports_reasoning,
            "audio_transcription": capabilities.audio_transcription,
        },
    })
}

enum AtomicAssignmentUpdate {
    Updated {
        previous_config_id: Option<String>,
        assignments: ModelAssignments,
        changed: bool,
    },
    Conflict {
        current_config_id: Option<String>,
    },
}

fn update_model_assignment_atomic(
    database: &Database,
    slot: AssignmentSlot,
    config_id: Option<String>,
    expected_current_config_id: Option<&str>,
) -> Result<AtomicAssignmentUpdate, String> {
    let mut connection = database.get_conn_safe().map_err(|error| {
        tool_error(
            "MODEL_ASSIGNMENTS_WRITE_FAILED",
            format!("Failed to lock the settings database: {error}"),
            "Retry after local database activity finishes.",
            true,
        )
    })?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_WRITE_FAILED",
                format!("Failed to start an assignment transaction: {error}"),
                "Retry after local database activity finishes.",
                true,
            )
        })?;
    let stored: Option<String> = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = 'model_assignments'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_READ_FAILED",
                format!("Failed to read current assignments: {error}"),
                "Retry after checking the model assignment settings.",
                true,
            )
        })?;
    let mut assignments: ModelAssignments = match stored {
        Some(stored) => serde_json::from_str(&stored).map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_INVALID",
                format!("Stored model assignments are invalid: {error}"),
                "Open Settings and repair the model assignments before retrying.",
                false,
            )
        })?,
        None => ModelAssignments::default(),
    };
    let previous_config_id = slot.current(&assignments).map(str::to_string);
    if previous_config_id.as_deref() != expected_current_config_id {
        return Ok(AtomicAssignmentUpdate::Conflict {
            current_config_id: previous_config_id,
        });
    }

    let changed = previous_config_id != config_id;
    if changed {
        slot.set(&mut assignments, config_id);
        let serialized = serde_json::to_string(&assignments).map_err(|error| {
            tool_error(
                "MODEL_ASSIGNMENTS_SERIALIZE_FAILED",
                format!("Failed to serialize model assignments: {error}"),
                "Retry after repairing the model assignment settings.",
                false,
            )
        })?;
        transaction
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('model_assignments', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET
                   value = excluded.value,
                   updated_at = excluded.updated_at
                 WHERE settings.value IS NOT excluded.value",
                params![serialized, Utc::now().to_rfc3339()],
            )
            .map_err(|error| {
                tool_error(
                    "MODEL_ASSIGNMENTS_WRITE_FAILED",
                    format!("Failed to save model assignments: {error}"),
                    "Retry after checking local storage availability.",
                    true,
                )
            })?;
    }
    transaction.commit().map_err(|error| {
        tool_error(
            "MODEL_ASSIGNMENTS_WRITE_FAILED",
            format!("Failed to commit model assignments: {error}"),
            "Retry after checking local storage availability.",
            true,
        )
    })?;

    Ok(AtomicAssignmentUpdate::Updated {
        previous_config_id,
        assignments,
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_capabilities() -> ModelCapabilities {
        ModelCapabilities {
            enabled: true,
            multimodal: false,
            embedding: false,
            reranker: false,
            image_generation: false,
            audio_transcription: false,
            provider_id: Some("openai".to_string()),
        }
    }

    #[test]
    fn exposes_exact_tool_surface_with_expected_risk() {
        let executor = SettingsModelsToolExecutor::new();
        for tool in [SETTINGS_GET_TOOL, MODEL_ASSIGNMENTS_GET_TOOL] {
            assert!(executor.can_handle(tool));
            assert!(executor.can_handle(&format!("builtin-{tool}")));
            assert_eq!(executor.sensitivity_level(tool), ToolSensitivity::Low);
            assert_eq!(executor.concurrency_class(tool), ToolConcurrency::ReadOnly);
        }
        for tool in [SETTINGS_SET_TOOL, MODEL_ASSIGNMENTS_SET_TOOL] {
            assert!(executor.can_handle(tool));
            assert_eq!(executor.sensitivity_level(tool), ToolSensitivity::Medium);
            assert_eq!(executor.concurrency_class(tool), ToolConcurrency::Serial);
        }
        assert!(!executor.can_handle("builtin-api_key_set"));
    }

    #[test]
    fn sensitive_names_are_separator_and_case_insensitive() {
        for protected in [
            "web_search.API-Key",
            "ApiKey",
            "auth_token",
            "client.secret",
            "oauth.session",
            "password",
            "service_credential",
            "private_key",
            "ACCESS_KEY",
            "Authorization",
            "cookie_store",
            "tool-approval.override",
            "cloud_storage.password",
            "mcp.tools",
            "permission",
        ] {
            assert!(contains_sensitive_identifier(protected), "{protected}");
        }
        assert!(!contains_sensitive_identifier("thinking.auto_collapse"));
        assert!(!contains_sensitive_identifier("enableNotifications"));
    }

    #[test]
    fn request_fields_and_database_rows_both_fail_closed() {
        let protected_argument = json!({
            "prefix": "theme",
            "api_key": "must never be accepted",
        });
        let error = arguments_object(&protected_argument, SETTINGS_GET_FIELDS).unwrap_err();
        assert!(error.contains("SENSITIVE_FIELD_REJECTED"));

        assert!(is_safe_setting_key("theme"));
        assert!(is_safe_setting_key("ui.pointer_cursor"));
        assert!(!is_safe_setting_key("ui.private_token"));
        assert!(!is_safe_setting_key("mcp.tools.list"));
    }

    #[test]
    fn settings_values_use_exact_types_and_ranges() {
        assert_eq!(
            validate_setting_value("theme", &json!("dark")).unwrap(),
            "dark"
        );
        assert_eq!(
            validate_setting_value("enableNotifications", &json!(true)).unwrap(),
            "true"
        );
        assert_eq!(
            validate_setting_value("maxChatHistory", &json!(20)).unwrap(),
            "20"
        );
        assert!(validate_setting_value("theme", &json!("sepia")).is_err());
        assert!(validate_setting_value("enableNotifications", &json!("true")).is_err());
        assert!(validate_setting_value("maxChatHistory", &json!(9)).is_err());
        assert!(validate_setting_value("textbook.max_pages", &json!(51)).is_err());
        assert!(validate_setting_value("api_key", &json!("secret")).is_err());
    }

    #[test]
    fn assignment_args_require_explicit_nullable_occ_value() {
        let missing_expected = json!({
            "slot": "model2_config_id",
            "config_id": "model-a",
        });
        let object = arguments_object(&missing_expected, MODEL_ASSIGNMENTS_SET_FIELDS).unwrap();
        assert!(required_nullable_string(object, "expected_current_config_id").is_err());

        let clear = json!({
            "slot": "model2_config_id",
            "config_id": null,
            "expected_current_config_id": "model-a",
        });
        let object = arguments_object(&clear, MODEL_ASSIGNMENTS_SET_FIELDS).unwrap();
        assert_eq!(required_nullable_string(object, "config_id").unwrap(), None);
        assert_eq!(
            AssignmentSlot::parse(object["slot"].as_str().unwrap()).unwrap(),
            AssignmentSlot::Model2
        );
        assert!(AssignmentSlot::parse("embedding_model_config_id").is_err());
        assert!(AssignmentSlot::parse("translation_display_mode").is_err());

        let oversized = json!({
            "config_id": "m".repeat(MAX_MODEL_CONFIG_ID_CHARS + 1),
        });
        assert!(required_nullable_string(oversized.as_object().unwrap(), "config_id").is_err());
    }

    #[test]
    fn model_directory_pagination_is_bounded() {
        let defaults = Map::new();
        assert_eq!(
            optional_positive_integer(&defaults, "page", 1, usize::MAX).unwrap(),
            1
        );
        assert_eq!(
            optional_positive_integer(&defaults, "page_size", 20, 20).unwrap(),
            20
        );

        let valid = json!({"page": 3, "page_size": 7});
        let valid = valid.as_object().unwrap();
        assert_eq!(
            optional_positive_integer(valid, "page", 1, usize::MAX).unwrap(),
            3
        );
        assert_eq!(
            optional_positive_integer(valid, "page_size", 20, 20).unwrap(),
            7
        );

        for invalid in [json!(0), json!(21), json!("20")] {
            let arguments = Map::from_iter([("page_size".to_string(), invalid)]);
            assert!(optional_positive_integer(&arguments, "page_size", 20, 20).is_err());
        }
    }

    #[test]
    fn model_capability_matrix_matches_runtime_consumers() {
        let text = text_capabilities();
        assert!(validate_model_for_slot(AssignmentSlot::Model2, &text).is_ok());
        assert!(validate_model_for_slot(AssignmentSlot::Translation, &text).is_ok());
        assert!(validate_model_for_slot(AssignmentSlot::Reranker, &text).is_err());
        assert!(validate_model_for_slot(AssignmentSlot::ExamSheetOcr, &text).is_err());

        let mut reranker = text.clone();
        reranker.reranker = true;
        assert!(validate_model_for_slot(AssignmentSlot::Reranker, &reranker).is_ok());
        assert!(validate_model_for_slot(AssignmentSlot::Model2, &reranker).is_err());

        let mut ocr = text.clone();
        ocr.multimodal = true;
        assert!(validate_model_for_slot(AssignmentSlot::ExamSheetOcr, &ocr).is_ok());

        let mut image = text.clone();
        image.image_generation = true;
        assert!(validate_model_for_slot(AssignmentSlot::ImageGeneration, &image).is_ok());

        let mut asr = text.clone();
        asr.audio_transcription = true;
        assert!(validate_model_for_slot(AssignmentSlot::VoiceInputAsr, &asr).is_err());
        asr.provider_id = Some("siliconflow".to_string());
        assert!(validate_model_for_slot(AssignmentSlot::VoiceInputAsr, &asr).is_ok());

        let mut disabled = text;
        disabled.enabled = false;
        let error = validate_model_for_slot(AssignmentSlot::Model2, &disabled).unwrap_err();
        assert!(error.contains("MODEL_DISABLED"));
    }

    #[test]
    fn model_directory_projection_never_contains_runtime_secrets() {
        let config = ApiConfig {
            id: "model-id".to_string(),
            name: "Safe display name".to_string(),
            vendor_name: Some("Provider".to_string()),
            model: "raw-model-should-not-be-returned".to_string(),
            api_key: "super-secret-api-key".to_string(),
            base_url: "https://private.example.test/v1".to_string(),
            headers: Some(std::collections::HashMap::from([(
                "Authorization".to_string(),
                "Bearer hidden".to_string(),
            )])),
            enabled: true,
            ..ApiConfig::default()
        };
        let serialized = safe_model_json(&config).to_string();
        assert!(serialized.contains("model-id"));
        assert!(serialized.contains("Safe display name"));
        for secret in [
            "super-secret-api-key",
            "private.example.test",
            "Bearer hidden",
            "raw-model-should-not-be-returned",
            "api_key",
            "base_url",
            "headers",
        ] {
            assert!(!serialized.contains(secret), "leaked: {secret}");
        }
    }

    #[test]
    fn assignment_update_is_atomic_and_occ_guarded() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::new(&directory.path().join("settings.sqlite")).unwrap();
        database
            .get_conn_safe()
            .unwrap()
            .execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);",
            )
            .unwrap();

        let first = update_model_assignment_atomic(
            &database,
            AssignmentSlot::Model2,
            Some("model-a".to_string()),
            None,
        )
        .unwrap();
        match first {
            AtomicAssignmentUpdate::Updated {
                previous_config_id,
                assignments,
                changed,
            } => {
                assert_eq!(previous_config_id, None);
                assert_eq!(assignments.model2_config_id.as_deref(), Some("model-a"));
                assert!(changed);
            }
            AtomicAssignmentUpdate::Conflict { .. } => panic!("unexpected conflict"),
        }

        let stale = update_model_assignment_atomic(
            &database,
            AssignmentSlot::Model2,
            Some("model-b".to_string()),
            None,
        )
        .unwrap();
        match stale {
            AtomicAssignmentUpdate::Conflict { current_config_id } => {
                assert_eq!(current_config_id.as_deref(), Some("model-a"));
            }
            AtomicAssignmentUpdate::Updated { .. } => panic!("stale update must conflict"),
        }
        let persisted: ModelAssignments =
            serde_json::from_str(&database.get_setting("model_assignments").unwrap().unwrap())
                .unwrap();
        assert_eq!(persisted.model2_config_id.as_deref(), Some("model-a"));

        let cleared = update_model_assignment_atomic(
            &database,
            AssignmentSlot::Model2,
            None,
            Some("model-a"),
        )
        .unwrap();
        match cleared {
            AtomicAssignmentUpdate::Updated { assignments, .. } => {
                assert_eq!(assignments.model2_config_id, None);
            }
            AtomicAssignmentUpdate::Conflict { .. } => panic!("clear should succeed"),
        }
    }

    #[test]
    fn all_tool_strings_are_unicode_bounded() {
        let input = "设".repeat(MAX_TOOL_STRING_CHARS + 1);
        let (bounded, truncated) = bounded_string(&input);
        assert!(truncated);
        assert_eq!(bounded.chars().count(), MAX_TOOL_STRING_CHARS);

        let mut nested = json!({"outer": {"value": input}});
        assert!(bound_json_strings(&mut nested));
        assert_eq!(
            nested["outer"]["value"].as_str().unwrap().chars().count(),
            MAX_TOOL_STRING_CHARS
        );
    }
}
