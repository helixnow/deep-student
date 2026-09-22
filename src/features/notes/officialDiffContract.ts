import type { FullDocumentSnapshot } from './fullDocument';
import type { CanvasAIEditRequest } from './hooks/useAIEditState';

/** Offsets are UTF-16 offsets in the FULL markdown, never viewport/PM positions. */
export interface AIReviewScope {
  kind: 'selection' | 'block' | 'section' | 'page';
  from: number;
  to: number;
  baseline: FullDocumentSnapshot;
}
export type AIReviewLanding = 'replace' | 'insert-below' | 'save-as';
export type AIReviewRequest = CanvasAIEditRequest & { scope?: AIReviewScope; landing?: AIReviewLanding };
export interface OfficialReviewDecision {
  action: 'accept' | 'reject';
  before: string;
  after: string;
  /** Candidate with rejected ranges withdrawn. A derived review artifact, not live content. */
  target: string;
  remaining: number;
  range?: { fromA: number; toA: number; fromB: number; toB: number };
}
export interface OfficialReviewControls {
  acceptAll(): Promise<void>;
  /** Current visible official group index; never persist an index as an identity. */
  decideGroup(index: number, action: 'accept' | 'reject'): Promise<void>;
  suspend(): void;
}
export interface AIReviewHost {
  /** Delegate to uploadLifecycle.acquireReviewLease: inert interaction + new-upload
   * gate; preserve the user's readonly flag and existing uploads. No live diff plugin. */
  acquireReviewLease?: () => (() => void);
  /** Selection/block/section must resolve against the full document contract. */
  resolveScope?: (kind: AIReviewScope['kind']) => AIReviewScope;
  /** Persist an accepted full-document result under the cross-WebView barrier. */
  applyDocument?: (markdown: string, baseline: FullDocumentSnapshot) => Promise<FullDocumentSnapshot>;
  /** Create once by operationId; subsequent groups update that note with full CAS.
   * Return only after durable save/history. Replaying the same result is idempotent. */
  saveAs?: (markdown: string, operationId: string, baseline?: FullDocumentSnapshot) => Promise<FullDocumentSnapshot>;
}

export function scopeAIReviewCandidate(request: AIReviewRequest, baseline: FullDocumentSnapshot,
  project: (request: CanvasAIEditRequest, original: string) => { content: string; error?: string }) {
  const scope = request.scope ?? { kind: 'page', from: 0, to: baseline.markdown.length, baseline };
  if (scope.baseline.noteId !== baseline.noteId || scope.baseline.revision !== baseline.revision
    || scope.baseline.markdown !== baseline.markdown || scope.from < 0 || scope.to < scope.from
    || scope.to > baseline.markdown.length || !Number.isInteger(scope.from) || !Number.isInteger(scope.to)) {
    throw new Error('审阅范围已过期，请重新选择范围。');
  }
  const projected = project(request, baseline.markdown.slice(scope.from, scope.to));
  const landing = request.landing ?? 'replace';
  const content = landing === 'save-as' ? projected.content
    : landing === 'insert-below'
      ? baseline.markdown.slice(0, scope.to) + '\n\n' + projected.content + baseline.markdown.slice(scope.to)
      : baseline.markdown.slice(0, scope.from) + projected.content + baseline.markdown.slice(scope.to);
  return { ...projected, content };
}
