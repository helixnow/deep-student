/**
 * Insight Recall v2 —— 前端镜像类型
 * 与 src-tauri/src/insight/types.rs 保持一致。
 */

export type InsightOwnership = 'self_reported' | 'guided' | 'ai_draft';
export type VerificationState = 'unverified' | 'verified' | 'contradicted';
export type InsightStatus = 'active' | 'cold' | 'archived';
export type EvidenceKind = 'chat_message' | 'resource' | 'note' | 'manual';
export type RelationType =
  | 'same_method'
  | 'same_trap'
  | 'counterexample'
  | 'abstract_of'
  | 'supersede'
  | 'contradict'
  | 'example_of';
export type DisclosureLevel =
  | 'hidden'
  | 'existence'
  | 'recall_prompt'
  | 'hint'
  | 'full'
  | 'direct_answer';

export interface InsightRevision {
  id: string;
  insight_id: string;
  resource_id: string | null;
  situation: string;
  stuck_point: string;
  turning_point: string;
  rule: string;
  validity_conditions: string;
  hypothetical_queries: string[];
  edit_note: string | null;
  created_at: string;
}

export interface InsightCard {
  id: string;
  title: string;
  ownership: InsightOwnership;
  verification_state: VerificationState;
  status: InsightStatus;
  recall_count: number;
  shown_count: number;
  useful_count: number;
  last_recalled_at: string | null;
  created_at: string;
  updated_at: string | null;
  current_revision: InsightRevision | null;
}

export interface InsightEvidenceInput {
  kind: EvidenceKind;
  session_id?: string | null;
  message_id?: string | null;
  variant_id?: string | null;
  block_id?: string | null;
  text_start?: number | null;
  text_end?: number | null;
  speaker?: string | null;
  resource_id?: string | null;
  quote_snapshot: string;
}

export interface InsightDraftInput {
  title: string;
  situation: string;
  stuck_point: string;
  turning_point: string;
  rule: string;
  validity_conditions: string;
  ownership: InsightOwnership;
  evidence: InsightEvidenceInput[];
}

export interface InsightCorrectInput {
  title?: string | null;
  situation?: string | null;
  stuck_point?: string | null;
  turning_point?: string | null;
  rule?: string | null;
  validity_conditions?: string | null;
  edit_note?: string | null;
}

export interface InsightEvidence {
  id: string;
  insight_id: string;
  revision_id: string | null;
  kind: EvidenceKind;
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

export interface InsightRelation {
  id: string;
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  scope: string | null;
  evidence: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

export type InsightFeedback = 'useful' | 'not_useful' | 'not_applicable';
