import React, { useEffect, useRef } from 'react';
import { createOfficialDiffAdapter } from '@/components/crepe/officialDiffAdapter';
import type { AIReviewSession } from './aiReviewModel';
import type { OfficialReviewControls, OfficialReviewDecision } from './officialDiffContract';
import '@milkdown/crepe/theme/common/diff.css';

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
          || latestReview.current.generation !== review.generation) return Promise.reject(new Error('审阅实例已关闭。'));
        return latest.current.onReviewDecision(decision);
      },
      onError: error => { if (!cancelled) latest.current.onReviewError(error); },
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
  return <div ref={root} className="notes-official-diff" aria-label="候选内容逐组审阅" />;
}
