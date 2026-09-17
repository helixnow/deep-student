//! Flashcard FSRS scheduler settings tools（读取/修改闪卡调度设置）。
//!
//! 与闪卡设置面板（SchedulerSettingsSection）读写同一份 `anki_decks.config_json`：
//! get 供对话回答"每日上限是多少 / 今天还能复习几张"，update 供用户口头调整
//! 每日新卡上限、每日复习上限、目标保持率等。写路径复用
//! `FsrsReviewService::update_scheduler_config` 的既有校验与事务。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::arg_utils::with_localized_message;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::fsrs_review_service::{FsrsReviewService, FsrsSchedulerConfigUpdate};

const FSRS_GET_SCHEDULER_CONFIG: &str = "fsrs_get_scheduler_config";
const FSRS_UPDATE_SCHEDULER_CONFIG: &str = "fsrs_update_scheduler_config";

/// 与前端 SchedulerSettingsSection 的 LIMIT_MAX（0–9999）保持同一契约。
const DAILY_LIMIT_MAX: u32 = 9999;

pub struct FsrsSettingsExecutor;

impl FsrsSettingsExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 仓库惯例：用 ctx.anki_db 现场 `FsrsReviewService::new`（同
    /// LearningOverviewExecutor / QBankExecutor 的 require_service 姿势）。
    fn require_service(ctx: &ExecutionContext) -> Result<FsrsReviewService, String> {
        let anki_db = ctx.anki_db.as_ref().ok_or_else(|| {
            fsrs_settings_error(
                "FSRS_DB_UNAVAILABLE",
                "闪卡数据库尚未初始化，调度设置不可用",
                "重启应用后重试；若仍失败请检查闪卡数据目录",
            )
        })?;
        Ok(FsrsReviewService::new(anki_db.clone()))
    }

    fn execute_get_config(&self, ctx: &ExecutionContext) -> Result<Value, String> {
        let service = Self::require_service(ctx)?;
        let config = service.get_scheduler_config().map_err(|e| {
            fsrs_settings_error(
                "FSRS_CONFIG_UNAVAILABLE",
                format!("读取闪卡调度配置失败: {e}"),
                "稍后重试；若持续失败请查看后端日志",
            )
        })?;
        // get_review_statistics 才携带 daily_limits（今日已用/剩余额度）；
        // get_stats 是轻量快照但不含已用计数。窗口取最小 7 天控制体积。
        let statistics = service.get_review_statistics(Some(7)).map_err(|e| {
            fsrs_settings_error(
                "FSRS_STATS_UNAVAILABLE",
                format!("读取闪卡今日额度统计失败: {e}"),
                "稍后重试；若持续失败请查看后端日志",
            )
        })?;
        Ok(json!({
            "config": serde_json::to_value(&config).unwrap_or(Value::Null),
            "dailyLimits": serde_json::to_value(&statistics.daily_limits).unwrap_or(Value::Null),
        }))
    }

    fn execute_update_config(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let request = parse_update_request(arguments)?;
        let service = Self::require_service(ctx)?;
        let update = FsrsSchedulerConfigUpdate {
            learn_ahead_minutes: None,
            new_per_day: request.new_per_day,
            reviews_per_day: request.reviews_per_day,
            desired_retention: request.desired_retention,
            leech_threshold: request.leech_threshold,
            leech_action: request.leech_action.clone(),
            enable_fuzz: request.enable_fuzz,
        };
        let config = service.update_scheduler_config(&update).map_err(|e| {
            fsrs_settings_error(
                "FSRS_UPDATE_FAILED",
                format!("写入闪卡调度设置失败: {e}"),
                "稍后重试；若持续失败请查看后端日志",
            )
        })?;
        let mut updated: Vec<&str> = Vec::new();
        if request.new_per_day.is_some() {
            updated.push("new_per_day");
        }
        if request.reviews_per_day.is_some() {
            updated.push("reviews_per_day");
        }
        if request.desired_retention.is_some() {
            updated.push("desired_retention");
        }
        if request.leech_threshold.is_some() {
            updated.push("leech_threshold");
        }
        if request.leech_action.is_some() {
            updated.push("leech_action");
        }
        if request.enable_fuzz.is_some() {
            updated.push("enable_fuzz");
        }
        Ok(json!({
            "config": serde_json::to_value(&config).unwrap_or(Value::Null),
            "updated": updated,
        }))
    }
}

