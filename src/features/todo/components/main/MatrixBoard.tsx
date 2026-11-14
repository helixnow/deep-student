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

/** 象限头部 6px 语义微圆点（替代整条彩色底纹，保持 Things 3 / Linear 极简克制） */
const QUADRANT_DOTS: Record<EisenhowerQuadrant, string> = {
  urgentImportant: 'bg-[color:hsl(var(--destructive))]',
  importantNotUrgent: 'bg-[color:hsl(var(--warning))]',
  urgentNotImportant: 'bg-[color:hsl(var(--info))]',
  neither: 'bg-muted-foreground/45',
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
  index: number;
  count: number;
  /** 当前有拖拽在途（用于弱提示所有可放置区域） */
  dragActive: boolean;
  children: React.ReactNode;
}> = ({ quadrant, index, count, dragActive, children }) => {
  const { t } = useTranslation(['todo']);
  const { setNodeRef, isOver } = useDroppable({ id: quadrant });
  return (
    <div
      ref={setNodeRef}
      data-todo-quadrant={quadrant}
      className={cn(
        'flex min-h-[150px] min-w-0 flex-col overflow-hidden bg-transparent md:min-h-0',
        'transition-[background-color,box-shadow] duration-150',
        // 1px 十字分割线：小屏纵向逐块底线，宽屏 2x2 十字线
        index < 3 && 'border-b border-[color:var(--border-default)]/35',
        index >= 2 && 'md:border-b-0',
        index % 2 === 0 && 'md:border-r md:border-[color:var(--border-default)]/35',
        isOver
          ? 'bg-[color:var(--interactive-hover)] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
          : dragActive && 'bg-foreground/[0.015]',
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <span
          aria-hidden="true"
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', QUADRANT_DOTS[quadrant])}
        />
        <span className="text-xs font-medium text-foreground/85">
          {t(`todo:matrix.${quadrant}`)}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground/55">{count}</span>
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
  /** 触屏批量多选模式（行首显复选框、点行即勾选） */
  checkMode?: boolean;
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
  checkMode,
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
      <div data-todo-matrix="" className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto border-t border-[color:var(--border-default)]/35 pb-[var(--keyboard-inset,0px)] md:grid-cols-2 md:grid-rows-2 md:overflow-hidden">
        {EISENHOWER_QUADRANTS.map((quadrant, index) => {
          const quadItems = quadrants[quadrant];
          return (
            <QuadrantCell
              key={quadrant}
              quadrant={quadrant}
              index={index}
              count={quadItems.length}
              dragActive={activeItem !== null}
            >
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/[0.08] md:overflow-y-auto">
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
                        checkMode={checkMode}
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
