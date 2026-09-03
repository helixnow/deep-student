//! Read-only LLM usage statistics tool.
//!
//! The executor reads the managed `LlmUsageDatabase` directly and reuses
//! `LlmUsageRepo`; it never invokes a Tauri command from inside the backend.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use chrono::NaiveDate;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::llm_usage::database::LlmUsageDatabase;
use crate::llm_usage::repo::{LlmUsageRepo, PriceCoverageDimension, PriceCoverageStat};
use crate::llm_usage::types::{CallerTypeSummary, ModelSummary, UsageRecord, UsageTrendPoint};

const TOOL_NAME: &str = "llm_usage_query";
const DEFAULT_PAGE_LIMIT: u32 = 20;
const MAX_PAGE_LIMIT: u32 = 20;
const MAX_PAGE_OFFSET: u32 = 100_000;
const MAX_TREND_DAYS: u32 = 366;
const MAX_HOURLY_TREND_DAYS: u32 = 31;
const MAX_TEXT_FIELD_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Granularity {
    Hour,
    Day,
}

impl Granularity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }

    fn as_repo_type(self) -> crate::llm_usage::types::TimeGranularity {
        match self {
            Self::Hour => crate::llm_usage::types::TimeGranularity::Hour,
            Self::Day => crate::llm_usage::types::TimeGranularity::Day,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PageRequest {
    offset: u32,
    limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum UsageQuery {
    Summary {
        start_date: String,
        end_date: String,
    },
    Trends {
        days: u32,
        granularity: Granularity,
        page: PageRequest,
    },
    ByModel {
        start_date: String,
        end_date: String,
        page: PageRequest,
    },
    ByCaller {
        start_date: String,
        end_date: String,
        page: PageRequest,
    },
    Recent {
        page: PageRequest,
    },
}

pub struct LlmUsageToolExecutor;

impl LlmUsageToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn execute_query(&self, conn: &Connection, arguments: &Value) -> Result<Value, String> {
        let query = parse_query(arguments)?;
        run_query(conn, query).map_err(|error| {
            log::error!("[LlmUsageToolExecutor] Query failed: {}", error);
            usage_error(
                "USAGE_QUERY_FAILED",
                "The LLM usage database query failed.",
                "Retry after the local usage database is available.",
                true,
            )
        })
    }
}

impl Default for LlmUsageToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

fn usage_error(
    code: &str,
    message: impl Into<String>,
    hint: impl Into<String>,
    retryable: bool,
) -> String {
    json!({
        "code": code,
        "message": message.into(),
        "hint": hint.into(),
        "retryable": retryable,
    })
    .to_string()
}

fn invalid_argument(field: &str, reason: impl Into<String>) -> String {
    usage_error(
        "INVALID_ARGUMENT",
        format!("Invalid '{}': {}", field, reason.into()),
        "Correct the tool arguments and retry.",
        false,
    )
}

fn arguments_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments
        .as_object()
        .ok_or_else(|| invalid_argument("arguments", "expected a JSON object"))
}

fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid_argument(
            key,
            "unknown field for this action; additional properties are not allowed",
        ));
    }
    Ok(())
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
        .ok_or_else(|| invalid_argument(field, "expected a string"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(invalid_argument(field, "must not be blank"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(invalid_argument(
            field,
            format!("must contain at most {max_chars} characters"),
        ));
    }
    Ok(trimmed.to_string())
}

fn required_u32(
    arguments: &Map<String, Value>,
    field: &str,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let raw = arguments
        .get(field)
        .ok_or_else(|| invalid_argument(field, "field is required"))?
        .as_u64()
        .ok_or_else(|| invalid_argument(field, "expected an unsigned integer"))?;
    let value = u32::try_from(raw)
        .map_err(|_| invalid_argument(field, format!("must be between {min} and {max}")))?;
    if !(min..=max).contains(&value) {
        return Err(invalid_argument(
            field,
            format!("must be between {min} and {max}"),
        ));
    }
    Ok(value)
}

fn optional_u32(
    arguments: &Map<String, Value>,
    field: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    match arguments.get(field) {
        None => Ok(default),
        Some(_) => required_u32(arguments, field, min, max),
    }
}

fn parse_page(arguments: &Map<String, Value>) -> Result<PageRequest, String> {
    Ok(PageRequest {
        offset: optional_u32(arguments, "offset", 0, 0, MAX_PAGE_OFFSET)?,
        limit: optional_u32(arguments, "limit", DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT)?,
    })
}

fn required_date(arguments: &Map<String, Value>, field: &str) -> Result<String, String> {
    let value = required_string(arguments, field, 10)?;
    let parsed = NaiveDate::parse_from_str(&value, "%Y-%m-%d")
        .map_err(|_| invalid_argument(field, "expected a real calendar date in YYYY-MM-DD"))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(invalid_argument(
            field,
            "expected the exact YYYY-MM-DD format",
        ));
    }
    Ok(value)
}

fn required_range(arguments: &Map<String, Value>) -> Result<(String, String), String> {
    let start_date = required_date(arguments, "start_date")?;
    let end_date = required_date(arguments, "end_date")?;
    let start = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d").expect("validated date");
    let end = NaiveDate::parse_from_str(&end_date, "%Y-%m-%d").expect("validated date");
    if start > end {
        return Err(invalid_argument(
            "start_date",
            "must be earlier than or equal to end_date",
        ));
    }
    Ok((start_date, end_date))
}

fn parse_query(arguments: &Value) -> Result<UsageQuery, String> {
    let arguments = arguments_object(arguments)?;
    let action = required_string(arguments, "action", 32)?;

    match action.as_str() {
        "summary" => {
            ensure_allowed_keys(arguments, &["action", "start_date", "end_date"])?;
            let (start_date, end_date) = required_range(arguments)?;
            Ok(UsageQuery::Summary {
                start_date,
                end_date,
            })
        }
        "trends" => {
            ensure_allowed_keys(
                arguments,
                &["action", "days", "granularity", "offset", "limit"],
            )?;
            let days = required_u32(arguments, "days", 1, MAX_TREND_DAYS)?;
            let granularity = match required_string(arguments, "granularity", 16)?.as_str() {
                "hour" => Granularity::Hour,
                "day" => Granularity::Day,
                _ => {
                    return Err(invalid_argument(
                        "granularity",
                        "expected one of hour or day",
                    ))
                }
            };
            if granularity == Granularity::Hour && days > MAX_HOURLY_TREND_DAYS {
                return Err(invalid_argument(
                    "days",
                    format!("hour granularity supports at most {MAX_HOURLY_TREND_DAYS} days"),
                ));
            }
            Ok(UsageQuery::Trends {
                days,
                granularity,
                page: parse_page(arguments)?,
            })
        }
        "by_model" => {
            ensure_allowed_keys(
                arguments,
                &["action", "start_date", "end_date", "offset", "limit"],
            )?;
            let (start_date, end_date) = required_range(arguments)?;
            Ok(UsageQuery::ByModel {
                start_date,
                end_date,
                page: parse_page(arguments)?,
            })
        }
        "by_caller" => {
            ensure_allowed_keys(
                arguments,
                &["action", "start_date", "end_date", "offset", "limit"],
            )?;
            let (start_date, end_date) = required_range(arguments)?;
            Ok(UsageQuery::ByCaller {
                start_date,
                end_date,
                page: parse_page(arguments)?,
            })
        }
        "recent" => {
            ensure_allowed_keys(arguments, &["action", "offset", "limit"])?;
            Ok(UsageQuery::Recent {
                page: parse_page(arguments)?,
            })
        }
        _ => Err(usage_error(
            "UNKNOWN_ACTION",
            format!("Unknown LLM usage action: {action}"),
            "Use summary, trends, by_model, by_caller, or recent.",
            false,
        )),
    }
}

fn run_query(
    conn: &Connection,
    query: UsageQuery,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    match query {
        UsageQuery::Summary {
            start_date,
            end_date,
        } => query_summary(conn, &start_date, &end_date),
        UsageQuery::Trends {
            days,
            granularity,
            page,
        } => query_trends(conn, days, granularity, page),
        UsageQuery::ByModel {
            start_date,
            end_date,
            page,
        } => query_by_model(conn, &start_date, &end_date, page),
        UsageQuery::ByCaller {
            start_date,
            end_date,
            page,
        } => query_by_caller(conn, &start_date, &end_date, page),
        UsageQuery::Recent { page } => query_recent(conn, page),
    }
}

fn query_summary(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    let summary = LlmUsageRepo::get_usage_summary(conn, Some(start_date), Some(end_date))?;
    let coverage = LlmUsageRepo::get_price_coverage(
        conn,
        start_date,
        end_date,
        PriceCoverageDimension::Overall,
    )?
    .into_iter()
    .next()
    .unwrap_or_else(empty_coverage);

    Ok(json!({
        "action": "summary",
        "requestedRange": { "startDate": start_date, "endDate": end_date },
        "resolvedRange": {
            "start": summary.start_date.to_rfc3339(),
            "end": summary.end_date.to_rfc3339(),
        },
        "totalRequests": summary.total_requests,
        "successRequests": summary.success_requests,
        "errorRequests": summary.error_requests,
        "promptTokens": summary.total_prompt_tokens,
        "completionTokens": summary.total_completion_tokens,
        "totalTokens": summary.total_tokens,
        "reasoningTokens": summary.total_reasoning_tokens,
        "cachedTokens": summary.total_cached_tokens,
        "averageTokensPerRequest": summary.avg_tokens_per_request,
        "averageDurationMs": summary.avg_duration_ms,
        "cost": cost_json(summary.total_estimated_cost_usd, &coverage),
    }))
}

fn query_trends(
    conn: &Connection,
    days: u32,
    granularity: Granularity,
    page: PageRequest,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    let points = LlmUsageRepo::get_usage_trends(conn, days, &granularity.as_repo_type())?;
    let coverage = LlmUsageRepo::get_recent_price_coverage(conn, days)?;
    let estimated_cost_usd = sum_trend_costs(&points);
    let total = points.len();
    let items = paginate(points, page)
        .into_iter()
        .map(trend_json)
        .collect::<Vec<_>>();
    let returned = items.len();

    Ok(json!({
        "action": "trends",
        "requestedWindow": { "days": days, "granularity": granularity.as_str() },
        "items": items,
        "page": page_json(page, returned, total),
        "cost": cost_json(estimated_cost_usd, &coverage),
    }))
}

fn query_by_model(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
    page: PageRequest,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    let summaries = LlmUsageRepo::get_usage_by_model(conn, start_date, end_date)?;
    let coverage = keyed_coverage(LlmUsageRepo::get_price_coverage(
        conn,
        start_date,
        end_date,
        PriceCoverageDimension::Model,
    )?);
    let total = summaries.len();
    let items = paginate(summaries, page)
        .into_iter()
        .map(|summary| {
            let key = summary.model_id.clone();
            model_json(summary, coverage.get(&key))
        })
        .collect::<Vec<_>>();
    let returned = items.len();

    Ok(json!({
        "action": "by_model",
        "requestedRange": { "startDate": start_date, "endDate": end_date },
        "items": items,
        "page": page_json(page, returned, total),
    }))
}

fn query_by_caller(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
    page: PageRequest,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    let summaries = LlmUsageRepo::get_usage_by_caller(conn, start_date, end_date)?;
    let coverage = keyed_coverage(LlmUsageRepo::get_price_coverage(
        conn,
        start_date,
        end_date,
        PriceCoverageDimension::CallerType,
    )?);
    let total = summaries.len();
    let items = paginate(summaries, page)
        .into_iter()
        .map(|summary| {
            let key = summary.caller_type.to_string();
            caller_json(summary, coverage.get(&key))
        })
        .collect::<Vec<_>>();
    let returned = items.len();

    Ok(json!({
        "action": "by_caller",
        "requestedRange": { "startDate": start_date, "endDate": end_date },
        "items": items,
        "page": page_json(page, returned, total),
    }))
}

fn query_recent(
    conn: &Connection,
    page: PageRequest,
) -> crate::llm_usage::database::LlmUsageResult<Value> {
    let mut records = LlmUsageRepo::get_recent_usage_page(conn, page.offset, page.limit + 1)?;
    let has_more = records.len() > page.limit as usize;
    records.truncate(page.limit as usize);
    let items = records.into_iter().map(recent_json).collect::<Vec<_>>();
    let returned = items.len();
    let next_offset = has_more.then_some(page.offset + returned as u32);

    Ok(json!({
        "action": "recent",
        "items": items,
        "page": {
            "offset": page.offset,
            "limit": page.limit,
            "returned": returned,
            "hasMore": has_more,
            "nextOffset": next_offset,
        },
        "redaction": {
            "callerId": "omitted",
            "configId": "omitted",
            "errorMessage": "omitted",
            "maxStringFieldChars": MAX_TEXT_FIELD_CHARS,
        },
    }))
}

fn paginate<T>(items: Vec<T>, page: PageRequest) -> Vec<T> {
    items
        .into_iter()
        .skip(page.offset as usize)
        .take(page.limit as usize)
        .collect()
}

fn page_json(page: PageRequest, returned: usize, total: usize) -> Value {
    let consumed = (page.offset as usize).saturating_add(returned);
    let has_more = consumed < total;
    json!({
        "offset": page.offset,
        "limit": page.limit,
        "returned": returned,
        "total": total,
        "hasMore": has_more,
        "nextOffset": has_more.then_some(consumed),
    })
}

fn empty_coverage() -> PriceCoverageStat {
    PriceCoverageStat {
        key: None,
        total_requests: 0,
        priced_requests: 0,
        total_tokens: 0,
        priced_tokens: 0,
    }
}

fn keyed_coverage(stats: Vec<PriceCoverageStat>) -> HashMap<String, PriceCoverageStat> {
    stats
        .into_iter()
        .filter_map(|stat| stat.key.clone().map(|key| (key, stat)))
        .collect()
}

fn ratio(numerator: u64, denominator: u64) -> Option<f64> {
    (denominator > 0).then_some(numerator as f64 / denominator as f64)
}

fn cost_json(estimated_usd: Option<f64>, coverage: &PriceCoverageStat) -> Value {
    let status = if coverage.total_requests == 0 {
        "not_applicable"
    } else if coverage.priced_requests == 0 {
        "unavailable"
    } else if coverage.priced_requests == coverage.total_requests {
        "complete"
    } else {
        "partial"
    };
    json!({
        "estimated": true,
        "currency": "USD",
        "estimatedUsd": estimated_usd,
        "priceCoverage": {
            "status": status,
            "pricedRequests": coverage.priced_requests,
            "totalRequests": coverage.total_requests,
            "requestRatio": ratio(coverage.priced_requests, coverage.total_requests),
            "pricedTokens": coverage.priced_tokens,
            "totalTokens": coverage.total_tokens,
            "tokenRatio": ratio(coverage.priced_tokens, coverage.total_tokens),
        },
    })
}

fn trend_json(point: UsageTrendPoint) -> Value {
    json!({
        "timeLabel": point.time_label,
        "timestamp": point.timestamp,
        "requestCount": point.request_count,
        "promptTokens": point.prompt_tokens,
        "completionTokens": point.completion_tokens,
        "totalTokens": point.total_tokens,
        "estimatedCostUsd": point.estimated_cost_usd,
        "successRate": point.success_rate,
    })
}

fn model_json(summary: ModelSummary, coverage: Option<&PriceCoverageStat>) -> Value {
    let fallback = PriceCoverageStat {
        key: None,
        total_requests: summary.request_count,
        priced_requests: 0,
        total_tokens: summary.total_tokens,
        priced_tokens: 0,
    };
    let (model_id, truncated) = bounded_string(&summary.model_id);
    json!({
        "modelId": model_id,
        "modelIdTruncated": truncated,
        "requestCount": summary.request_count,
        "promptTokens": summary.prompt_tokens,
        "completionTokens": summary.completion_tokens,
        "totalTokens": summary.total_tokens,
        "cost": cost_json(summary.estimated_cost_usd, coverage.unwrap_or(&fallback)),
    })
}

fn caller_json(summary: CallerTypeSummary, coverage: Option<&PriceCoverageStat>) -> Value {
    let fallback = PriceCoverageStat {
        key: None,
        total_requests: summary.request_count,
        priced_requests: 0,
        total_tokens: summary.total_tokens,
        priced_tokens: 0,
    };
    let (caller_type, caller_type_truncated) = bounded_string(&summary.caller_type.to_string());
    let (display_name, display_name_truncated) = bounded_string(&summary.display_name);
    json!({
        "callerType": caller_type,
        "callerTypeTruncated": caller_type_truncated,
        "displayName": display_name,
        "displayNameTruncated": display_name_truncated,
        "requestCount": summary.request_count,
        "totalTokens": summary.total_tokens,
        "cost": cost_json(summary.estimated_cost_usd, coverage.unwrap_or(&fallback)),
    })
}

fn recent_json(record: UsageRecord) -> Value {
    let (id, id_truncated) = bounded_string(&record.id);
    let (caller_type, caller_type_truncated) = bounded_string(&record.caller_type.to_string());
    let (model_id, model_id_truncated) = bounded_string(&record.model_id);
    let (provider_id, provider_id_truncated) = record
        .provider_id
        .as_deref()
        .map(bounded_string)
        .map(|(value, truncated)| (Some(value), truncated))
        .unwrap_or((None, false));
    let coverage = PriceCoverageStat {
        key: None,
        total_requests: 1,
        priced_requests: u64::from(record.estimated_cost_usd.is_some()),
        total_tokens: record.total_tokens as u64,
        priced_tokens: if record.estimated_cost_usd.is_some() {
            record.total_tokens as u64
        } else {
            0
        },
    };

    json!({
        "id": id,
        "idTruncated": id_truncated,
        "callerType": caller_type,
        "callerTypeTruncated": caller_type_truncated,
        "modelId": model_id,
        "modelIdTruncated": model_id_truncated,
        "providerId": provider_id,
        "providerIdTruncated": provider_id_truncated,
        "promptTokens": record.prompt_tokens,
        "completionTokens": record.completion_tokens,
        "totalTokens": record.total_tokens,
        "reasoningTokens": record.reasoning_tokens,
        "cachedTokens": record.cached_tokens,
        "durationMs": record.duration_ms,
        "success": record.success,
        "hadError": record.error_message.is_some(),
        "createdAt": record.created_at.to_rfc3339(),
        "cost": cost_json(record.estimated_cost_usd, &coverage),
    })
}

fn bounded_string(value: &str) -> (String, bool) {
    let mut chars = value.chars();
    let bounded = chars
        .by_ref()
        .take(MAX_TEXT_FIELD_CHARS)
        .collect::<String>();
    let truncated = chars.next().is_some();
    (bounded, truncated)
}

fn sum_trend_costs(items: &[UsageTrendPoint]) -> Option<f64> {
    let values = items
        .iter()
        .filter_map(|item| item.estimated_cost_usd)
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.into_iter().sum())
}

