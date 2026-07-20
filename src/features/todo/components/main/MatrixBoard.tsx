/**
 * MatrixBoard — 四象限视图（Eisenhower Matrix）
 *
 * 支持把任务拖到其他象限：
 * - 重要轴 → 调整优先级（提为 high / 降为 medium）
 * - 紧急轴 → 调整到期日（设为今天 / 移除已到期日期）
 * 拖放释放时通过 updateItem 落库，象限归类随 store 刷新自动更新。
 *
 * 拖拽手感：DragOverlay 拖影（轻微倾斜 + 浮起阴影 + 弹性落点归位），
 * 原位行拖起后降透明度占位；目标象限 hover 时主色高亮 + 「放到这里」提示。
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
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
import '../../styles/todo-motion.css';

const QUADRANT_ACCENTS: Record<EisenhowerQuadrant, string> = {
  urgentImportant: 'text-[color:hsl(var(--destructive))]',
  importantNotUrgent: 'text-[color:hsl(var(--warning))]',
  urgentNotImportant: 'text-[color:hsl(var(--info))]',
  neither: 'text-muted-foreground',
};

/** 象限头部极淡着色条（深浅色模式均用 /[0.06] 透明底，不喧宾夺主） */
const QUADRANT_HEADER_TINTS: Record<EisenhowerQuadrant, string> = {
  urgentImportant: 'bg-[color:hsl(var(--destructive))]/[0.06]',
  importantNotUrgent: 'bg-[color:hsl(var(--warning))]/[0.06]',
  urgentNotImportant: 'bg-[color:hsl(var(--info))]/[0.06]',
  neither: 'bg-[color:var(--interactive-hover)]',
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
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
  });
  return (
    // 拖影由 DragOverlay 渲染；原位行只降透明度作占位提示，不再自身位移
    <div ref={setNodeRef} {...listeners} className={cn(isDragging && 'opacity-30')}>
      {children}
    </div>
  );
};

const QuadrantCell: React.FC<{
  quadrant: EisenhowerQuadrant;
  count: number;
  /** 当前有拖拽在途（用于弱提示所有可放置区域） */
  dragActive: boolean;
  children: React.ReactNode;
}> = ({ quadrant, count, dragActive, children }) => {
  const { t } = useTranslation(['todo']);
  const { setNodeRef, isOver } = useDroppable({ id: quadrant });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-h-[180px] flex-col overflow-hidden rounded-[var(--radius-shell-control)] border bg-[color:var(--surface-raised,transparent)]',
        'transition-[border-color,background-color,box-shadow] duration-150',
        isOver
          ? 'border-[color:hsl(var(--primary))]/60 bg-[color:var(--interactive-hover)] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
          : dragActive
          ? 'border-dashed border-[color:var(--border-default)]'
          : 'border-[color:var(--border-default)]/60',
      )}
    >
      <div className={cn('flex items-center gap-2 px-3 py-2', QUADRANT_HEADER_TINTS[quadrant])}>
        <span className={cn('text-xs font-semibold', QUADRANT_ACCENTS[quadrant])}>
          {t(`todo:matrix.${quadrant}`)}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground/50">{count}</span>
        {isOver && (
          <span className="ui-rise-in ml-auto text-xs font-medium text-[color:hsl(var(--primary))]">
            {t('todo:matrix.dropHere', { defaultValue: '放到这里' })}
          </span>
        )}
      </div>
      {children}
    </div>
  );
};

interface MatrixBoardProps {
  quadrants: Record<EisenhowerQuadrant, TodoItem[]>;
  selectedItemId: string | null;
  focusedItemId: string | null;
  /** 批量多选集合（与列表视图共用同一选择编排） */
  checkedIds?: ReadonlySet<string>;
  onCheckToggle?: (id: string, opts: { shift: boolean }) => void;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export const MatrixBoard: React.FC<MatrixBoardProps> = ({
  quadrants,
  selectedItemId,
  focusedItemId,
  checkedIds,
  onCheckToggle,
  onToggle,
  onSelect,
  onDelete,
  onRename,
}) => {
  const { t } = useTranslation(['todo']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const sensors = useTouchFriendlyDndSensors();
  const [activeItem, setActiveItem] = useState<TodoItem | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const item = EISENHOWER_QUADRANTS.flatMap((q) => quadrants[q]).find(
        (i) => i.id === String(event.active.id),
      );
      setActiveItem(item ?? null);
    },
    [quadrants],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItem(null);
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
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveItem(null)}
    >
      <div className="grid grid-cols-1 gap-3 p-4 sm:p-6 lg:grid-cols-2">
        {EISENHOWER_QUADRANTS.map((quadrant) => {
          const quadItems = quadrants[quadrant];
          return (
            <QuadrantCell
              key={quadrant}
              quadrant={quadrant}
              count={quadItems.length}
              dragActive={activeItem !== null}
            >
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
                        isChecked={checkedIds?.has(item.id) ?? false}
                        onCheckToggle={onCheckToggle}
                      />
                    </DraggableMatrixRow>
                  ))
                )}
              </div>
            </QuadrantCell>
          );
        })}
      </div>

      {/* 拖影：轻微倾斜 + 浮起阴影；落点用签名缓动做弹性归位 */}
      <DragOverlay
        dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
      >
        {activeItem && (
          <div className="todo-matrix-drag-ghost">
            <TodoItemRow
              item={activeItem}
              onToggle={() => {}}
              onSelect={() => {}}
              onDelete={() => {}}
              isSelected={false}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
};
