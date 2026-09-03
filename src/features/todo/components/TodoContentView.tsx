/**
 * TodoContentView - 待办列表主视图
 *
 * 作为 Todo 页面的顶层壳体，负责：
 * - 套用应用统一的 study-shell-page 外壳
 * - 桌面端：仅渲染 TodoMainPanel（侧边栏已移至 Shell 导航位置，由 TodoShellSidebar 提供）
 * - 移动端：MobileSlidingLayout 手势滑动切换侧栏 / 主视图
 * - 注册 useMobileHeader，保持与其他页面一致的移动端顶栏；
 *   子层级（任务详情 / 回收站 / 番茄钟设置与统计）打开时切换为返回箭头
 * - 移动端子屏（回收站 / 番茄钟设置 / 番茄钟统计）在此全屏承载
 *
 * R1-14：todo://changed 经 registerDomainListener；详情面板编辑中延迟 reload。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowsClockwise, Plus } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { motionSafe, tweenFast } from '@/styles/motion-springs';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MobileSlidingLayout, useMobileHeader } from '@/components/layout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { PomodoroSettingsContent, PomodoroStatsContent } from '@/features/pomodoro';
import { registerDomainListener } from '@/features/workbench/agent/domainEvents';
import { useTodoStore } from '../stores/useTodoStore';
import { useAutomationStore } from '../stores/useAutomationStore';
import { requestAutomationCreate } from '../automationCreateRequest';
import { TodoSidebar } from './TodoSidebar';
import { TodoMainPanel, MobileDetailOverlay, type PomodoroSubView } from './TodoMainPanel';
import { TodoTrashScreen, TodoTrashWorkspace, useTodoTrashView } from './TodoTrashDialog';
import { TodoAutomationWorkspace } from './TodoAutomationWorkspace';

interface TodoContentViewProps {
  todoListId?: string;
  initialView?: 'todos' | 'automations';
  className?: string;
  /** workbench 窗口标题栏槽位（TodoAppWindow 传入）；提供时主面板工具栏迁入窗口标题栏 */
  titlebarPortalTarget?: HTMLElement | null;
}

/** 详情面板内焦点守卫：activeElement 落在 data-todo-detail-panel 内则延迟 reload */
const DETAIL_PANEL_SELECTOR = '[data-todo-detail-panel]';
const RELOAD_RETRY_MS = 400;
const RELOAD_MAX_ATTEMPTS = 25;

function isDetailPanelFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el || !(el instanceof Element)) return false;
  return Boolean(el.closest(DETAIL_PANEL_SELECTOR));
}

function scheduleTodoReload(signal: { cancelled: boolean }): void {
  let attempts = 0;
  const tryReload = () => {
    if (signal.cancelled) return;
    if (isDetailPanelFocused() && attempts < RELOAD_MAX_ATTEMPTS) {
      attempts += 1;
      window.setTimeout(tryReload, RELOAD_RETRY_MS);
      return;
    }
    const store = useTodoStore.getState();
    void store.loadLists();
    void store.reloadCurrentView();
    // 软删除/恢复也走同一事件；顺带校准侧栏回收站徽标（失败静默）
    void store.refreshTrashCounts();
  };
  tryReload();
}

