import { createElement, lazy, Suspense, type ComponentType } from 'react';
import { defineUiPlugin } from '@/ui-kernel/kernel';
import type { ShellNavItem, ShellView, ShellViewProps } from '@/ui-kernel/contracts/shell';
import {
  StudyBlocksIcon, StudyBooksIcon, StudyCardsIcon, StudyChatIcon,
  StudyMagicWandIcon, StudyMediaIcon, StudySettingsIcon, StudyTodoIcon,
} from '@/components/icons/StudySidebarIcons';
import { Database } from '@phosphor-icons/react';

// No page imports: App's existing hooks keep the exact memoized content elements,
// props, Suspense boundaries and import timing. This component adds no DOM.
function OfficialViewContent({ content }: ShellViewProps) { return content; }

const views: ShellView[] = ([
  { id: 'dashboard', contentKey: 'dashboardContent', titleKey: 'common:navigation.dashboard', extraClass: 'overflow-hidden' },
  { id: 'settings', contentKey: 'settingsContent', titleKey: 'sidebar:navigation.settings', extraClass: 'overflow-hidden', shell: { sidebarKind: 'settings', sidebarOwnsBackNavigation: true, hideExpandedSidebarToggle: true, contentClass: 'settings-view' } },
  { id: 'task-dashboard', contentKey: 'taskDashboardContent', titleKey: 'sidebar:navigation.flashcards', shell: { cardsHubTabs: true } },
  { id: 'skills-management', contentKey: 'skillsManagementContent', titleKey: 'sidebar:navigation.skills_management', shell: { toolbarSlot: 'skills-toolbar' } },
  { id: 'data-management', contentKey: 'dataManagementContent', titleKey: 'common:navigation.data_management' },
  { id: 'template-management', contentKey: 'templateManagementContent', titleKey: 'sidebar:navigation.flashcards', shell: { cardsHubTabs: true } },
  { id: 'ui-lab', contentKey: 'styleDebugContent', titleKey: 'sidebar:navigation.ui_lab', visible: ({ uiLabEnabled }) => uiLabEnabled },
  { id: 'learning-hub', contentKey: 'learningHubContent', titleKey: 'sidebar:navigation.learning_hub', shell: { sidebarKind: 'desktop-page', pageBackButton: true, toolbarSlot: 'learning-hub-toolbar' } },
  { id: 'media', contentKey: 'mediaStudioContent', titleKey: 'sidebar:navigation.media', shell: { toolbarSlot: 'media-toolbar' } },
  { id: 'sandbox-workbench', contentKey: 'sandboxWorkbenchContent', titleKey: 'common:navigation.sandbox_workbench' },
  { id: 'pdf-reader', contentKey: 'pdfReaderContent', titleKey: 'common:navigation.pdf_reader' },
  { id: 'todo', contentKey: 'todoContent', titleKey: 'sidebar:navigation.todo', shell: { sidebarKind: 'todo', sidebarOwnsBackNavigation: true, toolbarSlot: 'todo-toolbar' } },
  { id: 'flashcards', contentKey: 'flashcardsContent', titleKey: 'sidebar:navigation.flashcards', shell: { cardsHubTabs: true } },
  { id: 'crepe-demo', contentKey: 'crepeDemoContent', titleKey: 'common:navigation.crepe_demo', visible: ({ dev }) => dev },
  { id: 'chat-v2-test', contentKey: 'chatV2TestContent', titleKey: 'common:navigation.chat_v2_test', visible: ({ dev }) => dev },
  { id: 'llm-playground', contentKey: 'llmPlaygroundContent', titleKey: 'common:navigation.llm_playground', visible: ({ dev }) => dev },
  { id: 'chat-v2', contentKey: 'chatV2Content', titleKey: 'sidebar:navigation.chat_v2', allowInDemo: true, shell: { chatHeader: true, mobileBackToHome: false } },
] satisfies Omit<ShellView, 'component'>[]).map((view, index) => ({
  ...view, component: OfficialViewContent, order: (index + 1) * 10, keepAlive: true,
  shell: { sidebarKind: 'main', mobileBackToHome: true, ...view.shell },
}));

