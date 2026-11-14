/**
 * Insight card service — TS mirror of
 * `dstu-research/src/insight/service.rs` (draft → confirm → correct → delete,
 * feedback accounting and manual relations).
 *
 * Every write runs inside one `BEGIN IMMEDIATE` transaction, matching the Rust
 * `transaction_with_behavior(Immediate)` calls. Revisions are immutable: edits
 * always create a new revision and never rewrite history.
 */
import { nanoid } from 'nanoid';
import type { IpcInteger } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { AppError, type AppErrorType } from '../../../platform/errors/api.ts';
import { enqueueWithConn } from '../repository/insight-jobs.ts';
import {
  bumpInsightUseful, getInsightCard, insertInsightEvent, insertInsightEvidence,
  insertInsightRevision, insertInsightRow, listInsightEvidence, listInsightEvents,
  listInsightIds, listInsightRelations, listInsightRevisions, markDerivedRelationsForReview,
  nowIso, setCurrentInsightRevision, softDeleteInsightCard, updateInsightTitle,
  upsertInsightRelation,
  type InsightCard, type InsightEventRow, type InsightEvidenceRow, type InsightRelationRow,
  type InsightRevision,
} from '../repository/insight-cards.ts';
import {
  createOrReuseTypedResource, hashContent, type MemoryResourceWriter,
} from '../repository/vfs.ts';

export type InsightOwnership = 'self_reported' | 'guided' | 'ai_draft';
export type InsightEvidenceKind = 'chat_message' | 'resource' | 'note' | 'manual';

export interface InsightEvidenceInput {
  kind: InsightEvidenceKind;
  sessionId?: string | null;
  messageId?: string | null;
  variantId?: string | null;
  blockId?: string | null;
  textStart?: number | null;
  textEnd?: number | null;
  speaker?: string | null;
  resourceId?: string | null;
  quoteSnapshot: string;
}

export interface InsightDraftInput {
  title: string;
  situation: string;
  stuckPoint: string;
  turningPoint: string;
  rule: string;
  validityConditions: string;
  ownership: InsightOwnership;
  evidence: InsightEvidenceInput[];
}

export interface InsightCorrectInput {
  title?: string | null;
  situation?: string | null;
  stuckPoint?: string | null;
  turningPoint?: string | null;
  rule?: string | null;
  validityConditions?: string | null;
  editNote?: string | null;
}

export type InsightDatabase = SqlExecutor & {
  transaction<T>(fn: (tx: SqlExecutor) => T): T;
};

/** Business-layer AppError classification; the command facade wraps it in CommandError. */
export class InsightAppError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'InsightAppError';
    this.appError = appError;
  }
}

function fail(type: AppErrorType, message: string): never {
  throw new InsightAppError(AppError.new(type, message));
}

const RELATION_TYPES = [
  'same_method', 'same_trap', 'counterexample', 'abstract_of',
  'supersede', 'contradict', 'example_of',
] as const;
export type InsightRelationType = typeof RELATION_TYPES[number];

function generate(prefix: string): string {
  return `${prefix}_${nanoid(10)}`;
}

/** Rust `InsightRevision::render_content`. */
export function renderInsightRevisionContent(revision: {
  situation: string; stuckPoint: string; turningPoint: string; rule: string;
  validityConditions: string;
}): string {
  let out = '';
  if (revision.situation !== '') out += `## 情境\n${revision.situation}\n\n`;
  if (revision.stuckPoint !== '') out += `## 卡点\n${revision.stuckPoint}\n\n`;
  if (revision.turningPoint !== '') out += `## 转折\n${revision.turningPoint}\n\n`;
  if (revision.rule !== '') out += `## 规则\n${revision.rule}\n\n`;
  if (revision.validityConditions !== '') {
    out += `## 成立条件\n${revision.validityConditions}\n`;
  }
  return out;
}

export class InsightService {
  private readonly db: InsightDatabase;
  private readonly resources: MemoryResourceWriter;
  constructor(db: InsightDatabase, resources: MemoryResourceWriter) {
    this.db = db;
    this.resources = resources;
  }

  /** Rust `validate_draft`. */
  static validateDraft(input: InsightDraftInput): void {
    if (input.title.trim() === '') {
      fail('Validation', '灵感卡标题不能为空');
    }
    if (input.turningPoint.trim() === '' && input.rule.trim() === '') {
      fail('Validation', '转折与规则至少填写一项');
    }
  }

  private static hasUserEvidence(input: InsightDraftInput): boolean {
    return input.evidence.some(evidence =>
      evidence.speaker === 'user' || evidence.kind === 'manual');
  }

