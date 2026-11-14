import React, { Suspense, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { CurrentView } from '@/types/navigation';
import { MobilePageScaffold } from '@/components/layout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { FeatureUnavailablePanel } from '@/components/system-status/FeatureUnavailablePanel';
import {
  PageLoadingFallback,
  LazySettings,
  LazySOTADashboard,
  LazySkillsManagementPage,
  LazyTemplateManagementPage,
  LazyStyleDebugPage,
  LazyLearningHubPage,
  LazySandboxWorkbenchPage,
  LazyPdfReader,
  LazyTodoPage,
  LazyFlashcardsPage,
  LazyMediaStudioPage,
  LazyCrepeDemoPage,
  LazyChatV2IntegrationTest,
  LazyLLMOutputPlayground,
  LazyChatV2Page,
  LazyDataImportExport,
  LazyImportConversationDialog,
} from '@/lazyComponents';
import type { SetCurrentView } from '@/app/navigation/viewRouting';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import type { SlotEntry } from '@/ui-kernel/slots';
import { RegisteredViewLayer } from '@/ui-plugins/official/shell/RegisteredViewLayer';
import { invalidateShellViewComponent, resolveShellViewComponent } from '@/ui-kernel/shell-view';
const viewLoadingFallback = <PageLoadingFallback />;
import type { ShellView, ShellViewContribution } from '@/ui-kernel/contracts/shell';

// App 壳层：经典壳各保活视图层的内容元素，从 App.tsx 原样搬出。
// 每个视图内容都以 useMemo 保持稳定引用（ViewLayerRenderer 的 memo 以 children 引用比较），
// lazy 组件仍来自 src/lazyComponents.tsx（chunk 划分不变）。三个 hook 在 App 中按原顺序
// 调用；task-dashboard / data-management 两个内容依赖 App 内的 state setter，仍在 App 中。

/**
 * dashboard / settings 视图内容。
 */
export function useDashboardAndSettingsContents(currentView: CurrentView, isSmallScreen: boolean, setCurrentView: SetCurrentView) {
  // 🚀 性能优化：memoize 各视图内容，防止切换视图时所有已缓存视图子树被重新协调
  // 当 App 因 currentView 变化而重渲染时，useMemo 返回相同的 React 元素引用，
  // React 协调器看到相同引用后会跳过整个子树的 diff，大幅减少切换耗时。
  // 仅包含稳定依赖（useCallback/useState setter/ref）的视图可安全 memoize。
  const dashboardContent = useMemo(() => (
    // P3-1：移动端组件自带 MobileSlidingLayout 抽屉壳（含内容滚动），
    // 外层再套 CustomScrollArea 会让抽屉的 absolute 定位落进滚动视口
    isSmallScreen ? (
      <Suspense fallback={<PageLoadingFallback />}>
        <LazySOTADashboard
          onBack={() => setCurrentView('chat-v2')}
          onNavigate={(view) => setCurrentView(view)}
        />
      </Suspense>
    ) : (
      <CustomScrollArea className="flex-1" viewportClassName="flex-1" trackOffsetTop={12} trackOffsetBottom={12}>
        <Suspense fallback={<PageLoadingFallback />}>
          <LazySOTADashboard
            onBack={() => setCurrentView('chat-v2')}
            onNavigate={(view) => setCurrentView(view)}
          />
        </Suspense>
      </CustomScrollArea>
    )
  ), [isSmallScreen, setCurrentView]);

  const isSettingsActive = currentView === 'settings';
  const settingsContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazySettings
        onBack={() => setCurrentView('chat-v2')}
        isActive={isSettingsActive}
      />
    </Suspense>
  ), [isSettingsActive, setCurrentView]);

  return { dashboardContent, settingsContent };
}

/**
 * skills / flashcards / media / ui-lab / learning-hub / pdf-reader / chat-v2 / template-management 视图内容。
 */
