/**
 * 排序题作答组件：拖拽 + 上下移按钮
 *
 * - 桌面端 HTML5 拖拽排序；移动端/触屏用上下移按钮（≥44px 命中区）
 * - 提交后逐项揭示：位置正确绿色、错误红色，并展示正确顺序对照
 *
 * 2026-07 题库题型扩展
 */

import React, { useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Check, X, CaretUp, CaretDown, DotsSixVertical } from '@phosphor-icons/react';
import { LatexText } from '@/components/LatexText';
import type { OrderingStructuredData } from './structured';

export interface OrderingAnswerProps {
  data: OrderingStructuredData;
  /** 当前排列（item key 数组） */
  order: string[];
  onChange: (order: string[]) => void;
  /** 已提交：禁用交互并进入揭示态 */
  submitted?: boolean;
  className?: string;
}

export const OrderingAnswer: React.FC<OrderingAnswerProps> = ({
  data,
  order,
  onChange,
  submitted = false,
  className,
}) => {
  const { t } = useTranslation('practice');
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const contentByKey = useMemo(() => {
    const map = new Map<string, string>();
    data.items.forEach((item) => map.set(item.key, item.content));
    return map;
  }, [data.items]);

  const hasCorrectOrder = data.correct_order.length > 0;

  const move = useCallback((from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }, [order, onChange]);

  const handleDragStart = useCallback((index: number) => (e: React.DragEvent) => {
    dragIndexRef.current = index;
    setDraggingIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 需要 setData 才会触发 drag
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from !== null) move(from, index);
    dragIndexRef.current = null;
    setDragOverIndex(null);
    setDraggingIndex(null);
  }, [move]);

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
    setDraggingIndex(null);
  }, []);

  return (
    <div className={cn('space-y-3', className)}>
      {!submitted && (
        <p className="text-xs text-muted-foreground">{t('editor.ordering.instruction')}</p>
      )}

      <ol className="space-y-1.5">
        {order.map((key, index) => {
          const isCorrectPosition = submitted && hasCorrectOrder
            ? data.correct_order[index] === key
            : null;
          return (
            <li
              key={key}
              draggable={!submitted}
              onDragStart={handleDragStart(index)}
              onDragOver={handleDragOver(index)}
              onDrop={handleDrop(index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex min-h-[44px] items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                !submitted && 'cursor-grab active:cursor-grabbing bg-card/40 border-border/50 hover:border-foreground/25',
                draggingIndex === index && 'opacity-40',
                dragOverIndex === index && draggingIndex !== index && 'border-primary/60 bg-primary/[0.06]',
                isCorrectPosition === true && 'border-success/60 bg-success/[0.08] dark:bg-success/[0.15]',
                isCorrectPosition === false && 'border-destructive/50 bg-destructive/[0.08] dark:bg-destructive/[0.15] qbank-anim-shake',
                submitted && isCorrectPosition === null && 'border-border/40'
              )}
            >
              {/* 序号 / 揭示图标 */}
              <span
                className={cn(
                  'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  isCorrectPosition === true && 'bg-success text-success-foreground qbank-anim-pop',
                  isCorrectPosition === false && 'bg-destructive text-white',
                  isCorrectPosition === null && 'border border-foreground/[0.16] text-foreground/65'
                )}
              >
                {isCorrectPosition === true ? (
                  <Check size={13} weight="bold" />
                ) : isCorrectPosition === false ? (
                  <X size={13} />
                ) : (
                  index + 1
                )}
              </span>

              <LatexText
                content={contentByKey.get(key) || key}
                className="min-w-0 flex-1 text-sm leading-relaxed"
              />

              {!submitted && (
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                    aria-label={t('editor.ordering.moveUp')}
                    className="!h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground"
                  >
                    <CaretUp size={14} />
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    disabled={index === order.length - 1}
                    onClick={() => move(index, index + 1)}
                    aria-label={t('editor.ordering.moveDown')}
                    className="!h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground"
                  >
                    <CaretDown size={14} />
                  </NotionButton>
                  {/* 拖拽把手（仅视觉提示，整行可拖） */}
                  <DotsSixVertical
                    size={16}
                    className="ml-0.5 hidden text-muted-foreground/50 sm:block"
                    aria-hidden
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* 提交后：正确顺序对照（有错位时展示） */}
      {submitted && hasCorrectOrder && order.some((key, i) => data.correct_order[i] !== key) && (
        <div className="ui-rise-in space-y-1.5 rounded-md border border-success/30 bg-success/[0.05] p-2.5">
          <div className="text-xs font-medium text-success">{t('editor.ordering.correctOrder')}</div>
          <ol className="space-y-1">
            {data.correct_order.map((key, index) => (
              <li key={key} className="flex items-center gap-2 text-sm">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-success/15 text-[11px] font-medium text-success">
                  {index + 1}
                </span>
                <LatexText content={contentByKey.get(key) || key} className="min-w-0 text-foreground/80" />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
};

export default OrderingAnswer;
