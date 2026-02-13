use std::sync::Arc;
use tauri::State;

use super::database::LlmUsageDatabase;
use super::repo::LlmUsageRepo;
use super::types::{
    CallerTypeSummary, DailySummary, ModelSummary, TimeGranularity, UsageRecord, UsageSummary,
    UsageTrendPoint,
};

#[tauri::command]
pub async fn llm_usage_get_trends(
    db: State<'_, Arc<LlmUsageDatabase>>,
    days: u32,
    granularity: String,
) -> Result<Vec<UsageTrendPoint>, String> {
    let granularity = match granularity.as_str() {
        "hour" => TimeGranularity::Hour,
        "day" => TimeGranularity::Day,
        "week" => TimeGranularity::Week,
        "month" => TimeGranularity::Month,
        _ => TimeGranularity::Day,
    };

    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_usage_trends(&conn, days, &granularity).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn llm_usage_by_model(
    db: State<'_, Arc<LlmUsageDatabase>>,
    start_date: String,
    end_date: String,
) -> Result<Vec<ModelSummary>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_usage_by_model(&conn, &start_date, &end_date).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn llm_usage_by_caller(
    db: State<'_, Arc<LlmUsageDatabase>>,
    start_date: String,
    end_date: String,
) -> Result<Vec<CallerTypeSummary>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_usage_by_caller(&conn, &start_date, &end_date).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn llm_usage_summary(
    db: State<'_, Arc<LlmUsageDatabase>>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<UsageSummary, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_usage_summary(&conn, start_date.as_deref(), end_date.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn llm_usage_recent(
    db: State<'_, Arc<LlmUsageDatabase>>,
    limit: Option<u32>,
) -> Result<Vec<UsageRecord>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_recent_usage(&conn, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn llm_usage_daily(
    db: State<'_, Arc<LlmUsageDatabase>>,
    start_date: String,
    end_date: String,
) -> Result<Vec<DailySummary>, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::get_daily_summary(&conn, &start_date, &end_date).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn llm_usage_cleanup(
    db: State<'_, Arc<LlmUsageDatabase>>,
    before_date: String,
) -> Result<usize, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    LlmUsageRepo::delete_old_records(&conn, &before_date).map_err(|e| e.to_string())
}
