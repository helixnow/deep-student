/**
 * Test-only row seeding for the ported `learning_overview_executor.rs` aggregation test.
 * The Rust test persists these rows through ChatV2Repo / exam / VfsPomodoroRepo; L17 never
 * writes these tables in production (X6-SW-MEM-02), so the helpers live under tests/.
 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';

export function insertChatSession(db: SqlExecutor, id: string, mode = 'chat',
  createdAt = new Date().toISOString()): void {
  db.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
          VALUES (?1, ?2, 'active', ?3, ?3)`, [id, mode, createdAt]);
}

export function insertChatMessage(db: SqlExecutor, id: string, sessionId: string,
  timestamp = Date.now()): void {
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
          VALUES (?1, ?2, 'user', '[]', ?3)`, [id, sessionId, timestamp]);
}

export function insertExamSheet(db: SqlExecutor, id: string, createdAt: string): void {
  db.run(`INSERT INTO exam_sheets
            (id, status, temp_id, metadata_json, preview_json, created_at, updated_at)
          VALUES (?1, 'completed', ?2, '{}', '{}', ?3, ?3)`,
  [id, `temp_${id}`, createdAt]);
}

export function insertQuestion(db: SqlExecutor, id: string, examId: string,
  createdAt: string): void {
  db.run(`INSERT INTO questions (id, exam_id, content, created_at, updated_at)
          VALUES (?1, ?2, 'Learning question', ?3, ?3)`, [id, examId, createdAt]);
}

export function insertAnswerSubmission(db: SqlExecutor, id: string, questionId: string,
  submittedAt: string): void {
  db.run(`INSERT INTO answer_submissions
            (id, question_id, user_answer, is_correct, grading_method, submitted_at)
          VALUES (?1, ?2, 'A', 1, 'auto', ?3)`, [id, questionId, submittedAt]);
}

export function insertPomodoroRecord(db: SqlExecutor, params: {
  id: string; startTime: string; endTime: string | null; duration: number;
  actualDuration: number; type: string; status: string; createdAt: string;
}): void {
  db.run(`INSERT INTO pomodoro_records
            (id, todo_item_id, start_time, end_time, duration, actual_duration, type,
             status, created_at)
          VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  [params.id, params.startTime, params.endTime, params.duration, params.actualDuration,
    params.type, params.status, params.createdAt]);
}
