import React from 'react';

/** Render counters shared by the golden test and the lazyComponents mock. */
export const renders: Record<string, number> = {};

export function resetRenders(): void {
  for (const key of Object.keys(renders)) delete renders[key];
}

export function Mark({ name, children }: { name: string; children?: React.ReactNode }) {
  renders.__all = (renders.__all ?? 0) + 1;
  renders[name] = (renders[name] ?? 0) + 1;
  return <div data-content={name}>{children}</div>;
}

export const LAZY_MARKERS = [
  'LazySettings', 'LazySOTADashboard', 'LazySkillsManagementPage',
  'LazyTemplateManagementPage', 'LazyStyleDebugPage', 'LazyLearningHubPage', 'LazySandboxWorkbenchPage',
  'LazyPdfReader', 'LazyTodoPage', 'LazyFlashcardsPage', 'LazyMediaStudioPage', 'LazyCrepeDemoPage',
  'LazyChatV2IntegrationTest', 'LazyLLMOutputPlayground', 'LazyChatV2Page',
] as const;
