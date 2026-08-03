//! Read-only learning overview and Pomodoro statistics tools.

use std::collections::HashMap;
use std::time::Instant;

use async_trait::async_trait;
use chrono::{Duration, Local, NaiveDate};
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::arg_utils::with_localized_message;
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::LearningActivity;
use crate::fsrs_review_service::FsrsReviewService;
use crate::review_plan_service::ReviewPlanService;
use crate::vfs::repos::VfsPomodoroRepo;
use crate::vfs::types::PomodoroDailyStat;

const LEARNING_OVERVIEW: &str = "learning_overview";
const POMODORO_TODAY_STATS: &str = "pomodoro_today_stats";
const POMODORO_DAILY_STATS: &str = "pomodoro_daily_stats";
const MAX_RANGE_DAYS: i64 = 90;
const MAX_PAGE_SIZE: u32 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PageRequest {
    page: u32,
    page_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OverviewRequest {
    start_date: NaiveDate,
    end_date: NaiveDate,
    page: PageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DailyRequest {
    days: u32,
    page: PageRequest,
}

#[derive(Debug, Default)]
struct ActivityTotals {
    count: u64,
    chat_sessions: u64,
    chat_messages: u64,
    notes_edited: u64,
    textbooks_opened: u64,
    exams_created: u64,
    translations_created: u64,
    essays_created: u64,
    anki_cards_created: u64,
    questions_answered: u64,
}

pub struct LearningOverviewExecutor;

impl LearningOverviewExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_overview(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let request = parse_overview_request(arguments)?;
        let start_date = request.start_date.format("%Y-%m-%d").to_string();
        let end_date = request.end_date.format("%Y-%m-%d").to_string();
        let total_days = (request.end_date - request.start_date).num_days() as usize + 1;
        let mut source_errors = Vec::new();

        let (activities, activity_errors) = collect_learning_activities(
            request.start_date,
            request.end_date,
            ctx.chat_v2_db.as_deref(),
            ctx.vfs_db.as_deref(),
            ctx.anki_db.as_deref().or(ctx.main_db.as_deref()),
        );
        source_errors.extend(activity_errors);

        let vfs_db = ctx.vfs_db.as_ref();
        let pomodoro = match vfs_db {
            Some(db) => {
                let today = Local::now().date_naive();
                let days_to_today = (today - request.start_date).num_days() + 1;
                match u32::try_from(days_to_today).ok().filter(|days| *days > 0) {
                    Some(days) if days > 366 => {
                        source_errors.push(source_error(
                            "pomodoro",
                            "番茄钟日统计仅支持最近 366 天",
                            "Daily Pomodoro statistics are available only for the most recent 366 days.",
                        ));
                        Vec::new()
                    }
                    Some(days) => match VfsPomodoroRepo::get_daily_stats(db, days) {
                        Ok(items) => items
                            .into_iter()
                            .filter(|item| item.date >= start_date && item.date <= end_date)
                            .collect(),
                        Err(error) => {
                            source_errors.push(source_error(
                                "pomodoro",
                                "番茄钟统计暂时不可用",
                                format!("Pomodoro statistics are unavailable: {error}"),
                            ));
                            Vec::new()
                        }
                    },
                    None => Vec::new(),
                }
            }
            None => {
                source_errors.push(source_error(
                    "pomodoro",
                    "VFS 数据库尚未初始化，番茄钟统计不可用",
                    "The VFS database is not initialized, so Pomodoro statistics are unavailable.",
                ));
                Vec::new()
            }
        };

        let qbank = match vfs_db {
            Some(db) => match qbank_totals(db) {
                Ok(value) => Some(value),
                Err(error) => {
                    source_errors.push(source_error(
                        "question_bank",
                        "题库统计暂时不可用",
                        format!("Question bank statistics are unavailable: {error}"),
                    ));
                    None
                }
            },
            None => {
                source_errors.push(source_error(
                    "question_bank",
                    "VFS 数据库尚未初始化，题库统计不可用",
                    "The VFS database is not initialized, so question bank statistics are unavailable.",
                ));
                None
            }
        };

        let sm2_review = match vfs_db {
            Some(db) => match ReviewPlanService::new(db.clone()).get_review_stats(None) {
                Ok(stats) => serde_json::to_value(stats).ok(),
                Err(error) => {
                    source_errors.push(source_error(
                        "sm2_review",
                        "SM-2 复习统计暂时不可用",
                        format!("SM-2 review statistics are unavailable: {error}"),
                    ));
                    None
                }
            },
            None => {
                source_errors.push(source_error(
                    "sm2_review",
                    "VFS 数据库尚未初始化，SM-2 复习统计不可用",
                    "The VFS database is not initialized, so SM-2 review statistics are unavailable.",
                ));
                None
            }
        };

        let fsrs = match ctx.anki_db.as_ref() {
            Some(db) => match FsrsReviewService::new(db.clone()).get_stats() {
                Ok(stats) => serde_json::to_value(stats).ok(),
                Err(error) => {
                    source_errors.push(source_error(
                        "fsrs",
                        "FSRS 复习统计暂时不可用",
                        format!("FSRS review statistics are unavailable: {error}"),
                    ));
                    None
                }
            },
            None => {
                source_errors.push(source_error(
                    "fsrs",
                    "Anki 数据库尚未初始化，FSRS 统计不可用",
                    "The Anki database is not initialized, so FSRS statistics are unavailable.",
                ));
                None
            }
        };

        // A-P0/A-P1：掌握度摘要 + 今日优先复习（可附到期闪卡计数）
        let mastery = match vfs_db {
            Some(db) => match crate::mastery::MasteryService::new(db.clone()).overview_summary(5) {
                Ok(mut summary) => {
                    if let Some(anki) = ctx.anki_db.as_ref() {
                        if let Ok(due_cards) =
                            FsrsReviewService::new(anki.clone()).get_due(Some(200))
                        {
                            let mut due_by_concept: HashMap<String, u32> = HashMap::new();
                            for card in &due_cards {
                                if let Some(concept) =
                                    card.tags.iter().map(|t| t.trim()).find(|t| !t.is_empty())
                                {
                                    *due_by_concept.entry(concept.to_string()).or_insert(0) += 1;
                                }
                            }
                            for item in &mut summary.today_priority_review {
                                item.due_card_count =
                                    due_by_concept.get(&item.concept_key).copied();
                                if let Some(n) = item.due_card_count {
                                    item.reason = format!(
                                        "{}；今日到期 {} 张",
                                        item.reason.trim_end_matches('。'),
                                        n
                                    );
                                }
                            }
                        }
                    }
                    serde_json::to_value(summary).ok()
                }
                Err(error) => {
                    source_errors.push(source_error(
                        "mastery",
                        "掌握度统计暂时不可用",
                        format!("Mastery statistics are unavailable: {error}"),
                    ));
                    None
                }
            },
            None => {
                source_errors.push(source_error(
                    "mastery",
                    "VFS 数据库尚未初始化，掌握度统计不可用",
                    "The VFS database is not initialized, so mastery statistics are unavailable.",
                ));
                None
            }
        };

        let activity_totals = aggregate_activities(&activities);
        let pomodoro_totals = aggregate_pomodoro(&pomodoro);
        let daily = merge_daily(&activities, &pomodoro, request.start_date, request.end_date);
        let (daily_page, has_more) = paginate(&daily, &request.page);
        let partial = !source_errors.is_empty();

        Ok(with_localized_message(
            json!({
                "success": true,
                "range": {
                    "startDate": start_date,
                    "endDate": end_date,
                    "totalDays": total_days,
                },
                "activityTotals": activity_totals_json(&activity_totals),
                "focusTotals": pomodoro_totals,
                "questionBank": qbank,
                "fsrsReview": fsrs,
                "sm2Review": sm2_review,
                "mastery": mastery,
                "daily": daily_page,
                "page": request.page.page,
                "page_size": request.page.page_size,
                "total": daily.len(),
                "has_more": has_more,
                "truncated": has_more,
                "partial": partial,
                "sourceErrors": source_errors,
            }),
            "chat.tools.learning.overview_ready",
            json!({
                "startDate": start_date,
                "endDate": end_date,
                "focusSeconds": pomodoro_totals["focusSeconds"],
                "partial": partial,
            }),
            format!(
                "已汇总 {} 至 {} 的学习情况，专注 {} 秒{}",
                start_date,
                end_date,
                pomodoro_totals["focusSeconds"],
                if partial {
                    "；部分数据源不可用"
                } else {
                    ""
                }
            ),
            format!(
                "Learning activity from {} through {} is ready: {} focus seconds{}.",
                start_date,
                end_date,
                pomodoro_totals["focusSeconds"],
                if partial {
                    "; some sources were unavailable"
                } else {
                    ""
                }
            ),
        ))
    }

    fn execute_today(&self, arguments: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let object = arguments_object(arguments)?;
        ensure_allowed_keys(object, &[])?;
        let db = ctx.vfs_db.as_ref().ok_or_else(|| {
            learning_error(
                "LEARNING_DATABASE_UNAVAILABLE",
                "VFS 数据库尚未初始化",
                "The VFS database is not initialized.",
            )
        })?;
        let stats = VfsPomodoroRepo::get_today_stats(db).map_err(|error| {
            learning_error(
                "POMODORO_QUERY_FAILED",
                "无法读取今日番茄钟统计",
                format!("Could not read today's Pomodoro statistics: {error}"),
            )
        })?;
        let date = Local::now().date_naive().format("%Y-%m-%d").to_string();

        Ok(with_localized_message(
            json!({
                "success": true,
                "date": date,
                "stats": stats,
            }),
            "chat.tools.learning.pomodoro_today_ready",
            json!({
                "date": date,
                "completedCount": stats.completed_count,
                "focusSeconds": stats.total_focus_seconds,
                "interruptedCount": stats.interrupted_count,
            }),
            format!(
                "今日完成 {} 个番茄钟，专注 {} 秒，中断 {} 次",
                stats.completed_count, stats.total_focus_seconds, stats.interrupted_count
            ),
            format!(
                "Today: {} completed Pomodoro sessions, {} focus seconds, and {} interruptions.",
                stats.completed_count, stats.total_focus_seconds, stats.interrupted_count
            ),
        ))
    }

    fn execute_daily(&self, arguments: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let request = parse_daily_request(arguments)?;
        let db = ctx.vfs_db.as_ref().ok_or_else(|| {
            learning_error(
                "LEARNING_DATABASE_UNAVAILABLE",
                "VFS 数据库尚未初始化",
                "The VFS database is not initialized.",
            )
        })?;
        let items = VfsPomodoroRepo::get_daily_stats(db, request.days).map_err(|error| {
            learning_error(
                "POMODORO_QUERY_FAILED",
                "无法读取番茄钟每日统计",
                format!("Could not read daily Pomodoro statistics: {error}"),
            )
        })?;
        let totals = aggregate_pomodoro(&items);
        let (page_items, has_more) = paginate(&items, &request.page);

        Ok(with_localized_message(
            json!({
                "success": true,
                "days": request.days,
                "daily": page_items,
                "totals": totals,
                "page": request.page.page,
                "page_size": request.page.page_size,
                "total": items.len(),
                "has_more": has_more,
                "truncated": has_more,
            }),
            "chat.tools.learning.pomodoro_daily_ready",
            json!({
                "days": request.days,
                "focusSeconds": totals["focusSeconds"],
            }),
            format!(
                "近 {} 天累计专注 {} 秒",
                request.days, totals["focusSeconds"]
            ),
            format!(
                "The last {} days contain {} focus seconds.",
                request.days, totals["focusSeconds"]
            ),
        ))
    }
}

impl Default for LearningOverviewExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for LearningOverviewExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            LEARNING_OVERVIEW | POMODORO_TODAY_STATS | POMODORO_DAILY_STATS
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
            LEARNING_OVERVIEW => self.execute_overview(&call.arguments, ctx).await,
            POMODORO_TODAY_STATS => self.execute_today(&call.arguments, ctx),
            POMODORO_DAILY_STATS => self.execute_daily(&call.arguments, ctx),
            _ => Err(learning_error(
                "UNKNOWN_TOOL",
                "不支持的学习统计工具",
                format!("Unsupported learning statistics tool: {}", call.name),
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
                "[LearningOverviewExecutor] Failed to persist tool block: {}",
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
        "LearningOverviewExecutor"
    }
}

fn arguments_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments.as_object().ok_or_else(|| {
        invalid_argument(
            "arguments",
            "参数必须是 JSON 对象",
            "Arguments must be a JSON object.",
        )
    })
}

