import type { CurrentView } from '@/types/navigation';

/**
 * 闪卡中心（Cards hub）：把「闪卡复习」「Anki 制卡任务」「模板管理」三个经典壳
 * 视图收拢成一个页面、三个分区标签。
 *
 * 设计取舍：分区 = 既有视图 id（flashcards / task-dashboard / template-management），
 * 不新造视图。好处：
 * - 所有旧导航入口（NAVIGATE_TO_VIEW / MOBILE_APP_NAVIGATE / 命令面板 / 工作台
 *   降级映射 / 历史记录 / 视图持久化）无需改动即落到对应分区；
 * - 各分区页面的保活、移动端顶栏注册、返回键守卫等按视图 id 工作的机制保持原样；
 * - 分区切换走正常导航，进入前进/后退历史。
 *
 * 侧栏与移动抽屉只保留一个入口（以 flashcards 为代表视图），任一分区活跃时该
 * 入口高亮；点击入口回到本次运行中最近访问的分区（首次默认「复习」）。
 */

export type CardsHubTabId = 'review' | 'generate' | 'templates';

export type CardsHubView = Extract<CurrentView, 'flashcards' | 'task-dashboard' | 'template-management'>;

export interface CardsHubTab {
  id: CardsHubTabId;
  view: CardsHubView;
  labelKey: string;
  fallbackLabel: string;
}

/** 分区顺序按使用频率：复习（每日）→ 制卡（产出）→ 模板（低频配置） */
export const CARDS_HUB_TABS: readonly CardsHubTab[] = [
  { id: 'review', view: 'flashcards', labelKey: 'sidebar:navigation.cards_hub.review', fallbackLabel: '复习' },
  { id: 'generate', view: 'task-dashboard', labelKey: 'sidebar:navigation.cards_hub.generate', fallbackLabel: '制卡' },
  { id: 'templates', view: 'template-management', labelKey: 'sidebar:navigation.cards_hub.templates', fallbackLabel: '模板' },
];

/** 侧栏 / 移动启动器里代表整个闪卡中心的入口视图，同时是默认分区 */
export const CARDS_HUB_ENTRY_VIEW: CardsHubView = 'flashcards';

const HUB_VIEWS: ReadonlySet<string> = new Set(CARDS_HUB_TABS.map((tab) => tab.view));

export function isCardsHubView(view: CurrentView | string | null | undefined): view is CardsHubView {
  return typeof view === 'string' && HUB_VIEWS.has(view);
}

export function getCardsHubTabForView(view: CurrentView | string | null | undefined): CardsHubTab | null {
  return CARDS_HUB_TABS.find((tab) => tab.view === view) ?? null;
}

let lastVisitedHubView: CardsHubView = CARDS_HUB_ENTRY_VIEW;

/** App 在 currentView 变化时调用：记住最近访问的分区（仅本次运行，重启回到「复习」） */
export function rememberCardsHubView(view: CurrentView | string | null | undefined): void {
  if (isCardsHubView(view)) lastVisitedHubView = view;
}

/** 侧栏入口点击的落点：最近访问的分区 */
export function resolveCardsHubEntryView(): CardsHubView {
  return lastVisitedHubView;
}

/** 测试用：重置最近访问分区 */
export function resetCardsHubMemoryForTests(): void {
  lastVisitedHubView = CARDS_HUB_ENTRY_VIEW;
}

/**
 * 导航入口是否应高亮：闪卡中心入口在任一分区活跃时高亮，其余入口按视图相等判断。
 * 两侧都应传入已 canonicalize 的视图。
 */
export function isNavEntryActive(entryView: CurrentView | string, currentView: CurrentView | string): boolean {
  if (entryView === CARDS_HUB_ENTRY_VIEW) return isCardsHubView(currentView);
  return entryView === currentView;
}

/** 导航入口点击的实际落点：闪卡中心入口回到最近分区，其余入口原样返回 */
export function resolveNavEntryTarget<T extends CurrentView | string>(entryView: T): T | CardsHubView {
  return entryView === CARDS_HUB_ENTRY_VIEW ? resolveCardsHubEntryView() : entryView;
}

/**
 * 导航入口点击的落点（侧栏 / 移动启动器共用）：
 * 闪卡中心入口在组内时保持当前分区（不跳回别的分区），组外时回到最近访问分区；
 * 其余入口原样返回。
 */
export function resolveNavEntryClick<T extends CurrentView>(entryView: T, currentView: CurrentView): T | CardsHubView {
  if (entryView === CARDS_HUB_ENTRY_VIEW && isCardsHubView(currentView)) return currentView;
  return resolveNavEntryTarget(entryView);
}

/**
 * 同组分区切换的移动端层滑动方向：按分区顺序，切到右侧分区为 1（右入）、左侧为 -1，
 * 让分区切换读作「横向翻页」而不是「压栈进入新页面」。非组内切换返回 null。
 */
export function getCardsHubSwitchDirection(fromView: CurrentView | string, toView: CurrentView | string): 1 | -1 | null {
  if (fromView === toView) return null;
  const from = CARDS_HUB_TABS.findIndex((tab) => tab.view === fromView);
  const to = CARDS_HUB_TABS.findIndex((tab) => tab.view === toView);
  if (from < 0 || to < 0) return null;
  return to > from ? 1 : -1;
}
