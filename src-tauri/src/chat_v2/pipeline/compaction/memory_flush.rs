//! 压缩后的记忆冲刷（memory flush）台账子系统。
//!
//! 被压缩掉的增量区间会按段（segment）入列一张 SQLite 台账表，由带租约的
//! worker 逐段提取记忆事实并写入 MemoryService。台账行与 compaction 记录在
//! 同一事务提交，崩溃后可恢复；privacy / auto-extract 策略读取失败时 fail-closed。

use crate::chat_v2::error::{ChatV2Error, ChatV2Result};
use crate::chat_v2::pipeline::ChatV2Pipeline;
use chrono::Utc;
use log::{debug, info, warn};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;

const MEMORY_FLUSH_LEDGER_TABLE: &str = "chat_v2_compaction_memory_flushes";
const MEMORY_FLUSH_SEGMENT_MAX_CHARS: usize = 12_000;
const MEMORY_FLUSH_LEASE_MS: i64 = 15 * 60 * 1_000;
const MEMORY_FLUSH_RETRY_BACKOFF_MS: i64 = 30_000;
const MEMORY_FLUSH_EXTRACTION_TIMEOUT_SECS: u64 = 30;
const MEMORY_FLUSH_DRAIN_BATCH_SIZE: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryFlushPolicy {
    Enabled,
    Disabled(&'static str),
}

#[derive(Debug, Clone)]
pub(super) struct PendingMemoryFlush {
    pub(super) segment_id: String,
    pub(super) compaction_id: String,
    pub(super) session_id: String,
    pub(super) segment_ordinal: usize,
    pub(super) segment_text: String,
    pub(super) extraction_json: Option<String>,
    pub(super) facts_completed: usize,
    pub(super) activities_completed: usize,
}

struct MemoryFlushRecoveryGuard<'a> {
    running: &'a std::sync::atomic::AtomicBool,
}

impl Drop for MemoryFlushRecoveryGuard<'_> {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

fn ensure_memory_flush_ledger_with_conn(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        r#"
        CREATE TABLE IF NOT EXISTS {table} (
            segment_id          TEXT PRIMARY KEY,
            compaction_id       TEXT NOT NULL,
            session_id          TEXT NOT NULL,
            segment_ordinal     INTEGER NOT NULL DEFAULT 0,
            segment_text        TEXT NOT NULL,
            extraction_json     TEXT,
            facts_completed     INTEGER NOT NULL DEFAULT 0,
            activities_completed INTEGER NOT NULL DEFAULT 0,
            status              TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending', 'processing', 'completed', 'skipped')),
            lease_owner         TEXT,
            lease_expires_at    INTEGER,
            last_error          TEXT,
            attempt_count       INTEGER NOT NULL DEFAULT 0,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            completed_at        INTEGER,
            FOREIGN KEY(compaction_id) REFERENCES chat_v2_compactions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_pending
            ON {table}(session_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_compaction
            ON {table}(compaction_id);
        "#,
        table = MEMORY_FLUSH_LEDGER_TABLE,
    ))?;

    // The ledger predates segmented flushes on some nightly installations. Add the cursor
    // in place and derive legacy ordinals from their original insertion order.
    let has_segment_ordinal = {
        let mut stmt =
            conn.prepare(&format!("PRAGMA table_info({})", MEMORY_FLUSH_LEDGER_TABLE))?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for column in columns {
            if column? == "segment_ordinal" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_segment_ordinal {
        conn.execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN segment_ordinal INTEGER NOT NULL DEFAULT 0",
                MEMORY_FLUSH_LEDGER_TABLE
            ),
            [],
        )?;
        conn.execute(
            &format!(
                r#"
                UPDATE {table}
                SET segment_ordinal = (
                    SELECT COUNT(*)
                    FROM {table} AS prior
                    WHERE prior.compaction_id = {table}.compaction_id
                      AND (
                        prior.created_at < {table}.created_at
                        OR (prior.created_at = {table}.created_at AND prior.rowid < {table}.rowid)
                      )
                )
                "#,
                table = MEMORY_FLUSH_LEDGER_TABLE,
            ),
            [],
        )?;
    }

    conn.execute_batch(&format!(
        r#"
        CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_order
            ON {table}(session_id, created_at, compaction_id, segment_ordinal, status);
        "#,
        table = MEMORY_FLUSH_LEDGER_TABLE,
    ))
}

