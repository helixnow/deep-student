/**
 * MatrixBoard — 四象限视图（Eisenhower Matrix）
 *
 * 支持把任务拖到其他象限：
 * - 重要轴 → 调整优先级（提为 high / 降为 medium）
 * - 紧急轴 → 调整到期日（设为今天 / 移除已到期日期）
 * 拖放释放时通过 updateItem 落库，象限归类随 store 刷新自动更新。
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  pointerWithin,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import {
  useTouchFriendlyDndSensors,
  SHELL_SAFE_AUTO_SCROLL,
} from '@/hooks/useTouchFriendlyDndSensors';
import { useTodoStore } from '../../stores/useTodoStore';
import type { EisenhowerQuadrant, TodoItem, UpdateTodoItemInput } from '../../types';
import { EISENHOWER_QUADRANTS, localToday } from '../../types';
import { TodoItemRow } from './TodoItemRow';

const QUADRANT_ACCENTS: Record<EisenhowerQuadrant, string> = {
  urgentImportant: 'text-[color:hsl(var(--destructive))]',
  importantNotUrgent: 'text-[color:hsl(var(--warning))]',
  urgentNotImportant: 'text-[color:hsl(var(--info))]',
  neither: 'text-muted-foreground',
};

/** 拖到目标象限时需要落库的字段变更；已在该象限则返回 null */
export function quadrantDropChanges(
  item: TodoItem,
  quadrant: EisenhowerQuadrant,
  today: string = localToday(),
): UpdateTodoItemInput | null {
  const wantImportant =
    quadrant === 'urgentImportant' || quadrant === 'importantNotUrgent';
  const wantUrgent = quadrant === 'urgentImportant' || quadrant === 'urgentNotImportant';
  const isImportant = item.priority === 'high' || item.priority === 'urgent';
  const isUrgent = Boolean(item.dueDate) && (item.dueDate as string) <= today;

  const changes: UpdateTodoItemInput = { id: item.id };
  let changed = false;
  if (wantImportant && !isImportant) {
    changes.priority = 'high';
    changed = true;
  }
  if (!wantImportant && isImportant) {
    changes.priority = 'medium';
    changed = true;
  }
  if (wantUrgent && !isUrgent) {
    changes.dueDate = today;
    changed = true;
  }
  if (!wantUrgent && isUrgent) {
    changes.dueDate = '';
    changed = true;
  }
  return changed ? changes : null;
}

const DraggableMatrixRow: React.FC<{
  item: TodoItem;
  children: React.ReactNode;
}> = ({ item, children }) => {
  // 有意不铺开 attributes（tabIndex/role）：矩阵行的键盘操作走面板级 j/k 导航，
  // 避免每行成为 Tab 停靠点并让 Enter 被 KeyboardSensor 劫持成拖拽
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={cn(isDragging && 'relative z-10 opacity-70 shadow-lg')}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      {children}
    </div>
  );
};

const QuadrantCell: React.FC<{
  quadrant: EisenhowerQuadrant;
  count: number;
  children: React.ReactNode;
}> = ({ quadrant, count, children }) => {
  const { t } = useTranslation(['todo']);
  const { setNodeRef, isOver } = useDroppable({ id: quadrant });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-h-[180px] flex-col rounded-[var(--radius-shell-control)] border bg-[color:var(--surface-raised,transparent)]',
        'transition-colors duration-150',
        isOver
          ? 'border-[color:hsl(var(--primary))]/50 bg-[color:var(--interactive-hover)]'
          : 'border-[color:var(--border-default)]/60',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn('text-xs font-semibold', QUADRANT_ACCENTS[quadrant])}>
          {t(`todo:matrix.${quadrant}`)}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/50">{count}</span>
      </div>
      {children}
    </div>
  );
};

interface MatrixBoardProps {
  quadrants: Record<EisenhowerQuadrant, TodoItem[]>;
  selectedItemId: string | null;
  focusedItemId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export const MatrixBoard: React.FC<MatrixBoardProps> = ({
  quadrants,
  selectedItemId,
  focusedItemId,
  onToggle,
  onSelect,
  onDelete,
  onRename,
}) => {
  const { t } = useTranslation(['todo']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const sensors = useTouchFriendlyDndSensors();

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const quadrant = over.id as EisenhowerQuadrant;
      if (!EISENHOWER_QUADRANTS.includes(quadrant)) return;
      const item = EISENHOWER_QUADRANTS.flatMap((q) => quadrants[q]).find(
        (i) => i.id === String(active.id),
      );
      if (!item) return;
      const changes = quadrantDropChanges(item, quadrant);
      if (changes) void updateItem(changes);
    },
    [quadrants, updateItem],
  );

  return (
    <DndContext
      sensors={sensors}
      autoScroll={SHELL_SAFE_AUTO_SCROLL}
      collisionDetection={pointerWithin}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 gap-3 p-4 sm:p-6 lg:grid-cols-2">
        {EISENHOWER_QUADRANTS.map((quadrant) => {
          const quadItems = quadrants[quadrant];
          return (
            <QuadrantCell key={quadrant} quadrant={quadrant} count={quadItems.length}>
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/[0.08]">
                {quadItems.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center py-6 text-xs text-muted-foreground/40">
                    {t('todo:matrix.empty')}
                  </div>
                ) : (
                  quadItems.map((item) => (
                    <DraggableMatrixRow key={item.id} item={item}>
                      <TodoItemRow
                        item={item}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        onDelete={onDelete}
                        onRename={onRename}
                        isSelected={selectedItemId === item.id}
                        isFocused={focusedItemId === item.id}
                      />
                    </DraggableMatrixRow>
                  ))
                )}
              </div>
            </QuadrantCell>
          );
        })}
      </div>
    </DndContext>
  );
};
