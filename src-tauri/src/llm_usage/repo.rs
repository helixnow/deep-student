use chrono::Utc;
use rusqlite::{params, Connection, Transaction};
use tracing::debug;

use super::database::LlmUsageResult;
use super::types::{
    CallerType, CallerTypeSummary, DailySummary, ModelSummary, TimeGranularity, UsageRecord,
    UsageSummary, UsageTrendPoint,
};

pub struct LlmUsageRepo;

impl LlmUsageRepo {
    pub fn insert_usage(conn: &Connection, record: &UsageRecord) -> LlmUsageResult<()> {
        debug!("[LlmUsageRepo] Inserting usage record: id={}", record.id);

        let status = if record.success { "success" } else { "error" };
        let timestamp = record.created_at.to_rfc3339();

        // 从 model_id 推断 provider
        let provider = Self::infer_provider(&record.model_id);

        conn.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, adapter, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens, token_source,
                duration_ms, caller_type, session_id, status, error_message, cost_estimate
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18
            )
            "#,
            params![
                record.id,
                timestamp,
                provider,
                record.model_id,
                Option::<String>::None,
                record.config_id,
                record.prompt_tokens,
                record.completion_tokens,
                record.total_tokens,
                record.reasoning_tokens,
                record.cached_tokens,
                "api",
                record.duration_ms,
                record.caller_type.to_string(),
                record.caller_id,
                status,
                record.error_message,
                record.estimated_cost_usd,
            ],
        )?;

        Ok(())
    }

    /// 从 model_id 推断供应商名称
    fn infer_provider(model_id: &str) -> &'static str {
        let model_lower = model_id.to_lowercase();

        if model_lower.contains("gpt") || model_lower.contains("o1") || model_lower.contains("o3") {
            "openai"
        } else if model_lower.contains("claude") {
            "anthropic"
        } else if model_lower.contains("gemini") || model_lower.contains("gemma") {
            "google"
        } else if model_lower.contains("deepseek") {
            "deepseek"
        } else if model_lower.contains("qwen") || model_lower.contains("qwq") {
            "alibaba"
        } else if model_lower.contains("llama")
            || model_lower.contains("mixtral")
            || model_lower.contains("mistral")
        {
            "meta/mistral"
        } else if model_lower.contains("embedding") || model_lower.contains("bge") {
            "embedding"
        } else if model_lower.contains("rerank") {
            "reranker"
        } else {
            "unknown"
        }
    }

    pub fn insert_usage_batch(
        conn: &mut Connection,
        records: &[UsageRecord],
    ) -> LlmUsageResult<usize> {
        if records.is_empty() {
            return Ok(0);
        }

        debug!(
            "[LlmUsageRepo] Batch inserting {} usage records",
            records.len()
        );

        let tx = conn.transaction()?;
        let mut count = 0;

        for record in records {
            if Self::insert_usage_in_tx(&tx, record).is_ok() {
                count += 1;
            }
        }

        tx.commit()?;
        debug!("[LlmUsageRepo] Batch insert completed: {} records", count);

        Ok(count)
    }

    fn insert_usage_in_tx(tx: &Transaction, record: &UsageRecord) -> LlmUsageResult<()> {
        let status = if record.success { "success" } else { "error" };
        let timestamp = record.created_at.to_rfc3339();
        let provider = Self::infer_provider(&record.model_id);

        tx.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, adapter, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens, token_source,
                duration_ms, caller_type, session_id, status, error_message, cost_estimate
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18
            )
            "#,
            params![
                record.id,
                timestamp,
                provider,
                record.model_id,
                Option::<String>::None,
                record.config_id,
                record.prompt_tokens,
                record.completion_tokens,
                record.total_tokens,
                record.reasoning_tokens,
                record.cached_tokens,
                "api",
                record.duration_ms,
                record.caller_type.to_string(),
                record.caller_id,
                status,
                record.error_message,
                record.estimated_cost_usd,
            ],
        )?;

        Ok(())
    }

    pub fn get_usage_trends(
        conn: &Connection,
        days: u32,
        granularity: &TimeGranularity,
    ) -> LlmUsageResult<Vec<UsageTrendPoint>> {
        let time_format = match granularity {
            TimeGranularity::Hour => "%Y-%m-%d %H:00",
            TimeGranularity::Day => "%Y-%m-%d",
            TimeGranularity::Week => "%Y-W%W",
            TimeGranularity::Month => "%Y-%m",
        };

        let sql = format!(
            r#"
            SELECT
                strftime('{}', timestamp) as time_key,
                SUM(total_tokens) as total_tokens,
                SUM(prompt_tokens) as prompt_tokens,
                SUM(completion_tokens) as completion_tokens,
                COUNT(*) as call_count,
                MIN(timestamp) as first_ts
            FROM llm_usage_logs
            WHERE timestamp >= datetime('now', '-{} days')
            GROUP BY time_key
            ORDER BY time_key ASC
            "#,
            time_format, days
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            let time_label: String = row.get(0)?;
            let first_ts: String = row.get::<_, String>(5).unwrap_or_default();
            let timestamp = chrono::DateTime::parse_from_rfc3339(&first_ts)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            Ok(UsageTrendPoint {
                time_label,
                timestamp,
                total_tokens: row.get::<_, i64>(1)? as u64,
                prompt_tokens: row.get::<_, i64>(2)? as u64,
                completion_tokens: row.get::<_, i64>(3)? as u64,
                request_count: row.get::<_, i64>(4)? as u32,
                estimated_cost_usd: None,
                success_rate: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }

    pub fn get_usage_by_model(
        conn: &Connection,
        start_date: &str,
        end_date: &str,
    ) -> LlmUsageResult<Vec<ModelSummary>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                model,
                COUNT(*) as call_count,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                COALESCE(SUM(cost_estimate), 0) as total_cost_estimate
            FROM llm_usage_logs
            WHERE date_key >= ?1 AND date_key <= ?2
            GROUP BY model
            ORDER BY total_tokens DESC
            "#,
        )?;

        let rows = stmt.query_map(params![start_date, end_date], |row| {
            Ok(ModelSummary {
                model_id: row.get(0)?,
                request_count: row.get::<_, i64>(1)? as u64,
                prompt_tokens: row.get::<_, i64>(2)? as u64,
                completion_tokens: row.get::<_, i64>(3)? as u64,
                total_tokens: row.get::<_, i64>(4)? as u64,
                estimated_cost_usd: row.get(5).ok(),
                percentage: None,
                avg_tokens_per_request: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }

    pub fn get_usage_by_caller(
        conn: &Connection,
        start_date: &str,
        end_date: &str,
    ) -> LlmUsageResult<Vec<CallerTypeSummary>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                caller_type,
                COUNT(*) as call_count,
                SUM(total_tokens) as total_tokens,
                COALESCE(SUM(cost_estimate), 0) as total_cost_estimate
            FROM llm_usage_logs
            WHERE date_key >= ?1 AND date_key <= ?2
            GROUP BY caller_type
            ORDER BY total_tokens DESC
            "#,
        )?;

        let rows = stmt.query_map(params![start_date, end_date], |row| {
            let caller_type_str: String = row.get(0)?;
            let caller_type = CallerType::from_str(&caller_type_str);
            let display_name = caller_type.display_name().to_string();
            Ok(CallerTypeSummary {
                caller_type,
                display_name,
                request_count: row.get::<_, i64>(1)? as u64,
                total_tokens: row.get::<_, i64>(2)? as u64,
                estimated_cost_usd: row.get(3).ok(),
                percentage: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }

    pub fn get_usage_summary(
        conn: &Connection,
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> LlmUsageResult<UsageSummary> {
        let (where_clause, params_vec): (String, Vec<String>) = match (start_date, end_date) {
            (Some(start), Some(end)) => (
                "WHERE date_key >= ?1 AND date_key <= ?2".to_string(),
                vec![start.to_string(), end.to_string()],
            ),
            (Some(start), None) => ("WHERE date_key >= ?1".to_string(), vec![start.to_string()]),
            (None, Some(end)) => ("WHERE date_key <= ?1".to_string(), vec![end.to_string()]),
            (None, None) => (String::new(), vec![]),
        };

        let sql = format!(
            r#"
            SELECT
                COUNT(*) as total_calls,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
                COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
                COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
                COALESCE(SUM(cost_estimate), 0) as total_cost_estimate,
                COALESCE(AVG(duration_ms), 0) as avg_duration_ms
            FROM llm_usage_logs
            {}
            "#,
            where_clause
        );

        let mut stmt = conn.prepare(&sql)?;
        let now = Utc::now();

        let build_summary = |row: &rusqlite::Row| -> rusqlite::Result<UsageSummary> {
            Ok(UsageSummary {
                start_date: now,
                end_date: now,
                total_requests: row.get::<_, i64>(0)? as u64,
                success_requests: row.get::<_, i64>(6)? as u64,
                error_requests: row.get::<_, i64>(7)? as u64,
                total_prompt_tokens: row.get::<_, i64>(1)? as u64,
                total_completion_tokens: row.get::<_, i64>(2)? as u64,
                total_tokens: row.get::<_, i64>(3)? as u64,
                total_reasoning_tokens: Some(row.get::<_, i64>(4)? as u64),
                total_cached_tokens: Some(row.get::<_, i64>(5)? as u64),
                total_estimated_cost_usd: row.get(8).ok(),
                avg_tokens_per_request: None,
                avg_duration_ms: row.get(9).ok(),
                by_caller_type: None,
                by_model: None,
                trend_points: None,
            })
        };

        let summary = if params_vec.is_empty() {
            stmt.query_row([], build_summary)?
        } else if params_vec.len() == 1 {
            stmt.query_row(params![params_vec[0]], build_summary)?
        } else {
            stmt.query_row(params![params_vec[0], params_vec[1]], build_summary)?
        };

        Ok(summary)
    }

    pub fn get_recent_usage(conn: &Connection, limit: u32) -> LlmUsageResult<Vec<UsageRecord>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, timestamp, model, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens,
                duration_ms, caller_type, session_id, status, error_message, cost_estimate
            FROM llm_usage_logs
            ORDER BY timestamp DESC
            LIMIT ?1
            "#,
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            let caller_type_str: String = row.get(10)?;
            let status: String = row.get(12)?;
            let timestamp_str: String = row.get(1)?;
            let created_at = chrono::DateTime::parse_from_rfc3339(&timestamp_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[LlmUsageRepo] Failed to parse timestamp '{}': {}, using epoch fallback",
                        timestamp_str,
                        e
                    );
                    chrono::DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                });

            Ok(UsageRecord {
                id: row.get(0)?,
                caller_type: CallerType::from_str(&caller_type_str),
                caller_id: row.get(11)?,
                model_id: row.get(2)?,
                config_id: row.get(3)?,
                prompt_tokens: row.get(4)?,
                completion_tokens: row.get(5)?,
                total_tokens: row.get(6)?,
                reasoning_tokens: row.get(7)?,
                cached_tokens: row.get(8)?,
                estimated_cost_usd: row.get(14)?,
                duration_ms: row.get(9)?,
                success: status == "success",
                error_message: row.get(13)?,
                created_at,
                workspace_id: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }

    pub fn delete_old_records(conn: &Connection, before_date: &str) -> LlmUsageResult<usize> {
        let deleted = conn.execute(
            "DELETE FROM llm_usage_logs WHERE date_key < ?1",
            params![before_date],
        )?;

        debug!(
            "[LlmUsageRepo] Deleted {} old records before {}",
            deleted, before_date
        );

        Ok(deleted)
    }

    pub fn get_daily_summary(
        conn: &Connection,
        start_date: &str,
        end_date: &str,
    ) -> LlmUsageResult<Vec<DailySummary>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                date_key,
                COUNT(*) as call_count,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                COALESCE(SUM(cost_estimate), 0) as total_cost_estimate
            FROM llm_usage_logs
            WHERE date_key >= ?1 AND date_key <= ?2
            GROUP BY date_key
            ORDER BY date_key DESC
            "#,
        )?;

        let rows = stmt.query_map(params![start_date, end_date], |row| {
            Ok(DailySummary {
                date: row.get(0)?,
                caller_type: None,
                model_id: None,
                request_count: row.get::<_, i64>(1)? as u32,
                success_count: row.get::<_, i64>(2)? as u32,
                error_count: row.get::<_, i64>(3)? as u32,
                total_prompt_tokens: row.get::<_, i64>(4)? as u64,
                total_completion_tokens: row.get::<_, i64>(5)? as u64,
                total_tokens: row.get::<_, i64>(6)? as u64,
                total_reasoning_tokens: None,
                total_cached_tokens: None,
                total_estimated_cost_usd: row.get(7).ok(),
                avg_duration_ms: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // 使用 Refinery 格式的初始化迁移
        conn.execute_batch(include_str!(
            "../../migrations/llm_usage/V20260130__init.sql"
        ))
        .unwrap();
        conn
    }

    #[test]
    fn test_insert_and_query() {
        let conn = setup_test_db();

        let record = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50);

        LlmUsageRepo::insert_usage(&conn, &record).unwrap();

        let recent = LlmUsageRepo::get_recent_usage(&conn, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].model_id, "gpt-4o");
    }

    #[test]
    fn test_get_summary() {
        let conn = setup_test_db();

        let record = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 50);

        LlmUsageRepo::insert_usage(&conn, &record).unwrap();

        let summary = LlmUsageRepo::get_usage_summary(&conn, None, None).unwrap();
        assert_eq!(summary.total_requests, 1);
        assert_eq!(summary.total_tokens, 150);
    }
}
