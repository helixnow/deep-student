/**
 * TodoContentView - 待办列表主视图
 *
 * 作为 Todo 页面的顶层壳体，负责：
 * - 套用应用统一的 study-shell-page 外壳
 * - 桌面端：仅渲染 TodoMainPanel（侧边栏已移至 Shell 导航位置，由 TodoShellSidebar 提供）
 * - 移动端：MobileSlidingLayout 手势滑动切换侧栏 / 主视图
 * - 注册 useMobileHeader，保持与其他页面一致的移动端顶栏
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MobileSlidingLayout, useMobileHeader } from '@/components/layout';
import { useTodoStore } from '../stores/useTodoStore';
import { TodoSidebar } from './TodoSidebar';
import { TodoMainPanel } from './TodoMainPanel';

interface TodoContentViewProps {
  todoListId?: string;
  className?: string;
}

export const TodoContentView: React.FC<TodoContentViewProps> = ({
  todoListId,
  className,
}) => {
  const { t } = useTranslation(['todo']);
  const { isSmallScreen } = useBreakpoint();
  const { initialize, setActiveList, setViewFilter, activeListId, filter, lists } = useTodoStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (todoListId && todoListId !== activeListId) {
      if (filter.view !== 'all') {
        setActiveList(todoListId);
        setViewFilter('all');
        return;
      }
      setActiveList(todoListId);
    }
  }, [todoListId, activeListId, filter.view, setActiveList, setViewFilter]);

  // 计算当前视图标题（移动端顶栏用）
  const activeList = lists.find((l) => l.id === activeListId);
  const headerTitle = (() => {
    switch (filter.view) {
      case 'today': return t('todo:views.today');
      case 'upcoming': return t('todo:views.upcoming');
      case 'overdue': return t('todo:views.overdue');
      case 'completed': return t('todo:views.completed');
      default: return activeList?.title || t('todo:views.inbox');
    }
  })();

  useMobileHeader(
    'todo',
    {
      title: headerTitle,
      showMenu: true,
      onMenuClick: () => setSidebarOpen(true),
    },
    [headerTitle],
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
            <div className="study-shell-sidebar-frame flex h-full flex-col">
              <TodoSidebar onItemSelect={() => setSidebarOpen(false)} />
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
          <TodoMainPanel />
        </MobileSlidingLayout>
      </div>
    );
  }

  // ===== 桌面端：仅主面板（侧边栏已移至 Shell 导航位置） =====
  return (
    <div
      className={cn(
        'study-shell-page flex h-full w-full overflow-hidden',
        className,
      )}
    >
      <TodoMainPanel />
    </div>
  );
};
