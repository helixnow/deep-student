import React, { Suspense } from 'react';
import {
  closeDailySprint,
  refreshSprintReadiness,
  useSprintLauncherSnapshot,
} from './sprintLauncherStore';

const LazyUnifiedDailySprintPlayer = React.lazy(() => import('./UnifiedDailySprintPlayer'));

export const DailySprintHost: React.FC = () => {
  const { isOpen, launchSeq, launchOptions, spaceId, rootFolderId, defaultDeckId } =
    useSprintLauncherSnapshot();

  if (!isOpen) return null;

  return (
    <Suspense fallback={null}>
      <LazyUnifiedDailySprintPlayer
        key={launchSeq}
        spaceId={launchOptions?.spaceId ?? spaceId}
        rootFolderId={launchOptions?.rootFolderId ?? rootFolderId}
        examDateOverride={launchOptions?.examDateOverride ?? null}
        sprintBudgetMinutesOverride={launchOptions?.sprintBudgetMinutesOverride ?? null}
        defaultDeckIdOverride={launchOptions?.defaultDeckIdOverride ?? defaultDeckId}
        initialPlan={launchOptions?.preloadedPlan ?? null}
        onClose={() => closeDailySprint()}
        onSettled={() => {
          void refreshSprintReadiness();
        }}
      />
    </Suspense>
  );
};

export default DailySprintHost;
