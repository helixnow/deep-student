//! 「本课学习台账」：由某节音视频课产出的闪卡 / 题目的只读统计（docs/dev/media-learning §3）
//!
//! | 命令 | 说明 |
//! |---|---|
//! | `media_study_ledger(resourceIds, includeCardIds?)` | 每节课：卡片数 / 到期 / 新卡、题目数 / 作答 / 正确率 / 错题、所在题目集 |
//!
//! - 卡片：制卡任务 `document_tasks.anki_generation_options_json.$.source_ref.id` 等于媒体 id
//!   （chatanki 读媒体、CardForge 直接制卡都会写入）→ `anki_cards` ↔ `fsrs_card_states`（Anki 库）。
//! - 题目：`questions.source_ref.resourceIds` 含媒体 id（出题流水线写入，VFS 库）。
//! - 两个库各查一次、按 resource_id 聚合：库页每行一个计数，不做 N+1。畸形 JSON 不让整条查询报错。

use std::collections::HashMap;

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use tauri::State;

/// 单次查询的资源数上限（SQLite 变量数限制之内）
const MAX_LEDGER_RESOURCES: usize = 500;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStudyLedger {
    pub resource_id: String,
    pub card_count: i64,
    /// 已入队且未暂停、此刻到期的学习 / 复习卡（不含新卡，与卡片库「已到期」同口径）
    pub cards_due: i64,
    /// 已入队且未暂停的新卡
    pub cards_new: i64,
    /// 本课全部卡片的 `anki_cards.id`（「复习本课卡片」用）；仅 includeCardIds 时返回
    pub card_ids: Vec<String>,
    pub question_count: i64,
    /// 做过的题数（attempt_count > 0）
    pub questions_attempted: i64,
    /// 累计作答次数 / 答对次数（正确率 = correct / attempts）
    pub attempt_total: i64,
    pub correct_total: i64,
    /// 最近一次答错的题数
    pub questions_wrong: i64,
    /// 本课题目所在的题目集（题多的在前）
    pub exam_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct CardTally {
    count: i64,
    due: i64,
    new: i64,
    ids: Vec<String>,
}

#[derive(Debug, Default)]
struct QuestionTally {
    count: i64,
    attempted: i64,
    attempts: i64,
    correct: i64,
    wrong: i64,
    exams: HashMap<String, i64>,
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

fn card_tallies(
    conn: &Connection,
    ids: &[String],
    now_ms: i64,
    include_ids: bool,
) -> rusqlite::Result<HashMap<String, CardTally>> {
    let mut out: HashMap<String, CardTally> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT t.rid, ac.id, fs.id IS NOT NULL, fs.state, fs.due_ms, COALESCE(fs.suspended, 0)
         FROM (
             SELECT id,
                    CASE WHEN json_valid(anki_generation_options_json)
                         THEN json_extract(anki_generation_options_json, '$.source_ref.id') END AS rid
             FROM document_tasks
             WHERE deleted_at IS NULL
         ) t
         JOIN anki_cards ac ON ac.task_id = t.id AND ac.deleted_at IS NULL
         LEFT JOIN fsrs_card_states fs ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
         WHERE t.rid IN ({})
         ORDER BY ac.created_at, ac.id",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(ids.iter()))?;
    while let Some(row) = rows.next()? {
        let rid: String = row.get(0)?;
        let card_id: String = row.get(1)?;
        let enqueued: bool = row.get(2)?;
        let state: Option<i64> = row.get(3)?;
        let due_ms: Option<i64> = row.get(4)?;
        let suspended: i64 = row.get(5)?;
        let tally = out.entry(rid).or_default();
        tally.count += 1;
        if include_ids {
            tally.ids.push(card_id);
        }
        if enqueued && suspended == 0 {
            match state {
                Some(0) => tally.new += 1,
                Some(_) if due_ms.is_some_and(|due| due <= now_ms) => tally.due += 1,
                _ => {}
            }
        }
    }
    Ok(out)
}

fn question_tallies(
    conn: &Connection,
    ids: &[String],
) -> rusqlite::Result<HashMap<String, QuestionTally>> {
    let mut out: HashMap<String, QuestionTally> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT DISTINCT rid.value, q.id, q.exam_id, COALESCE(q.attempt_count, 0),
                COALESCE(q.correct_count, 0), q.is_correct
         FROM questions q
         JOIN exam_sheets e ON e.id = q.exam_id AND e.deleted_at IS NULL
         JOIN json_each(
             CASE WHEN json_valid(q.source_ref) AND json_type(q.source_ref, '$.resourceIds') = 'array'
                  THEN json_extract(q.source_ref, '$.resourceIds')
                  ELSE '[]' END
         ) rid
         WHERE q.deleted_at IS NULL AND rid.value IN ({})",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(ids.iter()))?;
    while let Some(row) = rows.next()? {
        let rid: String = row.get(0)?;
        let exam_id: String = row.get(2)?;
        let attempts: i64 = row.get(3)?;
        let correct: i64 = row.get(4)?;
        let is_correct: Option<i64> = row.get(5)?;
        let tally = out.entry(rid).or_default();
        tally.count += 1;
        if attempts > 0 {
            tally.attempted += 1;
        }
        tally.attempts += attempts.max(0);
        tally.correct += correct.max(0);
        if attempts > 0 && is_correct == Some(0) {
            tally.wrong += 1;
        }
        *tally.exams.entry(exam_id).or_default() += 1;
    }
    Ok(out)
}

/// 去空白、去重，保持首次出现顺序，截到上限
fn normalize_ids(resource_ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    resource_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .take(MAX_LEDGER_RESOURCES)
        .collect()
}

fn assemble(
    ids: &[String],
    mut cards: HashMap<String, CardTally>,
    mut questions: HashMap<String, QuestionTally>,
) -> Vec<MediaStudyLedger> {
    ids.iter()
        .map(|id| {
            let card = cards.remove(id).unwrap_or_default();
            let question = questions.remove(id).unwrap_or_default();
            let mut exams: Vec<(String, i64)> = question.exams.into_iter().collect();
            exams.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            MediaStudyLedger {
                resource_id: id.clone(),
                card_count: card.count,
                cards_due: card.due,
                cards_new: card.new,
                card_ids: card.ids,
                question_count: question.count,
                questions_attempted: question.attempted,
                attempt_total: question.attempts,
                correct_total: question.correct,
                questions_wrong: question.wrong,
                exam_ids: exams.into_iter().map(|(exam, _)| exam).collect(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn media_study_ledger(
    resource_ids: Vec<String>,
    include_card_ids: Option<bool>,
    state: State<'_, crate::commands::AppState>,
) -> Result<Vec<MediaStudyLedger>, String> {
    let anki_db = state.anki_database.clone();
    let vfs_db = state.vfs_db.clone();
    let include_ids = include_card_ids.unwrap_or(false);
    tokio::task::spawn_blocking(move || -> Result<Vec<MediaStudyLedger>, String> {
        let ids = normalize_ids(resource_ids);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cards = {
            let conn = anki_db.get_conn_safe().map_err(|e| e.to_string())?;
            card_tallies(&conn, &ids, now_ms, include_ids).map_err(|e| e.to_string())?
        };
        let questions = match vfs_db {
            Some(db) => {
                let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
                question_tallies(&conn, &ids).map_err(|e| e.to_string())?
            }
            None => HashMap::new(),
        };
        Ok(assemble(&ids, cards, questions))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::database::setup_migrated_test_db;

    fn anki_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE document_tasks (id TEXT PRIMARY KEY, anki_generation_options_json TEXT, deleted_at TEXT);
             CREATE TABLE anki_cards (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT, deleted_at TEXT);
             CREATE TABLE fsrs_card_states (id TEXT PRIMARY KEY, anki_card_id TEXT, state INTEGER,
                 due_ms INTEGER, suspended INTEGER, deleted_at TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn tallies_cards_by_task_source_ref() {
        let conn = anki_conn();
        conn.execute_batch(
            r#"INSERT INTO document_tasks VALUES
                 ('t1', '{"source_ref":{"kind":"resource","id":"file_lec"}}', NULL),
                 ('t2', '{"source_ref":{"kind":"note","id":"note_x"}}', NULL),
                 ('t3', 'not json', NULL),
                 ('t4', '{"source_ref":{"kind":"resource","id":"file_lec"}}', '2026-10-01');
               INSERT INTO anki_cards VALUES
                 ('c1', 't1', '1', NULL), ('c2', 't1', '2', NULL), ('c3', 't1', '3', NULL),
                 ('c4', 't1', '4', NULL), ('c5', 't1', '5', '2026-10-02'),
                 ('c6', 't2', '6', NULL), ('c7', 't3', '7', NULL), ('c8', 't4', '8', NULL);
               INSERT INTO fsrs_card_states VALUES
                 ('s1', 'c1', 2, 1000, 0, NULL),
                 ('s2', 'c2', 2, 9000, 0, NULL),
                 ('s3', 'c3', 0, 0, 0, NULL),
                 ('s4', 'c4', 2, 1000, 1, NULL);"#,
        )
        .unwrap();
        let ids = vec!["file_lec".to_string(), "file_none".to_string()];
        let tallies = card_tallies(&conn, &ids, 5000, true).unwrap();
        let lec = &tallies["file_lec"];
        assert_eq!((lec.count, lec.due, lec.new), (4, 1, 1));
        assert_eq!(lec.ids, vec!["c1", "c2", "c3", "c4"]);
        assert!(!tallies.contains_key("file_none"));
        assert!(card_tallies(&conn, &ids, 5000, false).unwrap()["file_lec"]
            .ids
            .is_empty());
    }

    #[test]
    fn tallies_questions_by_resource_ids_and_assembles_in_request_order() {
        let (_dir, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        for (id, deleted_at) in [
            ("exam_a", None),
            ("exam_b", None),
            ("exam_gone", Some("2026-10-05")),
        ] {
            conn.execute(
                "INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at, deleted_at)
                 VALUES (?1, ?1, 'completed', ?1, '{}', '{}', '2026-10-05', '2026-10-05', ?2)",
                rusqlite::params![id, deleted_at],
            )
            .unwrap();
        }
        let insert = |id: &str,
                      exam: &str,
                      source: Option<&str>,
                      attempts: i64,
                      correct: i64,
                      is_correct: Option<i64>| {
            conn.execute(
                "INSERT INTO questions (id, exam_id, content, source_ref, attempt_count, correct_count, is_correct, created_at, updated_at)
                 VALUES (?1, ?2, 'q', ?3, ?4, ?5, ?6, '2026-10-05', '2026-10-05')",
                rusqlite::params![id, exam, source, attempts, correct, is_correct],
            )
            .unwrap();
        };
        insert(
            "q1",
            "exam_a",
            Some(r#"{"resourceIds":["file_lec"]}"#),
            2,
            1,
            Some(0),
        );
        insert(
            "q2",
            "exam_a",
            Some(r#"{"resourceIds":["file_lec","file_other"]}"#),
            1,
            1,
            Some(1),
        );
        insert(
            "q3",
            "exam_b",
            Some(r#"{"resourceIds":["file_lec"]}"#),
            0,
            0,
            None,
        );
        insert(
            "q4",
            "exam_gone",
            Some(r#"{"resourceIds":["file_lec"]}"#),
            3,
            0,
            Some(0),
        );
        insert("q5", "exam_a", Some("broken"), 1, 0, Some(0));
        insert("q6", "exam_a", None, 0, 0, None);
        insert(
            "q7",
            "exam_a",
            Some(r#"{"resourceIds":"file_lec"}"#),
            1,
            0,
            Some(0),
        );

        let ids = normalize_ids(vec![
            " file_other ".into(),
            "file_lec".into(),
            "file_lec".into(),
            "".into(),
        ]);
        assert_eq!(ids, vec!["file_other", "file_lec"]);
        let questions = question_tallies(&conn, &ids).unwrap();
        let ledgers = assemble(&ids, HashMap::new(), questions);
        assert_eq!(ledgers[0].resource_id, "file_other");
        assert_eq!(ledgers[0].question_count, 1);
        let lec = &ledgers[1];
        assert_eq!(
            (
                lec.question_count,
                lec.questions_attempted,
                lec.attempt_total,
                lec.correct_total,
                lec.questions_wrong
            ),
            (3, 2, 3, 2, 1)
        );
        assert_eq!(lec.exam_ids, vec!["exam_a", "exam_b"]);
        assert_eq!(lec.card_count, 0);
    }
}
