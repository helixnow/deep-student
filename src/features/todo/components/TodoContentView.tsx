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

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MobileSlidingLayout, useMobileHeader } from '@/components/layout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { PomodoroSettingsContent, PomodoroStatsContent } from '@/features/pomodoro';
import { registerDomainListener } from '@/features/workbench/agent/domainEvents';
import { useTodoStore } from '../stores/useTodoStore';
import { TodoSidebar } from './TodoSidebar';
import { TodoMainPanel, MobileDetailOverlay, type PomodoroSubView } from './TodoMainPanel';
import { TodoTrashScreen, TodoTrashWorkspace, useTodoTrashView } from './TodoTrashDialog';
import { TodoAutomationWorkspace } from './TodoAutomationWorkspace';

interface TodoContentViewProps {
  todoListId?: string;
  initialView?: 'todos' | 'automations';
  className?: string;
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
  };
  tryReload();
}

export const TodoContentView: React.FC<TodoContentViewProps> = ({
  todoListId,
  initialView,
  className,
}) => {
  const { t } = useTranslation(['todo']);
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
  // 移动端 inline 子屏（全屏替换中屏内容，返回走顶栏箭头 / Android 返回键）
  const [trashOpen, setTrashOpen] = useState(false);
  const [pomodoroSubView, setPomodoroSubView] = useState<PomodoroSubView | null>(null);
  // 桌面端内联回收站视图（侧栏点击后主内容区切换，经共享 store 协调）
  const desktopTrashOpen = useTodoTrashView((s) => s.isOpen);
  const closeDesktopTrash = useTodoTrashView((s) => s.close);
  const reloadGuardRef = useRef<{ cancelled: boolean }>({ cancelled: false });

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
  const mobileDetailOpen = workspaceView === 'todos' && isSmallScreen && items.some((i) => i.id === selectedItemId);

  // 子层级打开时统一顶栏切返回箭头（契约 1）；层级优先级与视觉堆叠一致
  const headerConfig = (() => {
    if (isSmallScreen) {
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
          title: t('todo:detail.title'),
          showBackArrow: true,
          onMenuClick: () => selectItem(null),
        };
      }
    }
    return {
      title: headerTitle,
      showMenu: true,
      onMenuClick: () => setSidebarOpen(true),
    };
  })();

  useMobileHeader(
    'todo',
    headerConfig,
    [headerTitle, isSmallScreen, trashOpen, pomodoroSubView, mobileDetailOpen],
  );

  // ===== 移动端：MobileSlidingLayout =====
  if (isSmallScreen) {
    return (
      <div
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
            ? <TodoAutomationWorkspace />
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
              viewportClassName="px-5 py-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))]"
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
  // 回收站为内联视图优先级最高（侧栏点击切换，带返回）
  return (
    <div
      className={cn(
        'study-shell-page flex h-full w-full overflow-hidden',
        className,
      )}
    >
      {desktopTrashOpen ? (
        <TodoTrashWorkspace />
      ) : workspaceView === 'automations' ? (
        <TodoAutomationWorkspace />
      ) : (
        <TodoMainPanel />
      )}
    </div>
  );
};
