/**
 * Cordis `insight` service facade.
 *
 * L15's `src/insight-commands.ts` keeps the command names/defaults and expects a
 * snake_case wire service; the memory lane owns the actual card storage. This
 * adapter maps between the two shapes so `insight_*` commands reach the real
 * `InsightService` instead of failing with "VFS 数据库未初始化".
 */
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import { CommandError, type IpcInteger } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import {
  InsightAppError, InsightService, type InsightCorrectInput, type InsightDraftInput,
  type InsightEvidenceKind, type InsightOwnership,
} from './insight-service.ts';
import type {
  InsightCard, InsightEventRow, InsightEvidenceRow, InsightRelationRow, InsightRevision,
} from '../repository/insight-cards.ts';

function ownershipOf(value: Wire.InsightOwnership__De): InsightOwnership {
  if (typeof value === 'string') return value;
  if ('guided' in value) return 'guided';
  if ('ai_draft' in value) return 'ai_draft';
  return 'self_reported';
}

function evidenceKindOf(value: Wire.EvidenceKind__De): InsightEvidenceKind {
  if (typeof value === 'string') return value;
  if ('resource' in value) return 'resource';
  if ('note' in value) return 'note';
  if ('manual' in value) return 'manual';
  return 'chat_message';
}

function draftInputOf(input: Wire.InsightDraftInput): InsightDraftInput {
  return {
    title: input.title,
    situation: input.situation,
    stuckPoint: input.stuck_point,
    turningPoint: input.turning_point,
    rule: input.rule,
    validityConditions: input.validity_conditions,
    ownership: ownershipOf(input.ownership),
    evidence: input.evidence.map(evidence => ({
      kind: evidenceKindOf(evidence.kind),
      sessionId: evidence.session_id ?? null,
      messageId: evidence.message_id ?? null,
      variantId: evidence.variant_id ?? null,
      blockId: evidence.block_id ?? null,
      textStart: evidence.text_start ?? null,
      textEnd: evidence.text_end ?? null,
      speaker: evidence.speaker ?? null,
      resourceId: evidence.resource_id ?? null,
      quoteSnapshot: evidence.quote_snapshot,
    })),
  };
}

function correctInputOf(input: Wire.InsightCorrectInput): InsightCorrectInput {
  return {
    title: input.title ?? null,
    situation: input.situation ?? null,
    stuckPoint: input.stuck_point ?? null,
    turningPoint: input.turning_point ?? null,
    rule: input.rule ?? null,
    validityConditions: input.validity_conditions ?? null,
    editNote: input.edit_note ?? null,
  };
}

function revisionOf(revision: InsightRevision): Wire.InsightRevision {
  return {
    id: revision.id,
    insight_id: revision.insightId,
    resource_id: revision.resourceId,
    situation: revision.situation,
    stuck_point: revision.stuckPoint,
    turning_point: revision.turningPoint,
    rule: revision.rule,
    validity_conditions: revision.validityConditions,
    hypothetical_queries: [...revision.hypotheticalQueries],
    edit_note: revision.editNote,
    created_at: revision.createdAt,
  };
}

function cardOf(card: InsightCard): Wire.InsightCard {
  return {
    id: card.id,
    title: card.title,
    ownership: card.ownership as Wire.InsightOwnership,
    verification_state: card.verificationState as Wire.VerificationState,
    status: card.status as Wire.InsightStatus,
    recall_count: card.recallCount,
    shown_count: card.shownCount,
    useful_count: card.usefulCount,
    last_recalled_at: card.lastRecalledAt,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    current_revision: card.currentRevision === null ? null : revisionOf(card.currentRevision),
  };
}

function evidenceOf(evidence: InsightEvidenceRow): Wire.InsightEvidence {
  return {
    id: evidence.id,
    insight_id: evidence.insightId,
    revision_id: evidence.revisionId,
    kind: evidence.kind as Wire.EvidenceKind,
    session_id: evidence.sessionId,
    message_id: evidence.messageId,
    variant_id: evidence.variantId,
    block_id: evidence.blockId,
    text_start: evidence.textStart,
    text_end: evidence.textEnd,
    speaker: evidence.speaker,
    resource_id: evidence.resourceId,
    quote_snapshot: evidence.quoteSnapshot,
    created_at: evidence.createdAt,
  };
}

