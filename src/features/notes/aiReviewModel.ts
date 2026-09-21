import { diffLines } from 'diff';
import i18n from '@/i18n';
import type { FullDocumentSnapshot } from './fullDocument';
import type { CanvasAIEditRequest } from './hooks/useAIEditState';

export type AIReviewDecision = 'pending' | 'accept' | 'reject';
export interface AIReviewGroup {
  id: number;
  before: string;
  after: string;
  changed: boolean;
  decision: AIReviewDecision;
}
export interface AIReviewSession {
  request: CanvasAIEditRequest;
  baseline: FullDocumentSnapshot;
  candidate: string;
  groups: AIReviewGroup[];
  collapsed: boolean;
  wholeDocument: boolean;
  error?: string;
  /** An applied draft whose persistence failed may only be retried unchanged. */
  retryBaseline?: FullDocumentSnapshot;
  persistenceId?: string;
  /** Restored records are local reviews, never live Canvas RPC requests. */
  restored?: boolean;
  conflict?: boolean;
  resolution?: 'accepted' | 'discarded';
}

export function aiReviewError(key: string, fallback: string): string {
  return String(i18n.t(`notes:aiReview.errors.${key}`, { defaultValue: fallback }));
}

// Partial line edits are unsafe for linked/structured nodes. Keep these candidates atomic.
const complexMarkdown = /(^\s*(?:`{3,}|~{3,}|\$\$|>|[-+*]\s|\d+[.)]\s|<|\[.+\]:)|\||!\[|\[\[|\]\(|\$[^\n]+\$|^ {4}\S)/m;

export function createAIReviewSession(request: CanvasAIEditRequest, baseline: FullDocumentSnapshot, candidate: string): AIReviewSession {
  const wholeDocument = complexMarkdown.test(baseline.markdown) || complexMarkdown.test(candidate);
  const groups: AIReviewGroup[] = [];
  if (wholeDocument) {
    groups.push({ id: 0, before: baseline.markdown, after: candidate, changed: baseline.markdown !== candidate, decision: 'pending' });
  } else {
    // Use raw diff chunks, never displayed DiffLine strings: those omit terminal newlines.
    for (const change of diffLines(baseline.markdown, candidate)) {
      const changed = !!(change.added || change.removed);
      let group = groups[groups.length - 1];
      if (!group || group.changed !== changed) {
        group = { id: groups.length, before: '', after: '', changed, decision: 'pending' };
        groups.push(group);
      }
      if (!change.added) group.before += change.value;
      if (!change.removed) group.after += change.value;
    }
  }
  return { request, baseline, candidate, groups, collapsed: false, wholeDocument };
}

/** Pending groups are included only by the explicit “accept remaining” action. */
export function composeAIReview(session: AIReviewSession, acceptPending = false): string {
  return session.groups.map((group) =>
    !group.changed || group.decision === 'accept' || (acceptPending && group.decision === 'pending')
      ? group.after : group.before,
  ).join('');
}

export function decideAIReviewGroup(session: AIReviewSession, id: number, decision: AIReviewDecision): AIReviewSession {
  if (!session.groups.some((group) => group.id === id && group.changed && group.decision !== decision)) return session;
  return { ...session, retryBaseline: undefined, groups: session.groups.map((group) => group.id === id ? { ...group, decision } : group) };
}

/** In-app recovery, keyed by owning window + note. No diff-plugin clear/suspend semantics. */
const sessions = new Map<string, AIReviewSession>();
const versions = new Map<string, number>();
export const aiReviewSessionKey = (noteId: string, windowId?: string) => JSON.stringify([windowId ?? 'notes', noteId]);
export const readAIReviewSession = (key: string) => sessions.get(key) ?? null;
export const aiReviewSessionVersion = (key: string) => versions.get(key) ?? 0;
export const storeAIReviewSession = (key: string, session: AIReviewSession | null) => {
  versions.set(key, aiReviewSessionVersion(key) + 1);
  if (session) sessions.set(key, session);
  else sessions.delete(key);
};

export function isReviewShortcut(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'defaultPrevented'>): boolean {
  return !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}