fn ensure_allowed_keys(arguments: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid_argument(
            key,
            format!("不支持字段 {key}"),
            format!("Unknown field '{key}'; additional properties are not allowed."),
        ));
    }
    Ok(())
}

fn parse_page(arguments: &Map<String, Value>) -> Result<PageRequest, String> {
    let page = optional_u32(arguments, "page", 1, 1, u32::MAX)?;
    let page_size = optional_u32(arguments, "page_size", MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE)?;
    Ok(PageRequest { page, page_size })
}

fn optional_u32(
    arguments: &Map<String, Value>,
    field: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let Some(value) = arguments.get(field) else {
        return Ok(default);
    };
    let raw = value.as_u64().ok_or_else(|| {
        invalid_argument(
            field,
            format!("{field} 必须是整数"),
            format!("'{field}' must be an integer."),
        )
    })?;
    let value = u32::try_from(raw).map_err(|_| {
        invalid_argument(
            field,
            format!("{field} 超出范围"),
            format!("'{field}' is outside the supported range."),
        )
    })?;
    if !(min..=max).contains(&value) {
        return Err(invalid_argument(
            field,
            format!("{field} 必须在 {min}..={max} 范围内"),
            format!("'{field}' must be between {min} and {max}."),
        ));
    }
    Ok(value)
}

