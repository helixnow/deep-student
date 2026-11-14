/**
 * SRS projection writes for `insight_jobs` (`srs_projection`).
 *
 * The projection deliberately lands in the `mistakes` database: one synthetic
 * `document_tasks` row plus one materialized `anki_cards` row whose
 * `source_type` is `inspiration`. L16 owns both tables; the caller supplies its
 * mistakes connection to the published *WithConn APIs, in Rust statement order.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { nowIso } from './insight-cards.ts';
import type { AnkiService } from '../../anki/api.ts';

export type InsightProjectionOwner = Pick<AnkiService, 'tombstoneInsightProjectionCardWithConn'
  | 'upsertInsightProjectionTaskWithConn' | 'writeInsightProjectionCardWithConn'>;

export interface InsightProjectionCard {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly currentRevision: {
    readonly situation: string;
    readonly stuckPoint: string;
    readonly turningPoint: string;
    readonly rule: string;
    readonly validityConditions: string;
  } | null;
}

/** Rust `execute_srs_projection`: materialize one card, regenerating content in place. */
export function projectInsightCard(mistakes: SqlExecutor, card: InsightProjectionCard | null,
  insightId: string, getOwner: () => InsightProjectionOwner): void {
  const taskId = `task_insight_${insightId}`;
  const cardId = `ac_insight_${insightId}`;
  const now = nowIso();

  if (card === null) {
    // Tombstone propagation: the source card is gone, so the projection follows.
    getOwner().tombstoneInsightProjectionCardWithConn(mistakes, cardId, now);
    return;
  }
  if (card.status !== 'active') return;
  const revision = card.currentRevision;
  if (revision === null) throw new Error('Database error: 灵感卡缺少当前修订');

  const front = revision.stuckPoint.trim() === ''
    ? `【${card.title}】\n${revision.situation}`
    : `【${card.title}】\n${revision.situation}\n\n卡点：${revision.stuckPoint}`;
  let back = `转折：${revision.turningPoint}`;
  if (revision.rule.trim() !== '') back += `\n规则：${revision.rule}`;
  if (revision.validityConditions.trim() !== '') {
    back += `\n成立条件：${revision.validityConditions}`;
  }

  const owner = getOwner();
  owner.upsertInsightProjectionTaskWithConn(mistakes, {
    taskId, documentId: `insight:${insightId}`, originalDocumentName: card.title,
    contentSegment: revision.rule, now,
  });
  owner.writeInsightProjectionCardWithConn(mistakes, {
    cardId, taskId, front, back, sourceId: insightId, now,
  });
}