impl Default for FsrsSettingsExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for FsrsSettingsExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            FSRS_GET_SCHEDULER_CONFIG | FSRS_UPDATE_SCHEDULER_CONFIG
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let tool_name = strip_tool_namespace(&call.name);
        let result = match tool_name {
            FSRS_GET_SCHEDULER_CONFIG => self.execute_get_config(ctx),
            FSRS_UPDATE_SCHEDULER_CONFIG => self.execute_update_config(&call.arguments, ctx),
            _ => Err(fsrs_settings_error(
                "UNKNOWN_TOOL",
                "不支持的闪卡调度设置工具",
                &format!(
                    "Unsupported flashcard scheduler settings tool: {}",
                    call.name
                ),
            )),
        };

        let duration_ms = started.elapsed().as_millis() as u64;
        let tool_result = match result {
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

        if let Err(error) = ctx.save_tool_block(&tool_result) {
            log::warn!(
                "[FsrsSettingsExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        if strip_tool_namespace(tool_name) == FSRS_UPDATE_SCHEDULER_CONFIG {
            ToolSensitivity::Medium
        } else {
            ToolSensitivity::Low
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if strip_tool_namespace(tool_name) == FSRS_UPDATE_SCHEDULER_CONFIG {
            ToolConcurrency::Serial
        } else {
            ToolConcurrency::ReadOnly
        }
    }

    fn name(&self) -> &'static str {
        "FsrsSettingsExecutor"
    }
}

#[derive(Debug, Default, PartialEq)]
struct SchedulerConfigUpdateRequest {
    new_per_day: Option<u32>,
    reviews_per_day: Option<u32>,
    desired_retention: Option<f64>,
    leech_threshold: Option<u32>,
    leech_action: Option<String>,
    enable_fuzz: Option<bool>,
}

/// snake_case 为主（schema SSOT），兼容 camelCase 写入方（对齐
/// FsrsReviewService::load_scheduler_config 的 field 双读惯例）。
fn field<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    value
        .get(snake)
        .filter(|v| !v.is_null())
        .or_else(|| value.get(camel).filter(|v| !v.is_null()))
}

fn parse_update_request(arguments: &Value) -> Result<SchedulerConfigUpdateRequest, String> {
    if !arguments.is_object() {
        return Err(invalid_args("参数必须是 JSON 对象"));
    }
    let mut request = SchedulerConfigUpdateRequest::default();
    if let Some(v) = field(arguments, "new_per_day", "newPerDay") {
        request.new_per_day = Some(parse_limit(v, "new_per_day")?);
    }
    if let Some(v) = field(arguments, "reviews_per_day", "reviewsPerDay") {
        request.reviews_per_day = Some(parse_limit(v, "reviews_per_day")?);
    }
    if let Some(v) = field(arguments, "desired_retention", "desiredRetention") {
        let n = v.as_f64().ok_or_else(|| {
            invalid_args("desired_retention 必须是 (0,1) 开区间内的小数，例如 0.9")
        })?;
        if !n.is_finite() || n <= 0.0 || n >= 1.0 {
            return Err(invalid_args(
                "desired_retention 必须在 (0,1) 开区间内，例如 0.9",
            ));
        }
        request.desired_retention = Some(n);
    }
    if let Some(v) = field(arguments, "leech_threshold", "leechThreshold") {
        let n = v
            .as_u64()
            .ok_or_else(|| invalid_args("leech_threshold 必须是 0–9999 的整数"))?;
        if n > u64::from(DAILY_LIMIT_MAX) {
            return Err(invalid_args("leech_threshold 必须是 0–9999 的整数"));
        }
        request.leech_threshold = Some(n as u32);
    }
    if let Some(v) = field(arguments, "leech_action", "leechAction") {
        let s = v.as_str().ok_or_else(|| {
            invalid_args("leech_action 仅支持 \"suspend\"（暂停）或 \"mark\"（仅标记）")
        })?;
        if s != "suspend" && s != "mark" {
            return Err(invalid_args(
                "leech_action 仅支持 \"suspend\"（暂停）或 \"mark\"（仅标记）",
            ));
        }
        request.leech_action = Some(s.to_string());
    }
    if let Some(v) = field(arguments, "enable_fuzz", "enableFuzz") {
        request.enable_fuzz = Some(
            v.as_bool()
                .ok_or_else(|| invalid_args("enable_fuzz 必须是布尔值"))?,
        );
    }
    if request == SchedulerConfigUpdateRequest::default() {
        return Err(invalid_args(
            "至少提供一个要修改的字段：new_per_day / reviews_per_day / desired_retention / leech_threshold / leech_action / enable_fuzz",
        ));
    }
    Ok(request)
}