const nav: ShellNavItem[] = ([
  { id: 'chat-v2', viewId: 'chat-v2', labelKey: 'sidebar:navigation.chat_v2', fallback: '新会话', icon: StudyChatIcon,
    desktop: { placement: 'primary', chatScope: true, action: 'new-session', omitFallback: true },
    mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.chat_v2', fallback: '会话' }, ariaLabel: { key: 'sidebar:navigation.sessions', fallback: '会话' } } },
  { id: 'learning-hub', viewId: 'learning-hub', labelKey: 'sidebar:navigation.learning_hub', fallback: '资源库', icon: StudyBooksIcon,
    desktop: { placement: 'primary' }, mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.learning_hub', fallback: '资源' }, ariaLabel: { key: 'sidebar:navigation.learning_hub', fallback: '资源库' } } },
  { id: 'media', viewId: 'media', labelKey: 'sidebar:navigation.media', fallback: '音视频', icon: StudyMediaIcon,
    desktop: { placement: 'primary' }, mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.media', fallback: '音视频' }, ariaLabel: { key: 'sidebar:navigation.media', fallback: '音视频' } } },
  { id: 'todo', viewId: 'todo', labelKey: 'sidebar:navigation.todo', icon: StudyTodoIcon,
    desktop: { placement: 'primary' }, mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.todo', fallback: '待办' }, ariaLabel: { key: 'sidebar:navigation.todo', fallback: '待办' } } },
  { id: 'skills-management', viewId: 'skills-management', labelKey: 'sidebar:navigation.skills_management', fallback: '技能管理', icon: StudyMagicWandIcon,
    desktop: { placement: 'primary' }, mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.skills_management', fallback: '技能' }, ariaLabel: { key: 'sidebar:navigation.skills_management', fallback: '技能管理' } } },
  { id: 'flashcards', viewId: 'flashcards', labelKey: 'sidebar:navigation.flashcards', fallback: '闪卡', icon: StudyCardsIcon,
    desktop: { placement: 'primary' }, mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.flashcards', fallback: '闪卡' }, ariaLabel: { key: 'sidebar:navigation.flashcards', fallback: '闪卡' } } },
  { id: 'ui-lab', viewId: 'ui-lab', labelKey: 'sidebar:navigation.ui_lab', icon: StudyBlocksIcon,
    visible: ({ uiLabEnabled }) => uiLabEnabled, desktop: { placement: 'primary' } },
  { id: 'data-management', viewId: 'data-management', labelKey: 'common:navigation.data_management', fallback: '数据管理', icon: Database,
    mobile: { placement: 'launcher', label: { key: 'sidebar:navigation.launcher.data_management', fallback: '数据' }, ariaLabel: { key: 'common:navigation.data_management', fallback: '数据管理' } } },
  { id: 'settings', viewId: 'settings', labelKey: 'sidebar:navigation.settings', fallback: '设置', icon: StudySettingsIcon,
    desktop: { placement: 'settings' }, mobile: { placement: 'settings' } },
] satisfies ShellNavItem[]).map((item, index) => ({ ...item, order: (index + 1) * 10 }));

const HostUnavailablePanel = lazy(() => import('@/components/system-status/HostUnavailablePanel'));

function hostUnavailableView(hostId: string, titleKey: string, reason: string | undefined): ComponentType<ShellViewProps> {
  return function HostUnavailableView() {
    return createElement(Suspense, { fallback: null }, createElement(HostUnavailablePanel, { hostId, titleKey, reason }));
  };
}

/** 卡片中心（任务面板、模板管理、闪卡）的视图与导航，与 Host 插件 `dstu.anki` 配对。 */
export const ANKI_HOST_PLUGIN = 'dstu.anki';
const ankiViewIds = new Set(['task-dashboard', 'template-management', 'flashcards']);
const ankiNavIds = new Set(['flashcards']);

const ankiHalf = defineUiPlugin({
  meta: { id: ANKI_HOST_PLUGIN, host: true },
  apply(ctx) {
    const degraded = ctx.ui.hostStatus.state(ANKI_HOST_PLUGIN) === 'degraded';
    const reason = ctx.ui.hostStatus.reason(ANKI_HOST_PLUGIN);
    for (const view of views) {
      if (!ankiViewIds.has(view.id)) continue;
      const value = degraded ? { ...view, component: hostUnavailableView(ANKI_HOST_PLUGIN, view.titleKey, reason) } : view;
      ctx.ui.contribute('views', { id: view.id, key: view.id, order: view.order, value });
    }
    for (const item of nav) if (ankiNavIds.has(item.id)) ctx.ui.nav.register(item);
  },
});

export const order = 10;
export const officialShellViewIds: ReadonlySet<string> = new Set(views.map(view => view.id));
export default { ...defineUiPlugin({
  meta: { id: 'dstu.ui.shell' },
  async apply(ctx) {
    for (const view of views) if (!ankiViewIds.has(view.id)) ctx.ui.contribute('views', { id: view.id, key: view.id, order: view.order, value: view });
    for (const item of nav) if (!ankiNavIds.has(item.id)) ctx.ui.nav.register(item);
    await ctx.ui.pair(ankiHalf);
  },
}), order };
