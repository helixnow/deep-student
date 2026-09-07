//! 灵感卡 SQL 仓储层：纯 `*_with_conn` 函数，事务边界由调用方控制。

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::AppError;

use super::types::*;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::database(e.to_string())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ============================================================================
// insights
// ============================================================================

pub fn insert_insight(conn: &Connection, id: &str, title: &str, ownership: InsightOwnership) -> Result<(), AppError> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO insights (id, title, ownership, verification_state, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'unverified', 'active', ?4, ?4)",
        params![id, title, ownership.as_str(), now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn get_insight_row(
    conn: &Connection,
    id: &str,
) -> Result<Option<(String, String, String, String, i64, i64, i64, Option<String>, String, Option<String>, Option<String>)>, AppError> {
    conn.query_row(
        "SELECT title, ownership, verification_state, status, recall_count, shown_count,
                useful_count, last_recalled_at, created_at, updated_at, current_revision_id
         FROM insights WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?,
            ))
        },
    )
    .optional()
    .map_err(db_err)
}

/// 主表行 + 当前修订 组装为 InsightCard（service.get_insight 与 recall 共用）
pub fn get_card(conn: &Connection, id: &str) -> Result<Option<InsightCard>, AppError> {
    let Some((title, ownership, verification, status, recall_count, shown_count, useful_count, last_recalled_at, created_at, updated_at, current_rev_id)) =
        get_insight_row(conn, id)?
    else {
        return Ok(None);
    };
    let current_revision = current_rev_id
        .and_then(|rid| get_revision(conn, &rid).ok().flatten());
    Ok(Some(InsightCard {
        id: id.to_string(),
        title,
        ownership: InsightOwnership::parse(&ownership),
        verification_state: VerificationState::parse(&verification),
        status: InsightStatus::parse(&status),
        recall_count,
        shown_count,
        useful_count,
        last_recalled_at,
        created_at,
        updated_at,
        current_revision,
    }))
}

