/**
 * 闪卡中心（复习 / 制卡 / 模板）分区契约：
 * - 三个旧视图 id 即三个分区，旧导航目标（含废弃别名、工作台降级映射）都落到对应分区；
 * - 侧栏 / 移动启动器只保留 flashcards 一个入口，任一分区活跃时高亮；
 * - 入口点击：组内保持当前分区，组外回到最近访问分区（首次默认「复习」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/workbench/core/windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [] }) },
}));
vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { registerLegacyFallback: vi.fn() },
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/utils/i18n', () => ({
  t: (key: string) => key,
}));

import { canonicalizeView } from '../canonicalView';
import {
  CARDS_HUB_ENTRY_VIEW,
  CARDS_HUB_TABS,
  getCardsHubSwitchDirection,
  getCardsHubTabForView,
  isCardsHubView,
  isNavEntryActive,
  rememberCardsHubView,
  resetCardsHubMemoryForTests,
  resolveNavEntryClick,
} from '../cardsHub';
import { translateLegacyNavigation } from '@/features/workbench/core/legacyNavigationMap';
import { createNavItems, MOBILE_APP_LAUNCHER_VIEWS } from '@/config/navigation';
import type { TFunction } from 'i18next';

const passthroughT = ((key: string, fallback?: string) => fallback ?? key) as unknown as TFunction;

describe('cards hub tabs', () => {
  beforeEach(() => resetCardsHubMemoryForTests());

  it('orders tabs by usage frequency and defaults to review', () => {
    expect(CARDS_HUB_TABS.map((tab) => [tab.id, tab.view])).toEqual([
      ['review', 'flashcards'],
      ['generate', 'task-dashboard'],
      ['templates', 'template-management'],
    ]);
    expect(CARDS_HUB_ENTRY_VIEW).toBe('flashcards');
  });

  it('recognises only the three hub views', () => {
    expect(isCardsHubView('flashcards')).toBe(true);
    expect(isCardsHubView('task-dashboard')).toBe(true);
    expect(isCardsHubView('template-management')).toBe(true);
    expect(isCardsHubView('chat-v2')).toBe(false);
    expect(isCardsHubView('learning-hub')).toBe(false);
    expect(isCardsHubView(undefined)).toBe(false);
  });

  it.each([
    // 旧视图 id 原样可用
    ['flashcards', 'review'],
    ['task-dashboard', 'generate'],
    ['template-management', 'templates'],
    // 废弃别名经 canonicalizeView 重定向后落到对应分区
    ['anki-generation', 'generate'],
    ['template-json-preview', 'templates'],
  ])('legacy target %s lands on the %s tab', (legacyView, tabId) => {
    expect(getCardsHubTabForView(canonicalizeView(legacyView))?.id).toBe(tabId);
  });

  it('highlights the single hub entry for every hub tab', () => {
    for (const tab of CARDS_HUB_TABS) {
      expect(isNavEntryActive('flashcards', tab.view)).toBe(true);
    }
    expect(isNavEntryActive('flashcards', 'chat-v2')).toBe(false);
    expect(isNavEntryActive('todo', 'todo')).toBe(true);
    expect(isNavEntryActive('todo', 'task-dashboard')).toBe(false);
  });

  it('keeps the current tab when the entry is clicked inside the hub', () => {
    expect(resolveNavEntryClick('flashcards', 'template-management')).toBe('template-management');
    expect(resolveNavEntryClick('flashcards', 'task-dashboard')).toBe('task-dashboard');
  });

  it('returns to the last visited tab from outside the hub (review on first visit)', () => {
    expect(resolveNavEntryClick('flashcards', 'chat-v2')).toBe('flashcards');
    rememberCardsHubView('task-dashboard');
    rememberCardsHubView('settings');
    expect(resolveNavEntryClick('flashcards', 'chat-v2')).toBe('task-dashboard');
    // 非闪卡中心入口不受影响
    expect(resolveNavEntryClick('todo', 'chat-v2')).toBe('todo');
  });

  it('slides sibling tabs by tab order and ignores switches outside the hub', () => {
    expect(getCardsHubSwitchDirection('flashcards', 'template-management')).toBe(1);
    expect(getCardsHubSwitchDirection('template-management', 'task-dashboard')).toBe(-1);
    expect(getCardsHubSwitchDirection('chat-v2', 'flashcards')).toBeNull();
    expect(getCardsHubSwitchDirection('flashcards', 'flashcards')).toBeNull();
  });

  it('exposes one hub entry in the sidebar and mobile launcher', () => {
    const views = createNavItems(passthroughT).map((item) => item.view);
    expect(views).toContain('flashcards');
    expect(views).not.toContain('task-dashboard');
    expect(views).not.toContain('template-management');
    expect(MOBILE_APP_LAUNCHER_VIEWS).toContain('flashcards');
    expect(MOBILE_APP_LAUNCHER_VIEWS).not.toContain('task-dashboard');
  });
});

describe('cards hub legacy workbench navigation', () => {
  let dispatched: Array<{ name: string; detail?: unknown }>;

  beforeEach(() => {
    dispatched = [];
    vi.stubGlobal('window', {
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push({ name: event.type, detail: event.detail });
        return true;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: globalThis.setTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ['flashcards', 'review'],
    ['taskDashboard', 'generate'],
    ['templates', 'templates'],
  ])('workbench app %s opens the %s tab in the classic shell', (typeId, tabId) => {
    translateLegacyNavigation({ typeId, reason: 'dock' }, 'launch');
    const navigate = dispatched.find((event) => event.name === 'NAVIGATE_TO_VIEW');
    const view = (navigate?.detail as { view?: string } | undefined)?.view;
    expect(getCardsHubTabForView(canonicalizeView(view ?? ''))?.id).toBe(tabId);
  });
});
