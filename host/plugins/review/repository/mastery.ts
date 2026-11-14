import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { appError, errorText } from '../src/errors.ts';
import type { MasteryEvent, MasteryOutcome, MasterySource, MasteryState } from '../api.ts';

export const WEAK_SCORE_THRESHOLD = 0.5;
export const MIN_TOTAL_FOR_WEAK = 3;
export const RECOVER_SCORE_THRESHOLD = 0.75;
const clamp = (n: number) => Math.min(1, Math.max(0, n));
export function targetSignal(outcome: MasteryOutcome): number {
  if (outcome === 'correct') return 1;
  if (outcome === 'wrong') return 0;
  return [0.5, 0, 0.3, 0.8, 1][outcome.rating] ?? 0.5;
}
export function outcomeDb(outcome: MasteryOutcome): string { return typeof outcome === 'string' ? outcome : 'rating'; }
export function insertEvent(
  db: SqlExecutor, id: string, created: string, windowStart: string,
  source: MasterySource, concept: string, item: string, outcome: MasteryOutcome,
): void {
  let prior = 0;
  if (targetSignal(outcome) >= 0.5) {
    try {
      prior = db.pluck<number>(`SELECT COUNT(*) FROM mastery_events
        WHERE concept_key = ?1 AND item_id = ?2 AND deleted_at IS NULL AND created_at >= ?3 AND weight > 0
        AND (outcome = 'correct' OR (outcome = 'rating' AND COALESCE(signal, 0.35) >= 0.5))`, [concept, item, windowStart]) ?? 0;
    } catch { prior = 0; } // Rust deliberately ignores the weight query's error.
  }
  const weight = Math.max(0.05, Math.pow(0.25, prior | 0));
  try {
    db.run(`INSERT INTO mastery_events (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?2) ON CONFLICT(id) DO NOTHING`,
    [id, created, source, concept, item, outcomeDb(outcome), weight, clamp(targetSignal(outcome))]);
  } catch (e) { throw appError('Database', `insert mastery_events: ${errorText(e)}`); }
}
export function recomputeStateWithConn(db: SqlExecutor, conceptKey: string): MasteryState {
  const rows = db.all<{ outcome: string; weight: number; created_at: string; signal: number | null }>(`SELECT outcome, weight, created_at, signal FROM mastery_events
    WHERE concept_key = ?1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, [conceptKey]);
  const state: MasteryState = { conceptKey, score: 0.5, streak: 0, total: 0, wrongCount: 0, lastSignalAt: null };
  for (const row of rows) {
    const target = row.signal === null ? ({ correct: 1, wrong: 0, rating: 0.35 }[row.outcome] ?? 0.5) : clamp(row.signal);
    const alphaW = clamp(0.30 * clamp(row.weight));
    state.score = clamp(state.score + alphaW * (target - state.score));
    state.total++;
    state.lastSignalAt = row.created_at;
    if (target < 0.5) { state.wrongCount++; state.streak = 0; }
    else state.streak = Math.min(2147483647, state.streak + 1);
  }
  try {
    db.run(`INSERT INTO mastery_states (concept_key, score, streak, total, wrong_count, last_signal_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(concept_key) DO UPDATE SET
      score = excluded.score, streak = excluded.streak, total = excluded.total,
      wrong_count = excluded.wrong_count, last_signal_at = excluded.last_signal_at`,
    [conceptKey, state.score, state.streak, state.total, state.wrongCount, state.lastSignalAt]);
  } catch (e) { throw appError('Database', `upsert mastery_states: ${errorText(e)}`); }
  return state;
}
const COLUMNS = 'concept_key AS conceptKey, score, streak, total, wrong_count AS wrongCount, last_signal_at AS lastSignalAt';
export function getState(db: SqlExecutor, concept: string): MasteryState | null { return db.get<MasteryState>(`SELECT ${COLUMNS} FROM mastery_states WHERE concept_key = ?1`, [concept]) ?? null; }
export function weakConcepts(db: SqlExecutor, limit: number): MasteryState[] {
  return db.all<MasteryState>(`SELECT ${COLUMNS} FROM mastery_states WHERE score < ?1 AND total >= ?2 ORDER BY score ASC, wrong_count DESC LIMIT ?3`, [WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK, limit]);
}
export function allStates(db: SqlExecutor): MasteryState[] { return db.all<MasteryState>(`SELECT ${COLUMNS} FROM mastery_states ORDER BY concept_key`); }
export function allConcepts(db: SqlExecutor): string[] {
  return db.all<{ concept_key: string }>('SELECT concept_key FROM mastery_states UNION SELECT concept_key FROM mastery_events ORDER BY concept_key').map(r => r.concept_key);
}
export function overview(db: SqlExecutor): { conceptCount: number; weakCount: number; avgScore: number } {
  return db.one(`SELECT COUNT(*) AS conceptCount,
    COALESCE(SUM(CASE WHEN score < ?1 AND total >= ?2 THEN 1 ELSE 0 END), 0) AS weakCount,
    COALESCE(AVG(score), 0.0) AS avgScore FROM mastery_states`, [WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK]);
}
export function recentWrongSummary(db: SqlExecutor, concept: string, limit: number): string {
  const rows = db.all<{ item_id: string; created_at: string }>(`SELECT item_id, created_at FROM mastery_events
    WHERE concept_key = ?1 AND outcome = 'wrong' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?2`, [concept, limit]);
  return `concept=${concept}; recent wrongs: ${rows.length ? rows.map(r => `${r.item_id}@${r.created_at}`).join(', ') : '(none)'}`;
}
export function listEvents(db: SqlExecutor, concept: string, limit: number): MasteryEvent[] {
  return db.all<MasteryEvent & { signal: number | null }>(`SELECT id, created_at AS createdAt, source, concept_key AS conceptKey,
    item_id AS itemId, outcome, weight, signal FROM mastery_events WHERE concept_key = ?1 AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT ?2`, [concept, limit]).map(({ signal, ...row }) => ({ ...row,
    source: ['qbank', 'fsrs', 'insight'].includes(row.source) ? row.source : 'qbank', ...(signal === null ? {} : { signal }) }));
}
export function eventConcept(db: SqlExecutor, id: string): string | null { return db.pluck<string>('SELECT concept_key FROM mastery_events WHERE id = ?1', [id]) ?? null; }
export function tombstone(db: SqlExecutor, id: string, now: string): void {
  db.run(`UPDATE mastery_events SET deleted_at = COALESCE(deleted_at, ?2), updated_at = ?2,
    local_version = COALESCE(local_version, 0) + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END WHERE id = ?1`, [id, now]);
}
export interface ChainEvent { revision: number; id: string; concept_key: string; outcome: string; deleted_at: string | null }
export function correctionChain(db: SqlExecutor, baseId: string): ChainEvent[] {
  const prefix = `${baseId}_r`;
  return db.all<Omit<ChainEvent, 'revision'>>('SELECT id, concept_key, outcome, deleted_at FROM mastery_events WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2', [baseId, prefix])
    .flatMap(row => {
      const suffix = row.id.slice(prefix.length);
      const revision = row.id === baseId ? 0 : /^\+?[0-9]+$/.test(suffix) && Number(suffix) >= 1 && Number(suffix) <= 4294967295 ? Number(suffix) : null;
      return revision === null ? [] : [{ ...row, revision }];
    });
}
export function insertCorrection(db: SqlExecutor, id: string, now: string, concept: string, question: string, outcome: MasteryOutcome): void {
  try {
    db.run(`INSERT INTO mastery_events (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, ?7, ?2) ON CONFLICT(id) DO NOTHING`, [id, now, 'qbank', concept, question, outcomeDb(outcome), clamp(targetSignal(outcome))]);
  } catch (e) { throw appError('Database', `insert mastery correction event: ${errorText(e)}`); }
}
/** Rust `dstu-research/src/insight/recall.rs:426-448` `record_recall_verdict_to_mastery`. */
export function insertInsightRecallVerdict(
  db: SqlExecutor, insightId: string, sessionId: string, success: boolean, now: string,
): void {
  const outcome = success ? 'correct' : 'wrong';
  try {
    db.run(`INSERT OR IGNORE INTO mastery_events
      (id, created_at, source, concept_key, item_id, outcome, weight, signal, updated_at)
      VALUES (?1, ?2, 'insight', ?3, ?3, ?4, 1.0, ?5, ?2)`,
    [`me_insight_${insightId}_${sessionId}_${outcome}`, now, `insight:${insightId}`, outcome, success ? 1.0 : 0.0]);
  } catch (e) { throw appError('Database', `写入 mastery 证据失败: ${errorText(e)}`); }
}
