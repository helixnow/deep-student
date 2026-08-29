use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, Connection, Transaction};
use tracing::debug;

use super::database::LlmUsageResult;
use super::types::{
    CallerType, CallerTypeSummary, DailySummary, ModelSummary, SessionUsageSummary,
    TimeGranularity, UsageRecord, UsageSummary, UsageTrendPoint,
};

pub struct LlmUsageRepo;

/// Pricing coverage for one aggregate bucket. A `cost_estimate` of zero still
/// counts as priced; a NULL value means no applicable price was available.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceCoverageStat {
    pub key: Option<String>,
    pub total_requests: u64,
    pub priced_requests: u64,
    pub total_tokens: u64,
    pub priced_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceCoverageDimension {
    Overall,
    Model,
    CallerType,
}

impl LlmUsageRepo {
    pub fn insert_usage(conn: &Connection, record: &UsageRecord) -> LlmUsageResult<()> {
        debug!("[LlmUsageRepo] Inserting usage record: id={}", record.id);

        let status = if record.success { "success" } else { "error" };
        let timestamp = record.created_at.to_rfc3339();

        let provider = record
            .provider_id
            .clone()
            .unwrap_or_else(|| Self::infer_provider(&record.model_id).to_string());

        conn.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, adapter, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens, cache_write_tokens, token_source,
                duration_ms, caller_type, session_id, variant_id, run_id,
                status, error_message, cost_estimate
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
            )
            "#,
            params![
                record.id,
                timestamp,
                provider,
                record.model_id,
                record.adapter,
                record.config_id,
                record.prompt_tokens,
                record.completion_tokens,
                record.total_tokens,
                record.reasoning_tokens,
                record.cached_tokens,
                record.cache_write_tokens,
                record.token_source.as_deref().unwrap_or("api"),
                record.duration_ms,
                record.caller_type.to_string(),
                record.caller_id,
                record.variant_id,
                record.run_id,
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
        let provider = record
            .provider_id
            .clone()
            .unwrap_or_else(|| Self::infer_provider(&record.model_id).to_string());

        tx.execute(
            r#"
            INSERT INTO llm_usage_logs (
                id, timestamp, provider, model, adapter, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens, cache_write_tokens, token_source,
                duration_ms, caller_type, session_id, variant_id, run_id,
                status, error_message, cost_estimate
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
            )
            "#,
            params![
                record.id,
                timestamp,
                provider,
                record.model_id,
                record.adapter,
                record.config_id,
                record.prompt_tokens,
                record.completion_tokens,
                record.total_tokens,
                record.reasoning_tokens,
                record.cached_tokens,
                record.cache_write_tokens,
                record.token_source.as_deref().unwrap_or("api"),
                record.duration_ms,
                record.caller_type.to_string(),
                record.caller_id,
                record.variant_id,
                record.run_id,
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
                MIN(timestamp) as first_ts,
                SUM(cost_estimate) as total_cost_estimate
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
                estimated_cost_usd: row.get::<_, Option<f64>>(6)?,
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
                SUM(cost_estimate) as total_cost_estimate
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
                estimated_cost_usd: row.get::<_, Option<f64>>(5)?,
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
                SUM(cost_estimate) as total_cost_estimate
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
                estimated_cost_usd: row.get::<_, Option<f64>>(3)?,
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
                SUM(cost_estimate) as total_cost_estimate,
                AVG(duration_ms) as avg_duration_ms,
                MIN(timestamp) as first_timestamp,
                MAX(timestamp) as last_timestamp
            FROM llm_usage_logs
            {}
            "#,
            where_clause
        );

        let mut stmt = conn.prepare(&sql)?;
        let now = Utc::now();

        let build_summary = |row: &rusqlite::Row| -> rusqlite::Result<UsageSummary> {
            let first_timestamp = row
                .get::<_, Option<String>>(10)?
                .and_then(|value| parse_rfc3339_utc(&value));
            let last_timestamp = row
                .get::<_, Option<String>>(11)?
                .and_then(|value| parse_rfc3339_utc(&value));
            let requested_start = start_date.and_then(|value| parse_date_boundary(value, false));
            let requested_end = end_date.and_then(|value| parse_date_boundary(value, true));

            Ok(UsageSummary {
                start_date: requested_start.or(first_timestamp).unwrap_or(now),
                end_date: requested_end.or(last_timestamp).unwrap_or(now),
                total_requests: row.get::<_, i64>(0)? as u64,
                success_requests: row.get::<_, i64>(6)? as u64,
                error_requests: row.get::<_, i64>(7)? as u64,
                total_prompt_tokens: row.get::<_, i64>(1)? as u64,
                total_completion_tokens: row.get::<_, i64>(2)? as u64,
                total_tokens: row.get::<_, i64>(3)? as u64,
                total_reasoning_tokens: Some(row.get::<_, i64>(4)? as u64),
                total_cached_tokens: Some(row.get::<_, i64>(5)? as u64),
                total_estimated_cost_usd: row.get::<_, Option<f64>>(8)?,
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

        let mut summary = summary;
        summary.compute_averages();
        Ok(summary)
    }

    /// ★ 1.2 会话级用量聚合（caller_id = session_id）
    pub fn get_session_usage(
        conn: &Connection,
        session_id: &str,
    ) -> LlmUsageResult<SessionUsageSummary> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                COUNT(*) as request_count,
                COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                SUM(cost_estimate) as cost_estimate
            FROM llm_usage_logs
            WHERE caller_id = ?1
            "#,
        )?;

        let summary = stmt.query_row(params![session_id], |row| {
            Ok(SessionUsageSummary {
                session_id: session_id.to_string(),
                request_count: row.get::<_, i64>(0)? as u64,
                prompt_tokens: row.get::<_, i64>(1)? as u64,
                completion_tokens: row.get::<_, i64>(2)? as u64,
                total_tokens: row.get::<_, i64>(3)? as u64,
                estimated_cost_usd: row.get::<_, Option<f64>>(4)?,
            })
        })?;

        Ok(summary)
    }

    pub fn get_recent_usage(conn: &Connection, limit: u32) -> LlmUsageResult<Vec<UsageRecord>> {
        Self::get_recent_usage_page(conn, 0, limit)
    }

    pub fn get_recent_usage_page(
        conn: &Connection,
        offset: u32,
        limit: u32,
    ) -> LlmUsageResult<Vec<UsageRecord>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, timestamp, provider, model, api_config_id,
                prompt_tokens, completion_tokens, total_tokens,
                reasoning_tokens, cached_tokens,
                duration_ms, caller_type, session_id, status, error_message, cost_estimate,
                adapter, token_source, cache_write_tokens, variant_id, run_id
            FROM llm_usage_logs
            ORDER BY timestamp DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], |row| {
            let caller_type_str: String = row.get(11)?;
            let status: String = row.get(13)?;
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
                caller_id: row.get(12)?,
                variant_id: row.get(19)?,
                run_id: row.get(20)?,
                model_id: row.get(3)?,
                config_id: row.get(4)?,
                provider_id: row.get(2)?,
                adapter: row.get(16)?,
                token_source: row.get(17)?,
                prompt_tokens: row.get(5)?,
                completion_tokens: row.get(6)?,
                total_tokens: row.get(7)?,
                reasoning_tokens: row.get(8)?,
                cached_tokens: row.get(9)?,
                cache_write_tokens: row.get(18)?,
                estimated_cost_usd: row.get(15)?,
                duration_ms: row.get(10)?,
                success: status == "success",
                error_message: row.get(14)?,
                created_at,
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
                SUM(cost_estimate) as total_cost_estimate
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
                total_estimated_cost_usd: row.get::<_, Option<f64>>(7)?,
                avg_duration_ms: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(results)
    }

    pub fn get_price_coverage(
        conn: &Connection,
        start_date: &str,
        end_date: &str,
        dimension: PriceCoverageDimension,
    ) -> LlmUsageResult<Vec<PriceCoverageStat>> {
        let (select_key, group_by) = match dimension {
            PriceCoverageDimension::Overall => ("NULL", ""),
            PriceCoverageDimension::Model => ("model", "GROUP BY model ORDER BY model"),
            PriceCoverageDimension::CallerType => {
                ("caller_type", "GROUP BY caller_type ORDER BY caller_type")
            }
        };
        let sql = format!(
            r#"
            SELECT
                {select_key} as coverage_key,
                COUNT(*) as total_requests,
                COUNT(cost_estimate) as priced_requests,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(CASE WHEN cost_estimate IS NOT NULL THEN total_tokens ELSE 0 END), 0)
                    as priced_tokens
            FROM llm_usage_logs
            WHERE date_key >= ?1 AND date_key <= ?2
            {group_by}
            "#
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![start_date, end_date], |row| {
            Ok(PriceCoverageStat {
                key: row.get(0)?,
                total_requests: row.get::<_, i64>(1)? as u64,
                priced_requests: row.get::<_, i64>(2)? as u64,
                total_tokens: row.get::<_, i64>(3)? as u64,
                priced_tokens: row.get::<_, i64>(4)? as u64,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    pub fn get_recent_price_coverage(
        conn: &Connection,
        days: u32,
    ) -> LlmUsageResult<PriceCoverageStat> {
        conn.query_row(
            r#"
            SELECT
                COUNT(*) as total_requests,
                COUNT(cost_estimate) as priced_requests,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(CASE WHEN cost_estimate IS NOT NULL THEN total_tokens ELSE 0 END), 0)
                    as priced_tokens
            FROM llm_usage_logs
            WHERE timestamp >= datetime('now', ?1)
            "#,
            params![format!("-{} days", days)],
            |row| {
                Ok(PriceCoverageStat {
                    key: None,
                    total_requests: row.get::<_, i64>(0)? as u64,
                    priced_requests: row.get::<_, i64>(1)? as u64,
                    total_tokens: row.get::<_, i64>(2)? as u64,
                    priced_tokens: row.get::<_, i64>(3)? as u64,
                })
            },
        )
        .map_err(Into::into)
    }
}

fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn parse_date_boundary(value: &str, end_of_day: bool) -> Option<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    let naive = if end_of_day {
        date.and_hms_nano_opt(23, 59, 59, 999_999_999)?
    } else {
        date.and_hms_opt(0, 0, 0)?
    };
    Some(DateTime::from_naive_utc_and_offset(naive, Utc))
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
        // V20260824：cache_write_tokens 列（insert/read 路径已引用）
        conn.execute_batch(include_str!(
            "../../migrations/llm_usage/V20260824__add_cache_write_tokens.sql"
        ))
        .unwrap();
        // V20260826：variant_id / run_id 遥测身份分列（insert/read 路径已引用）
        conn.execute_batch(include_str!(
            "../../migrations/llm_usage/V20260826__add_stream_identity.sql"
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

    #[test]
    fn test_insert_usage_writes_real_adapter_and_token_source() {
        let conn = setup_test_db();

        let record = UsageRecord::new(CallerType::ChatV2, "claude-3-opus".to_string(), 100, 50)
            .with_adapter("anthropic_messages".to_string())
            .with_token_source("heuristic".to_string());

        LlmUsageRepo::insert_usage(&conn, &record).unwrap();

        let (adapter, token_source): (Option<String>, String) = conn
            .query_row(
                "SELECT adapter, token_source FROM llm_usage_logs WHERE id = ?1",
                [&record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(adapter, Some("anthropic_messages".to_string()));
        assert_eq!(token_source, "heuristic");

        // 回读路径也应带出新字段
        let recent = LlmUsageRepo::get_recent_usage(&conn, 10).unwrap();
        assert_eq!(recent[0].adapter, Some("anthropic_messages".to_string()));
        assert_eq!(recent[0].token_source, Some("heuristic".to_string()));
    }

    #[test]
    fn test_insert_usage_persists_cache_write_tokens_and_null_unmeasured() {
        let conn = setup_test_db();

        let measured = UsageRecord::new(CallerType::ChatV2, "claude-3-opus".to_string(), 1000, 50)
            .with_cached_tokens(750)
            .with_cache_write_tokens(250);
        let unmeasured = UsageRecord::new(CallerType::ChatV2, "gpt-4o".to_string(), 100, 10);

        LlmUsageRepo::insert_usage(&conn, &measured).unwrap();
        LlmUsageRepo::insert_usage(&conn, &unmeasured).unwrap();

        let (cached, write): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?1",
                [&measured.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(cached, Some(750));
        assert_eq!(write, Some(250));

        let (plain_cached, plain_write): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?1",
                [&unmeasured.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(plain_cached, None, "无测量必须落 NULL 而不是 0");
        assert_eq!(plain_write, None, "无测量必须落 NULL 而不是 0");

        // 回读路径带出 cache_write_tokens
        let recent = LlmUsageRepo::get_recent_usage(&conn, 10).unwrap();
        let read_back = recent
            .iter()
            .find(|r| r.id == measured.id)
            .expect("measured record read back");
        assert_eq!(read_back.cache_write_tokens, Some(250));
        let plain_back = recent
            .iter()
            .find(|r| r.id == unmeasured.id)
            .expect("unmeasured record read back");
        assert_eq!(plain_back.cache_write_tokens, None);
    }

    #[test]
    fn test_insert_usage_prefers_explicit_provider_id() {
        let conn = setup_test_db();

        let record = UsageRecord::new(
            CallerType::VoiceInput,
            "TeleAI/TeleSpeechASR".to_string(),
            0,
            0,
        )
        .with_provider_id("siliconflow".to_string());

        LlmUsageRepo::insert_usage(&conn, &record).unwrap();

        let provider: String = conn
            .query_row(
                "SELECT provider FROM llm_usage_logs WHERE id = ?1",
                [&record.id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(provider, "siliconflow");
    }
}
