/**
 * Insight Recall v2 —— Tauri API 层
 * 后端命令：src-tauri/src/insight/handlers.rs
 */

import { tauriInvoke } from '@/api/tauriClient';
import type {
  InsightCard,
  InsightCorrectInput,
  InsightDraftInput,
  InsightEvidence,
  InsightFeedback,
  InsightRelation,
  InsightRevision,
} from './types';

export function insightCreateDraft(input: InsightDraftInput): Promise<InsightCard> {
  return tauriInvoke<InsightCard>('insight_create_draft', { input });
}

export function insightConfirm(
  insightId: string,
  edits?: InsightCorrectInput,
): Promise<InsightCard> {
  return tauriInvoke<InsightCard>('insight_confirm', {
    insightId,
    edits: edits ?? null,
  });
}

export function insightCorrect(
  insightId: string,
  input: InsightCorrectInput,
): Promise<InsightCard> {
  return tauriInvoke<InsightCard>('insight_correct', { insightId, input });
}

export function insightDelete(insightId: string): Promise<void> {
  return tauriInvoke<void>('insight_delete', { insightId });
}

export function insightGet(insightId: string): Promise<InsightCard | null> {
  return tauriInvoke<InsightCard | null>('insight_get', { insightId });
}

export function insightList(
  status?: string,
  limit = 100,
  offset = 0,
): Promise<InsightCard[]> {
  return tauriInvoke<InsightCard[]>('insight_list', {
    status: status ?? null,
    limit,
    offset,
  });
}

export function insightListRevisions(insightId: string): Promise<InsightRevision[]> {
  return tauriInvoke<InsightRevision[]>('insight_list_revisions', { insightId });
}

export function insightListEvidence(insightId: string): Promise<InsightEvidence[]> {
  return tauriInvoke<InsightEvidence[]>('insight_list_evidence', { insightId });
}

export function insightListRelations(insightId: string): Promise<InsightRelation[]> {
  return tauriInvoke<InsightRelation[]>('insight_list_relations', { insightId });
}

export function insightRecordFeedback(
  insightId: string,
  feedback: InsightFeedback,
  sessionId?: string,
): Promise<void> {
  return tauriInvoke<void>('insight_record_feedback', {
    insightId,
    feedback,
    sessionId: sessionId ?? null,
  });
}

export function insightAddRelation(
  fromId: string,
  toId: string,
  relationType: string,
  scope?: string,
  evidence?: string,
): Promise<string> {
  return tauriInvoke<string>('insight_add_relation', {
    fromId,
    toId,
    relationType,
    scope: scope ?? null,
    evidence: evidence ?? null,
  });
}