fn optional_date(arguments: &Map<String, Value>, field: &str) -> Result<Option<NaiveDate>, String> {
    let Some(value) = arguments.get(field) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        invalid_argument(
            field,
            format!("{field} 必须是 YYYY-MM-DD 字符串"),
            format!("'{field}' must be a YYYY-MM-DD string."),
        )
    })?;
    if value.len() != 10 {
        return Err(invalid_argument(
            field,
            format!("{field} 必须使用精确 YYYY-MM-DD 格式"),
            format!("'{field}' must use the exact YYYY-MM-DD format."),
        ));
    }
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        invalid_argument(
            field,
            format!("{field} 不是有效日历日期"),
            format!("'{field}' is not a valid calendar date."),
        )
    })?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(invalid_argument(
            field,
            format!("{field} 必须使用精确 YYYY-MM-DD 格式"),
            format!("'{field}' must use the exact YYYY-MM-DD format."),
        ));
    }
    Ok(Some(parsed))
}

fn parse_overview_request(arguments: &Value) -> Result<OverviewRequest, String> {
    let arguments = arguments_object(arguments)?;
    ensure_allowed_keys(arguments, &["start_date", "end_date", "page", "page_size"])?;
    let start_date = optional_date(arguments, "start_date")?;
    let end_date = optional_date(arguments, "end_date")?;
    let today = Local::now().date_naive();
    let (start_date, end_date) = match (start_date, end_date) {
        (None, None) => (today - Duration::days(6), today),
        (Some(start), Some(end)) => (start, end),
        _ => {
            return Err(invalid_argument(
                "date_range",
                "start_date 与 end_date 必须同时提供或同时省略",
                "Provide both start_date and end_date, or omit both.",
            ))
        }
    };
    if start_date > end_date {
        return Err(invalid_argument(
            "start_date",
            "start_date 不得晚于 end_date",
            "start_date must not be later than end_date.",
        ));
    }
    if end_date > today {
        return Err(invalid_argument(
            "end_date",
            "end_date 不得晚于今天",
            "end_date must not be later than today.",
        ));
    }
    let days = (end_date - start_date).num_days() + 1;
    if days > MAX_RANGE_DAYS {
        return Err(invalid_argument(
            "date_range",
            format!("日期范围最多 {MAX_RANGE_DAYS} 天"),
            format!("The date range may contain at most {MAX_RANGE_DAYS} days."),
        ));
    }
    Ok(OverviewRequest {
        start_date,
        end_date,
        page: parse_page(arguments)?,
    })
}

