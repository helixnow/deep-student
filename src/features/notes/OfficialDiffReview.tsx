import React, { useEffect, useRef } from 'react';
import i18next from 'i18next';
import { createOfficialDiffAdapter } from '@/components/crepe/officialDiffAdapter';
import type { AIReviewSession } from './aiReviewModel';
import type { OfficialReviewControls, OfficialReviewDecision } from './officialDiffContract';
import '@milkdown/crepe/theme/common/diff.css';
import { noteHostError } from './noteHostErrors';
import { useOptionalSlot, useOptionalUiKernel } from '@/ui-kernel/react';

export interface OfficialDiffReviewProps {
  review: AIReviewSession;
  onReviewDecision: (decision: OfficialReviewDecision) => Promise<string | void>;
  onReviewReady: (controls: OfficialReviewControls | null) => void;
  onReviewError: (error: unknown) => void;
}
export function OfficialDiffReview({ review, ...callbacks }: OfficialDiffReviewProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(callbacks); latest.current = callbacks;
  const latestReview = useRef(review); latestReview.current = review;
  // editor.extensions: snapshot when the review opens; only entries listing 'diff' join the fixed stack.
  // RUST-FIX(RF-W18-diff-extension-purpose): snapshot contributions when opening review.
  const extensionEntries = useOptionalSlot('editor.extensions');
  const kernel = useOptionalUiKernel();
  const contributions = useRef({ extensionEntries, kernel });
  contributions.current = { extensionEntries, kernel };
  useEffect(() => {
    if (!root.current || review.collapsed || review.conflict || review.resolution) return;
    let cancelled = false;
    let adapter: Awaited<ReturnType<typeof createOfficialDiffAdapter>> | undefined;
    // A private child prevents an older asynchronous destroy from touching the new instance.
    const container = document.createElement('div'); root.current.append(container);
    void createOfficialDiffAdapter({ root: container,
      baseline: review.request.landing === 'save-as' ? review.savedAs?.markdown ?? '' : review.baseline.markdown,
      target: review.target,
      onDecision: decision => {
        if (cancelled || latestReview.current.persistenceId !== review.persistenceId
          || latestReview.current.generation !== review.generation) return Promise.reject(new Error(noteHostError('review_closed', '审阅实例已关闭。')));
        return latest.current.onReviewDecision(decision);
      },
      onError: error => { if (!cancelled) latest.current.onReviewError(error); },
      extensions: contributions.current.extensionEntries,
      onContributionError: (entry, error) => {
        const current = contributions.current.kernel;
        if (current) current.errors.report({ pluginId: entry.owner, origin: entry.origin, phase: 'render', error, slot: 'editor.extensions', entryId: entry.id });
        else console.error(`[editor.extensions] "${entry.id}" failed`, error);
      },
    }).then(async result => {
      adapter = result;
      if (cancelled) { await result.destroy(); container.remove(); }
      else latest.current.onReviewReady(result);
    }).catch(error => { container.remove(); if (!cancelled) latest.current.onReviewError(error); });
    return () => {
      cancelled = true;
      latest.current.onReviewReady(null);
      if (adapter) { adapter.suspend(); void adapter.destroy().finally(() => container.remove()); }
    };
    // Decisions are applied by the mounted adapter after the host confirms persistence.
    // Recreate only on reopen/new session; not during an in-flight per-group commit.
  }, [review.persistenceId, review.generation, review.collapsed, review.conflict, review.resolution]);
  return <div ref={root} className="notes-official-diff" aria-label={i18next.t('notes:aiDiff.official_review_label', '候选内容逐组审阅')} />;
}
