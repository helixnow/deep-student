import React, { lazy, Suspense } from 'react';
import type { LearningHubSidebarProps } from './types';

type LearningHubPageProps = React.ComponentProps<typeof import('./LearningHubPage').LearningHubPage>;

const Sidebar = lazy(() => import('./LearningHubSidebar').then((module) => ({ default: module.LearningHubSidebar })));
const Page = lazy(() => import('./LearningHubPage').then((module) => ({ default: module.LearningHubPage })));

export function LearningHubSidebar(props: LearningHubSidebarProps) {
  return (
    <Suspense fallback={null}>
      <Sidebar {...props} />
    </Suspense>
  );
}

export function LearningHubPage(props: LearningHubPageProps) {
  return (
    <Suspense fallback={null}>
      <Page {...props} />
    </Suspense>
  );
}