fn parse_daily_request(arguments: &Value) -> Result<DailyRequest, String> {
    let arguments = arguments_object(arguments)?;
    ensure_allowed_keys(arguments, &["days", "page", "page_size"])?;
    Ok(DailyRequest {
        days: optional_u32(arguments, "days", 7, 1, MAX_RANGE_DAYS as u32)?,
        page: parse_page(arguments)?,
    })
}

fn invalid_argument(field: &str, zh_cn: impl Into<String>, en_us: impl Into<String>) -> String {
    let zh_cn = zh_cn.into();
    let en_us = en_us.into();
    with_localized_message(
        json!({
            "code": "INVALID_ARGUMENT",
            "field": field,
            "retryable": false,
        }),
        "chat.tools.learning.invalid_argument",
        json!({ "field": field }),
        zh_cn,
        en_us,
    )
    .to_string()
}

fn learning_error(code: &str, zh_cn: impl Into<String>, en_us: impl Into<String>) -> String {
    with_localized_message(
        json!({ "code": code, "retryable": true }),
        "chat.tools.learning.query_failed",
        json!({ "code": code }),
        zh_cn,
        en_us,
    )
    .to_string()
}

fn source_error(source: &str, zh_cn: impl Into<String>, en_us: impl Into<String>) -> Value {
    with_localized_message(
        json!({
            "source": source,
            "code": "SOURCE_UNAVAILABLE",
            "retryable": true,
        }),
        "chat.tools.learning.source_unavailable",
        json!({ "source": source }),
        zh_cn,
        en_us,
    )
}

fn qbank_totals(db: &crate::vfs::database::VfsDatabase) -> Result<Value, String> {
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let question_banks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM exam_sheets WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let totals: Option<(i64, i64, i64, i64, i64, i64, i64)> = conn
        .query_row(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(attempt_count), 0),
                COALESCE(SUM(correct_count), 0)
            FROM questions
            WHERE deleted_at IS NULL
            "#,
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (total, new_count, in_progress, mastered, review, attempts, correct) =
        totals.unwrap_or_default();
    let correct_rate = if attempts > 0 {
        correct as f64 / attempts as f64
    } else {
        0.0
    };
    Ok(json!({
        "questionBanks": question_banks,
        "totalQuestions": total,
        "new": new_count,
        "inProgress": in_progress,
        "mastered": mastered,
        "review": review,
        "totalAttempts": attempts,
        "totalCorrect": correct,
        "correctRate": correct_rate,
        "source": "questions_table_read_only",
    }))
}

fn query_date_counts(
    conn: &rusqlite::Connection,
    sql: &str,
    start: &str,
    end: &str,
) -> Result<Vec<(String, u32)>, String> {
    conn.prepare(sql)
        .and_then(|mut statement| {
            let rows = statement.query_map(rusqlite::params![start, end], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })?;
            rows.collect()
        })
        .map_err(|error| error.to_string())
}

fn empty_activity_details() -> crate::commands::DailyActivityDetails {
    crate::commands::DailyActivityDetails {
        chat_sessions: 0,
        chat_messages: 0,
        notes_edited: 0,
        textbooks_opened: 0,
        exams_created: 0,
        translations_created: 0,
        essays_created: 0,
        anki_cards_created: 0,
        questions_answered: 0,
    }
}

