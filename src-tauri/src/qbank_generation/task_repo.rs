//! 题目集 AI 出题 - 后台任务仓储
//!
//! 2026-09-09 后台化改造（决策见 docs/dev/ai-qbank-generation-v3-plan-2026-09-08.md §三）：
//! 出题从「SSE 流式 + 面板内状态」改为「后台任务 + 全局事件 + 轮询兜底」。
//! 任务状态与结果落库（vfs.db 的 `qbank_generation_tasks` 表），
//! 保证关闭面板 / 切换标签页 / 应用重启后结果可恢复。
//!
//! 状态机：queued -> running -> completed | failed | cancelled（终态不可回退）

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::database::VfsDatabase;
use crate::vfs::VfsError;

use super::types::{GeneratedQuestionDraft, SkippedReference};

/// 任务状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationTaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl GenerationTaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }

    /// 是否终态（终态不可回退）
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// 任务完整记录（内部使用，含 request_json / stream_event）
#[derive(Debug, Clone)]
pub struct GenerationTaskRecord {
    pub id: String,
    pub exam_id: String,
    pub status: GenerationTaskStatus,
    /// 请求快照（QbankGenerationRequest JSON）
    pub request_json: String,
    pub drafts: Vec<GeneratedQuestionDraft>,
    pub rejected_count: usize,
    pub rejection_reasons: Vec<String>,
    pub skipped_references: Vec<SkippedReference>,
    pub used_reference_count: usize,
    /// LLM 流事件名（取消用）
    pub stream_event: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

/// 任务对外视图（发给前端；不含 request_json/stream_event，避免大 base64 回传）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTaskView {
    pub id: String,
    pub exam_id: String,
    pub status: GenerationTaskStatus,
    pub drafts: Vec<GeneratedQuestionDraft>,
    pub rejected_count: usize,
    pub rejection_reasons: Vec<String>,
    pub skipped_references: Vec<SkippedReference>,
    pub used_reference_count: usize,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

impl From<GenerationTaskRecord> for GenerationTaskView {
    fn from(record: GenerationTaskRecord) -> Self {
        Self {
            id: record.id,
            exam_id: record.exam_id,
            status: record.status,
            drafts: record.drafts,
            rejected_count: record.rejected_count,
            rejection_reasons: record.rejection_reasons,
            skipped_references: record.skipped_references,
            used_reference_count: record.used_reference_count,
            error: record.error,
            created_at: record.created_at,
            updated_at: record.updated_at,
            finished_at: record.finished_at,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map_db_err(e: rusqlite::Error) -> VfsError {
    VfsError::Database(format!("出题任务表操作失败: {}", e))
}

/// 创建任务（状态 queued）
pub fn create_task(
    db: &VfsDatabase,
    task_id: &str,
    exam_id: &str,
    request_json: &str,
    stream_event: &str,
) -> Result<GenerationTaskRecord, VfsError> {
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    conn.execute(
        r#"INSERT INTO qbank_generation_tasks
           (id, exam_id, status, request_json, drafts_json, rejected_count,
            rejection_reasons_json, skipped_references_json, used_reference_count,
            stream_event, created_at, updated_at)
           VALUES (?1, ?2, 'queued', ?3, NULL, 0, '[]', '[]', 0, ?4, ?5, ?5)"#,
        params![task_id, exam_id, request_json, stream_event, now],
    )
    .map_err(map_db_err)?;

    log::info!(
        "[QbankGeneration] 创建后台任务: id={}, exam={}",
        task_id,
        exam_id
    );

    get_task(db, task_id)?.ok_or_else(|| VfsError::Other("任务创建后读取失败".to_string()))
}

/// 读取任务
pub fn get_task(db: &VfsDatabase, task_id: &str) -> Result<Option<GenerationTaskRecord>, VfsError> {
    let conn = db.get_conn_safe()?;
    get_task_with_conn(&conn, task_id)
}

fn get_task_with_conn(
    conn: &Connection,
    task_id: &str,
) -> Result<Option<GenerationTaskRecord>, VfsError> {
    conn.query_row(
        r#"SELECT id, exam_id, status, request_json, drafts_json, rejected_count,
                  rejection_reasons_json, skipped_references_json, used_reference_count,
                  stream_event, error, created_at, updated_at, finished_at
           FROM qbank_generation_tasks WHERE id = ?1"#,
        params![task_id],
        row_to_record,
    )
    .optional()
    .map_err(map_db_err)
}

/// 列出题目集的任务（按创建时间倒序）
pub fn list_tasks(
    db: &VfsDatabase,
    exam_id: &str,
    limit: usize,
) -> Result<Vec<GenerationTaskRecord>, VfsError> {
    let conn = db.get_conn_safe()?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, exam_id, status, request_json, drafts_json, rejected_count,
                      rejection_reasons_json, skipped_references_json, used_reference_count,
                      stream_event, error, created_at, updated_at, finished_at
               FROM qbank_generation_tasks
               WHERE exam_id = ?1
               ORDER BY created_at DESC
               LIMIT ?2"#,
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![exam_id, limit as i64], row_to_record)
        .map_err(map_db_err)?;
    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(map_db_err)?);
    }
    Ok(tasks)
}

/// 标记为运行中
pub fn mark_running(db: &VfsDatabase, task_id: &str) -> Result<(), VfsError> {
    update_status(db, task_id, GenerationTaskStatus::Running, None)
}

/// 标记为完成（写入草稿与统计）
pub fn mark_completed(
    db: &VfsDatabase,
    task_id: &str,
    drafts: &[GeneratedQuestionDraft],
    rejected_count: usize,
    rejection_reasons: &[String],
    skipped_references: &[SkippedReference],
    used_reference_count: usize,
) -> Result<(), VfsError> {
    let drafts_json =
        serde_json::to_string(drafts).map_err(|e| VfsError::Serialization(e.to_string()))?;
    let reasons_json = serde_json::to_string(rejection_reasons)
        .map_err(|e| VfsError::Serialization(e.to_string()))?;
    let skipped_json = serde_json::to_string(skipped_references)
        .map_err(|e| VfsError::Serialization(e.to_string()))?;
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    conn.execute(
        r#"UPDATE qbank_generation_tasks
           SET status = 'completed', drafts_json = ?2, rejected_count = ?3,
               rejection_reasons_json = ?4, skipped_references_json = ?5,
               used_reference_count = ?6, error = NULL, updated_at = ?7, finished_at = ?7
           WHERE id = ?1 AND status IN ('queued', 'running')"#,
        params![
            task_id,
            drafts_json,
            rejected_count as i64,
            reasons_json,
            skipped_json,
            used_reference_count as i64,
            now
        ],
    )
    .map_err(map_db_err)?;
    log::info!(
        "[QbankGeneration] 任务完成: id={}, drafts={}, rejected={}, used_references={}, skipped={}",
        task_id,
        drafts.len(),
        rejected_count,
        used_reference_count,
        skipped_references.len()
    );
    Ok(())
}

/// 标记为失败
pub fn mark_failed(db: &VfsDatabase, task_id: &str, error: &str) -> Result<(), VfsError> {
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    conn.execute(
        r#"UPDATE qbank_generation_tasks
           SET status = 'failed', error = ?2, updated_at = ?3, finished_at = ?3
           WHERE id = ?1 AND status IN ('queued', 'running')"#,
        params![task_id, error, now],
    )
    .map_err(map_db_err)?;
    log::warn!("[QbankGeneration] 任务失败: id={}, error={}", task_id, error);
    Ok(())
}

/// 标记为已取消
pub fn mark_cancelled(db: &VfsDatabase, task_id: &str) -> Result<(), VfsError> {
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    conn.execute(
        r#"UPDATE qbank_generation_tasks
           SET status = 'cancelled', updated_at = ?2, finished_at = ?2
           WHERE id = ?1 AND status IN ('queued', 'running')"#,
        params![task_id, now],
    )
    .map_err(map_db_err)?;
    log::info!("[QbankGeneration] 任务已取消: id={}", task_id);
    Ok(())
}

fn update_status(
    db: &VfsDatabase,
    task_id: &str,
    status: GenerationTaskStatus,
    error: Option<&str>,
) -> Result<(), VfsError> {
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    conn.execute(
        "UPDATE qbank_generation_tasks SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
        params![task_id, status.as_str(), error, now],
    )
    .map_err(map_db_err)?;
    Ok(())
}

/// 应用启动时收敛中断任务：queued/running → failed（避免前端一直显示「生成中」）
///
/// 返回被标记的任务数。
pub fn recover_interrupted_tasks(db: &VfsDatabase) -> Result<usize, VfsError> {
    let now = now_ms();
    let conn = db.get_conn_safe()?;
    let affected = conn
        .execute(
            r#"UPDATE qbank_generation_tasks
               SET status = 'failed',
                   error = '应用重启导致任务中断，请重新生成',
                   updated_at = ?1,
                   finished_at = ?1
               WHERE status IN ('queued', 'running')"#,
            params![now],
        )
        .map_err(map_db_err)?;
    if affected > 0 {
        log::warn!(
            "[QbankGeneration] 启动恢复：{} 个中断任务已标记为 failed",
            affected
        );
    }
    Ok(affected)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationTaskRecord> {
    let status: String = row.get(2)?;
    let drafts_json: Option<String> = row.get(4)?;
    let reasons_json: String = row.get(6)?;
    let skipped_json: String = row.get(7)?;
    Ok(GenerationTaskRecord {
        id: row.get(0)?,
        exam_id: row.get(1)?,
        status: GenerationTaskStatus::parse(&status),
        request_json: row.get(3)?,
        drafts: drafts_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default(),
        rejected_count: row.get::<_, i64>(5)?.max(0) as usize,
        rejection_reasons: serde_json::from_str(&reasons_json).unwrap_or_default(),
        skipped_references: serde_json::from_str(&skipped_json).unwrap_or_default(),
        used_reference_count: row.get::<_, i64>(8)?.max(0) as usize,
        stream_event: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        finished_at: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_roundtrip_and_terminal() {
        for status in [
            GenerationTaskStatus::Queued,
            GenerationTaskStatus::Running,
            GenerationTaskStatus::Completed,
            GenerationTaskStatus::Failed,
            GenerationTaskStatus::Cancelled,
        ] {
            assert_eq!(GenerationTaskStatus::parse(status.as_str()), status);
        }
        assert!(!GenerationTaskStatus::Queued.is_terminal());
        assert!(!GenerationTaskStatus::Running.is_terminal());
        assert!(GenerationTaskStatus::Completed.is_terminal());
        assert!(GenerationTaskStatus::Failed.is_terminal());
        assert!(GenerationTaskStatus::Cancelled.is_terminal());
    }

    #[test]
    fn view_omits_request_json_and_stream_event() {
        let record = GenerationTaskRecord {
            id: "task_1".to_string(),
            exam_id: "exam_1".to_string(),
            status: GenerationTaskStatus::Completed,
            request_json: "{\"secret\":\"base64...\"}".to_string(),
            drafts: vec![],
            rejected_count: 0,
            rejection_reasons: vec![],
            skipped_references: vec![],
            used_reference_count: 0,
            stream_event: "qbank_generation_stream_x".to_string(),
            error: None,
            created_at: 1,
            updated_at: 2,
            finished_at: Some(2),
        };
        let view = GenerationTaskView::from(record);
        let json = serde_json::to_value(&view).expect("serialize view");
        assert_eq!(json["id"], "task_1");
        assert_eq!(json["status"], "completed");
        assert!(json.get("request_json").is_none());
        assert!(json.get("streamEvent").is_none());
    }
}
