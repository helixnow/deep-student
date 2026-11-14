/**
 * FE-B1 evidence: the full command palette manifest as the production assembly registers it.
 *
 * For development and production builds it records every command field (zh-CN, en-US and i18n-key renderings), the
 * visibility matrix (view × focused Workbench app × theme × Notes workspace resource × mobile), search ordering,
 * shortcut resolution, and the side-effect trace (IPC commands with sorted argument keys, DOM events, resolver calls)
 * of executing each command. The golden is captured from the pre-refactor assembly and is never rewritten.
 */
import fs from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  trace: [] as unknown[][],
  resource: null as null | { type: 'note' | 'mindmap'; id: string },
  mobile: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    state.trace.push(['invoke', cmd, Object.keys(args ?? {}).sort()]);
    if (cmd === 'import_apkg_to_library') return { importedCards: 3, reviewEnqueue: { enqueued: 2 } };
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async (options: Record<string, unknown>) => {
    state.trace.push(['dialog.open', Object.keys(options).sort()]);
    return '/fixture/deck.apkg';
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => { state.trace.push(['window.isFullscreen']); return false; },
    setFullscreen: async (value: boolean) => { state.trace.push(['window.setFullscreen', value]); },
  }),
}));
vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: (message: string) => { state.trace.push(['confirm', typeof message]); return false; },
  unifiedAlert: (message: string) => { state.trace.push(['alert', typeof message]); },
}));
vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: async (text: string) => { state.trace.push(['clipboard.write', typeof text]); return true; },
}));
vi.mock('@/shared/workbenchHost', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkspaceActiveResourceType: () => state.resource?.type ?? null,
}));
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isMobilePlatform: () => state.mobile,
}));
// useAppBackgroundServices' other services are not part of the command manifest.
vi.mock('@/features/todo/reminderScheduler', () => ({ initReminderScheduler: () => () => {} }));
vi.mock('@/stores/syncStatusStore', () => ({
  ensureAutoSyncSchedulerStarted: () => {},
  ensureSyncProgressListener: async () => {},
  useAutoSyncStore: { persist: undefined },
}));
vi.mock('@/features/anki/ankiCompletionNotifier', () => ({ initAnkiCompletionNotifier: () => () => {} }));

import i18n from '@/i18n';
import { commandRegistry } from '../registry/commandRegistry';
import type { Command, CommandView, DependencyResolver } from '../registry/types';
import { useAppBackgroundServices } from '@/app/hooks/useAppBackgroundServices';

const GOLDEN = 'src/command-palette/__golden__/commands.json';

const LEGACY_VIEWS: CommandView[] = [
  'chat-v2', 'sandbox-workbench', 'settings', 'dashboard', 'data-management', 'task-dashboard', 'template-management',
  'ui-lab', 'crepe-demo', 'pdf-reader', 'learning-hub', 'media', 'skills-management', 'todo', 'flashcards',
  'chat-v2-test', 'llm-playground',
];
const FOCUSED_APPS = [null, 'notes', 'files', 'chat', 'mindmap', 'todo'] as const;
const RESOURCES = [null, { type: 'note', id: 'n1' }, { type: 'mindmap', id: 'm1' }] as const;
const CONTEXTS: Array<{ view: CommandView; focused: string | null }> = [
  ...LEGACY_VIEWS.map((view) => ({ view, focused: null })),
  ...FOCUSED_APPS.map((focused) => ({ view: 'workbench' as CommandView, focused })),
];

function makeDeps(view: CommandView, focused: string | null, dark: boolean, record = false): DependencyResolver {
  const rec = (name: string) => (...args: unknown[]) => { if (record) state.trace.push(['deps.' + name, ...args.map(describeArg)]); };
  return {
    navigate: rec('navigate'),
    getCurrentView: () => view,
    getFocusedWorkbenchAppTypeId: () => focused,
    t: i18n.t.bind(i18n) as DependencyResolver['t'],
    showNotification: rec('showNotification'),
    toggleTheme: rec('toggleTheme'),
    isDarkMode: () => dark,
    switchLanguage: rec('switchLanguage'),
    getCurrentLanguage: () => i18n.language,
    openCommandPalette: rec('openCommandPalette'),
    closeCommandPalette: rec('closeCommandPalette'),
  };
}

function describeArg(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value ?? null;
  if (typeof value === 'object') return { keys: Object.keys(value as object).sort() };
  return typeof value;
}

