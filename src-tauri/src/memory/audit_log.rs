use std::sync::Arc;
use std::time::Instant;

use rusqlite::params;
use tracing::warn;

use crate::vfs::database::VfsDatabase;

#[derive(Debug, Clone)]
pub struct MemoryAuditEntry {
    pub source: MemoryOpSource,
    pub operation: MemoryOpType,
    pub success: bool,
    pub note_id: Option<String>,
    pub title: Option<String>,
    pub content_preview: Option<String>,
    pub folder: Option<String>,
    pub event: Option<String>,
    pub confidence: Option<f32>,
    pub reason: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub extra_json: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum MemoryOpSource {
    ToolCall,
    AutoExtract,
    Handler,
    Evolution,
}

impl MemoryOpSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ToolCall => "tool_call",
            Self::AutoExtract => "auto_extract",
            Self::Handler => "handler",
            Self::Evolution => "evolution",
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum MemoryOpType {
    Write,
    WriteSmart,
    Update,
    Delete,
    Search,
    Extract,
    ProfileRefresh,
    CategoryRefresh,
    EvolutionCycle,
    Move,
    UpdateTags,
    AddRelation,
    RemoveRelation,
}

impl MemoryOpType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::WriteSmart => "write_smart",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Search => "search",
            Self::Extract => "extract",
            Self::ProfileRefresh => "profile_refresh",
            Self::CategoryRefresh => "category_refresh",
            Self::EvolutionCycle => "evolution_cycle",
            Self::Move => "move",
            Self::UpdateTags => "update_tags",
            Self::AddRelation => "add_relation",
            Self::RemoveRelation => "remove_relation",
        }
    }
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        text.to_string()
    } else {
        text.chars().take(max_chars).collect::<String>() + "..."
    }
}

#[derive(Clone)]
pub struct MemoryAuditLogger {
    vfs_db: Arc<VfsDatabase>,
}

impl MemoryAuditLogger {
    pub fn new(vfs_db: Arc<VfsDatabase>) -> Self {
        Self { vfs_db }
    }

    pub fn log(&self, entry: &MemoryAuditEntry) {
        let conn = match self.vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                warn!("[MemoryAudit] DB connection failed: {}", e);
                return;
            }
        };

        let content_preview = entry
            .content_preview
            .as_deref()
            .map(|s| truncate_preview(s, 100));

        if let Err(e) = conn.execute(
            r#"INSERT INTO memory_audit_log
                (source, operation, success, note_id, title, content_preview,
                 folder, event, confidence, reason, session_id, duration_ms, extra_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"#,
            params![
                entry.source.as_str(),
                entry.operation.as_str(),
                entry.success as i32,
                entry.note_id,
                entry.title,
                content_preview,
                entry.folder,
                entry.event,
                entry.confidence,
                entry.reason,
                entry.session_id,
                entry.duration_ms.map(|v| v as i64),
                entry.extra_json,
            ],
        ) {
            warn!("[MemoryAudit] Failed to insert audit log: {}", e);
        }
    }

    pub fn log_write_smart_result(
        &self,
        source: MemoryOpSource,
        title: &str,
        content: &str,
        folder: Option<&str>,
        result: &super::service::SmartWriteOutput,
        duration_ms: u64,
        session_id: Option<&str>,
    ) {
        self.log(&MemoryAuditEntry {
            source,
            operation: MemoryOpType::WriteSmart,
            success: true,
            note_id: if result.note_id.is_empty() {
                None
            } else {
                Some(result.note_id.clone())
            },
            title: Some(title.to_string()),
            content_preview: Some(content.to_string()),
            folder: folder.map(|s| s.to_string()),
            event: Some(result.event.clone()),
            confidence: Some(result.confidence),
            reason: Some(result.reason.clone()),
            session_id: session_id.map(|s| s.to_string()),
            duration_ms: Some(duration_ms),
            extra_json: if result.downgraded {
                Some(r#"{"downgraded":true}"#.to_string())
            } else {
                None
            },
        });
    }

    pub fn log_error(
        &self,
        source: MemoryOpSource,
        operation: MemoryOpType,
        title: Option<&str>,
        content: Option<&str>,
        folder: Option<&str>,
        error: &str,
        session_id: Option<&str>,
        duration_ms: u64,
    ) {
        self.log(&MemoryAuditEntry {
            source,
            operation,
            success: false,
            note_id: None,
            title: title.map(|s| s.to_string()),
            content_preview: content.map(|s| s.to_string()),
            folder: folder.map(|s| s.to_string()),
            event: None,
            confidence: None,
            reason: Some(error.to_string()),
            session_id: session_id.map(|s| s.to_string()),
            duration_ms: Some(duration_ms),
            extra_json: None,
        });
    }

    pub fn log_extract_result(
        &self,
        candidates_count: usize,
        stored_count: usize,
        duration_ms: u64,
        session_id: Option<&str>,
    ) {
        self.log(&MemoryAuditEntry {
            source: MemoryOpSource::AutoExtract,
            operation: MemoryOpType::Extract,
            success: true,
            note_id: None,
            title: None,
            content_preview: None,
            folder: None,
            event: None,
            confidence: None,
            reason: Some(format!(
                "提取 {} 条候选，写入 {} 条",
                candidates_count, stored_count
            )),
            session_id: session_id.map(|s| s.to_string()),
            duration_ms: Some(duration_ms),
            extra_json: Some(
                serde_json::json!({
                    "candidates": candidates_count,
                    "stored": stored_count
                })
                .to_string(),
            ),
        });
    }

    pub fn log_filtered(
        &self,
        source: MemoryOpSource,
        title: &str,
        content: &str,
        filter_reason: &str,
    ) {
        self.log(&MemoryAuditEntry {
            source,
            operation: MemoryOpType::WriteSmart,
            success: false,
            note_id: None,
            title: Some(title.to_string()),
            content_preview: Some(content.to_string()),
            folder: None,
            event: Some("FILTERED".to_string()),
            confidence: None,
            reason: Some(filter_reason.to_string()),
            session_id: None,
            duration_ms: Some(0),
            extra_json: None,
        });
    }
}