/// Database-backed activity aggregation shared by the executor and headless
/// tests. This mirrors the Learning Hub heatmap sources without requiring an
/// `AppHandle`. Each unavailable source is reported while the remaining
/// sources continue to contribute data.
fn collect_learning_activities(
    start: NaiveDate,
    end: NaiveDate,
    chat_db: Option<&crate::chat_v2::database::ChatV2Database>,
    vfs_db: Option<&crate::vfs::database::VfsDatabase>,
    anki_db: Option<&crate::database::Database>,
) -> (Vec<LearningActivity>, Vec<Value>) {
    let start_date = start.format("%Y-%m-%d").to_string();
    let end_date = end.format("%Y-%m-%d").to_string();
    let mut daily_map = HashMap::new();
    let mut date = start;
    while date <= end {
        daily_map.insert(
            date.format("%Y-%m-%d").to_string(),
            empty_activity_details(),
        );
        date += Duration::days(1);
    }

    let mut query_errors = Vec::new();
    let mut source_errors = Vec::new();
    let mut apply =
        |conn: &rusqlite::Connection,
         sql: &str,
         source: &str,
         assign: fn(&mut crate::commands::DailyActivityDetails, u32)| {
            match query_date_counts(conn, sql, &start_date, &end_date) {
                Ok(rows) => {
                    for (date, count) in rows {
                        if let Some(details) = daily_map.get_mut(&date) {
                            assign(details, count);
                        }
                    }
                }
                Err(error) => query_errors.push(source_error(
                    source,
                    format!("学习活动数据源 {source} 暂时不可用"),
                    format!("Learning activity source {source} is unavailable: {error}"),
                )),
            }
        };

    if let Some(db) = chat_db {
        match db.get_conn_safe() {
            Ok(conn) => {
                apply(
                    &conn,
                    "SELECT DATE(created_at), COUNT(*) FROM chat_v2_sessions \
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2 \
                 GROUP BY DATE(created_at)",
                    "learning_activity.chat_sessions",
                    |details, count| details.chat_sessions = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(datetime(timestamp/1000, 'unixepoch')), COUNT(*) \
                 FROM chat_v2_messages \
                 WHERE DATE(datetime(timestamp/1000, 'unixepoch')) >= ?1 \
                   AND DATE(datetime(timestamp/1000, 'unixepoch')) <= ?2 \
                 GROUP BY DATE(datetime(timestamp/1000, 'unixepoch'))",
                    "learning_activity.chat_messages",
                    |details, count| details.chat_messages = count,
                );
            }
            Err(error) => source_errors.push(source_error(
                "learning_activity.chat_v2",
                "ChatV2 学习活动暂时不可用",
                format!("ChatV2 learning activity is unavailable: {error}"),
            )),
        }
    } else {
        source_errors.push(source_error(
            "learning_activity.chat_v2",
            "ChatV2 数据库尚未初始化",
            "The ChatV2 database is not initialized.",
        ));
    }

    if let Some(db) = vfs_db {
        match db.get_conn_safe() {
            Ok(conn) => {
                apply(
                    &conn,
                    "SELECT DATE(updated_at), COUNT(*) FROM notes \
                 WHERE deleted_at IS NULL AND DATE(updated_at) >= ?1 AND DATE(updated_at) <= ?2 \
                 GROUP BY DATE(updated_at)",
                    "learning_activity.notes",
                    |details, count| details.notes_edited = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(last_opened_at), COUNT(*) FROM files \
                 WHERE last_opened_at IS NOT NULL \
                   AND DATE(last_opened_at) >= ?1 AND DATE(last_opened_at) <= ?2 \
                 GROUP BY DATE(last_opened_at)",
                    "learning_activity.textbooks",
                    |details, count| details.textbooks_opened = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(created_at), COUNT(*) FROM exam_sheets \
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2 \
                 GROUP BY DATE(created_at)",
                    "learning_activity.exams",
                    |details, count| details.exams_created = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(created_at), COUNT(*) FROM translations \
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2 \
                 GROUP BY DATE(created_at)",
                    "learning_activity.translations",
                    |details, count| details.translations_created = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(created_at), COUNT(*) FROM essays \
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2 \
                 GROUP BY DATE(created_at)",
                    "learning_activity.essays",
                    |details, count| details.essays_created = count,
                );
                apply(
                    &conn,
                    "SELECT DATE(submitted_at), COUNT(*) FROM answer_submissions \
                 WHERE DATE(submitted_at) >= ?1 AND DATE(submitted_at) <= ?2 \
                 GROUP BY DATE(submitted_at)",
                    "learning_activity.questions",
                    |details, count| details.questions_answered = count,
                );
            }
            Err(error) => source_errors.push(source_error(
                "learning_activity.vfs",
                "VFS 学习活动暂时不可用",
                format!("VFS learning activity is unavailable: {error}"),
            )),
        }
    } else {
        source_errors.push(source_error(
            "learning_activity.vfs",
            "VFS 数据库尚未初始化",
            "The VFS database is not initialized.",
        ));
    }

    if let Some(db) = anki_db {
        let conn_handle = db.conn();
        match conn_handle.lock() {
            Ok(conn) => apply(
                &conn,
                "SELECT DATE(created_at), COUNT(*) FROM anki_cards \
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2 \
                 GROUP BY DATE(created_at)",
                "learning_activity.anki",
                |details, count| details.anki_cards_created = count,
            ),
            Err(error) => source_errors.push(source_error(
                "learning_activity.anki",
                "Anki 学习活动暂时不可用",
                format!("Anki learning activity is unavailable: {error}"),
            )),
        }
    } else {
        source_errors.push(source_error(
            "learning_activity.anki",
            "Anki 数据库尚未初始化",
            "The Anki database is not initialized.",
        ));
    }

    drop(apply);
    query_errors.extend(source_errors);

    let mut activities = daily_map
        .into_iter()
        .map(|(date, details)| LearningActivity {
            date,
            count: details.chat_sessions
                + details.chat_messages
                + details.notes_edited
                + details.textbooks_opened
                + details.exams_created
                + details.translations_created
                + details.essays_created
                + details.anki_cards_created
                + details.questions_answered,
            details,
        })
        .collect::<Vec<_>>();
    activities.sort_by(|left, right| left.date.cmp(&right.date));
    (activities, query_errors)
}

