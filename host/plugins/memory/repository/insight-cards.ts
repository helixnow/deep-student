/**
 * Insight card recall persistence — TS mirror of
 * `dstu-research/src/insight/repo.rs` read paths and
 * `insight/recall.rs` FTS/LIKE candidate generation plus relation expansion.
 *
 * Only the columns consumed by recall are read. Insight cards are written by
 * fixtures here because the full card service (create/confirm/correct) is not
 * part of this lane yet; the triggers from `V20260908__insight_fts.sql` keep
 * the contentless FTS index in sync.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { IpcInteger } from '../../../kernel/api.ts';
import { chronoRfc3339, orderedNowEpochNanos } from '../../../platform/time/index.ts';
import { internalizationDiscount } from '../src/disclosure.ts';

export function nowIso(): string {
  return chronoRfc3339(orderedNowEpochNanos());
}

export type InsightStatus = 'active' | 'cold' | 'archived';
export type RecallMatchedVia = 'fts' | 'like' | 'relation' | 'fts_rewritten';

export interface InsightRevision {
  id: string;
  insightId: string;
  resourceId: string | null;
  situation: string;
  stuckPoint: string;
  turningPoint: string;
  rule: string;
  validityConditions: string;
  hypotheticalQueries: string[];
  editNote: string | null;
  createdAt: string;
}

export interface InsightCard {
  id: string;
  title: string;
  ownership: string;
  verificationState: string;
  status: InsightStatus;
  recallCount: number;
  shownCount: number;
  usefulCount: number;
  lastRecalledAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  currentRevision: InsightRevision | null;
}

export interface RecallCandidate {
  card: InsightCard;
  confidence: number;
  matchedVia: RecallMatchedVia;
}

interface InsightRow {
  title: string;
  ownership: string;
  verification_state: string;
  status: string;
  recall_count: number;
  shown_count: number;
  useful_count: number;
  last_recalled_at: string | null;
  created_at: string;
  updated_at: string | null;
  current_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  insight_id: string;
  resource_id: string | null;
  situation: string;
  stuck_point: string;
  turning_point: string;
  rule: string;
  validity_conditions: string;
  hypothetical_queries: string | null;
  edit_note: string | null;
  created_at: string;
}

const getInsightRowQuery = defineQuery<[string], InsightRow>(
  `SELECT title, ownership, verification_state, status, recall_count, shown_count,
          useful_count, last_recalled_at, created_at, updated_at, current_revision_id
   FROM insights WHERE id = ?1 AND deleted_at IS NULL`,
  { name: 'memory.insight.card.get' });

const getRevisionQuery = defineQuery<[string], RevisionRow>(
  `SELECT id, insight_id, resource_id, situation, stuck_point, turning_point, rule,
          validity_conditions, hypothetical_queries, edit_note, created_at
   FROM insight_revisions WHERE id = ?1 AND deleted_at IS NULL`,
  { name: 'memory.insight.revision.get' });

function parseStatus(value: string): InsightStatus {
  return value === 'cold' || value === 'archived' ? value : 'active';
}

/** Rust `repo::get_card` (deleted cards read as absent). */
export function getInsightCard(db: SqlExecutor, id: string): InsightCard | null {
  const row = db.get(getInsightRowQuery, [id]);
  if (row === undefined) return null;
  const currentRevision = row.current_revision_id === null
    ? null : getInsightRevision(db, row.current_revision_id);
  return {
    id,
    title: row.title,
    ownership: row.ownership,
    verificationState: row.verification_state,
    status: parseStatus(row.status),
    recallCount: row.recall_count,
    shownCount: row.shown_count,
    usefulCount: row.useful_count,
    lastRecalledAt: row.last_recalled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentRevision,
  };
}

/** Rust `repo::get_revision`. */
export function getInsightRevision(db: SqlExecutor, revisionId: string): InsightRevision | null {
  const revisionRow = db.get(getRevisionQuery, [revisionId]);
  if (revisionRow === undefined) return null;
  return {
    id: revisionRow.id,
    insightId: revisionRow.insight_id,
    resourceId: revisionRow.resource_id,
    situation: revisionRow.situation,
    stuckPoint: revisionRow.stuck_point,
    turningPoint: revisionRow.turning_point,
    rule: revisionRow.rule,
    validityConditions: revisionRow.validity_conditions,
    hypotheticalQueries: revisionRow.hypothetical_queries === null
      ? [] : safeJsonArray(revisionRow.hypothetical_queries),
    editNote: revisionRow.edit_note,
    createdAt: revisionRow.created_at,
  };
}