fn parse_limit(value: &Value, name: &str) -> Result<u32, String> {
    let n = value
        .as_u64()
        .ok_or_else(|| invalid_args(&format!("{name} 必须是 0–{DAILY_LIMIT_MAX} 的整数")))?;
    if n > u64::from(DAILY_LIMIT_MAX) {
        return Err(invalid_args(&format!(
            "{name} 必须是 0–{DAILY_LIMIT_MAX} 的整数（对齐闪卡设置面板的 0–9999 区间）"
        )));
    }
    Ok(n as u32)
}

fn invalid_args(message: &str) -> String {
    fsrs_settings_error("INVALID_ARGS", message, "修正参数后重试")
}

fn fsrs_settings_error(code: &str, message: impl Into<String>, hint: &str) -> String {
    let message = message.into();
    with_localized_message(
        json!({
            "code": code,
            "hint": hint,
            "hintFallback": {
                "zh-CN": hint,
                "en-US": "Review the structured error code and correct the request before retrying."
            },
            "retryable": false,
        }),
        "chat.tools.fsrs_settings.error",
        json!({ "code": code, "detail": message }),
        message,
        format!("Flashcard scheduler settings operation failed ({code})."),
    )
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::data_governance::migration::{MigrationCoordinator, MISTAKES_MIGRATIONS};
    use crate::data_governance::schema_registry::DatabaseId;
    use crate::database::Database;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn headless_ctx() -> ExecutionContext {
        let emitter = Arc::new(ChatV2EventEmitter::new_headless("sess-fsrs".to_string()));
        let registry = Arc::new(crate::tools::ToolRegistry::new());
        ExecutionContext::new(
            "sess-fsrs".to_string(),
            "msg-fsrs".to_string(),
            "blk-fsrs".to_string(),
            emitter,
            registry,
            None,
        )
    }

    fn setup_migrated_fsrs_db() -> (TempDir, Arc<Database>) {
        let temp_dir = TempDir::new().expect("create temporary app data directory");
        let root = temp_dir.path().to_path_buf();
        let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("migrate mistakes database");
        let db = Arc::new(Database::new(&root.join("mistakes.db")).expect("open mistakes db"));
        (temp_dir, db)
    }

    #[test]
    fn can_handle_matches_both_tools_and_splits_sensitivity() {
        let executor = FsrsSettingsExecutor::new();
        assert!(executor.can_handle("builtin-fsrs_get_scheduler_config"));
        assert!(executor.can_handle("fsrs_update_scheduler_config"));
        assert!(!executor.can_handle("builtin-learning_overview"));
        assert_eq!(
            executor.sensitivity_level("builtin-fsrs_get_scheduler_config"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-fsrs_update_scheduler_config"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.concurrency_class("builtin-fsrs_get_scheduler_config"),
            ToolConcurrency::ReadOnly
        );
        assert_eq!(
            executor.concurrency_class("builtin-fsrs_update_scheduler_config"),
            ToolConcurrency::Serial
        );
    }

    #[test]
    fn parse_update_request_validates_bounds_and_aliases() {
        let valid = parse_update_request(&json!({
            "new_per_day": 50,
            "reviewsPerDay": 300,
            "desired_retention": 0.85,
            "leech_action": "mark",
        }))
        .expect("valid request");
        assert_eq!(valid.new_per_day, Some(50));
        assert_eq!(valid.reviews_per_day, Some(300));
        assert_eq!(valid.desired_retention, Some(0.85));
        assert_eq!(valid.leech_action.as_deref(), Some("mark"));

        for (invalid, name) in [
            (json!({"new_per_day": 10000}), "limit above max"),
            (json!({"reviews_per_day": -1}), "negative limit"),
            (json!({"new_per_day": 20.5}), "float limit"),
            (json!({"desired_retention": 1.0}), "retention upper bound"),
            (json!({"desired_retention": "0.9"}), "retention type"),
            (json!({"leech_action": "ban"}), "leech action enum"),
            (json!({"enable_fuzz": "yes"}), "fuzz type"),
            (json!({}), "empty update"),
            (json!([]), "non-object"),
        ] {
            let error = parse_update_request(&invalid).expect_err(&format!("{name} must fail"));
            let structured: Value = serde_json::from_str(&error).expect("structured error");
            assert_eq!(structured["code"], "INVALID_ARGS", "{name}");
        }

        // 0 是合法上限值（用于"今天不引入新卡"），边界 9999 同样合法。
        assert_eq!(
            parse_update_request(&json!({"new_per_day": 0}))
                .expect("zero limit")
                .new_per_day,
            Some(0)
        );
        assert_eq!(
            parse_update_request(&json!({"reviews_per_day": 9999}))
                .expect("max limit")
                .reviews_per_day,
            Some(9999)
        );
    }

    #[test]
    fn get_then_update_roundtrip_on_migrated_db() {
        let (_temp, db) = setup_migrated_fsrs_db();
        let mut ctx = headless_ctx();
        ctx.anki_db = Some(db);
        let executor = FsrsSettingsExecutor::new();

        let initial = executor
            .execute_get_config(&ctx)
            .expect("initial get must succeed");
        assert_eq!(initial["config"]["newPerDay"], 20);
        assert_eq!(initial["config"]["reviewsPerDay"], 200);
        assert_eq!(initial["dailyLimits"]["newPerDay"], 20);
        assert_eq!(initial["dailyLimits"]["newRemainingToday"], 20);

        let updated = executor
            .execute_update_config(&json!({"new_per_day": 50, "desired_retention": 0.85}), &ctx)
            .expect("update must succeed");
        assert_eq!(
            updated["updated"],
            json!(["new_per_day", "desired_retention"])
        );
        assert_eq!(updated["config"]["newPerDay"], 50);
        assert_eq!(updated["config"]["desiredRetention"], 0.85);
        assert_eq!(updated["config"]["reviewsPerDay"], 200, "untouched field");

        let reread = executor
            .execute_get_config(&ctx)
            .expect("reread must succeed");
        assert_eq!(reread["config"]["newPerDay"], 50);
        assert_eq!(reread["config"]["desiredRetention"], 0.85);
        assert_eq!(reread["dailyLimits"]["newPerDay"], 50);
    }

    #[test]
    fn missing_anki_db_is_structured_fail_closed() {
        let ctx = headless_ctx();
        let executor = FsrsSettingsExecutor::new();
        let error = executor
            .execute_get_config(&ctx)
            .expect_err("missing anki db must fail");
        let structured: Value = serde_json::from_str(&error).expect("structured error");
        assert_eq!(structured["code"], "FSRS_DB_UNAVAILABLE");
        assert_eq!(structured["retryable"], false);
    }
}