pub(super) fn enqueue_memory_flush_with_conn(
    conn: &rusqlite::Connection,
    pending: &PendingMemoryFlush,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    ensure_memory_flush_ledger_with_conn(conn)?;
    let inserted = conn.execute(
        &format!(
            r#"
            INSERT OR IGNORE INTO {table} (
                segment_id, compaction_id, session_id, segment_ordinal, segment_text,
                extraction_json, facts_completed, activities_completed,
                status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, 'pending', ?6, ?6)
            "#,
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![
            pending.segment_id,
            pending.compaction_id,
            pending.session_id,
            pending.segment_ordinal as i64,
            pending.segment_text,
            now_ms,
        ],
    )?;
    Ok(inserted == 1)
}

pub(super) fn build_memory_flush_segment_id(
    session_id: &str,
    previous_compaction_id: Option<&str>,
    start_message_id: &str,
    end_message_id_exclusive: &str,
    ordinal: usize,
) -> String {
    let mut hasher = Sha256::new();
    let ordinal = ordinal.to_string();
    for part in [
        "compaction-memory-flush-v1",
        session_id,
        previous_compaction_id.unwrap_or(""),
        start_message_id,
        end_message_id_exclusive,
        ordinal.as_str(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    format!("seg_{}", hex::encode(&digest[..16]))
}

pub(super) fn split_memory_flush_segment(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::with_capacity(MEMORY_FLUSH_SEGMENT_MAX_CHARS);
    let mut current_chars = 0usize;

    // Rendered messages and tool blocks are separated by blank lines. Keep those units intact
    // whenever possible; only a single oversized unit is split at a character boundary.
    for unit in trimmed.split_inclusive("\n\n") {
        let unit_chars = unit.chars().count();
        if unit_chars <= MEMORY_FLUSH_SEGMENT_MAX_CHARS {
            if current_chars > 0
                && current_chars.saturating_add(unit_chars) > MEMORY_FLUSH_SEGMENT_MAX_CHARS
            {
                chunks.push(std::mem::take(&mut current));
                current = String::with_capacity(MEMORY_FLUSH_SEGMENT_MAX_CHARS);
                current_chars = 0;
            }
            current.push_str(unit);
            current_chars += unit_chars;
            continue;
        }

        if !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current = String::with_capacity(MEMORY_FLUSH_SEGMENT_MAX_CHARS);
            current_chars = 0;
        }
        for ch in unit.chars() {
            current.push(ch);
            current_chars += 1;
            if current_chars == MEMORY_FLUSH_SEGMENT_MAX_CHARS {
                chunks.push(std::mem::take(&mut current));
                current = String::with_capacity(MEMORY_FLUSH_SEGMENT_MAX_CHARS);
                current_chars = 0;
            }
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn read_memory_flush_policy_with_conn(
    conn: &rusqlite::Connection,
) -> Result<MemoryFlushPolicy, String> {
    fn read_value(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT value FROM memory_config WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("read memory setting '{}': {}", key, e))
    }

    let privacy_mode = match read_value(conn, "privacy_mode")?.as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        Some(other) => {
            return Err(format!(
                "invalid memory setting 'privacy_mode': '{}'",
                other
            ))
        }
    };
    if privacy_mode {
        return Ok(MemoryFlushPolicy::Disabled("privacy mode"));
    }

    match read_value(conn, "auto_extract_frequency")?.as_deref() {
        None | Some("balanced") | Some("aggressive") => Ok(MemoryFlushPolicy::Enabled),
        Some("off") => Ok(MemoryFlushPolicy::Disabled("auto extract off")),
        Some(other) => Err(format!(
            "invalid memory setting 'auto_extract_frequency': '{}'",
            other
        )),
    }
}

fn encode_flush_extraction(
    extraction: &crate::memory::FlushExtraction,
) -> serde_json::Result<String> {
    let facts: Vec<serde_json::Value> = extraction
        .facts
        .iter()
        .map(|fact| {
            serde_json::json!({
                "title": fact.title,
                "content": fact.content,
                "folder": fact.folder,
            })
        })
        .collect();
    serde_json::to_string(&serde_json::json!({
        "facts": facts,
        "activities": extraction.activities,
    }))
}

fn decode_flush_extraction(json: &str) -> Result<crate::memory::FlushExtraction, String> {
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("decode persisted memory extraction: {}", e))?;
    Ok(crate::memory::compaction_flush::parse_flush_response(json))
}

fn memory_flush_fact_idempotency_key(segment_id: &str, index: usize) -> String {
    format!("compaction_flush:{}:fact:{}", segment_id, index)
}

fn cleanup_memory_flush_receipts(
    vfs_db: &crate::vfs::database::VfsDatabase,
    segment_id: &str,
) -> Result<usize, String> {
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|error| format!("open VFS receipt database: {}", error))?;
    conn.execute(
        "DELETE FROM memory_write_idempotency WHERE idempotency_key GLOB ?1",
        params![format!("compaction_flush:{}:fact:*", segment_id)],
    )
    .map_err(|error| format!("delete completed memory-flush receipts: {}", error))
}

fn ensure_single_ledger_update(changed: usize) -> ChatV2Result<()> {
    if changed == 1 {
        Ok(())
    } else {
        Err(ChatV2Error::Database(
            "memory flush lease was lost before ledger update".to_string(),
        ))
    }
}

fn claim_next_pending_memory_flush_with_conn(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
    worker_id: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<PendingMemoryFlush>> {
    ensure_memory_flush_ledger_with_conn(conn)?;
    let candidate: Option<String> = conn
        .query_row(
            &format!(
                r#"
                SELECT candidate.segment_id
                FROM {table} AS candidate
                WHERE (?1 IS NULL OR candidate.session_id = ?1)
                  AND (
                    candidate.status = 'pending'
                    OR (candidate.status = 'processing'
                        AND COALESCE(candidate.lease_expires_at, 0) <= ?2)
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM {table} AS earlier
                    WHERE earlier.session_id = candidate.session_id
                      AND earlier.status NOT IN ('completed', 'skipped')
                      AND (
                        earlier.created_at < candidate.created_at
                        OR (
                          earlier.created_at = candidate.created_at
                          AND earlier.compaction_id < candidate.compaction_id
                        )
                        OR (
                          earlier.created_at = candidate.created_at
                          AND earlier.compaction_id = candidate.compaction_id
                          AND earlier.segment_ordinal < candidate.segment_ordinal
                        )
                      )
                  )
                ORDER BY candidate.created_at ASC,
                         candidate.compaction_id ASC,
                         candidate.segment_ordinal ASC,
                         candidate.segment_id ASC
                LIMIT 1
                "#,
                table = MEMORY_FLUSH_LEDGER_TABLE,
            ),
            params![session_id, now_ms],
            |row| row.get(0),
        )
        .optional()?;
    let Some(segment_id) = candidate else {
        return Ok(None);
    };

    let changed = conn.execute(
        &format!(
            r#"
            UPDATE {table}
            SET status = 'processing', lease_owner = ?1, lease_expires_at = ?2,
                attempt_count = attempt_count + 1, updated_at = ?3, last_error = NULL
            WHERE segment_id = ?4
              AND (
                status = 'pending'
                OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?3)
              )
            "#,
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![
            worker_id,
            now_ms + MEMORY_FLUSH_LEASE_MS,
            now_ms,
            segment_id,
        ],
    )?;
    if changed != 1 {
        return Ok(None);
    }

    conn.query_row(
        &format!(
            r#"
            SELECT segment_id, compaction_id, session_id, segment_ordinal, segment_text,
                   extraction_json, facts_completed, activities_completed
            FROM {table}
            WHERE segment_id = ?1 AND status = 'processing' AND lease_owner = ?2
            "#,
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![segment_id, worker_id],
        |row| {
            Ok(PendingMemoryFlush {
                segment_id: row.get(0)?,
                compaction_id: row.get(1)?,
                session_id: row.get(2)?,
                segment_ordinal: row.get::<_, i64>(3)?.max(0) as usize,
                segment_text: row.get(4)?,
                extraction_json: row.get(5)?,
                facts_completed: row.get::<_, i64>(6)?.max(0) as usize,
                activities_completed: row.get::<_, i64>(7)?.max(0) as usize,
            })
        },
    )
    .optional()
}

fn has_claimable_memory_flush_with_conn(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    ensure_memory_flush_ledger_with_conn(conn)?;
    conn.query_row(
        &format!(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM {table} AS candidate
                WHERE (?1 IS NULL OR candidate.session_id = ?1)
                  AND (
                    candidate.status = 'pending'
                    OR (candidate.status = 'processing'
                        AND COALESCE(candidate.lease_expires_at, 0) <= ?2)
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM {table} AS earlier
                    WHERE earlier.session_id = candidate.session_id
                      AND earlier.status NOT IN ('completed', 'skipped')
                      AND (
                        earlier.created_at < candidate.created_at
                        OR (
                          earlier.created_at = candidate.created_at
                          AND earlier.compaction_id < candidate.compaction_id
                        )
                        OR (
                          earlier.created_at = candidate.created_at
                          AND earlier.compaction_id = candidate.compaction_id
                          AND earlier.segment_ordinal < candidate.segment_ordinal
                        )
                      )
                  )
                LIMIT 1
            )
            "#,
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![session_id, now_ms],
        |row| row.get(0),
    )
}

fn save_memory_flush_extraction_with_conn(
    conn: &rusqlite::Connection,
    segment_id: &str,
    worker_id: &str,
    extraction_json: &str,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    conn.execute(
        &format!(
            "UPDATE {table} SET extraction_json = ?1, updated_at = ?2, lease_expires_at = ?3 \
             WHERE segment_id = ?4 AND status = 'processing' AND lease_owner = ?5",
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![
            extraction_json,
            now_ms,
            now_ms + MEMORY_FLUSH_LEASE_MS,
            segment_id,
            worker_id,
        ],
    )
    .map(|changed| changed == 1)
}

fn update_memory_flush_progress_with_conn(
    conn: &rusqlite::Connection,
    segment_id: &str,
    worker_id: &str,
    facts_completed: usize,
    activities_completed: usize,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    conn.execute(
        &format!(
            "UPDATE {table} SET facts_completed = ?1, activities_completed = ?2, \
             updated_at = ?3, lease_expires_at = ?4 \
             WHERE segment_id = ?5 AND status = 'processing' AND lease_owner = ?6",
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![
            facts_completed as i64,
            activities_completed as i64,
            now_ms,
            now_ms + MEMORY_FLUSH_LEASE_MS,
            segment_id,
            worker_id,
        ],
    )
    .map(|changed| changed == 1)
}

fn complete_memory_flush_with_conn(
    conn: &rusqlite::Connection,
    segment_id: &str,
    worker_id: &str,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    conn.execute(
        &format!(
            "UPDATE {table} SET status = 'completed', lease_owner = NULL, \
             lease_expires_at = NULL, last_error = NULL, segment_text = '', extraction_json = NULL, \
             updated_at = ?1, completed_at = ?1 \
             WHERE segment_id = ?2 AND status = 'processing' AND lease_owner = ?3",
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![now_ms, segment_id, worker_id],
    )
    .map(|changed| changed == 1)
}

fn release_memory_flush_with_conn(
    conn: &rusqlite::Connection,
    segment_id: &str,
    worker_id: &str,
    error: &str,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    conn.execute(
        &format!(
            "UPDATE {table} SET status = 'processing', lease_owner = NULL, \
             lease_expires_at = ?2, last_error = ?1, updated_at = ?3 \
             WHERE segment_id = ?4 AND status = 'processing' AND lease_owner = ?5",
            table = MEMORY_FLUSH_LEDGER_TABLE,
        ),
        params![
            error,
            now_ms + MEMORY_FLUSH_RETRY_BACKOFF_MS,
            now_ms,
            segment_id,
            worker_id,
        ],
    )
    .map(|changed| changed == 1)
}

impl ChatV2Pipeline {
    /// Schedule a non-blocking global recovery pass when the shared backoff permits it.
    pub(crate) fn schedule_memory_flush_recovery(&self) {
        let now_ms = Utc::now().timestamp_millis();
        if self.memory_flush_recovery_running.load(Ordering::Acquire)
            || now_ms < self.memory_flush_next_retry_at_ms.load(Ordering::Acquire)
        {
            return;
        }
        let pipeline = self.clone();
        tauri::async_runtime::spawn(async move {
            pipeline.recover_pending_memory_flushes().await;
        });
    }

    /// Startup and request-entry recovery hook. Database leases make this safe across processes;
    /// the in-memory guard prevents duplicate Lance/LLM setup inside one process.
    pub(crate) async fn recover_pending_memory_flushes(&self) {
        self.flush_pending_memory_segments(None).await;
    }

    pub(super) async fn flush_pending_memory_segments(&self, session_id: Option<&str>) {
        if self
            .memory_flush_recovery_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let guard = MemoryFlushRecoveryGuard {
            running: &self.memory_flush_recovery_running,
        };
        let should_continue = self.flush_pending_memory_segments_guarded(session_id).await;
        self.memory_flush_next_retry_at_ms.store(
            Utc::now().timestamp_millis() + MEMORY_FLUSH_RETRY_BACKOFF_MS,
            Ordering::Release,
        );
        drop(guard);

        if should_continue {
            self.memory_flush_next_retry_at_ms
                .store(0, Ordering::Release);
            self.schedule_memory_flush_recovery();
        }
    }

    /// Process committed memory-flush ledger rows. Configuration failures are fail-closed:
    /// no LLM call or memory write occurs, and pending rows remain recoverable.
    async fn flush_pending_memory_segments_guarded(&self, session_id: Option<&str>) -> bool {
        use crate::memory::{CompactionMemoryFlush, MemoryService};
        use crate::vfs::lance_store::VfsLanceStore;
        use std::sync::Arc;

        let claimable = self.db.get_conn_safe().and_then(|conn| {
            has_claimable_memory_flush_with_conn(&conn, session_id, Utc::now().timestamp_millis())
                .map_err(ChatV2Error::from)
        });
        match claimable {
            Ok(true) => {}
            Ok(false) => return false,
            Err(error) => {
                warn!(
                    "[compaction] pending memory flush preflight failed: {}",
                    error
                );
                return false;
            }
        }

        let Some(vfs_db) = self.vfs_db.clone() else {
            debug!("[compaction] pending memory flush retained: VFS database unavailable");
            return false;
        };

        let policy = match vfs_db
            .get_conn_safe()
            .map_err(|e| format!("open VFS settings database: {}", e))
            .and_then(|conn| read_memory_flush_policy_with_conn(&conn))
        {
            Ok(policy) => policy,
            Err(e) => {
                warn!(
                    "[compaction] pending memory flush retained; settings read failed closed: {}",
                    e
                );
                return false;
            }
        };

        if let MemoryFlushPolicy::Disabled(reason) = policy {
            match self.skip_pending_memory_flushes(session_id, reason) {
                Ok(skipped_segment_ids) => {
                    for segment_id in skipped_segment_ids {
                        if let Err(error) = cleanup_memory_flush_receipts(&vfs_db, &segment_id) {
                            warn!(
                                "[compaction] failed to clean skipped memory receipts segment={}: {}",
                                segment_id, error
                            );
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        "[compaction] failed to mark disabled memory flushes skipped: {}",
                        e
                    );
                }
            }
            debug!("[compaction] memory flush skipped: {}", reason);
            return false;
        }

        // 优先复用 app 托管单例（保留 Lance 连接与 ensured_tables 缓存）；
        // 无托管单例（启动降级/测试）时才按需新建。
        let lance_store = match crate::chat_v2::pipeline::managed_vfs_lance_store_for(&vfs_db) {
            Some(store) => store,
            None => match VfsLanceStore::new(vfs_db.clone()) {
                Ok(store) => Arc::new(store),
                Err(e) => {
                    warn!(
                        "[compaction] pending memory flush retained: lance store unavailable: {}",
                        e
                    );
                    return false;
                }
            },
        };
        let memory_service = MemoryService::new(vfs_db, lance_store, self.llm_manager.clone());
        let flusher = CompactionMemoryFlush::new(self.llm_manager.clone());
        let worker_id = format!("memory_flush_{}", uuid::Uuid::new_v4());
        let mut processed = 0usize;

        while processed < MEMORY_FLUSH_DRAIN_BATCH_SIZE {
            let pending = match self.claim_next_pending_memory_flush(session_id, &worker_id) {
                Ok(Some(pending)) => pending,
                Ok(None) => break,
                Err(e) => {
                    warn!("[compaction] claim pending memory flush failed: {}", e);
                    break;
                }
            };
            processed += 1;
            let segment_id = pending.segment_id.clone();
            let result = self
                .process_claimed_memory_flush(pending, &worker_id, &memory_service, &flusher)
                .await;

            match result {
                Ok(()) => {}
                Err(e) => {
                    warn!(
                        "[compaction] memory flush segment={} failed; retained for retry: {}",
                        segment_id, e
                    );
                    if let Err(release_err) = self.release_memory_flush(&segment_id, &worker_id, &e)
                    {
                        warn!(
                            "[compaction] release memory flush lease failed segment={}: {}",
                            segment_id, release_err
                        );
                    }
                }
            }
        }
        processed == MEMORY_FLUSH_DRAIN_BATCH_SIZE
    }

    fn claim_next_pending_memory_flush(
        &self,
        session_id: Option<&str>,
        worker_id: &str,
    ) -> ChatV2Result<Option<PendingMemoryFlush>> {
        let conn = self.db.get_conn_safe()?;
        claim_next_pending_memory_flush_with_conn(
            &conn,
            session_id,
            worker_id,
            Utc::now().timestamp_millis(),
        )
        .map_err(ChatV2Error::from)
    }

    async fn process_claimed_memory_flush(
        &self,
        mut pending: PendingMemoryFlush,
        worker_id: &str,
        memory_service: &crate::memory::MemoryService,
        flusher: &crate::memory::CompactionMemoryFlush,
    ) -> Result<(), String> {
        use crate::memory::{daily_log, MemoryOpSource, MemoryType};

        let extraction = match pending.extraction_json.as_deref() {
            Some(json) => decode_flush_extraction(json)?,
            None => {
                // Cancellation is safe only before any memory mutation. Once item writes start,
                // let MemoryService finish its idempotency finalization instead of timing it out.
                let extraction = tokio::time::timeout(
                    std::time::Duration::from_secs(MEMORY_FLUSH_EXTRACTION_TIMEOUT_SECS),
                    flusher.extract(&pending.segment_text),
                )
                .await
                .map_err(|_| {
                    format!(
                        "memory extraction timed out after {}s",
                        MEMORY_FLUSH_EXTRACTION_TIMEOUT_SECS
                    )
                })?
                .map_err(|e| format!("memory extraction LLM failed: {}", e))?;
                let json = encode_flush_extraction(&extraction)
                    .map_err(|e| format!("encode memory extraction: {}", e))?;
                self.save_memory_flush_extraction(&pending.segment_id, worker_id, &json)
                    .map_err(|e| e.to_string())?;
                pending.extraction_json = Some(json);
                extraction
            }
        };

        if pending.facts_completed > extraction.facts.len()
            || pending.activities_completed > extraction.activities.len()
        {
            return Err("memory flush ledger progress exceeds extraction length".to_string());
        }

        let mut facts_stored = 0usize;
        for (index, fact) in extraction
            .facts
            .iter()
            .enumerate()
            .skip(pending.facts_completed)
        {
            let idempotency_key = memory_flush_fact_idempotency_key(&pending.segment_id, index);
            let output = memory_service
                .write_smart_with_source(
                    fact.folder.as_deref(),
                    &fact.title,
                    &fact.content,
                    MemoryOpSource::AutoExtract,
                    Some(&pending.session_id),
                    MemoryType::Fact,
                    None,
                    Some(&idempotency_key),
                )
                .await
                .map_err(|e| format!("store memory fact {}: {}", index, e))?;
            if matches!(output.event.as_str(), "ADD" | "UPDATE" | "APPEND") {
                facts_stored += 1;
            }
            self.update_memory_flush_progress(
                &pending.segment_id,
                worker_id,
                index + 1,
                pending.activities_completed,
            )
            .map_err(|e| e.to_string())?;
            pending.facts_completed = index + 1;
        }

        let mut activities_stored = 0usize;
        for (index, activity) in extraction
            .activities
            .iter()
            .enumerate()
            .skip(pending.activities_completed)
        {
            let outcome = daily_log::append_entry(memory_service, activity)
                .map_err(|e| format!("store daily activity {}: {}", index, e))?;
            if outcome.appended {
                activities_stored += 1;
            }
            self.update_memory_flush_progress(
                &pending.segment_id,
                worker_id,
                pending.facts_completed,
                index + 1,
            )
            .map_err(|e| e.to_string())?;
            pending.activities_completed = index + 1;
        }

        self.complete_memory_flush(&pending.segment_id, worker_id)
            .map_err(|e| e.to_string())?;
        // 🆕 与工具写入路径对齐：flush 写入落盘后触发统一维护流程
        // （__user_profile__ 画像摘要刷新 + 条件分类刷新 + 自进化）。
        // spawn 到后台任务，不阻塞 flush 主流程；内部失败不影响账本进度提交。
        if facts_stored > 0 || activities_stored > 0 {
            memory_service.spawn_post_write_maintenance();
        }
        if let Err(error) =
            cleanup_memory_flush_receipts(memory_service.vfs_db_ref(), &pending.segment_id)
        {
            // The completed Chat ledger prevents replay, so receipt cleanup is best-effort.
            warn!(
                "[compaction] failed to clean completed memory receipts segment={}: {}",
                pending.segment_id, error
            );
        }
        info!(
            "[compaction] memory flush completed: segment={} compaction={} facts={}/{} activities={}/{}",
            pending.segment_id,
            pending.compaction_id,
            facts_stored,
            extraction.facts.len(),
            activities_stored,
            extraction.activities.len()
        );
        Ok(())
    }

    fn save_memory_flush_extraction(
        &self,
        segment_id: &str,
        worker_id: &str,
        extraction_json: &str,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = Utc::now().timestamp_millis();
        let changed = save_memory_flush_extraction_with_conn(
            &conn,
            segment_id,
            worker_id,
            extraction_json,
            now_ms,
        )?;
        ensure_single_ledger_update(usize::from(changed))
    }

    fn update_memory_flush_progress(
        &self,
        segment_id: &str,
        worker_id: &str,
        facts_completed: usize,
        activities_completed: usize,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = Utc::now().timestamp_millis();
        let changed = update_memory_flush_progress_with_conn(
            &conn,
            segment_id,
            worker_id,
            facts_completed,
            activities_completed,
            now_ms,
        )?;
        ensure_single_ledger_update(usize::from(changed))
    }

    fn complete_memory_flush(&self, segment_id: &str, worker_id: &str) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = Utc::now().timestamp_millis();
        let changed = complete_memory_flush_with_conn(&conn, segment_id, worker_id, now_ms)?;
        ensure_single_ledger_update(usize::from(changed))
    }

    fn release_memory_flush(
        &self,
        segment_id: &str,
        worker_id: &str,
        error: &str,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let changed = release_memory_flush_with_conn(
            &conn,
            segment_id,
            worker_id,
            error,
            Utc::now().timestamp_millis(),
        )?;
        ensure_single_ledger_update(usize::from(changed))
    }

    fn skip_pending_memory_flushes(
        &self,
        session_id: Option<&str>,
        reason: &str,
    ) -> ChatV2Result<Vec<String>> {
        let mut conn = self.db.get_conn_safe()?;
        let tx = conn.transaction()?;
        ensure_memory_flush_ledger_with_conn(&tx)?;
        let now_ms = Utc::now().timestamp_millis();
        let skipped_segment_ids = {
            let mut stmt = tx.prepare(&format!(
                "SELECT segment_id FROM {table} \
                 WHERE (?1 IS NULL OR session_id = ?1) AND (status = 'pending' \
                   OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?2))",
                table = MEMORY_FLUSH_LEDGER_TABLE,
            ))?;
            let rows = stmt.query_map(params![session_id, now_ms], |row| row.get(0))?;

            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        tx.execute(
            &format!(
                "UPDATE {table} SET status = 'skipped', lease_owner = NULL, \
                 lease_expires_at = NULL, last_error = ?1, segment_text = '', \
                 extraction_json = NULL, updated_at = ?2, completed_at = ?2 \
                 WHERE (?3 IS NULL OR session_id = ?3) AND (status = 'pending' \
                   OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?2))",
                table = MEMORY_FLUSH_LEDGER_TABLE,
            ),
            params![reason, now_ms, session_id],
        )?;
        tx.commit()?;
        Ok(skipped_segment_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_memory_flush_ledger() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory ledger");
        conn.execute_batch(
            "CREATE TABLE chat_v2_compactions (id TEXT PRIMARY KEY);\
             INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test');",
        )
        .expect("create compaction parent table");
        ensure_memory_flush_ledger_with_conn(&conn).expect("create memory flush ledger");
        conn
    }

    fn pending_memory_flush() -> PendingMemoryFlush {
        PendingMemoryFlush {
            segment_id: "seg_test".to_string(),
            compaction_id: "cmp_test".to_string(),
            session_id: "session_test".to_string(),
            segment_ordinal: 0,
            segment_text: "A sufficiently long conversation segment for extraction.".to_string(),
            extraction_json: None,
            facts_completed: 0,
            activities_completed: 0,
        }
    }

    #[test]
    fn missing_or_malformed_memory_settings_fail_closed() {
        let conn = rusqlite::Connection::open_in_memory().expect("open sqlite");
        assert!(
            read_memory_flush_policy_with_conn(&conn).is_err(),
            "missing settings table must not default to sending conversation text to an LLM"
        );

        conn.execute_batch(
            "CREATE TABLE memory_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
             INSERT INTO memory_config (key, value) VALUES ('privacy_mode', 'corrupt');",
        )
        .expect("create malformed settings");
        assert!(
            read_memory_flush_policy_with_conn(&conn).is_err(),
            "malformed privacy setting must fail closed"
        );
    }

    #[test]
    fn privacy_and_auto_extract_off_disable_memory_flush() {
        let conn = rusqlite::Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            "CREATE TABLE memory_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
             INSERT INTO memory_config (key, value) VALUES ('privacy_mode', 'true');\
             INSERT INTO memory_config (key, value) VALUES ('auto_extract_frequency', 'balanced');",
        )
        .expect("create settings");
        assert_eq!(
            read_memory_flush_policy_with_conn(&conn).unwrap(),
            MemoryFlushPolicy::Disabled("privacy mode")
        );

        conn.execute(
            "UPDATE memory_config SET value = 'false' WHERE key = 'privacy_mode'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE memory_config SET value = 'off' WHERE key = 'auto_extract_frequency'",
            [],
        )
        .unwrap();
        assert_eq!(
            read_memory_flush_policy_with_conn(&conn).unwrap(),
            MemoryFlushPolicy::Disabled("auto extract off")
        );
    }

    #[test]
    fn memory_flush_segment_id_is_stable_and_boundary_scoped() {
        let first = build_memory_flush_segment_id("s1", Some("cmp0"), "m3", "m9", 0);
        let retry = build_memory_flush_segment_id("s1", Some("cmp0"), "m3", "m9", 0);
        let different_end = build_memory_flush_segment_id("s1", Some("cmp0"), "m3", "m10", 0);
        let next_chunk = build_memory_flush_segment_id("s1", Some("cmp0"), "m3", "m9", 1);
        assert_eq!(first, retry);
        assert_ne!(first, different_end);
        assert_ne!(first, next_chunk);
    }

    #[test]
    fn long_memory_flush_input_is_split_without_omitting_the_middle() {
        let input = format!(
            "{}MIDDLE_SENTINEL{}",
            "a".repeat(MEMORY_FLUSH_SEGMENT_MAX_CHARS + 17),
            "z".repeat(MEMORY_FLUSH_SEGMENT_MAX_CHARS + 29)
        );
        let chunks = split_memory_flush_segment(&input);
        assert!(chunks.len() >= 3);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= MEMORY_FLUSH_SEGMENT_MAX_CHARS));
        assert_eq!(chunks.concat(), input);
        assert!(chunks.concat().contains("MIDDLE_SENTINEL"));
    }

    #[test]
    fn memory_flush_split_prefers_rendered_block_boundaries() {
        let first = format!("[#0 USER]\n{}\n\n", "a".repeat(7_000));
        let second = format!("[#1 ASSISTANT]\n{}\n\n", "b".repeat(7_000));
        let input = format!("{}{}", first, second);
        let chunks = split_memory_flush_segment(&input);
        assert_eq!(chunks, vec![first, second.trim_end().to_string()]);
        assert_eq!(chunks.concat(), input.trim());
    }

    #[test]
    fn legacy_memory_flush_ledger_backfills_stable_ordinals() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_v2_compactions (id TEXT PRIMARY KEY);\
             INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test');\
             CREATE TABLE chat_v2_compaction_memory_flushes (\
               segment_id TEXT PRIMARY KEY, compaction_id TEXT NOT NULL, session_id TEXT NOT NULL,\
               segment_text TEXT NOT NULL, extraction_json TEXT, facts_completed INTEGER NOT NULL DEFAULT 0,\
               activities_completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',\
               lease_owner TEXT, lease_expires_at INTEGER, last_error TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,\
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER\
             );\
             INSERT INTO chat_v2_compaction_memory_flushes\
               (segment_id, compaction_id, session_id, segment_text, created_at, updated_at) VALUES\
               ('seg_old_0', 'cmp_test', 'session_test', 'zero', 10, 10),\
               ('seg_old_1', 'cmp_test', 'session_test', 'one', 10, 10);",
        )
        .unwrap();

        ensure_memory_flush_ledger_with_conn(&conn).unwrap();
        let ordinals: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    "SELECT segment_ordinal FROM chat_v2_compaction_memory_flushes ORDER BY rowid",
                )
                .unwrap();
            let rows = stmt.query_map([], |row| row.get(0)).unwrap();
            let values = rows.collect::<Result<_, _>>().unwrap();
            values
        };
        assert_eq!(ordinals, vec![0, 1]);
    }

    #[test]
    fn claim_never_overtakes_an_earlier_segment_in_the_same_session() {
        let conn = setup_memory_flush_ledger();
        let first = pending_memory_flush();
        let mut second = first.clone();
        second.segment_id = "seg_test_1".to_string();
        second.segment_ordinal = 1;
        assert!(enqueue_memory_flush_with_conn(&conn, &first, 100).unwrap());
        assert!(enqueue_memory_flush_with_conn(&conn, &second, 100).unwrap());
        assert!(
            has_claimable_memory_flush_with_conn(&conn, Some(&first.session_id), 1_000,).unwrap()
        );

        let claimed = claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&first.session_id),
            "worker_1",
            1_000,
        )
        .unwrap()
        .unwrap();
        assert_eq!(claimed.segment_id, first.segment_id);
        assert_eq!(claimed.segment_ordinal, 0);
        assert!(claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&first.session_id),
            "worker_2",
            1_001,
        )
        .unwrap()
        .is_none());
        assert!(
            !has_claimable_memory_flush_with_conn(&conn, Some(&first.session_id), 1_001,).unwrap()
        );

        assert!(
            complete_memory_flush_with_conn(&conn, &first.segment_id, "worker_1", 1_002,).unwrap()
        );
        let next = claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&first.session_id),
            "worker_2",
            1_003,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next.segment_id, second.segment_id);
        assert_eq!(next.segment_ordinal, 1);
    }

    #[test]
    fn ledger_enqueue_rolls_back_with_compaction_transaction() {
        let mut conn = setup_memory_flush_ledger();
        conn.execute("DELETE FROM chat_v2_compactions", []).unwrap();
        let tx = conn.transaction().expect("begin transaction");
        tx.execute(
            "INSERT INTO chat_v2_compactions (id) VALUES ('cmp_test')",
            [],
        )
        .unwrap();
        assert!(enqueue_memory_flush_with_conn(&tx, &pending_memory_flush(), 10).unwrap());
        tx.rollback().expect("rollback transaction");

        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", MEMORY_FLUSH_LEDGER_TABLE),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "failed compaction transaction must not queue flush"
        );
    }

    #[tokio::test]
    async fn crashed_flush_reuses_real_vfs_receipt_and_persisted_extraction() {
        use crate::memory::{MemoryOpSource, MemoryService, MemoryType};

        let conn = setup_memory_flush_ledger();
        let pending = pending_memory_flush();
        assert!(enqueue_memory_flush_with_conn(&conn, &pending, 100).unwrap());
        assert!(
            !enqueue_memory_flush_with_conn(&conn, &pending, 101).unwrap(),
            "stable segment ID must deduplicate enqueue retries"
        );

        let first = claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&pending.session_id),
            "worker_1",
            1_000,
        )
        .unwrap()
        .expect("first lease");
        let mut extraction_llm_calls = 0usize;
        let extraction_json = if let Some(json) = first.extraction_json {
            json
        } else {
            extraction_llm_calls += 1;
            let json = r#"{"facts":[{"title":"偏好","content":"偏好先看结论","folder":"偏好"}],"activities":[]}"#
                .to_string();
            assert!(save_memory_flush_extraction_with_conn(
                &conn,
                &first.segment_id,
                "worker_1",
                &json,
                1_001,
            )
            .unwrap());
            json
        };
        assert_eq!(
            decode_flush_extraction(&extraction_json)
                .unwrap()
                .facts
                .len(),
            1
        );

        let (_temp_dir, vfs_db, memory_service) =
            crate::memory::test_support::setup_memory_service();
        {
            let vfs_conn = vfs_db.get_conn_safe().unwrap();
            vfs_conn
                .execute(
                    "INSERT INTO memory_config (key, value) VALUES ('privacy_mode', 'true') \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [],
                )
                .unwrap();
        }

        // First prove that an interruption between the VFS mutation and receipt rolls back both.
        let first_key = memory_flush_fact_idempotency_key(&first.segment_id, 0);
        MemoryService::fail_next_idempotent_write_before_receipt(&first_key);
        let interrupted = memory_service
            .write_smart_with_source(
                Some("偏好"),
                "崩溃恢复测试",
                "偏好先看结论",
                MemoryOpSource::AutoExtract,
                Some(&pending.session_id),
                MemoryType::Fact,
                None,
                Some(&first_key),
            )
            .await;
        assert!(interrupted.is_err());
        {
            let vfs_conn = vfs_db.get_conn_safe().unwrap();
            let (notes, receipts): (i64, i64) = (
                vfs_conn
                    .query_row(
                        "SELECT COUNT(*) FROM notes WHERE title = '崩溃恢复测试' AND deleted_at IS NULL",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap(),
                vfs_conn
                    .query_row(
                        "SELECT COUNT(*) FROM memory_write_idempotency WHERE idempotency_key = ?1",
                        params![first_key],
                        |row| row.get(0),
                    )
                    .unwrap(),
            );
            assert_eq!((notes, receipts), (0, 0));
        }

        // Commit the actual VFS note and completed receipt, then crash before Chat ledger progress.
        let first_output = memory_service
            .write_smart_with_source(
                Some("偏好"),
                "崩溃恢复测试",
                "偏好先看结论",
                MemoryOpSource::AutoExtract,
                Some(&pending.session_id),
                MemoryType::Fact,
                None,
                Some(&first_key),
            )
            .await
            .unwrap();
        vfs_db
            .get_conn_safe()
            .unwrap()
            .execute(
                "UPDATE memory_write_idempotency SET created_at = 0 WHERE idempotency_key = ?1",
                params![first_key],
            )
            .unwrap();
        assert!(claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&pending.session_id),
            "worker_2",
            1_000 + MEMORY_FLUSH_LEASE_MS - 1,
        )
        .unwrap()
        .is_none());

        let retry = claim_next_pending_memory_flush_with_conn(
            &conn,
            Some(&pending.session_id),
            "worker_2",
            1_001 + MEMORY_FLUSH_LEASE_MS,
        )
        .unwrap()
        .expect("expired lease must be recoverable");
        if retry.extraction_json.is_none() {
            extraction_llm_calls += 1;
        }
        let retry_key = memory_flush_fact_idempotency_key(&retry.segment_id, 0);
        assert_eq!(first_key, retry_key);
        let retry_output = memory_service
            .write_smart_with_source(
                Some("偏好"),
                "崩溃恢复测试",
                "偏好先看结论",
                MemoryOpSource::AutoExtract,
                Some(&pending.session_id),
                MemoryType::Fact,
                None,
                Some(&retry_key),
            )
            .await
            .unwrap();
        assert_eq!(retry_output, first_output);
        assert!(update_memory_flush_progress_with_conn(
            &conn,
            &retry.segment_id,
            "worker_2",
            1,
            0,
            1_002 + MEMORY_FLUSH_LEASE_MS,
        )
        .unwrap());
        assert!(complete_memory_flush_with_conn(
            &conn,
            &retry.segment_id,
            "worker_2",
            1_003 + MEMORY_FLUSH_LEASE_MS,
        )
        .unwrap());
        assert_eq!(
            cleanup_memory_flush_receipts(&vfs_db, &retry.segment_id).unwrap(),
            1
        );

        assert_eq!(
            extraction_llm_calls, 1,
            "retry must reuse persisted extraction"
        );
        {
            let vfs_conn = vfs_db.get_conn_safe().unwrap();
            let notes: i64 = vfs_conn
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE title = '崩溃恢复测试' AND deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let completed_receipts: i64 = vfs_conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_write_idempotency \
                     WHERE idempotency_key = ?1 AND event != 'IN_PROGRESS'",
                    params![retry_key],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(notes, 1, "receipt replay must not duplicate the VFS note");
            assert_eq!(completed_receipts, 0);
        }
        let (status, attempts): (String, i64) = conn
            .query_row(
                &format!(
                    "SELECT status, attempt_count FROM {} WHERE segment_id = ?1",
                    MEMORY_FLUSH_LEDGER_TABLE
                ),
                params![pending.segment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(attempts, 2);
    }
}