export function useFeatureViewContents(
  currentView: CurrentView,
  chatV2Blocked: boolean,
  t: TFunction,
  isSelectingTemplate: boolean,
  handleTemplateSelected: (template: any) => void,
  handleTemplateSelectionCancel: () => void,
  templateManagementRefreshTick: number,
) {
  const skillsManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazySkillsManagementPage /></Suspense>
  ), []);

  const isFlashcardsActive = currentView === 'flashcards';
  const flashcardsContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyFlashcardsPage isActive={isFlashcardsActive} />
    </Suspense>
  ), [isFlashcardsActive]);

  const isMediaActive = currentView === 'media';
  const mediaStudioContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyMediaStudioPage isActive={isMediaActive} />
    </Suspense>
  ), [isMediaActive]);

  const styleDebugContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <MobilePageScaffold>
        <LazyStyleDebugPage />
      </MobilePageScaffold>
    </Suspense>
  ), []);

  const learningHubContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyLearningHubPage /></Suspense>
  ), []);

  const pdfReaderContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <MobilePageScaffold>
        <LazyPdfReader />
      </MobilePageScaffold>
    </Suspense>
  ), []);

  const chatV2Content = useMemo(() => (
    chatV2Blocked
      ? <FeatureUnavailablePanel component="chat_v2" title={t('common:maintenance.chat_unavailable')} />
      : <Suspense fallback={<PageLoadingFallback />}><LazyChatV2Page allowReadingLayout /></Suspense>
  ), [chatV2Blocked, t]);

  // template-management: 依赖仅在模板选择流程触发时变化，日常视图切换中保持稳定
  const templateManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyTemplateManagementPage
        isSelectingMode={isSelectingTemplate}
        onTemplateSelected={handleTemplateSelected}
        onCancel={handleTemplateSelectionCancel}
        refreshToken={templateManagementRefreshTick}
      />
    </Suspense>
  ), [isSelectingTemplate, handleTemplateSelected, handleTemplateSelectionCancel, templateManagementRefreshTick]);

  return {
    skillsManagementContent,
    flashcardsContent,
    mediaStudioContent,
    styleDebugContent,
    learningHubContent,
    pdfReaderContent,
    chatV2Content,
    templateManagementContent,
  };
}

/**
 * todo / sandbox-workbench 与开发模式视图（crepe-demo / chat-v2-test / llm-playground）内容。
 */
export function useAuxiliaryViewContents(setCurrentView: SetCurrentView) {
  // 保活视图层的内容必须保持稳定引用：ViewLayerRenderer 的 memo 以 children
  // 引用做比较，若每次 App 重渲染都新建元素，已访问的隐藏视图会跟着重渲染，
  // 表现为访问页面越多、切换越卡。以下内容统一 useMemo 收口。
  const todoContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyTodoPage /></Suspense>
  ), []);

  const sandboxWorkbenchContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <MobilePageScaffold><LazySandboxWorkbenchPage /></MobilePageScaffold>
    </Suspense>
  ), []);

  const crepeDemoContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <MobilePageScaffold><LazyCrepeDemoPage onBack={() => setCurrentView('settings')} /></MobilePageScaffold>
    </Suspense>
  ), [setCurrentView]);

  const chatV2TestContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyChatV2IntegrationTest /></Suspense>
  ), []);

  const llmPlaygroundContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyLLMOutputPlayground /></Suspense>
  ), []);

  return {
    todoContent,
    sandboxWorkbenchContent,
    crepeDemoContent,
    chatV2TestContent,
    llmPlaygroundContent,
  };
}

// 🚀 性能优化：DataImportExport, ImportConversationDialog 与制卡任务改为懒加载（与原 App.tsx 同法）
const AnkiTasksApp = React.lazy(() =>
  import('@/features/anki-tasks/AnkiTasksApp').then(m => ({ default: m.AnkiTasksApp }))
);

/** `useViewLayer` 的输入：壳层状态与视图切换入口，全部来自 App 的 committed state。 */
export interface ViewLayerOptions {
  currentView: CurrentView;
  isSmallScreen: boolean;
  setCurrentView: SetCurrentView;
  setIsSelectingTemplate: (selecting: boolean) => void;
  chatV2Blocked: boolean;
  t: TFunction;
  isSelectingTemplate: boolean;
  handleTemplateSelected: (template: any) => void;
  handleTemplateSelectionCancel: () => void;
  templateManagementRefreshTick: number;
  showImportConversation: boolean;
  setShowImportConversation: (open: boolean) => void;
  handleImportConversationSuccess: (mistakeId: string) => Promise<void>;
  uiLabEnabled: boolean;
  viewEntries: readonly SlotEntry<ShellViewContribution>[];
  visitedViews: Map<CurrentView, number>;
  viewNavDirection: 1 | -1;
}