#[async_trait]
impl ToolExecutor for LlmUsageToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == TOOL_NAME
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match ctx.window_ref().try_state::<Arc<LlmUsageDatabase>>() {
            Some(database) => match database.get_conn_safe() {
                Ok(conn) => self.execute_query(&conn, &call.arguments),
                Err(error) => {
                    log::error!("[LlmUsageToolExecutor] Connection failed: {}", error);
                    Err(usage_error(
                        "USAGE_DATABASE_UNAVAILABLE",
                        "The LLM usage database is unavailable.",
                        "Retry after application data initialization completes.",
                        true,
                    ))
                }
            },
            None => Err(usage_error(
                "USAGE_DATABASE_UNAVAILABLE",
                "The LLM usage database is not initialized.",
                "Retry after application data initialization completes.",
                true,
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
                "[LlmUsageToolExecutor] Failed to persist tool block: {}",
                error
            );
        }
        Ok(tool_result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "LlmUsageToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{SecondsFormat, Utc};
    use rusqlite::params;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory usage db");
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260130__init.sql"
        ))
        .expect("initialize usage schema");
        // V20260824：get_recent_usage_page 读取 cache_write_tokens 列
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260824__add_cache_write_tokens.sql"
        ))
        .expect("apply cache_write_tokens migration");
        conn.execute_batch(include_str!(
            "../../../migrations/llm_usage/V20260826__add_stream_identity.sql"
        ))
        .expect("apply stream identity migration");
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_usage(
        conn: &Connection,
        id: &str,
        timestamp: &str,
        model: &str,
        caller: &str,
        total_tokens: u32,
        cost: Option<f64>,
        session_id: Option<&str>,
        config_id: Option<&str>,
        error_message: Option<&str>,
    ) {
        conn.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                caller_type, session_id, status, error_message, cost_estimate
            ) VALUES (?1, ?2, 'test-provider', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                id,
                timestamp,
                model,
                config_id,
                total_tokens / 2,
                total_tokens - total_tokens / 2,
                total_tokens,
                caller,
                session_id,
                if error_message.is_some() {
                    "error"
                } else {
                    "success"
                },
                error_message,
                cost,
            ],
        )
        .expect("insert usage fixture");
    }

    fn parse_error(arguments: Value) -> Value {
        let error = parse_query(&arguments).expect_err("arguments should be rejected");
        serde_json::from_str(&error).expect("structured usage error")
    }

    #[test]
    fn action_matrix_rejects_missing_and_cross_action_fields() {
        assert_eq!(parse_error(json!({}))["code"], "INVALID_ARGUMENT");
        assert_eq!(
            parse_error(json!({
                "action": "recent",
                "start_date": "2026-07-01"
            }))["code"],
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_error(json!({ "action": "daily" }))["code"],
            "UNKNOWN_ACTION"
        );
    }

    #[test]
    fn dates_are_real_exact_and_ordered() {
        for arguments in [
            json!({
                "action": "summary",
                "start_date": "2026-02-30",
                "end_date": "2026-03-01"
            }),
            json!({
                "action": "summary",
                "start_date": "2026-7-01",
                "end_date": "2026-07-02"
            }),
            json!({
                "action": "summary",
                "start_date": "2026-07-03",
                "end_date": "2026-07-02"
            }),
        ] {
            assert_eq!(parse_error(arguments)["code"], "INVALID_ARGUMENT");
        }

        assert!(parse_query(&json!({
            "action": "summary",
            "start_date": "2024-02-29",
            "end_date": "2024-02-29"
        }))
        .is_ok());
    }

    #[test]
    fn trend_and_page_limits_are_enforced() {
        assert_eq!(
            parse_error(json!({
                "action": "trends",
                "days": 367,
                "granularity": "day"
            }))["code"],
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_error(json!({
                "action": "trends",
                "days": 32,
                "granularity": "hour"
            }))["code"],
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_error(json!({ "action": "recent", "limit": 21 }))["code"],
            "INVALID_ARGUMENT"
        );
        assert!(parse_query(&json!({
            "action": "trends",
            "days": 366,
            "granularity": "day",
            "limit": 20
        }))
        .is_ok());
    }

    #[test]
    fn summary_preserves_requested_range_and_reports_partial_pricing() {
        let conn = setup_test_db();
        insert_usage(
            &conn,
            "priced",
            "2026-07-01T10:00:00Z",
            "model-a",
            "chat_v2",
            120,
            Some(0.25),
            None,
            None,
            None,
        );
        insert_usage(
            &conn,
            "unpriced",
            "2026-07-02T10:00:00Z",
            "model-b",
            "translation",
            80,
            None,
            None,
            None,
            None,
        );

        let output = LlmUsageToolExecutor::new()
            .execute_query(
                &conn,
                &json!({
                    "action": "summary",
                    "start_date": "2026-07-01",
                    "end_date": "2026-07-31"
                }),
            )
            .expect("summary query");

        assert_eq!(output["requestedRange"]["startDate"], "2026-07-01");
        assert_eq!(output["requestedRange"]["endDate"], "2026-07-31");
        assert_eq!(output["totalTokens"], 200);
        assert_eq!(output["cost"]["estimated"], true);
        assert_eq!(output["cost"]["estimatedUsd"], 0.25);
        assert_eq!(output["cost"]["priceCoverage"]["status"], "partial");
        assert_eq!(output["cost"]["priceCoverage"]["pricedRequests"], 1);
        assert_eq!(output["cost"]["priceCoverage"]["totalRequests"], 2);
    }

    #[test]
    fn missing_prices_remain_null_in_model_results() {
        let conn = setup_test_db();
        insert_usage(
            &conn,
            "unpriced",
            "2026-07-02T10:00:00Z",
            "model-b",
            "chat_v2",
            80,
            None,
            None,
            None,
            None,
        );

        let output = LlmUsageToolExecutor::new()
            .execute_query(
                &conn,
                &json!({
                    "action": "by_model",
                    "start_date": "2026-07-01",
                    "end_date": "2026-07-31"
                }),
            )
            .expect("by-model query");

        assert!(output["items"][0]["cost"]["estimatedUsd"].is_null());
        assert_eq!(
            output["items"][0]["cost"]["priceCoverage"]["status"],
            "unavailable"
        );
    }

    #[test]
    fn recent_is_paginated_bounded_and_redacted() {
        let conn = setup_test_db();
        let long_model = "x".repeat(MAX_TEXT_FIELD_CHARS + 100);
        insert_usage(
            &conn,
            "recent-id",
            "2026-07-02T10:00:00Z",
            &long_model,
            "chat_v2",
            80,
            None,
            Some("secret-session"),
            Some("secret-config"),
            Some("secret-error"),
        );

        let output = LlmUsageToolExecutor::new()
            .execute_query(&conn, &json!({ "action": "recent", "limit": 1 }))
            .expect("recent query");
        let serialized = output.to_string();

        assert!(!serialized.contains("secret-session"));
        assert!(!serialized.contains("secret-config"));
        assert!(!serialized.contains("secret-error"));
        assert_eq!(
            output["items"][0]["modelId"]
                .as_str()
                .expect("bounded model")
                .chars()
                .count(),
            MAX_TEXT_FIELD_CHARS
        );
        assert_eq!(output["items"][0]["modelIdTruncated"], true);
        assert_eq!(output["page"]["limit"], 1);
    }

    #[test]
    fn trends_use_real_repo_data_and_keep_results_bounded() {
        let conn = setup_test_db();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        insert_usage(
            &conn,
            "today",
            &now,
            "model-a",
            "chat_v2",
            42,
            Some(0.01),
            None,
            None,
            None,
        );

        let output = LlmUsageToolExecutor::new()
            .execute_query(
                &conn,
                &json!({
                    "action": "trends",
                    "days": 1,
                    "granularity": "day",
                    "limit": 20
                }),
            )
            .expect("trends query");

        assert_eq!(output["items"].as_array().expect("trend items").len(), 1);
        assert_eq!(output["items"][0]["totalTokens"], 42);
        assert_eq!(output["page"]["limit"], 20);
        assert_eq!(output["cost"]["priceCoverage"]["status"], "complete");
    }
}
