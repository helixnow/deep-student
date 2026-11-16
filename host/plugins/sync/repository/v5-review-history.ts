import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { tableExists } from './sqlite-values.ts';

const columns = `id, question_id, quality, passed, ease_factor_before, ease_factor_after,
  interval_before, interval_after, repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds`;

/** A remote delete can precede delivery of a surviving plan. Keep device-local history until it has a parent again. */
export function detachV5ReviewHistory(db: SqlExecutor, planId: string): void {
  if (!db.get('SELECT 1 FROM review_history WHERE plan_id=? LIMIT 1', [planId])) return;
  db.exec(`CREATE TABLE IF NOT EXISTS __sync_v5_detached_review_history (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    quality INTEGER NOT NULL, passed INTEGER NOT NULL,
    ease_factor_before REAL NOT NULL, ease_factor_after REAL NOT NULL,
    interval_before INTEGER NOT NULL, interval_after INTEGER NOT NULL,
    repetitions_before INTEGER NOT NULL, repetitions_after INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL, user_answer TEXT, time_spent_seconds INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sync_v5_detached_review_question ON __sync_v5_detached_review_history(question_id);`);
  db.run(`INSERT INTO __sync_v5_detached_review_history (${columns})
    SELECT ${columns} FROM review_history WHERE plan_id=?`, [planId]);
  db.run('DELETE FROM review_history WHERE plan_id=?', [planId]);
}

export function attachV5ReviewHistory(db: SqlExecutor, questionId: string, planId: string): void {
  if (!tableExists(db, '__sync_v5_detached_review_history')) return;
  db.run(`INSERT INTO review_history (plan_id, ${columns})
    SELECT ?, ${columns} FROM __sync_v5_detached_review_history WHERE question_id=?`, [planId, questionId]);
  db.run('DELETE FROM __sync_v5_detached_review_history WHERE question_id=?', [questionId]);
}
