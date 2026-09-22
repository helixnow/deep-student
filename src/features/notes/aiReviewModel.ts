import i18n from '@/i18n';
import type { FullDocumentSnapshot } from './fullDocument';
import type { AIEditCheckpoint } from './hooks/useCanvasAIEditHandler';
import type { AIReviewRequest, OfficialReviewDecision } from './officialDiffContract';

export type AIReviewDecision = 'pending' | 'accept' | 'reject';
export interface AIReviewGroup { id: number; before: string; after: string; changed: boolean; decision: AIReviewDecision }
export interface AIReviewSession {
  request: AIReviewRequest;
  /** Last confirmed full document, owned by the host. */
  baseline: FullDocumentSnapshot;
  origin: FullDocumentSnapshot;
  candidate: string;
  target: string;
  generation: number;
  decisions: OfficialReviewDecision[];
  accepted: AIEditCheckpoint[];
  savedAs?: FullDocumentSnapshot;
  /** Display-only decision journal. Official diff alone computes pending groups. */
  groups: AIReviewGroup[];
  collapsed: boolean;
  wholeDocument: boolean;
  error?: string;
  retryBaseline?: FullDocumentSnapshot;
  retryDecision?: OfficialReviewDecision;
  persistenceId?: string;
  persistenceRevision?: number;
  restored?: boolean;
  conflict?: boolean;
  resolution?: 'accepted' | 'discarded';
}
export function aiReviewError(key: string, fallback: string): string {
  return String(i18n.t(`notes:aiReview.errors.${key}`, { defaultValue: fallback }));
}
export function createAIReviewSession(request: AIReviewRequest, baseline: FullDocumentSnapshot, candidate: string): AIReviewSession {
  return { request, baseline, origin: baseline, candidate, target: candidate, generation: 0, decisions: [], accepted: [],
    groups: [], collapsed: false, wholeDocument: false };
}
/** Derived display/export value; never used to decide or overwrite live content. */
export function composeAIReview(session: AIReviewSession, acceptPending = false): string {
  return acceptPending ? session.target : session.baseline.markdown;
}
const sessions = new Map<string, AIReviewSession>();
const versions = new Map<string, number>();
export const aiReviewSessionKey = (noteId: string, windowId?: string) => JSON.stringify([windowId ?? 'notes', noteId]);
export const readAIReviewSession = (key: string) => sessions.get(key) ?? null;
export const aiReviewSessionVersion = (key: string) => versions.get(key) ?? 0;
export const storeAIReviewSession = (key: string, session: AIReviewSession | null) => {
  versions.set(key, aiReviewSessionVersion(key) + 1);
  if (session) sessions.set(key, session); else sessions.delete(key);
};
export function isReviewShortcut(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'defaultPrevented'>): boolean {
  return !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}
