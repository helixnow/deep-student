import type { CurrentView } from '@/types/navigation';

/**
 * Canonical view mapping to prevent navigation dead-ends.
 * Deprecated views are redirected to supported destinations.
 */
const DEPRECATED_VIEW_MAP: Readonly<Record<string, CurrentView>> = {
  analysis: 'chat-v2',
  chat: 'chat-v2',
  notes: 'learning-hub',
  'markdown-editor': 'learning-hub',
  'textbook-library': 'learning-hub',
  'exam-sheet': 'learning-hub',
  batch: 'chat-v2',
  review: 'chat-v2',
  'anki-generation': 'task-dashboard',
  // 2026-02: 补全所有已移除视图的重定向，防止历史记录导航到空白页
  library: 'learning-hub',
  'mistake-detail': 'chat-v2',
  'llm-usage-stats': 'dashboard',
  irec: 'chat-v2',
  'irec-management': 'chat-v2',
  'irec-service-switcher': 'chat-v2',
  'math-workflow': 'chat-v2',
  'bridge-to-irec': 'chat-v2',
};

export const CANONICAL_VIEWS: ReadonlySet<CurrentView> = new Set([
  'chat-v2',
  'settings',
  'dashboard',
  'data-management',
  'task-dashboard',
  'template-management',
  'template-json-preview',
  'crepe-demo',
  'pdf-reader',
  'learning-hub',
  'skills-management',
  'chat-v2-test',
  'tree-test',
]);

export const canonicalizeView = (view: CurrentView | string): CurrentView => {
  const mapped = DEPRECATED_VIEW_MAP[view] ?? view;
  return CANONICAL_VIEWS.has(mapped as CurrentView) ? (mapped as CurrentView) : 'chat-v2';
};

export const isSupportedView = (view: CurrentView | string): boolean => {
  return CANONICAL_VIEWS.has(canonicalizeView(view));
};