pub fn set_current_revision(conn: &Connection, insight_id: &str, revision_id: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE insights SET current_revision_id = ?2, updated_at = ?3,
                local_version = local_version + 1
         WHERE id = ?1",
        params![insight_id, revision_id, now_iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn set_verification_state(conn: &Connection, insight_id: &str, state: VerificationState) -> Result<(), AppError> {
    conn.execute(
        "UPDATE insights SET verification_state = ?2, updated_at = ?3,
                local_version = local_version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![insight_id, state.as_str(), now_iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn set_status(conn: &Connection, insight_id: &str, status: InsightStatus) -> Result<(), AppError> {
    conn.execute(
        "UPDATE insights SET status = ?2, updated_at = ?3, local_version = local_version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![insight_id, status.as_str(), now_iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

/// 软删除（墓碑）：行保留用于同步墓碑，读路径全部过滤 deleted_at。
pub fn soft_delete_insight(conn: &Connection, insight_id: &str) -> Result<(), AppError> {
    let now = now_iso();
    conn.execute(
        "UPDATE insights SET deleted_at = ?2, updated_at = ?2, local_version = local_version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![insight_id, now],
    )
    .map_err(db_err)?;
    // 派生传播：修订、证据、关系同步打墓碑
    conn.execute(
        "UPDATE insight_revisions SET deleted_at = ?2, local_version = local_version + 1
         WHERE insight_id = ?1 AND deleted_at IS NULL",
        params![insight_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "UPDATE insight_evidence SET deleted_at = ?2, local_version = local_version + 1
         WHERE insight_id = ?1 AND deleted_at IS NULL",
        params![insight_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "UPDATE insight_relations SET deleted_at = ?2, status = 'withdrawn', local_version = local_version + 1
         WHERE (from_id = ?1 OR to_id = ?1) AND deleted_at IS NULL",
        params![insight_id, now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn bump_stat(conn: &Connection, insight_id: &str, column: &str) -> Result<(), AppError> {
    // column 只允许内部常量传入
    let sql = format!(
        "UPDATE insights SET {column} = {column} + 1, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL"
    );
    conn.execute(&sql, params![insight_id, now_iso()]).map_err(db_err)?;
    Ok(())
}

pub fn touch_last_recalled(conn: &Connection, insight_id: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE insights SET last_recalled_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![insight_id, now_iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn list_insights(
    conn: &Connection,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    match status {
        Some(s) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM insights WHERE deleted_at IS NULL AND status = ?1
                     ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![s, limit, offset], |row| row.get(0))
                .map_err(db_err)?;
            for r in rows {
                out.push(r.map_err(db_err)?);
            }
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM insights WHERE deleted_at IS NULL
                     ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![limit, offset], |row| row.get(0))
                .map_err(db_err)?;
            for r in rows {
                out.push(r.map_err(db_err)?);
            }
        }
    }
    Ok(out)
}

// ============================================================================
// insight_revisions
// ============================================================================

pub fn insert_revision(conn: &Connection, rev: &InsightRevision) -> Result<(), AppError> {
    let hq = if rev.hypothetical_queries.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&rev.hypothetical_queries).unwrap_or_default())
    };
    conn.execute(
        "INSERT INTO insight_revisions
         (id, insight_id, resource_id, situation, stuck_point, turning_point, rule,
          validity_conditions, hypothetical_queries, edit_note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            rev.id, rev.insight_id, rev.resource_id, rev.situation, rev.stuck_point,
            rev.turning_point, rev.rule, rev.validity_conditions, hq, rev.edit_note, rev.created_at,
        ],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn get_revision(conn: &Connection, revision_id: &str) -> Result<Option<InsightRevision>, AppError> {
    conn.query_row(
        "SELECT id, insight_id, resource_id, situation, stuck_point, turning_point, rule,
                validity_conditions, hypothetical_queries, edit_note, created_at
         FROM insight_revisions WHERE id = ?1 AND deleted_at IS NULL",
        params![revision_id],
        |row| {
            let hq: Option<String> = row.get(8)?;
            Ok(InsightRevision {
                id: row.get(0)?,
                insight_id: row.get(1)?,
                resource_id: row.get(2)?,
                situation: row.get(3)?,
                stuck_point: row.get(4)?,
                turning_point: row.get(5)?,
                rule: row.get(6)?,
                validity_conditions: row.get(7)?,
                hypothetical_queries: hq
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                edit_note: row.get(9)?,
                created_at: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

pub fn list_revisions(conn: &Connection, insight_id: &str) -> Result<Vec<InsightRevision>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM insight_revisions
             WHERE insight_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(db_err)?;
    let ids = stmt
        .query_map(params![insight_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(rev) = get_revision(conn, &id)? {
            out.push(rev);
        }
    }
    Ok(out)
}

// ============================================================================
// insight_evidence
// ============================================================================

pub fn insert_evidence(conn: &Connection, ev: &InsightEvidence) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO insight_evidence
         (id, insight_id, revision_id, kind, session_id, message_id, variant_id, block_id,
          text_start, text_end, speaker, resource_id, quote_snapshot, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            ev.id, ev.insight_id, ev.revision_id, ev.kind.as_str(), ev.session_id,
            ev.message_id, ev.variant_id, ev.block_id, ev.text_start, ev.text_end,
            ev.speaker, ev.resource_id, ev.quote_snapshot, ev.created_at,
        ],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn list_evidence(conn: &Connection, insight_id: &str) -> Result<Vec<InsightEvidence>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, insight_id, revision_id, kind, session_id, message_id, variant_id,
                    block_id, text_start, text_end, speaker, resource_id, quote_snapshot, created_at
             FROM insight_evidence
             WHERE insight_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![insight_id], |row| {
            Ok(InsightEvidence {
                id: row.get(0)?,
                insight_id: row.get(1)?,
                revision_id: row.get(2)?,
                kind: EvidenceKind::parse(&row.get::<_, String>(3)?),
                session_id: row.get(4)?,
                message_id: row.get(5)?,
                variant_id: row.get(6)?,
                block_id: row.get(7)?,
                text_start: row.get(8)?,
                text_end: row.get(9)?,
                speaker: row.get(10)?,
                resource_id: row.get(11)?,
                quote_snapshot: row.get(12)?,
                created_at: row.get(13)?,
            })
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(db_err)?);
    }
    Ok(out)
}

// ============================================================================
// insight_relations
// ============================================================================

pub fn upsert_relation(
    conn: &Connection,
    from_id: &str,
    to_id: &str,
    relation_type: RelationType,
    scope: Option<&str>,
    evidence: Option<&str>,
    created_by: &str,
) -> Result<String, AppError> {
    let id = generate_relation_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO insight_relations
         (id, from_id, to_id, relation_type, scope, evidence, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8)
         ON CONFLICT (from_id, to_id, relation_type) DO UPDATE SET
            status = 'active', scope = excluded.scope, evidence = excluded.evidence,
            updated_at = excluded.updated_at, local_version = insight_relations.local_version + 1",
        params![id, from_id, to_id, relation_type.as_str(), scope, evidence, created_by, now],
    )
    .map_err(db_err)?;
    // 取回真实 id（冲突复用时 id 不同）
    let real_id: String = conn
        .query_row(
            "SELECT id FROM insight_relations WHERE from_id = ?1 AND to_id = ?2 AND relation_type = ?3",
            params![from_id, to_id, relation_type.as_str()],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    Ok(real_id)
}

pub fn list_relations(conn: &Connection, insight_id: &str) -> Result<Vec<InsightRelation>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, from_id, to_id, relation_type, scope, evidence, status, created_by, created_at
             FROM insight_relations
             WHERE (from_id = ?1 OR to_id = ?1) AND deleted_at IS NULL
             ORDER BY created_at ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![insight_id], |row| {
            Ok(InsightRelation {
                id: row.get(0)?,
                from_id: row.get(1)?,
                to_id: row.get(2)?,
                relation_type: RelationType::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(RelationType::SameMethod),
                scope: row.get(4)?,
                evidence: row.get(5)?,
                status: row.get(6)?,
                created_by: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(db_err)?);
    }
    Ok(out)
}

/// 源卡被更正时：把以其为证据的派生关系（abstract_of/example_of）标记待复审。
/// 返回受影响的派生卡 id（原则卡复审队列的输入，阶段三消费）。
pub fn mark_derived_relations_for_review(
    conn: &Connection,
    source_insight_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT from_id FROM insight_relations
             WHERE to_id = ?1 AND relation_type IN ('abstract_of','example_of')
               AND status = 'active' AND deleted_at IS NULL",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![source_insight_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(db_err)?);
    }
    Ok(out)
}

// ============================================================================
// insight_events
// ============================================================================

#[allow(clippy::too_many_arguments)]
pub fn insert_event(
    conn: &Connection,
    insight_id: Option<&str>,
    session_id: Option<&str>,
    message_id: Option<&str>,
    event_type: InsightEventType,
    help_level: DisclosureLevel,
    quality_signal: Option<f64>,
    need_signal: Option<f64>,
    benefit_signal: Option<f64>,
    payload_json: Option<&str>,
) -> Result<String, AppError> {
    let id = generate_event_id();
    // help_level 列的 CHECK 以 'none' 为最低级；披露状态 Hidden 在事件账本中等价记为 'none'
    let help_level_str = match help_level {
        DisclosureLevel::Hidden => "none",
        other => other.as_str(),
    };
    conn.execute(
        "INSERT INTO insight_events
         (id, insight_id, session_id, message_id, event_type, help_level,
          quality_signal, need_signal, benefit_signal, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id, insight_id, session_id, message_id, event_type.as_str(), help_level_str,
            quality_signal, need_signal, benefit_signal, payload_json, now_iso(),
        ],
    )
    .map_err(db_err)?;
    Ok(id)
}

pub fn list_events(
    conn: &Connection,
    insight_id: &str,
    limit: i64,
) -> Result<Vec<InsightEvent>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, insight_id, session_id, message_id, event_type, help_level,
                    quality_signal, need_signal, benefit_signal, payload_json, created_at
             FROM insight_events
             WHERE insight_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![insight_id, limit], |row| {
            Ok(InsightEvent {
                id: row.get(0)?,
                insight_id: row.get(1)?,
                session_id: row.get(2)?,
                message_id: row.get(3)?,
                event_type: InsightEventType::parse(&row.get::<_, String>(4)?)
                    .unwrap_or(InsightEventType::RecallCandidate),
                help_level: row.get(5)?,
                quality_signal: row.get(6)?,
                need_signal: row.get(7)?,
                benefit_signal: row.get(8)?,
                payload_json: row.get(9)?,
                created_at: row.get(10)?,
            })
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(db_err)?);
    }
    Ok(out)
}
