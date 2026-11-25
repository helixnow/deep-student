/**
 * Non-destructive UI layout cache reset utility (SPOF-5B).
 *
 * Intentionally has ZERO static imports so it can be imported safely by
 * `TopLevelFallback.tsx` (in the startup closure) and `WorkbenchDesktop.tsx`
 * without pulling any heavy modules into startup chunks.
 *
 * Removes ONLY whitelisted UI layout / workbench window / desktop snapshot /
 * sidebar / view-state / split-pane keys from `localStorage`.
 * Strictly preserves auth tokens, API keys, onboarding/legal consent,
 * study data, drafts, custom templates/rubrics, and user settings.
 */

const WORKBENCH_SESSION_ACTIVE_KEY = 'ds.workbench.activeSession';

const PROTECTED_KEY_EXACT = new Set<string>([
  'user_agreement_accepted',
  'deepstudent_legal_consent',
  'onboarding_completed_flows',
  'onboarding_skipped',
  'onboarding_starter_focus',
  'onboarding_starter_cue_dismissed',
  'ds.studySpace.activeId.v1',
  'ds.studySpace.autoScopedSessions.v1',
  'chat-v2-last-session-id',
  'dstu-auto-sync',
  'dstu-custom-shortcuts',
  'i18nextLng',
  'language',
  'theme',
  'ui.fontFamily',
  'ui.fontScale',
  'mcp.tools.list',
]);

const PROTECTED_KEY_PATTERN =
  /(?:^|[._:-])(auth|token|secret|apikey|api[_-]?key|password|passwd|credential|oauth|jwt|cookie|consent|agreement|onboarding|studySpace|study[_-]?data|flashcard|anki|rubric|draft|sync|backup|skill|promptTemplates|recentLanguages|custom[_-]?shortcuts|account|profile)(?:$|[._:-])/i;

const UI_LAYOUT_EXACT_KEYS = new Set<string>([
  'desktop.workbenchSnapshot',
  'desktop.workbenchSpaceSnapshots.v1',
  'desktop.workbenchHandoff',
  'desktop.workbenchMode',
  'desktop.workbenchTileMargins',
  'desktop.workbenchDockSize',
  'desktop.workbenchDockAutohide',
  'desktop.workbenchDesktopWidgets',
  'desktop.workbenchWidgetAgenda',
  'desktop.workbenchWidgetBriefing',
  'desktop.workbenchGlassClarity',
  'desktop.workbenchMaterialTier',
  'desktop.workbenchRestoreSession',
  'desktop.workbenchWallpaper',
  'sidebar_collapsed',
  'todo-window-sidebar-width',
  'todo-sidebar-collapsed-sections',
  'chat-v2-sidebar-expanded-folders',
  'chat-v2-group-collapsed',
  'learning-hub-tabs-v1',
  'learningHub.notesLearningView',
  'learningHub.examsView',
  'qbank.listView.viewType',
  'qbank.tagNav.viewMode',
  'notes-local-graph:depth',
  'dstu-debug-toggle-pos',
  'dstu-dev-recovery-fab-pos',
]);

const UI_LAYOUT_KEY_PREFIXES: readonly string[] = [
  'desktop.workbench',
  'workbench.',
  'workbench-',
  'workbench_',
  'wb.',
  'ds.workbench.',
  'ds.layout.',
  'ds.ui.layout.',
  'dstu.layout.',
  'dstu-layout-',
  'dstu-sidebar-',
  'ui.layout.',
  'ui-layout-',
  'ui_layout_',
  'layout.',
  'layout-',
  'layout_',
  'sidebar.',
  'sidebar-',
  'sidebar_',
  'split-pane',
  'splitPane',
  'split_pane',
  'view-state',
  'viewState',
  'view_state',
  'panel-layout',
  'panelLayout',
  'window-layout',
  'windowLayout',
  'notes-backlinks-panel:',
  'translation.workbench.',
  'learning-hub-tabs',
  'media-library.',
  'preview-prefs-',
];

const UI_LAYOUT_SUFFIX_PATTERN =
  /(?:\.|:|-|_)(splitRatio|stackedRatio|sidebarWidth|sidebar-width|paneSize|panelSize|collapsed-sections)$/i;

/**
 * Returns true if and only if `key` belongs to transient UI layout, workbench
 * window/snapshot, sidebar, view-state, or split-pane storage and is NOT a
 * protected auth, consent, settings, or study-data key.
 */
export function isUiLayoutCacheKey(key: string): boolean {
  if (!key) return false;
  if (PROTECTED_KEY_EXACT.has(key)) return false;
  if (PROTECTED_KEY_PATTERN.test(key)) return false;
  if (UI_LAYOUT_EXACT_KEYS.has(key)) return true;
  if (UI_LAYOUT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return UI_LAYOUT_SUFFIX_PATTERN.test(key);
}

/**
 * Removes ONLY UI layout / workbench window / desktop snapshot / sidebar /
 * view-state / split-pane keys from the target Storage (defaults to
 * `window.localStorage`), leaving auth tokens, API keys, consent, study data,
 * and user settings untouched. Returns the sorted list of removed keys.
 */
export function resetUiLayoutCache(storage?: Storage): string[] {
  let target: Storage | undefined = storage;
  if (!target) {
    try {
      target = typeof window !== 'undefined' ? window.localStorage : undefined;
    } catch {
      return [];
    }
  }
  if (!target) return [];

  const keys: string[] = [];
  try {
    for (let i = 0; i < target.length; i += 1) {
      const key = target.key(i);
      if (typeof key === 'string' && isUiLayoutCacheKey(key)) {
        keys.push(key);
      }
    }
  } catch {
    return [];
  }

  const cleared: string[] = [];
  for (const key of keys) {
    try {
      target.removeItem(key);
      cleared.push(key);
    } catch {
      // Best-effort: continue clearing remaining UI layout cache keys.
    }
  }

  if (!storage) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(WORKBENCH_SESSION_ACTIVE_KEY);
      }
    } catch {
      // Ignore restricted sessionStorage contexts.
    }
  }

  return cleared.sort();
}

/**
 * Best-effort clears persisted workbench layout snapshots stored in the
 * desktop SQLite settings table when running inside the Tauri runtime.
 * Never touches study data, auth credentials, or general user settings.
 */
export async function resetPersistedWorkbenchSnapshots(): Promise<void> {
  if (typeof window === 'undefined') return;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await Promise.allSettled([
      invoke('save_setting', { key: 'desktop.workbenchSnapshot', value: '' }),
      invoke('save_setting', { key: 'desktop.workbenchSpaceSnapshots.v1', value: '' }),
    ]);
  } catch {
    // Best-effort: localStorage UI layout keys are already cleared.
  }
}