fn aggregate_activities(activities: &[LearningActivity]) -> ActivityTotals {
    let mut totals = ActivityTotals::default();
    for activity in activities {
        totals.count += u64::from(activity.count);
        totals.chat_sessions += u64::from(activity.details.chat_sessions);
        totals.chat_messages += u64::from(activity.details.chat_messages);
        totals.notes_edited += u64::from(activity.details.notes_edited);
        totals.textbooks_opened += u64::from(activity.details.textbooks_opened);
        totals.exams_created += u64::from(activity.details.exams_created);
        totals.translations_created += u64::from(activity.details.translations_created);
        totals.essays_created += u64::from(activity.details.essays_created);
        totals.anki_cards_created += u64::from(activity.details.anki_cards_created);
        totals.questions_answered += u64::from(activity.details.questions_answered);
    }
    totals
}

fn activity_totals_json(totals: &ActivityTotals) -> Value {
    json!({
        "count": totals.count,
        "chatSessions": totals.chat_sessions,
        "chatMessages": totals.chat_messages,
        "notesEdited": totals.notes_edited,
        "textbooksOpened": totals.textbooks_opened,
        "examsCreated": totals.exams_created,
        "translationsCreated": totals.translations_created,
        "essaysCreated": totals.essays_created,
        "ankiCardsCreated": totals.anki_cards_created,
        "questionsAnswered": totals.questions_answered,
    })
}

fn aggregate_pomodoro(items: &[PomodoroDailyStat]) -> Value {
    json!({
        "completedCount": items.iter().map(|item| item.completed_count as u64).sum::<u64>(),
        "focusSeconds": items.iter().map(|item| item.focus_seconds).sum::<i64>(),
        "interruptedCount": items.iter().map(|item| item.interrupted_count as u64).sum::<u64>(),
    })
}

