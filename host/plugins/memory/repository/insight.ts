import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { MasteryService } from '../../review/api.ts';
import { nowIso } from './insight-cards.ts';

const getSettingQuery = defineQuery<[string], string>(
  'SELECT value FROM settings WHERE key = ?1', { name: 'memory.insight.setting' });

/** Rust `disclosure.rs` reads the main settings table directly (`SELECT value FROM settings WHERE key`). */
export function getSetting(db: SqlExecutor, key: string): string | null {
  const value = db.pluck<string>(getSettingQuery, [key]);
  return typeof value === 'string' ? value : null;
}

const sumLedgerQuery = defineQuery<void, { shown: number; useful: number }>(
  `SELECT COALESCE(SUM(CASE WHEN event_type = 'shown_existence' THEN 1 ELSE 0 END), 0) AS shown,
          COALESCE(SUM(CASE WHEN event_type = 'feedback_useful' THEN 1 ELSE 0 END), 0) AS useful
   FROM insight_events WHERE created_at > datetime('now', '-30 days')`,
  { name: 'memory.insight.ledger' });

/** Rust `calibrate_policy_from_ledger`: three-ledger usefulness over the last 30 days. */
export function sumInsightLedger(db: SqlExecutor): { shown: number; useful: number } | undefined {
  return db.get(sumLedgerQuery);
}

const insertEventQuery = defineQuery<[string, string | null, string | null, string | null,
  string, string, string | null, string]>(`
  INSERT OR IGNORE INTO insight_events
    (id, insight_id, session_id, message_id, event_type, help_level,
     quality_signal, need_signal, benefit_signal, payload_json, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?8)`,
{ name: 'memory.insight.event.insert' });

/**
 * Rust `InsightRecallService::record_event_idempotent` (deterministic event id).
 * `hidden` is stored as `'none'`: the `help_level` CHECK has no `'hidden'`, and
 * OR IGNORE would otherwise drop every silence event without an error.
 */
export function recordInsightEventIdempotent(db: SqlExecutor, sessionId: string | null,
  messageId: string | null, insightId: string | null, eventType: string,
  helpLevel: string, payloadJson: string | null = null, createdAt = nowIso()): boolean {
  const id = `iev_${sessionId ?? 'none'}_${messageId ?? 'none'}_${insightId ?? 'none'}_${eventType}`;
  try {
    return db.run(insertEventQuery, [id, insightId, sessionId, messageId, eventType,
      helpLevel === 'hidden' ? 'none' : helpLevel, payloadJson, createdAt]).changes > 0;
  } catch (error) {
    throw new Error(`写入灵感事件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Rust `InsightRecallService::record_recall_verdict_to_mastery` (idempotent by id). */
export function recordRecallVerdictToMastery(owner: Pick<MasteryService,
  'recordInsightRecallVerdictWithConn'>, db: SqlExecutor, insightId: string,
  sessionId: string, success: boolean, now: string = nowIso()): void {
  owner.recordInsightRecallVerdictWithConn(db, insightId, sessionId, success, now);
}