  /** Rust `create_draft`: resource snapshot + insight + first revision + evidence. */
  createDraft(input: InsightDraftInput): InsightCard {
    InsightService.validateDraft(input);
    const ownership: InsightOwnership = input.ownership === 'self_reported'
      && !InsightService.hasUserEvidence(input) ? 'guided' : input.ownership;
    const insightId = generate('ic');
    const revisionId = generate('icr');
    const createdAt = nowIso();

    this.db.transaction(tx => {
      const revision = {
        id: revisionId,
        insightId,
        resourceId: null as string | null,
        situation: input.situation.trim(),
        stuckPoint: input.stuckPoint.trim(),
        turningPoint: input.turningPoint.trim(),
        rule: input.rule.trim(),
        validityConditions: input.validityConditions.trim(),
        hypotheticalQueries: [] as string[],
        editNote: 'initial draft',
        createdAt,
      };
      const content = renderInsightRevisionContent(revision);
      revision.resourceId = createOrReuseTypedResource(this.resources, tx, {
        type: 'insight_card',
        content,
        hash: hashContent(content),
        sourceId: insightId,
        sourceTable: 'insights',
        metadata: { name: input.title.trim() },
      });
      insertInsightRow(tx, insightId, input.title.trim(), ownership);
      insertInsightRevision(tx, revision);
      setCurrentInsightRevision(tx, insightId, revisionId);

      for (const evidence of input.evidence) {
        insertInsightEvidence(tx, {
          id: generate('ice'),
          insightId,
          revisionId,
          kind: evidence.kind,
          sessionId: evidence.sessionId ?? null,
          messageId: evidence.messageId ?? null,
          variantId: evidence.variantId ?? null,
          blockId: evidence.blockId ?? null,
          textStart: evidence.textStart ?? null,
          textEnd: evidence.textEnd ?? null,
          speaker: evidence.speaker ?? null,
          resourceId: evidence.resourceId ?? null,
          quoteSnapshot: evidence.quoteSnapshot,
          createdAt,
        });
      }

      insertInsightEvent(tx, {
        id: generate('iev'),
        insightId,
        sessionId: input.evidence[0]?.sessionId ?? null,
        messageId: null,
        eventType: 'recall_candidate',
        helpLevel: 'hidden',
      });
    });

    const card = getInsightCard(this.db, insightId);
    if (card === null) fail('Database', '创建后读取灵感卡失败');
    return card;
  }

  /** Rust `confirm` (optional edit creates a new revision, then confirmation event). */
  confirm(insightId: string, edits?: InsightCorrectInput | null): InsightCard {
    this.db.transaction(tx => {
      if (getInsightCard(tx, insightId) === null) {
        fail('NotFound', `灵感卡不存在: ${insightId}`);
      }
      if (edits !== undefined && edits !== null) {
        this.applyCorrection(tx, insightId, edits);
      }
      insertInsightEvent(tx, {
        id: generate('iev'), insightId, sessionId: null, messageId: null,
        eventType: 'confirmed', helpLevel: 'hidden',
      });
      enqueueWithConn(tx, 'srs_projection', `srs:${insightId}`,
        JSON.stringify({ insight_id: insightId }));
      enqueueWithConn(tx, 'merge_proposal', `merge:${insightId}`,
        JSON.stringify({ insight_id: insightId }));
    });
    const card = getInsightCard(this.db, insightId);
    if (card === null) fail('NotFound', '灵感卡不存在');
    return card;
  }

  /** Rust `correct`: a new revision plus the corrected event (derived review payload). */
  correct(insightId: string, input: InsightCorrectInput): InsightCard {
    this.db.transaction(tx => {
      if (getInsightCard(tx, insightId) === null) {
        fail('NotFound', `灵感卡不存在: ${insightId}`);
      }
      this.applyCorrection(tx, insightId, input);
      const derived = markDerivedRelationsForReview(tx, insightId);
      if (derived.length > 0) {
        enqueueWithConn(tx, 'principle_review', `preview:${insightId}`,
          JSON.stringify({ insight_id: insightId, derived_principles: derived }));
      }
      insertInsightEvent(tx, {
        id: generate('iev'), insightId, sessionId: null, messageId: null,
        eventType: 'corrected', helpLevel: 'hidden',
        payloadJson: derived.length === 0 ? null
          : JSON.stringify({ derived_principles: derived }),
      });
      enqueueWithConn(tx, 'srs_projection', `srs:${insightId}`,
        JSON.stringify({ insight_id: insightId }));
    });
    const card = getInsightCard(this.db, insightId);
    if (card === null) fail('NotFound', '灵感卡不存在');
    return card;
  }