const iconName = (icon: unknown) => (icon as { displayName?: string } | undefined)?.displayName ?? null;

function describeCommands(commands: readonly Command[]) {
  return commands.map((command, index) => ({
    index,
    id: command.id,
    name: command.name,
    description: command.description ?? null,
    category: command.category,
    shortcut: command.shortcut ?? null,
    icon: iconName(command.icon),
    keywords: command.keywords ?? null,
    priority: command.priority ?? null,
    tags: command.tags ?? null,
    dangerous: command.dangerous ?? null,
    requireConfirm: command.requireConfirm ?? null,
    confirmMessage: command.confirmMessage ?? null,
    visibleInViews: command.visibleInViews ?? null,
    hasIsEnabled: typeof command.isEnabled === 'function',
  }));
}

function visibilityMatrix() {
  const matrix: Record<string, string> = {};
  for (const { view, focused } of CONTEXTS) for (const dark of [false, true]) for (const resource of RESOURCES) for (const mobile of [false, true]) {
    state.resource = resource as typeof state.resource;
    state.mobile = mobile;
    const ids = commandRegistry.getAvailable(view, makeDeps(view, focused, dark)).map((c) => c.id);
    matrix[`${view}|${focused ?? '-'}|${dark ? 'dark' : 'light'}|${resource?.type ?? '-'}|${mobile ? 'mobile' : 'desktop'}`] = ids.join(' ');
  }
  state.resource = null;
  state.mobile = false;
  return matrix;
}

function searchMatrix() {
  const out: Record<string, string> = {};
  const contexts = [CONTEXTS[0], CONTEXTS.find((c) => c.view === 'learning-hub')!, CONTEXTS.find((c) => c.focused === 'notes')!, CONTEXTS.find((c) => c.view === 'settings')!];
  for (const { view, focused } of contexts) for (const query of ['', 'nav', '>nav', 'chat', 'theme', '笔记', '设置', 'set', 'zoom', 'anki', 'dev', 'goto', 'xyz-no-match']) {
    out[`${view}|${focused ?? '-'}|${query}`] = commandRegistry.search(query, view, makeDeps(view, focused, false)).map((c) => c.id).join(' ');
  }
  return out;
}

function shortcutMatrix() {
  const shortcuts = [...new Set(commandRegistry.getAll().map((c) => c.shortcut).filter(Boolean) as string[])].sort();
  const out: Record<string, Record<string, string | null>> = {};
  for (const shortcut of shortcuts) {
    const row: Record<string, string | null> = { '*': commandRegistry.getByShortcut(shortcut)?.id ?? null };
    for (const { view, focused } of CONTEXTS) {
      row[`${view}|${focused ?? '-'}`] = commandRegistry.resolveShortcut(shortcut, view, makeDeps(view, focused, false))?.id ?? null;
    }
    out[shortcut] = row;
  }
  return out;
}

async function executionTrace() {
  const out: Record<string, unknown> = {};
  const originalWindowDispatch = window.dispatchEvent.bind(window);
  const originalDocumentDispatch = document.dispatchEvent.bind(document);
  const describeEvent = (target: string, event: Event) => {
    const detail = (event as CustomEvent).detail;
    state.trace.push(['event', target, event.type, detail === undefined || detail === null ? null : describeArg(detail)]);
  };
  window.dispatchEvent = (event: Event) => { describeEvent('window', event); return originalWindowDispatch(event); };
  document.dispatchEvent = (event: Event) => { describeEvent('document', event); return originalDocumentDispatch(event); };
  const originalZoom = document.body.style.zoom;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    for (const command of commandRegistry.getAll()) {
      const context = CONTEXTS.find(({ view, focused }) => commandRegistry.getAvailable(view, makeDeps(view, focused, false)).some((c) => c.id === command.id));
      const { view, focused } = context ?? CONTEXTS[0];
      state.resource = view === 'workbench' && focused === 'notes' ? { type: command.id.startsWith('mindmap.') ? 'mindmap' : 'note', id: 'r1' } : null;
      state.trace = [];
      let error: string | null = null;
      try {
        await commandRegistry.execute(command.id, makeDeps(view, focused, false, true));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      await vi.runAllTimersAsync();
      if (document.body.style.zoom !== originalZoom) state.trace.push(['body.style.zoom', document.body.style.zoom]);
      out[command.id] = { context: `${view}|${focused ?? '-'}`, enabledSomewhere: !!context, error, trace: state.trace };
      document.body.style.zoom = originalZoom;
    }
  } finally {
    vi.useRealTimers();
    window.dispatchEvent = originalWindowDispatch;
    document.dispatchEvent = originalDocumentDispatch;
    state.trace = [];
    state.resource = null;
  }
  return out;
}