function relationOf(relation: InsightRelationRow): Wire.InsightRelation {
  return {
    id: relation.id,
    from_id: relation.fromId,
    to_id: relation.toId,
    relation_type: relation.relationType as Wire.RelationType,
    scope: relation.scope,
    evidence: relation.evidence,
    status: relation.status,
    created_by: relation.createdBy,
    created_at: relation.createdAt,
  };
}

function eventOf(event: InsightEventRow): Wire.InsightEvent {
  return {
    id: event.id,
    insight_id: event.insightId,
    session_id: event.sessionId,
    message_id: event.messageId,
    event_type: event.eventType as Wire.InsightEventType,
    help_level: event.helpLevel,
    quality_signal: event.qualitySignal,
    need_signal: event.needSignal,
    benefit_signal: event.benefitSignal,
    payload_json: event.payloadJson,
    created_at: event.createdAt,
  };
}

/** Command-level interface consumed by `review/src/insight-commands.ts`. */
export interface InsightCommandService {
  createDraft(input: Wire.InsightDraftInput): Promise<Wire.InsightCard>;
  confirm(insightId: string, edits: Wire.InsightCorrectInput | null): Promise<Wire.InsightCard>;
  correct(insightId: string, input: Wire.InsightCorrectInput): Promise<Wire.InsightCard>;
  delete(insightId: string): Promise<void>;
  getInsight(insightId: string): Promise<Wire.InsightCard | null>;
  /** Decoded Rust i64 pagination; keep bigint exact through the SQLite binding. */
  listInsights(status: string | null, limit: IpcInteger, offset: IpcInteger): Promise<Wire.InsightCard[]>;
  listRevisions(insightId: string): Promise<Wire.InsightRevision[]>;
  listEvidence(insightId: string): Promise<Wire.InsightEvidence[]>;
  listRelations(insightId: string): Promise<Wire.InsightRelation[]>;
  listEvents(insightId: string, limit: number): Promise<Wire.InsightEvent[]>;
  recordFeedback(insightId: string, feedback: string, sessionId: string | null): Promise<void>;
  addRelation(fromId: string, toId: string, relationType: string,
    scope: string | null, evidence: string | null): Promise<string>;
  runJobs(batchSize: number): Promise<number>;
}

export interface InsightCommandServiceOptions {
  /** Accepts a thunk so the service can be created after its VFS dependencies are published. */
  readonly service: InsightService | (() => InsightService);
  readonly runJobs: (batchSize: number) => number;
}

function commandErrorFrom(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof InsightAppError) return new CommandError(error.appError);
  return new CommandError(AppError.database(
    error instanceof Error ? error.message : String(error)));
}

/**
 * Business `InsightAppError` → kernel `CommandError(AppError)`. This is the
 * service boundary only; L15 keeps command registration/default arguments.
 * A raw repository error is classified as Database instead of guessing from a
 * message prefix.
 */
function commandServiceProxy(service: InsightService): InsightService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try { return (value as (...a: unknown[]) => unknown).apply(target, args); }
        catch (error) { throw commandErrorFrom(error); }
      };
    },
  });
}

export function createInsightCommandService(options: InsightCommandServiceOptions): InsightCommandService {
  const service = (): InsightService => commandServiceProxy(
    typeof options.service === 'function' ? options.service() : options.service);
  return {
    createDraft: async input => cardOf(service().createDraft(draftInputOf(input))),
    confirm: async (insightId, edits) => cardOf(service().confirm(insightId,
      edits === null ? null : correctInputOf(edits))),
    correct: async (insightId, input) => cardOf(service().correct(insightId, correctInputOf(input))),
    delete: async insightId => { service().delete(insightId); },
    getInsight: async insightId => {
      const card = service().getInsight(insightId);
      return card === null ? null : cardOf(card);
    },
    listInsights: async (status, limit, offset) =>
      service().listInsights(status, limit, offset).map(cardOf),
    listRevisions: async insightId => service().listRevisions(insightId).map(revisionOf),
    listEvidence: async insightId => service().listEvidence(insightId).map(evidenceOf),
    listRelations: async insightId => service().listRelations(insightId).map(relationOf),
    listEvents: async (insightId, limit) => service().listEvents(insightId, limit).map(eventOf),
    recordFeedback: async (insightId, feedback, sessionId) => {
      service().recordFeedback(insightId, feedback, sessionId);
    },
    addRelation: async (fromId, toId, relationType, scope, evidence) =>
      service().addRelation(fromId, toId, relationType, scope, evidence),
    runJobs: async batchSize => {
      try { return options.runJobs(batchSize); }
      catch (error) { throw commandErrorFrom(error); }
    },
  };
}