  /** Rust `apply_correction_with_conn`. */
  private applyCorrection(tx: SqlExecutor, insightId: string,
    input: InsightCorrectInput): void {
    const card = getInsightCard(tx, insightId);
    if (card === null) fail('NotFound', `灵感卡不存在: ${insightId}`);
    const current = card.currentRevision;
    if (current === null) fail('Database', '当前修订缺失');

    const revision = {
      id: generate('icr'),
      insightId,
      resourceId: null as string | null,
      situation: input.situation ?? current.situation,
      stuckPoint: input.stuckPoint ?? current.stuckPoint,
      turningPoint: input.turningPoint ?? current.turningPoint,
      rule: input.rule ?? current.rule,
      validityConditions: input.validityConditions ?? current.validityConditions,
      hypotheticalQueries: [...current.hypotheticalQueries],
      editNote: input.editNote ?? null,
      createdAt: nowIso(),
    };
    const content = renderInsightRevisionContent(revision);
    revision.resourceId = createOrReuseTypedResource(this.resources, tx, {
      type: 'insight_card',
      content,
      hash: hashContent(content),
      sourceId: insightId,
      sourceTable: 'insights',
      metadata: null,
    });
    insertInsightRevision(tx, revision);
    setCurrentInsightRevision(tx, insightId, revision.id);
    if (input.title !== undefined && input.title !== null) {
      updateInsightTitle(tx, insightId, input.title);
    }
  }

  /** Rust `delete`: tombstone only (history stays physically intact). */
  delete(insightId: string): void {
    this.db.transaction(tx => { softDeleteInsightCard(tx, insightId); });
  }

  /** Rust `record_feedback`: three-ledger columns stay separate. */
  recordFeedback(insightId: string, feedback: string, sessionId: string | null): void {
    const eventType = feedback === 'useful' ? 'feedback_useful'
      : feedback === 'not_useful' ? 'feedback_not_useful'
        : feedback === 'not_applicable' ? 'feedback_not_applicable' : null;
    if (eventType === null) fail('Validation', `未知反馈类型: ${feedback}`);

    this.db.transaction(tx => {
      insertInsightEvent(tx, {
        id: generate('iev'), insightId, sessionId, messageId: null,
        eventType, helpLevel: 'hidden',
        benefitSignal: eventType === 'feedback_useful' ? 1
          : eventType === 'feedback_not_useful' ? 0 : null,
        qualitySignal: eventType === 'feedback_not_applicable' ? 0 : null,
      });
      if (eventType === 'feedback_useful') bumpInsightUseful(tx, insightId);
    });
  }

  getInsight(insightId: string): InsightCard | null {
    return getInsightCard(this.db, insightId);
  }

  listInsights(status: string | null, limit: IpcInteger, offset: IpcInteger): InsightCard[] {
    const cards: InsightCard[] = [];
    // Rust service.rs:416: limit.min(500), with no lower bound or offset clamp.
    const capped = limit > 500 ? 500 : limit;
    for (const id of listInsightIds(this.db, status, capped, offset)) {
      const card = getInsightCard(this.db, id);
      if (card !== null) cards.push(card);
    }
    return cards;
  }

  listRevisions(insightId: string): InsightRevision[] {
    return listInsightRevisions(this.db, insightId);
  }

  listEvidence(insightId: string): InsightEvidenceRow[] {
    return listInsightEvidence(this.db, insightId);
  }

  listRelations(insightId: string): InsightRelationRow[] {
    return listInsightRelations(this.db, insightId);
  }

  listEvents(insightId: string, limit: number): InsightEventRow[] {
    return listInsightEvents(this.db, insightId, limit);
  }

  /** Rust `add_relation` (contradict/supersede require scope and evidence). */
  addRelation(fromId: string, toId: string, relationType: string,
    scope: string | null, evidence: string | null): string {
    if (!(RELATION_TYPES as readonly string[]).includes(relationType)) {
      fail('Validation', `未知关系类型: ${relationType}`);
    }
    if ((relationType === 'contradict' || relationType === 'supersede')
      && ((scope ?? '').trim() === '' || (evidence ?? '').trim() === '')) {
      fail('Validation', 'contradict/supersede 关系必须提供 scope 与 evidence');
    }
    const id = this.db.transaction(tx => {
      if (getInsightCard(tx, fromId) === null || getInsightCard(tx, toId) === null) {
        fail('NotFound', '关系端点不存在');
      }
      const relationId = upsertInsightRelation(tx, {
        id: generate('icx'), fromId, toId, relationType, scope, evidence,
        createdBy: 'user', createdAt: nowIso(),
      });
      if (relationType === 'same_method' || relationType === 'counterexample') {
        for (const endpoint of [fromId, toId]) {
          enqueueWithConn(tx, 'principle_synthesis', `principle:${endpoint}`,
            JSON.stringify({ insight_id: endpoint }));
        }
      }
      return relationId;
    });
    return id;
  }
}