export const TodoContentView: React.FC<TodoContentViewProps> = ({
  todoListId,
  initialView,
  className,
  titlebarPortalTarget,
}) => {
  const { t } = useTranslation(['todo', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const {
    initialize,
    setActiveList,
    setViewFilter,
    activeListId,
    filter,
    lists,
    items,
    selectedItemId,
    selectItem,
    workspaceView,
    setWorkspaceView,
  } = useTodoStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 移动端 inline 子屏（全屏替换中屏内容，返回走顶栏箭头 / Android 返回键）。
  // 注意：移动端回收站入口走本地 trashOpen（TodoSidebar 的 onOpenTrash 回调），
  // 与桌面端的 useTodoTrashView 共享 store 是两条独立路径——移动端需要接入
  // 统一顶栏返回箭头与 Android 返回键的 MobileDetailOverlay 承载，无法直接
  // 复用桌面 store。代价是 todoActivation 的 closeTrashView 只覆盖桌面路径；
  // 移动端 ACR 导航不受影响（子屏覆盖层在导航后由用户返回键收起）。
  const [trashOpen, setTrashOpen] = useState(false);
  const [pomodoroSubView, setPomodoroSubView] = useState<PomodoroSubView | null>(null);
  // 桌面端内联回收站视图（侧栏点击后主内容区切换，经共享 store 协调）
  const desktopTrashOpen = useTodoTrashView((s) => s.isOpen);
  const closeDesktopTrash = useTodoTrashView((s) => s.close);
  const reloadGuardRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // 自动化视图的移动端顶栏动作（≤2 契约）：页内标题栏在移动壳下隐藏
  // （TodoAutomationWorkspace hideHeader），刷新 / 新建上移统一顶栏。
  // 新建复用 requestAutomationCreate 共享入口（工作区消费，与命令面板同路径，
  // 内部另有满容量兜底）；容量门禁与工作区页内按钮同一判定。
  const automationCount = useAutomationStore((s) => s.count);
  const automationMax = useAutomationStore((s) => s.max);
  const automationCapacityFull = automationMax > 0 && automationCount >= automationMax;
  const [automationRefreshing, setAutomationRefreshing] = useState(false);
  const handleAutomationRefresh = useCallback(() => {
    setAutomationRefreshing(true);
    void Promise.resolve(useAutomationStore.getState().refresh())
      .finally(() => setAutomationRefreshing(false));
  }, []);

  // Workbench 窄窗双导航防御：窗口化承载（TodoAppWindow）已自带
  // WorkbenchSidebarLayout 的 compact 抽屉导航；此时若视口恰好 <768px，
  // 页内再启用 MobileSlidingLayout 会出现「窗口抽屉 + 页内滑动侧栏」双导航。
  // 通过 data-wb-sys-app 祖先判定（挂载后布局前完成，无闪烁），
  // 在 Workbench 窗内强制走桌面分支。
  // 三态：null = 尚未检测（首次 commit）。useMobileHeader 只在判定为
  // 独立视图（=== false）后启用，窗口化实例连首帧都不会往共享的
  // 'todo' viewId 写入顶栏配置（见下方 useMobileHeader 的 enabled 参数）。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [inWorkbenchWindow, setInWorkbenchWindow] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    setInWorkbenchWindow(Boolean(rootRef.current?.closest('[data-wb-sys-app]')));
  }, []);
  const useMobileLayout = isSmallScreen && !inWorkbenchWindow;

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (initialView) setWorkspaceView(initialView);
  }, [initialView, setWorkspaceView]);

  // AI / agent 写库后 todo://changed：经 domainEvents 统一订阅（去重复 listen）
  // 详情面板编辑中（焦点在 data-todo-detail-panel）则延迟到 blur 再 reload
  useEffect(() => {
    reloadGuardRef.current = { cancelled: false };
    const signal = reloadGuardRef.current;
    const unlisten = registerDomainListener('todo://changed', () => {
      scheduleTodoReload(signal);
    });
    return () => {
      signal.cancelled = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    if (todoListId && todoListId !== activeListId) {
      // workbench payload 指定清单时确保内容区不停留在回收站视图
      closeDesktopTrash();
      if (filter.view !== 'all') {
        setActiveList(todoListId);
        setViewFilter('all');
        return;
      }
      setActiveList(todoListId);
    }
  }, [todoListId, activeListId, filter.view, setActiveList, setViewFilter, closeDesktopTrash]);

  // 计算当前视图标题（移动端顶栏用）
  const activeList = lists.find((l) => l.id === activeListId);
  const headerTitle = (() => {
    if (workspaceView === 'automations') return t('todo:automation.title', '定时任务');
    switch (filter.view) {
      case 'today': return t('todo:views.today');
      case 'upcoming': return t('todo:views.upcoming');
      case 'matrix': return t('todo:views.matrix');
      case 'overdue': return t('todo:views.overdue');
      case 'completed': return t('todo:views.completed');
      default: return activeList?.title || t('todo:views.inbox');
    }
  })();

  // 移动端详情子屏是否打开（与 TodoMainPanel 内的覆盖层同一判定）
  const mobileDetailItem = workspaceView === 'todos' && useMobileLayout
    ? items.find((item) => item.id === selectedItemId) ?? null
    : null;
  const mobileDetailOpen = Boolean(mobileDetailItem);

  // 子层级打开时统一顶栏切返回箭头（契约 1）；层级优先级与视觉堆叠一致
  const headerConfig = (() => {
    if (useMobileLayout) {
      if (trashOpen) {
        return {
          title: t('todo:trash.title'),
          showBackArrow: true,
          onMenuClick: () => setTrashOpen(false),
        };
      }
      if (pomodoroSubView === 'settings') {
        return {
          title: t('todo:pomodoro.settings.title'),
          showBackArrow: true,
          onMenuClick: () => setPomodoroSubView(null),
        };
      }
      if (pomodoroSubView === 'stats') {
        return {
          title: t('todo:pomodoro.statsPopover.title'),
          showBackArrow: true,
          onMenuClick: () => setPomodoroSubView(null),
        };
      }
      if (mobileDetailOpen) {
        return {
          title: mobileDetailItem?.title || t('todo:detail.title'),
          showBackArrow: true,
          onMenuClick: () => selectItem(null),
        };
      }
    }
    return {
      title: headerTitle,
      showMenu: true,
      onMenuClick: () => setSidebarOpen(true),
      // 自动化视图：页内标题栏在移动壳下隐藏，刷新 / 新建收进统一顶栏右侧
      ...(workspaceView === 'automations'
        ? {
          rightActions: (
            <>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                aria-label={t('common:actions.refresh')}
                disabled={automationRefreshing}
                onClick={handleAutomationRefresh}
              >
                <ArrowsClockwise
                  size={18}
                  className={cn(automationRefreshing && 'animate-spin motion-reduce:animate-none')}
                />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                aria-label={t('todo:automation.new')}
                disabled={automationCapacityFull}
                onClick={() => requestAutomationCreate()}
              >
                <Plus size={18} />
              </DsButton>
            </>
          ),
        }
        : {}),
    };
  })();

  // enabled = 仅独立 todo 视图写顶栏：窗口化承载（TodoAppWindow）与独立视图
  // 共用 'todo' viewId，窗口实例若也写入会覆盖独立视图的配置、卸载时还会
  // 误清其缓存（挂错实例的 onMenuClick，汉堡菜单失灵）。检测未完成（null）
  // 一并视为禁用，避免首次 commit 抢写；判定落定由 deps 里的
  // inWorkbenchWindow 触发补写（useLayoutEffect 链在首帧绘制前完成，无闪烁）。
  useMobileHeader(
    'todo',
    headerConfig,
    [
      headerTitle, useMobileLayout, trashOpen, pomodoroSubView, mobileDetailOpen,
      mobileDetailItem?.title, inWorkbenchWindow,
      workspaceView, automationRefreshing, automationCapacityFull,
    ],
    inWorkbenchWindow === false,
  );

  // ===== 移动端：MobileSlidingLayout =====
  if (useMobileLayout) {
    return (
      <div
        ref={rootRef}
        className={cn(
          'study-shell-page relative flex h-full w-full flex-col overflow-hidden',
          className,
        )}
      >
        <MobileSlidingLayout
          sidebar={
            <div className="min-h-0">
              <TodoSidebar
                onItemSelect={() => setSidebarOpen(false)}
                onOpenTrash={() => {
                  setSidebarOpen(false);
                  setTrashOpen(true);
                }}
              />
            </div>
          }
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
          sidebarWidth="auto"
          enableGesture
          threshold={0.3}
          showContentOverlay
          className="flex-1"
        >
          {workspaceView === 'automations'
            ? <TodoAutomationWorkspace hideHeader />
            : <TodoMainPanel onOpenPomodoroSubView={setPomodoroSubView} />}
        </MobileSlidingLayout>

        {/* 回收站 inline 子屏（全屏覆盖 + 系统返回键 + 顶栏返回箭头） */}
        <MobileDetailOverlay open={trashOpen} onClose={() => setTrashOpen(false)}>
          <TodoTrashScreen className="w-full" />
        </MobileDetailOverlay>

        {/* 番茄钟设置 / 统计 inline 子屏（替代桌面锚定弹层，符合移动端弹层契约） */}
        <MobileDetailOverlay
          open={pomodoroSubView !== null}
          onClose={() => setPomodoroSubView(null)}
        >
          <div className="flex h-full w-full flex-col bg-[color:var(--surface-root)]">
            <CustomScrollArea
              className="min-h-0 flex-1"
              viewportClassName="px-5 py-4"
            >
              {pomodoroSubView === 'stats' ? (
                <PomodoroStatsContent showTitle={false} />
              ) : (
                <PomodoroSettingsContent size="md" />
              )}
            </CustomScrollArea>
          </div>
        </MobileDetailOverlay>
      </div>
    );
  }

  // ===== 桌面端：仅主面板（侧边栏已移至 Shell 导航位置） =====
  // 回收站为内联视图优先级最高（侧栏点击切换，带返回）。
  // 三态切换（trash > automations > todos）经 AnimatePresence 转场：
  // 旧视图 100ms 淡出，新视图 150ms 淡入 + 8px 上移（tweenFast 与
  // CSS --ease-standard 同曲线；motionSafe 在 reduced-motion 下瞬时完成）。
  const desktopMode = desktopTrashOpen
    ? 'trash'
    : workspaceView === 'automations'
      ? 'automations'
      : 'todos';
  return (
    <div
      ref={rootRef}
      className={cn(
        'study-shell-page flex h-full w-full overflow-hidden',
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={desktopMode}
          className="flex h-full w-full min-w-0"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: motionSafe(tweenFast) }}
          exit={{ opacity: 0, y: -4, transition: motionSafe({ ...tweenFast, duration: 0.1 }) }}
        >
          {desktopMode === 'trash' ? (
            <TodoTrashWorkspace titlebarPortalTarget={titlebarPortalTarget} />
          ) : desktopMode === 'automations' ? (
            <TodoAutomationWorkspace titlebarPortalTarget={titlebarPortalTarget} />
          ) : (
            <TodoMainPanel titlebarPortalTarget={titlebarPortalTarget} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};
