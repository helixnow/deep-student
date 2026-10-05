import React, { Suspense, useSyncExternalStore } from 'react';
import { isDueMistakesReviewOpen, subscribeDueMistakesReview } from './dueMistakesReview';

const LazyDueMistakesReviewOverlay = React.lazy(() => import('./DueMistakesReviewOverlay'));

/** 应用根部的挂载点：只在打开时才加载复习会话那一大块代码。 */
export const DueMistakesReviewHost: React.FC = () => {
  const open = useSyncExternalStore(subscribeDueMistakesReview, isDueMistakesReviewOpen, isDueMistakesReviewOpen);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyDueMistakesReviewOverlay />
    </Suspense>
  );
};