const listRevisionIdsQuery = defineQuery<[string], { id: string }>(
  `SELECT id FROM insight_revisions
   WHERE insight_id = ?1 AND deleted_at IS NULL
   ORDER BY created_at ASC, id ASC`, { name: 'memory.insight.revision.list' });

/** Rust `repo::list_revisions` (old revisions stay readable forever). */
export function listInsightRevisions(db: SqlExecutor, insightId: string): InsightRevision[] {
  const out: InsightRevision[] = [];
  for (const { id } of db.all(listRevisionIdsQuery, [insightId])) {
    const revision = getInsightRevision(db, id);
    if (revision !== null) out.push(revision);
  }
  return out;
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Rust `build_fts_match_query`: quoted phrase, <3 characters falls back to LIKE. */
export function buildFtsMatchQuery(keyword: string): string | null {
  const trimmed = keyword.trim();
  if (Array.from(trimmed).length < 3) return null;
  return `"${trimmed.replaceAll('"', '""')}"`;
}

/** Rust `bm25_to_confidence`: bm25 is negative, map into (0, 1]. */
export function bm25ToConfidence(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

interface FtsRow { id: string; rank: number }

const recallFtsQuery = defineQuery<[string, number], FtsRow>(
  `SELECT i.id, bm25(insight_fts, 5.0, 1.0) AS rank
   FROM insight_fts
   JOIN insights i ON i.rowid = insight_fts.rowid
   WHERE insight_fts MATCH ?1
     AND i.deleted_at IS NULL
     AND i.status = 'active'
   ORDER BY rank ASC, i.updated_at DESC, i.id ASC
   LIMIT ?2`,
  { name: 'memory.insight.recall.fts' });

interface LikeRow { id: string; score: number }

const recallLikeQuery = defineQuery<[string, number], LikeRow>(
  `SELECT i.id,
          CASE WHEN i.title LIKE ?1 ESCAPE '\\' THEN 0.6 ELSE 0.4 END AS score
   FROM insights i
   LEFT JOIN insight_revisions rev ON rev.id = i.current_revision_id
   WHERE i.deleted_at IS NULL
     AND i.status = 'active'
     AND (
           i.title LIKE ?1 ESCAPE '\\'
        OR rev.situation LIKE ?1 ESCAPE '\\'
        OR rev.stuck_point LIKE ?1 ESCAPE '\\'
        OR rev.turning_point LIKE ?1 ESCAPE '\\'
        OR rev.rule LIKE ?1 ESCAPE '\\'
     )
   ORDER BY score DESC, i.updated_at DESC, i.id ASC
   LIMIT ?2`,
  { name: 'memory.insight.recall.like' });

function escapeLike(keyword: string): string {
  return keyword.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Rust `recall_like_with_conn`: short-query fallback, title matches outrank body. */
export function recallLike(db: SqlExecutor, query: string, limit: number): RecallCandidate[] {
  const keyword = query.trim();
  if (keyword === '') return [];
  const rows = db.all(recallLikeQuery, [`%${escapeLike(keyword)}%`, limit]);
  const out: RecallCandidate[] = [];
  for (const row of rows) {
    const card = getInsightCard(db, row.id);
    if (card !== null) out.push({ card, confidence: row.score, matchedVia: 'like' });
  }
  return out;
}

/** Rust `recall_fts_with_conn` (trigram phrase search, discount applied). */
export function recallFts(db: SqlExecutor, query: string, limit: number): RecallCandidate[] {
  const matchQuery = buildFtsMatchQuery(query);
  if (matchQuery === null) return recallLike(db, query, limit);
  const rows = db.all(recallFtsQuery, [matchQuery, limit]);
  const out: RecallCandidate[] = [];
  for (const row of rows) {
    const card = getInsightCard(db, row.id);
    if (card === null) continue;
    const discount = internalizationDiscount(
      card.recallCount, card.shownCount, card.usefulCount);
    out.push({
      card, confidence: bm25ToConfidence(row.rank) * discount, matchedVia: 'fts',
    });
  }
  return out;
}

const relationPeersQuery = defineQuery<[string], { peer: string }>(
  `SELECT DISTINCT CASE WHEN from_id = ?1 THEN to_id ELSE from_id END AS peer
   FROM insight_relations
   WHERE status = 'active' AND deleted_at IS NULL
     AND relation_type IN ('same_method', 'same_trap')
     AND (from_id = ?1 OR to_id = ?1)`,
  { name: 'memory.insight.recall.relation_peers' });

/**
 * Rust `expand_via_relations_with_conn`: 1-hop same_method/same_trap peers of
 * direct hits become indirect candidates at 60% of the source confidence.
 */
export function expandViaRelations(db: SqlExecutor, hits: readonly RecallCandidate[],
  budget: number): RecallCandidate[] {
  const out: RecallCandidate[] = [];
  const seen = new Set(hits.map(hit => hit.card.id));
  for (const hit of hits) {
    const peers = db.all(relationPeersQuery, [hit.card.id]);
    for (const { peer } of peers) {
      if (seen.has(peer)) continue;
      seen.add(peer);
      const card = getInsightCard(db, peer);
      if (card === null || card.status !== 'active') continue;
      out.push({ card, confidence: hit.confidence * 0.6, matchedVia: 'relation' });
      if (out.length >= budget) return out;
    }
  }
  return out;
}

// ------------------------------------------------------------------ fixtures

export interface InsightCardFixture {
  id: string;
  title: string;
  situation?: string;
  stuckPoint?: string;
  turningPoint?: string;
  rule?: string;
  validityConditions?: string;
  ownership?: string;
  status?: InsightStatus;
  createdAt?: string;
  /** Simulated soft delete for recall-filter tests. */
  deletedAt?: string | null;
}

/**
 * Persist one insight plus its current revision exactly like the card service
 * does (insight row first, revision, then `current_revision_id`), letting the
 * migration triggers populate `insight_fts`.
 */
export function insertInsightCardFixture(db: SqlExecutor, fixture: InsightCardFixture): {
  cardId: string; revisionId: string;
} {
  const createdAt = fixture.createdAt ?? nowIso();
  const revisionId = `icr_${fixture.id}`;
  db.run(`INSERT INTO insights
            (id, current_revision_id, title, ownership, verification_state, status,
             created_at, updated_at, deleted_at)
          VALUES (?1, NULL, ?2, ?3, 'unverified', ?4, ?5, ?5, ?6)`,
  [fixture.id, fixture.title, fixture.ownership ?? 'self_reported',
    fixture.status ?? 'active', createdAt, fixture.deletedAt ?? null]);
  db.run(`INSERT INTO insight_revisions
            (id, insight_id, situation, stuck_point, turning_point, rule,
             validity_conditions, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  [revisionId, fixture.id, fixture.situation ?? '', fixture.stuckPoint ?? '',
    fixture.turningPoint ?? '', fixture.rule ?? '', fixture.validityConditions ?? '',
    createdAt]);
  db.run('UPDATE insights SET current_revision_id = ?2 WHERE id = ?1',
    [fixture.id, revisionId]);
  return { cardId: fixture.id, revisionId };
}

export function setInsightCardStatus(db: SqlExecutor, cardId: string,
  status: InsightStatus): void {
  db.run(`UPDATE insights SET status = ?2, updated_at = ?3,
            local_version = local_version + 1
          WHERE id = ?1 AND deleted_at IS NULL`,
  [cardId, status, nowIso()]);
}

export function softDeleteInsightCard(db: SqlExecutor, cardId: string): void {
  const now = nowIso();
  db.run(`UPDATE insights
          SET deleted_at = ?2, updated_at = ?2, local_version = local_version + 1
          WHERE id = ?1 AND deleted_at IS NULL`,
  [cardId, now]);
  db.run(`UPDATE insight_revisions
          SET deleted_at = ?2, local_version = local_version + 1
          WHERE insight_id = ?1 AND deleted_at IS NULL`,
  [cardId, now]);
  db.run(`UPDATE insight_evidence
          SET deleted_at = ?2, local_version = local_version + 1
          WHERE insight_id = ?1 AND deleted_at IS NULL`,
  [cardId, now]);
  db.run(`UPDATE insight_relations
          SET deleted_at = ?2, local_version = local_version + 1, status = 'withdrawn'
          WHERE (from_id = ?1 OR to_id = ?1) AND deleted_at IS NULL`,
  [cardId, now]);
}

export function insertInsightRelationFixture(db: SqlExecutor, params: {
  id: string;
  fromId: string;
  toId: string;
  relationType: 'same_method' | 'same_trap' | 'counterexample' | 'abstract_of'
    | 'supersede' | 'contradict' | 'example_of';
  scope?: string | null;
  evidence?: string | null;
  status?: 'active' | 'withdrawn';
  createdAt?: string;
}): void {
  const createdAt = params.createdAt ?? nowIso();
  db.run(`INSERT INTO insight_relations
            (id, from_id, to_id, relation_type, scope, evidence, status, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  [params.id, params.fromId, params.toId, params.relationType, params.scope ?? null,
    params.evidence ?? null, params.status ?? 'active', createdAt]);
}

// ------------------------------------------------------------------ writes

export function insertInsightRow(db: SqlExecutor, id: string, title: string,
  ownership: string, createdAt: string = nowIso()): void {
  db.run(`INSERT INTO insights
            (id, title, ownership, verification_state, status, created_at, updated_at)
          VALUES (?1, ?2, ?3, 'unverified', 'active', ?4, ?4)`,
  [id, title, ownership, createdAt]);
}

export interface InsightRevisionInput {
  id: string;
  insightId: string;
  resourceId: string | null;
  situation: string;
  stuckPoint: string;
  turningPoint: string;
  rule: string;
  validityConditions: string;
  hypotheticalQueries: string[];
  editNote: string | null;
  createdAt: string;
}

export function insertInsightRevision(db: SqlExecutor, revision: InsightRevisionInput): void {
  const hypothetical = revision.hypotheticalQueries.length === 0
    ? null : JSON.stringify(revision.hypotheticalQueries);
  db.run(`INSERT INTO insight_revisions
            (id, insight_id, resource_id, situation, stuck_point, turning_point, rule,
             validity_conditions, hypothetical_queries, edit_note, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
  [revision.id, revision.insightId, revision.resourceId, revision.situation,
    revision.stuckPoint, revision.turningPoint, revision.rule, revision.validityConditions,
    hypothetical, revision.editNote, revision.createdAt]);
}

export function setCurrentInsightRevision(db: SqlExecutor, insightId: string,
  revisionId: string): void {
  db.run(`UPDATE insights SET current_revision_id = ?2, updated_at = ?3,
            local_version = local_version + 1
          WHERE id = ?1`,
  [insightId, revisionId, nowIso()]);
}

export function updateInsightTitle(db: SqlExecutor, insightId: string, title: string): void {
  db.run('UPDATE insights SET title = ?2, updated_at = ?3 WHERE id = ?1',
    [insightId, title.trim(), nowIso()]);
}

export interface InsightEvidenceRow {
  id: string;
  insightId: string;
  revisionId: string | null;
  kind: string;
  sessionId: string | null;
  messageId: string | null;
  variantId: string | null;
  blockId: string | null;
  textStart: number | null;
  textEnd: number | null;
  speaker: string | null;
  resourceId: string | null;
  quoteSnapshot: string;
  createdAt: string;
}

export function insertInsightEvidence(db: SqlExecutor, evidence: InsightEvidenceRow): void {
  db.run(`INSERT INTO insight_evidence
            (id, insight_id, revision_id, kind, session_id, message_id, variant_id, block_id,
             text_start, text_end, speaker, resource_id, quote_snapshot, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
  [evidence.id, evidence.insightId, evidence.revisionId, evidence.kind, evidence.sessionId,
    evidence.messageId, evidence.variantId, evidence.blockId, evidence.textStart,
    evidence.textEnd, evidence.speaker, evidence.resourceId, evidence.quoteSnapshot,
    evidence.createdAt]);
}

interface EvidenceSqlRow {
  id: string;
  insight_id: string;
  revision_id: string | null;
  kind: string;
  session_id: string | null;
  message_id: string | null;
  variant_id: string | null;
  block_id: string | null;
  text_start: number | null;
  text_end: number | null;
  speaker: string | null;
  resource_id: string | null;
  quote_snapshot: string;
  created_at: string;
}

const listEvidenceQuery = defineQuery<[string], EvidenceSqlRow>(
  `SELECT id, insight_id, revision_id, kind, session_id, message_id, variant_id,
          block_id, text_start, text_end, speaker, resource_id, quote_snapshot, created_at
   FROM insight_evidence
   WHERE insight_id = ?1 AND deleted_at IS NULL
   ORDER BY created_at ASC, id ASC`,
  { name: 'memory.insight.evidence.list' });

export function listInsightEvidence(db: SqlExecutor, insightId: string): InsightEvidenceRow[] {
  return db.all(listEvidenceQuery, [insightId]).map(row => ({
    id: row.id, insightId: row.insight_id, revisionId: row.revision_id, kind: row.kind,
    sessionId: row.session_id, messageId: row.message_id, variantId: row.variant_id,
    blockId: row.block_id, textStart: row.text_start, textEnd: row.text_end,
    speaker: row.speaker, resourceId: row.resource_id, quoteSnapshot: row.quote_snapshot,
    createdAt: row.created_at,
  }));
}

export interface InsightEventRow {
  id: string;
  insightId: string | null;
  sessionId: string | null;
  messageId: string | null;
  eventType: string;
  helpLevel: string;
  qualitySignal: number | null;
  needSignal: number | null;
  benefitSignal: number | null;
  payloadJson: string | null;
  createdAt: string;
}

export function insertInsightEvent(db: SqlExecutor, params: {
  id: string;
  insightId: string | null;
  sessionId: string | null;
  messageId: string | null;
  eventType: string;
  helpLevel: string;
  qualitySignal?: number | null;
  needSignal?: number | null;
  benefitSignal?: number | null;
  payloadJson?: string | null;
  createdAt?: string;
}): string {
  const helpLevel = params.helpLevel === 'hidden' ? 'none' : params.helpLevel;
  const now = params.createdAt ?? nowIso();
  db.run(`INSERT INTO insight_events
            (id, insight_id, session_id, message_id, event_type, help_level,
             quality_signal, need_signal, benefit_signal, payload_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
  [params.id, params.insightId, params.sessionId, params.messageId, params.eventType,
    helpLevel, params.qualitySignal ?? null, params.needSignal ?? null,
    params.benefitSignal ?? null, params.payloadJson ?? null, now]);
  return params.id;
}

interface EventSqlRow {
  id: string;
  insight_id: string | null;
  session_id: string | null;
  message_id: string | null;
  event_type: string;
  help_level: string;
  quality_signal: number | null;
  need_signal: number | null;
  benefit_signal: number | null;
  payload_json: string | null;
  created_at: string;
}

const listEventsQuery = defineQuery<[string, number], EventSqlRow>(
  `SELECT id, insight_id, session_id, message_id, event_type, help_level,
          quality_signal, need_signal, benefit_signal, payload_json, created_at
   FROM insight_events
   WHERE insight_id = ?1 AND deleted_at IS NULL
   ORDER BY created_at DESC, id DESC LIMIT ?2`,
  { name: 'memory.insight.event.list' });

export function listInsightEvents(db: SqlExecutor, insightId: string,
  limit: number): InsightEventRow[] {
  return db.all(listEventsQuery, [insightId, Math.min(200, limit)]).map(row => ({
    id: row.id, insightId: row.insight_id, sessionId: row.session_id,
    messageId: row.message_id, eventType: row.event_type, helpLevel: row.help_level,
    qualitySignal: row.quality_signal, needSignal: row.need_signal,
    benefitSignal: row.benefit_signal, payloadJson: row.payload_json,
    createdAt: row.created_at,
  }));
}

const bumpUsefulQuery = defineQuery<[string, string]>(
  `UPDATE insights SET useful_count = useful_count + 1, updated_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL`, { name: 'memory.insight.bump.useful' });

export function bumpInsightUseful(db: SqlExecutor, insightId: string): void {
  db.run(bumpUsefulQuery, [insightId, nowIso()]);
}

const bumpShownQuery = defineQuery<[string, string]>(
  `UPDATE insights SET shown_count = shown_count + 1, updated_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL`, { name: 'memory.insight.bump.shown' });
const bumpRecallQuery = defineQuery<[string, string]>(
  `UPDATE insights SET recall_count = recall_count + 1, updated_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL`, { name: 'memory.insight.bump.recall' });

/** Rust `repo::bump_stat` for the two recall-path counters. */
export function bumpInsightStat(db: SqlExecutor, insightId: string, column: 'shown_count' | 'recall_count'): void {
  db.run(column === 'shown_count' ? bumpShownQuery : bumpRecallQuery, [insightId, nowIso()]);
}

const touchLastRecalledQuery = defineQuery<[string, string]>(
  'UPDATE insights SET last_recalled_at = ?2 WHERE id = ?1 AND deleted_at IS NULL',
  { name: 'memory.insight.touch.lastRecalled' });

/** Rust `repo::touch_last_recalled`. */
export function touchInsightLastRecalled(db: SqlExecutor, insightId: string): void {
  db.run(touchLastRecalledQuery, [insightId, nowIso()]);
}

const latestHelpLevelQuery = defineQuery<[string, string], { help_level: string | null }>(
  `SELECT help_level FROM insight_events
   WHERE insight_id = ?1 AND session_id = ?2
   ORDER BY created_at DESC, rowid DESC LIMIT 1`, { name: 'memory.insight.event.latestHelpLevel' });

/** insight_recall_executor.rs:195-203: the session's latest recorded help level (`None` on miss). */
export function latestInsightHelpLevel(db: SqlExecutor, insightId: string, sessionId: string): string | null {
  const row = db.get(latestHelpLevelQuery, [insightId, sessionId]);
  return typeof row?.help_level === 'string' ? row.help_level : null;
}

const listInsightIdsQuery = defineQuery<[IpcInteger, IpcInteger], { id: string }>(
  `SELECT id FROM insights WHERE deleted_at IS NULL
   ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`, { name: 'memory.insight.list' });
const listInsightIdsByStatusQuery = defineQuery<[string, IpcInteger, IpcInteger], { id: string }>(
  `SELECT id FROM insights WHERE deleted_at IS NULL AND status = ?1
   ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3`, { name: 'memory.insight.listByStatus' });

/** Rust `repo::list_insights` (ids only; the caller joins cards). */
export function listInsightIds(db: SqlExecutor, status: string | null, limit: IpcInteger,
  offset: IpcInteger): string[] {
  return status === null
    ? db.all(listInsightIdsQuery, [limit, offset]).map(row => row.id)
    : db.all(listInsightIdsByStatusQuery, [status, limit, offset]).map(row => row.id);
}

const upsertRelationQuery = defineQuery<[string, string, string, string | null, string | null,
  string, string]>(`
  INSERT INTO insight_relations
    (id, from_id, to_id, relation_type, scope, evidence, status, created_by, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8)
  ON CONFLICT (from_id, to_id, relation_type) DO UPDATE SET
    status = 'active', scope = excluded.scope, evidence = excluded.evidence,
    updated_at = excluded.updated_at, local_version = insight_relations.local_version + 1`,
  { name: 'memory.insight.relation.upsert' });

const findRelationQuery = defineQuery<[string, string, string], { id: string }>(
  `SELECT id FROM insight_relations WHERE from_id = ?1 AND to_id = ?2 AND relation_type = ?3`,
  { name: 'memory.insight.relation.find' });

export function upsertInsightRelation(db: SqlExecutor, params: {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  scope: string | null;
  evidence: string | null;
  createdBy: string;
  createdAt: string;
}): string {
  db.run(upsertRelationQuery, [params.id, params.fromId, params.toId, params.relationType,
    params.scope, params.evidence, params.createdBy, params.createdAt]);
  const row = db.get(findRelationQuery, [params.fromId, params.toId, params.relationType]);
  if (row === undefined) throw new Error('Database error: relation vanished after upsert');
  return row.id;
}

export interface InsightRelationRow {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  scope: string | null;
  evidence: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
}

interface RelationSqlRow {
  id: string;
  from_id: string;
  to_id: string;
  relation_type: string;
  scope: string | null;
  evidence: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

const listRelationsQuery = defineQuery<[string], RelationSqlRow>(
  `SELECT id, from_id, to_id, relation_type, scope, evidence, status, created_by, created_at
   FROM insight_relations
   WHERE (from_id = ?1 OR to_id = ?1) AND deleted_at IS NULL
   ORDER BY created_at ASC`, { name: 'memory.insight.relation.list' });

export function listInsightRelations(db: SqlExecutor, insightId: string): InsightRelationRow[] {
  return db.all(listRelationsQuery, [insightId]).map(row => ({
    id: row.id, fromId: row.from_id, toId: row.to_id, relationType: row.relation_type,
    scope: row.scope, evidence: row.evidence, status: row.status,
    createdBy: row.created_by, createdAt: row.created_at,
  }));
}

const markDerivedQuery = defineQuery<[string], { id: string }>(
  `SELECT DISTINCT from_id AS id FROM insight_relations
   WHERE to_id = ?1 AND relation_type = 'abstract_of'
     AND status = 'active' AND deleted_at IS NULL
   UNION
   SELECT DISTINCT to_id AS id FROM insight_relations
   WHERE from_id = ?1 AND relation_type = 'example_of'
     AND status = 'active' AND deleted_at IS NULL`,
  { name: 'memory.insight.relation.derived' });

/** Rust `mark_derived_relations_for_review`. */
export function markDerivedRelationsForReview(db: SqlExecutor, sourceInsightId: string): string[] {
  return db.all(markDerivedQuery, [sourceInsightId]).map(row => row.id);
}