/// RAII 计时器
pub struct OpTimer {
    start: Instant,
}

impl OpTimer {
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// 查询结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAuditLogItem {
    pub id: i64,
    pub timestamp: String,
    pub source: String,
    pub operation: String,
    pub success: bool,
    pub note_id: Option<String>,
    pub title: Option<String>,
    pub content_preview: Option<String>,
    pub folder: Option<String>,
    pub event: Option<String>,
    pub confidence: Option<f32>,
    pub reason: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: Option<i64>,
}

pub fn query_audit_logs(
    vfs_db: &VfsDatabase,
    limit: u32,
    offset: u32,
    source_filter: Option<&str>,
    operation_filter: Option<&str>,
    success_filter: Option<bool>,
) -> Result<Vec<MemoryAuditLogItem>, crate::vfs::error::VfsError> {
    let conn = vfs_db.get_conn_safe()?;

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(src) = source_filter {
        conditions.push(format!("source = ?{}", param_values.len() + 1));
        param_values.push(rusqlite::types::Value::from(src.to_string()));
    }
    if let Some(op) = operation_filter {
        conditions.push(format!("operation = ?{}", param_values.len() + 1));
        param_values.push(rusqlite::types::Value::from(op.to_string()));
    }
    if let Some(ok) = success_filter {
        conditions.push(format!("success = ?{}", param_values.len() + 1));
        param_values.push(rusqlite::types::Value::from(ok as i64));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        r#"SELECT id, timestamp, source, operation, success, note_id, title,
                  content_preview, folder, event, confidence, reason, session_id, duration_ms
           FROM memory_audit_log
           {}
           ORDER BY id DESC
           LIMIT ?{} OFFSET ?{}"#,
        where_clause,
        param_values.len() + 1,
        param_values.len() + 2,
    );

    param_values.push(rusqlite::types::Value::from(i64::from(limit)));
    param_values.push(rusqlite::types::Value::from(i64::from(offset)));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(param_values), |row| {
            Ok(MemoryAuditLogItem {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                source: row.get(2)?,
                operation: row.get(3)?,
                success: row.get::<_, i32>(4)? != 0,
                note_id: row.get(5)?,
                title: row.get(6)?,
                content_preview: row.get(7)?,
                folder: row.get(8)?,
                event: row.get(9)?,
                confidence: row.get(10)?,
                reason: row.get(11)?,
                session_id: row.get(12)?,
                duration_ms: row.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}