/**
 * The production assembly under test: the real UI kernel bootstrap installs the official UI plugins, whose feature
 * plugins contribute the commands; App then mounts `useAppBackgroundServices` as before.
 * (Golden captured from the previous assembly, where that hook registered the built-in commands itself.)
 */
async function bootCommands(): Promise<() => Promise<void>> {
  const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
  const kernel = await createAppUiKernel();
  const hook = renderHook(() => useAppBackgroundServices(i18n));
  return async () => {
    hook.unmount();
    await kernel.dispose();
  };
}

async function waitForNamespaces() {
  await act(async () => {
    await i18n.changeLanguage('en-US');
    await i18n.changeLanguage('zh-CN');
  });
  for (let i = 0; i < 200; i++) {
    if (i18n.hasResourceBundle('zh-CN', 'command_palette') && i18n.hasResourceBundle('en-US', 'command_palette')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('command_palette namespace did not load');
}

async function snapshot(language: string) {
  await act(async () => { await i18n.changeLanguage(language); });
  return describeCommands(commandRegistry.getAll());
}

/** i18n keys instead of texts: `t` returns its key while the commands are re-registered and read. */
async function snapshotKeys() {
  const realT = i18n.t;
  i18n.t = ((key: string | string[]) => (Array.isArray(key) ? key[0] : key)) as typeof i18n.t;
  try {
    await act(async () => { i18n.emit('languageChanged', i18n.language); });
    return describeCommands(commandRegistry.getAll());
  } finally {
    i18n.t = realT;
    await act(async () => { i18n.emit('languageChanged', i18n.language); });
  }
}

async function capture(mode: 'development' | 'production') {
  vi.stubEnv('DEV', mode === 'development');
  vi.stubEnv('PROD', mode === 'production');
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
  const dispose = await bootCommands();
  try {
    const zh = await snapshot('zh-CN');
    const en = await snapshot('en-US');
    const keys = await snapshotKeys();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    return {
      mode,
      stats: commandRegistry.getStats(),
      commands: zh.map((entry, i) => ({
        ...entry,
        name: { 'zh-CN': entry.name, 'en-US': en[i].name, key: keys[i].name },
        description: { 'zh-CN': entry.description, 'en-US': en[i].description, key: keys[i].description },
        keywords: { 'zh-CN': entry.keywords, 'en-US': en[i].keywords, key: keys[i].keywords },
        orderAfterLanguageSwitch: [en[i].id, keys[i].id],
      })),
      visibility: visibilityMatrix(),
      search: searchMatrix(),
      shortcuts: shortcutMatrix(),
      execution: await executionTrace(),
    };
  } finally {
    await dispose();
    vi.unstubAllEnvs();
  }
}

describe('command palette manifest (FE-B1 golden)', () => {
  const result: Record<string, unknown> = {};

  beforeAll(async () => {
    await waitForNamespaces();
    result.development = await capture('development');
    expect(commandRegistry.count()).toBe(0);
    result.production = await capture('production');
    expect(commandRegistry.count()).toBe(0);
  }, 120_000);

  afterAll(() => { commandRegistry.clear(); });

  it('matches the pre-refactor manifest field by field in development and production builds', () => {
    if (process.env.FE_B1_CAPTURE_GOLDEN === '1') {
      fs.mkdirSync('src/command-palette/__golden__', { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect((result.development as { commands: unknown[] }).commands).toEqual(golden.development.commands);
    expect((result.production as { commands: unknown[] }).commands).toEqual(golden.production.commands);
    expect(result).toEqual(golden);
  });

  it('keeps 96 commands in development and drops exactly the 9 dev commands in production', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const dev = golden.development.commands.map((c: { id: string }) => c.id);
    const prod = golden.production.commands.map((c: { id: string }) => c.id);
    expect(dev).toHaveLength(96);
    expect(dev.filter((id: string) => !prod.includes(id))).toEqual(dev.filter((id: string) => id.startsWith('dev.')));
    expect(prod.every((id: string) => dev.includes(id))).toBe(true);
  });
});