fn merge_daily(
    activities: &[LearningActivity],
    pomodoro: &[PomodoroDailyStat],
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Vec<Value> {
    let activity_by_date: HashMap<&str, &LearningActivity> = activities
        .iter()
        .map(|item| (item.date.as_str(), item))
        .collect();
    let pomodoro_by_date: HashMap<&str, &PomodoroDailyStat> = pomodoro
        .iter()
        .map(|item| (item.date.as_str(), item))
        .collect();
    let mut daily = Vec::new();
    let mut date = start_date;
    while date <= end_date {
        let date_string = date.format("%Y-%m-%d").to_string();
        let activity = activity_by_date.get(date_string.as_str()).copied();
        let focus = pomodoro_by_date.get(date_string.as_str()).copied();
        daily.push(json!({
            "date": date_string,
            "activityCount": activity.map(|item| item.count).unwrap_or(0),
            "activities": activity
                .and_then(|item| serde_json::to_value(&item.details).ok())
                .unwrap_or_else(|| json!({
                    "chatSessions": 0,
                    "chatMessages": 0,
                    "notesEdited": 0,
                    "textbooksOpened": 0,
                    "examsCreated": 0,
                    "translationsCreated": 0,
                    "essaysCreated": 0,
                    "ankiCardsCreated": 0,
                    "questionsAnswered": 0,
                })),
            "pomodoro": focus
                .and_then(|item| serde_json::to_value(item).ok())
                .unwrap_or_else(|| json!({
                    "date": date_string,
                    "completedCount": 0,
                    "focusSeconds": 0,
                    "interruptedCount": 0,
                })),
        }));
        date += Duration::days(1);
    }
    daily
}

fn paginate<T: Clone>(items: &[T], page: &PageRequest) -> (Vec<T>, bool) {
    let offset = (page.page as usize - 1).saturating_mul(page.page_size as usize);
    let page_items = items
        .iter()
        .skip(offset)
        .take(page.page_size as usize)
        .cloned()
        .collect::<Vec<_>>();
    let has_more = offset.saturating_add(page_items.len()) < items.len();
    (page_items, has_more)
}

#[cfg(test)]
mod tests {
    use super::super::executor::ToolExecutor;
    use super::*;
    use crate::commands::DailyActivityDetails;

    fn setup_learning_databases() -> (
        tempfile::TempDir,
        crate::chat_v2::database::ChatV2Database,
        crate::vfs::VfsDatabase,
    ) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::tempdir().expect("create learning test directory");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("apply ChatV2 migrations");
        coordinator
            .migrate_single(DatabaseId::Vfs)
            .expect("apply VFS migrations");
        let chat_db = crate::chat_v2::database::ChatV2Database::new(temp_dir.path())
            .expect("open migrated ChatV2 database");
        let vfs_db =
            crate::vfs::VfsDatabase::new(temp_dir.path()).expect("open migrated VFS database");
        (temp_dir, chat_db, vfs_db)
    }

    fn error_json(error: String) -> Value {
        serde_json::from_str(&error).expect("structured learning error")
    }

    #[test]
    fn overview_defaults_to_seven_days_and_strict_pagination() {
        let request = parse_overview_request(&json!({})).expect("default request");
        assert_eq!((request.end_date - request.start_date).num_days() + 1, 7);
        assert_eq!(
            request.page,
            PageRequest {
                page: 1,
                page_size: 20
            }
        );

        let error = error_json(
            parse_overview_request(&json!({ "page_size": 21 }))
                .expect_err("page size must be bounded"),
        );
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["field"], "page_size");
        assert!(error["messageFallback"]["en-US"].is_string());
    }

    #[test]
    fn overview_requires_exact_bounded_past_date_range() {
        for arguments in [
            json!({ "start_date": "2026-07-01" }),
            json!({ "start_date": "2026-7-01", "end_date": "2026-07-02" }),
            json!({ "start_date": "2026-02-30", "end_date": "2026-03-01" }),
            json!({ "start_date": "2026-07-02", "end_date": "2026-07-01" }),
            json!({ "unknown": true }),
        ] {
            assert!(parse_overview_request(&arguments).is_err(), "{arguments}");
        }

        let today = Local::now().date_naive();
        let too_old = today - Duration::days(MAX_RANGE_DAYS);
        assert!(parse_overview_request(&json!({
            "start_date": too_old.format("%Y-%m-%d").to_string(),
            "end_date": today.format("%Y-%m-%d").to_string(),
        }))
        .is_err());
    }

    #[test]
    fn daily_parser_is_closed_and_bounded() {
        assert_eq!(
            parse_daily_request(&json!({ "days": 30, "page": 2, "page_size": 10 }))
                .expect("daily request"),
            DailyRequest {
                days: 30,
                page: PageRequest {
                    page: 2,
                    page_size: 10
                },
            }
        );
        assert!(parse_daily_request(&json!({ "days": 0 })).is_err());
        assert!(parse_daily_request(&json!({ "days": 91 })).is_err());
        assert!(parse_daily_request(&json!({ "offset": 1 })).is_err());
    }

    #[test]
    fn normal_aggregation_and_pagination_preserve_full_totals() {
        let activities = vec![LearningActivity {
            date: "2026-07-14".to_string(),
            count: 3,
            details: DailyActivityDetails {
                chat_sessions: 1,
                chat_messages: 2,
                notes_edited: 0,
                textbooks_opened: 0,
                exams_created: 0,
                translations_created: 0,
                essays_created: 0,
                anki_cards_created: 0,
                questions_answered: 0,
            },
        }];
        let pomodoro = vec![PomodoroDailyStat {
            date: "2026-07-14".to_string(),
            completed_count: 2,
            focus_seconds: 3_000,
            interrupted_count: 1,
        }];
        let totals = aggregate_activities(&activities);
        assert_eq!(totals.count, 3);
        assert_eq!(totals.chat_messages, 2);
        assert_eq!(aggregate_pomodoro(&pomodoro)["focusSeconds"], 3_000);

        let daily = merge_daily(
            &activities,
            &pomodoro,
            NaiveDate::from_ymd_opt(2026, 7, 13).unwrap(),
            NaiveDate::from_ymd_opt(2026, 7, 14).unwrap(),
        );
        let (first_page, has_more) = paginate(
            &daily,
            &PageRequest {
                page: 1,
                page_size: 1,
            },
        );
        assert_eq!(first_page.len(), 1);
        assert!(has_more);
        assert_eq!(daily[1]["pomodoro"]["focusSeconds"], 3_000);
    }

    #[test]
    fn all_tools_are_low_sensitivity_read_only() {
        let executor = LearningOverviewExecutor::new();
        for name in [
            "builtin-learning_overview",
            "builtin-pomodoro_today_stats",
            "builtin-pomodoro_daily_stats",
        ] {
            assert!(executor.can_handle(name));
            assert_eq!(executor.sensitivity_level(name), ToolSensitivity::Low);
            assert_eq!(executor.concurrency_class(name), ToolConcurrency::ReadOnly);
        }
        assert!(!executor.can_handle("builtin-pomodoro_create"));
    }

    #[test]
    fn learning_activity_and_pomodoro_aggregate_real_migrated_rows() {
        use crate::chat_v2::repo::ChatV2Repo;
        use crate::chat_v2::types::{ChatMessage, ChatSession};
        use crate::vfs::types::CreatePomodoroRecordParams;

        let (_temp_dir, chat_db, vfs_db) = setup_learning_databases();
        let session = ChatSession::new("sess_learning_repo".to_string(), "chat".to_string());
        let activity_date = session.created_at.date_naive();
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("persist learning session");
        let message = ChatMessage::new_user(session.id.clone(), Vec::new());
        ChatV2Repo::create_message_v2(&chat_db, &message).expect("persist learning message");
        let submission_time = format!("{activity_date}T12:00:00Z");
        let related_record_time = format!("{}T12:00:00Z", activity_date - Duration::days(1));
        let conn = vfs_db.get_conn_safe().expect("open migrated VFS database");
        conn.execute(
            "INSERT INTO exam_sheets
                (id, status, temp_id, metadata_json, preview_json, created_at, updated_at)
             VALUES (?1, 'completed', ?2, '{}', '{}', ?3, ?3)",
            rusqlite::params![
                "exam_learning_repo",
                "temp_learning_repo",
                related_record_time
            ],
        )
        .expect("persist learning exam");
        conn.execute(
            "INSERT INTO questions (id, exam_id, content, created_at, updated_at)
             VALUES (?1, ?2, 'Learning question', ?3, ?3)",
            rusqlite::params![
                "question_learning_repo",
                "exam_learning_repo",
                related_record_time
            ],
        )
        .expect("persist learning question");
        conn.execute(
            "INSERT INTO answer_submissions
                (id, question_id, user_answer, is_correct, grading_method, submitted_at)
             VALUES (?1, ?2, 'A', 1, 'auto', ?3)",
            rusqlite::params![
                "submission_learning_repo",
                "question_learning_repo",
                submission_time
            ],
        )
        .expect("persist learning answer submission");
        drop(conn);

        let (activities, source_errors) = collect_learning_activities(
            activity_date,
            activity_date,
            Some(&chat_db),
            Some(&vfs_db),
            None,
        );
        assert_eq!(source_errors.len(), 1);
        assert_eq!(source_errors[0]["source"], "learning_activity.anki");
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].details.chat_sessions, 1);
        assert_eq!(activities[0].details.chat_messages, 1);
        assert_eq!(activities[0].details.questions_answered, 1);
        assert_eq!(activities[0].count, 3);
        let activity_totals = aggregate_activities(&activities);
        assert_eq!(activity_totals.chat_sessions, 1);
        assert_eq!(activity_totals.chat_messages, 1);
        assert_eq!(activity_totals.questions_answered, 1);

        let now = chrono::Utc::now();
        crate::vfs::repos::VfsPomodoroRepo::create_record(
            &vfs_db,
            CreatePomodoroRecordParams {
                todo_item_id: None,
                start_time: (now - Duration::minutes(25)).to_rfc3339(),
                end_time: Some(now.to_rfc3339()),
                duration: 1_500,
                actual_duration: 1_420,
                r#type: "work".to_string(),
                status: "completed".to_string(),
            },
        )
        .expect("persist completed pomodoro");
        crate::vfs::repos::VfsPomodoroRepo::create_record(
            &vfs_db,
            CreatePomodoroRecordParams {
                todo_item_id: None,
                start_time: now.to_rfc3339(),
                end_time: None,
                duration: 1_500,
                actual_duration: 90,
                r#type: "work".to_string(),
                status: "interrupted".to_string(),
            },
        )
        .expect("persist interrupted pomodoro");

        let daily = VfsPomodoroRepo::get_daily_stats(&vfs_db, 1)
            .expect("aggregate persisted pomodoro rows");
        let focus = aggregate_pomodoro(&daily);
        assert_eq!(focus["completedCount"], 1);
        assert_eq!(focus["interruptedCount"], 1);
        assert_eq!(focus["focusSeconds"], 1_510);
    }

    #[test]
    fn learning_activity_sql_failures_are_reported_as_partial_sources() {
        let temp_dir = tempfile::tempdir().expect("create unmigrated ChatV2 directory");
        let chat_db = crate::chat_v2::database::ChatV2Database::new(temp_dir.path())
            .expect("open intentionally unmigrated ChatV2 database");
        let today = Local::now().date_naive();
        let (activities, errors) =
            collect_learning_activities(today, today, Some(&chat_db), None, None);

        assert_eq!(activities.len(), 1);
        assert!(errors
            .iter()
            .any(|error| error["source"] == "learning_activity.chat_sessions"));
        assert!(errors
            .iter()
            .any(|error| error["source"] == "learning_activity.vfs"));
        assert!(errors
            .iter()
            .any(|error| error["source"] == "learning_activity.anki"));
        assert!(errors
            .iter()
            .all(|error| error["code"] == "SOURCE_UNAVAILABLE"));
    }
}