/**
 * 经典壳的视图层：contentKey → 内容元素，再按 `views` 槽位组装保活层。
 *
 * 内容元素一律 useMemo 保持稳定引用（ViewLayerRenderer 的 memo 以 children 引用比较，
 * 否则访问过的隐藏视图会随 App 重渲染一起协调）。视图条目仍是 `ShellView`（`contentKey`）；
 * W17 的 `load()` 迁移需要同步重录 `tests/visual/__golden__/slots/*.json`，见 W38.md。
 */
export function useViewLayer(options: ViewLayerOptions): React.ReactNode[] {
  const {
    currentView, isSmallScreen, setCurrentView, setIsSelectingTemplate,
    chatV2Blocked, t, isSelectingTemplate, handleTemplateSelected,
    handleTemplateSelectionCancel, templateManagementRefreshTick,
    showImportConversation, setShowImportConversation, handleImportConversationSuccess,
    uiLabEnabled, viewEntries, visitedViews, viewNavDirection,
  } = options;

  const { dashboardContent, settingsContent } = useDashboardAndSettingsContents(
    currentView,
    isSmallScreen,
    setCurrentView,
  );

  const taskDashboardContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <AnkiTasksApp
        onNavigateToChat={(sessionId) => {
          setCurrentView('chat-v2');
          dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId });
        }}
        onOpenChat={() => setCurrentView('chat-v2')}
        onOpenTemplateManagement={() => {
          setIsSelectingTemplate(false);
          setCurrentView('template-management');
        }}
      />
    </Suspense>
  ), [setCurrentView, setIsSelectingTemplate]);

  const {
    skillsManagementContent,
    flashcardsContent,
    mediaStudioContent,
    styleDebugContent,
    learningHubContent,
    pdfReaderContent,
    chatV2Content,
    templateManagementContent,
  } = useFeatureViewContents(
    currentView,
    chatV2Blocked,
    t,
    isSelectingTemplate,
    handleTemplateSelected,
    handleTemplateSelectionCancel,
    templateManagementRefreshTick,
  );

  // data-management: 依赖仅在导入对话框打开/语言切换时变化
  const dataManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyDataImportExport onBack={() => setCurrentView('chat-v2')} />
      <LazyImportConversationDialog
        open={showImportConversation}
        onOpenChange={setShowImportConversation}
        onImportSuccess={handleImportConversationSuccess}
      />
    </Suspense>
  ), [showImportConversation, handleImportConversationSuccess, setCurrentView, setShowImportConversation]);

  const {
    todoContent,
    sandboxWorkbenchContent,
    crepeDemoContent,
    chatV2TestContent,
    llmPlaygroundContent,
  } = useAuxiliaryViewContents(setCurrentView);

  const [, setRetryGeneration] = useState(0);
  const retryHandlers = useMemo(() => new Map(viewEntries.map(({ value }) => [value.id, () => {
    invalidateShellViewComponent(value);
    setRetryGeneration(generation => generation + 1);
  }])), [viewEntries]);

  const viewContents: Record<string, React.ReactNode> = {
    dashboardContent, settingsContent, taskDashboardContent, skillsManagementContent,
    dataManagementContent, templateManagementContent, styleDebugContent, learningHubContent,
    mediaStudioContent, sandboxWorkbenchContent, pdfReaderContent, todoContent,
    flashcardsContent, crepeDemoContent, chatV2TestContent, llmPlaygroundContent, chatV2Content,
  };
  return viewEntries.filter(({ value }) => !value.visible || value.visible({ dev: import.meta.env.DEV, uiLabEnabled })).map(({ owner, value }) => (
      <RegisteredViewLayer
        key={value.id}
        entry={value}
        component={resolveShellViewComponent(value)}
        onRetry={retryHandlers.get(value.id)}
        suspenseFallback={viewLoadingFallback}
        content={value.contentKey ? viewContents[value.contentKey] : undefined}
        footerOverlay={owner?.startsWith('workshop.plugin-') ? (
          <div
            aria-label="插件工坊快捷栏"
            className="fixed bottom-5 right-6 z-30 flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 py-1.5 text-xs shadow-sm backdrop-blur"
          >
            <span className="text-muted-foreground">插件工坊作品</span>
            <button
              type="button"
              onClick={() => setCurrentView('chat-v2')}
              className="rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              返回对话继续改进
            </button>
          </div>
        ) : undefined}
        view={value.id as CurrentView}
        currentView={currentView}
        visitedViews={visitedViews}
        errorBoundaryName={value.id}
        navDirection={viewNavDirection}
        extraClass={value.extraClass}
      />
  ));
}
