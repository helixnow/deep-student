/**
 * TodoContentView - 待办列表主视图
 *
 * DSTU EditorWrapper 懒加载的入口组件。
 * 包含侧边栏列表选择 + 主内容区域。
 */

import React, { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTodoStore } from './useTodoStore';
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
  const { initialize, setActiveList, activeListId } = useTodoStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (todoListId && todoListId !== activeListId) {
      setActiveList(todoListId);
    }
  }, [todoListId, activeListId, setActiveList]);

  return (
    <div className={cn('flex h-full w-full overflow-hidden bg-background', className)}>
      <TodoSidebar />
      <TodoMainPanel />
    </div>
  );
};
