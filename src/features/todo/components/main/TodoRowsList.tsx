/**
 * TodoRowsList — 待办行列表渲染器
 *
 * - 常规规模：普通渲染 + AnimatedListRow 进出场动画（新增展开/删除收合）
 * - 大列表（> 100 行）：@tanstack/react-virtual 虚拟化，动态高度测量
 * - 键盘导航焦点行自动滚动到可见区域
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatedListRow } from '@/components/ui/AnimatedListRow';
import type { TodoItem } from '../../types';
import { TodoItemRow } from './TodoItemRow';

export interface TodoRowSpec {
  item: TodoItem;
  depth?: number;
  subtaskProgress?: { done: number; total: number };
}

const VIRTUALIZE_THRESHOLD = 100;
/** 单行估算高度（标题行 + 元数据行），实际以 measureElement 动态测量为准 */
const ESTIMATED_ROW_HEIGHT = 58;

interface TodoRowsListProps {
  rows: TodoRowSpec[];
  /** 外层 ScrollArea 的 viewport（虚拟化滚动容器） */
  scrollElement: HTMLElement | null;
  selectedItemId: string | null;
  focusedItemId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

const VirtualRows: React.FC<TodoRowsListProps & { scrollElement: HTMLElement }> = ({
  rows,
  scrollElement,
  selectedItemId,
  focusedItemId,
  onToggle,
  onSelect,
  onDelete,
  onRename,
}) => {
  // 列表上方还有快速添加栏等内容：把列表容器相对滚动容器的偏移
  // 告知虚拟化器，可见范围计算才准确
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setScrollMargin(
      container.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop,
    );
  }, [scrollElement]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => rows[index]?.item.id ?? index,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
  });

  // 键盘导航：焦点行不在视口内时滚动过去（虚拟化下 DOM 里可能还没有该行）。
  // rows 用 ref 读取：数据刷新不应把视口拉回焦点行，只有焦点变化才滚动
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  useEffect(() => {
    if (!focusedItemId) return;
    const index = rowsRef.current.findIndex((r) => r.item.id === focusedItemId);
    if (index >= 0) virtualizerRef.current.scrollToIndex(index, { align: 'auto' });
  }, [focusedItemId]);

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full border-b border-border/[0.08]"
            style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
          >
            <TodoItemRow
              item={row.item}
              depth={row.depth}
              subtaskProgress={row.subtaskProgress}
              onToggle={onToggle}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              isSelected={selectedItemId === row.item.id}
              isFocused={focusedItemId === row.item.id}
            />
          </div>
        );
      })}
    </div>
  );
};

export const TodoRowsList: React.FC<TodoRowsListProps> = (props) => {
  const { rows, scrollElement } = props;
  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD && Boolean(scrollElement);

  // AnimatePresence 需要稳定 key；行 id 天然稳定
  const plain = useMemo(
    () => (
      <div className="flex flex-col divide-y divide-border/[0.08]">
        <AnimatePresence initial={false}>
          {rows.map((row) => (
            <AnimatedListRow key={row.item.id}>
              <TodoItemRow
                item={row.item}
                depth={row.depth}
                subtaskProgress={row.subtaskProgress}
                onToggle={props.onToggle}
                onSelect={props.onSelect}
                onDelete={props.onDelete}
                onRename={props.onRename}
                isSelected={props.selectedItemId === row.item.id}
                isFocused={props.focusedItemId === row.item.id}
              />
            </AnimatedListRow>
          ))}
        </AnimatePresence>
      </div>
    ),
    [rows, props.onToggle, props.onSelect, props.onDelete, props.onRename, props.selectedItemId, props.focusedItemId],
  );

  if (shouldVirtualize && scrollElement) {
    return <VirtualRows {...props} scrollElement={scrollElement} />;
  }
  return plain;
};
