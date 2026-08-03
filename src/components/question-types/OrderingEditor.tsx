/**
 * 排序题编辑器：条目编辑 + 正确顺序排列
 *
 * - 条目列表定义展示顺序（做题时按此呈现）
 * - "正确顺序"区用上下移按钮排列标准答案
 *
 * 2026-07 题库题型扩展
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Plus, X, CaretUp, CaretDown } from '@phosphor-icons/react';
import type { StructuredItem } from './structured';

export interface OrderingEditorValue {
  items: StructuredItem[];
  correctOrder: string[];
}

export interface OrderingEditorProps {
  value: OrderingEditorValue;
  onChange: (value: OrderingEditorValue) => void;
  className?: string;
}

const MAX_ITEMS = 12;
const ITEM_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function nextKey(items: StructuredItem[]): string {
  for (const ch of ITEM_KEYS) {
    if (!items.some((item) => item.key === ch)) return ch;
  }
  return `K${items.length + 1}`;
}

export const OrderingEditor: React.FC<OrderingEditorProps> = ({ value, onChange, className }) => {
  const { t } = useTranslation('practice');

  const handleItemChange = useCallback((index: number, content: string) => {
    const items = [...value.items];
    items[index] = { ...items[index], content };
    onChange({ ...value, items });
  }, [value, onChange]);

  const handleAdd = useCallback(() => {
    if (value.items.length >= MAX_ITEMS) return;
    const key = nextKey(value.items);
    onChange({
      items: [...value.items, { key, content: '' }],
      correctOrder: [...value.correctOrder, key],
    });
  }, [value, onChange]);

  const handleRemove = useCallback((index: number) => {
    const removed = value.items[index];
    onChange({
      items: value.items.filter((_, i) => i !== index),
      correctOrder: value.correctOrder.filter((key) => key !== removed.key),
    });
  }, [value, onChange]);

  const moveCorrect = useCallback((from: number, to: number) => {
    if (to < 0 || to >= value.correctOrder.length) return;
    const next = [...value.correctOrder];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ ...value, correctOrder: next });
  }, [value, onChange]);

  const contentByKey = new Map(value.items.map((item) => [item.key, item.content]));

  return (
    <div className={cn('space-y-3', className)}>
      {/* 条目列表 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('editor.structEdit.orderingItems')}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleAdd}
            disabled={value.items.length >= MAX_ITEMS}
            className="ui-press h-5 px-1.5 text-[10px] [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!px-3 [@media(pointer:coarse)]:text-xs"
          >
            <Plus size={10} className="mr-0.5" />
            {t('editor.structEdit.addItem')}
          </DsButton>
        </div>
        {value.items.map((item, index) => (
          <div
            key={item.key}
            className="group flex min-h-8 items-center gap-1.5 rounded-md border border-border/40 bg-muted/10 px-1.5 transition-colors hover:border-border/70"
          >
            <span className="w-5 flex-shrink-0 text-center text-[10px] font-semibold text-muted-foreground">
              {item.key}
            </span>
            <Input
              value={item.content}
              onChange={(e) => handleItemChange(index, e.target.value)}
              placeholder={`${item.key} ...`}
              className="min-w-0 flex-1 bg-transparent text-xs [@media(pointer:coarse)]:text-[16px]"
            />
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => handleRemove(index)}
              aria-label={t('editor.structEdit.removeItem')}
              className="!h-4 !w-4 !p-0 flex-shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:opacity-70"
            >
              <X size={10} />
            </DsButton>
          </div>
        ))}
        {value.items.length === 0 && (
          <p className="rounded-md border border-dashed border-border/40 px-2 py-2 text-center text-xs text-muted-foreground/60">
            {t('editor.structEdit.emptyItems')}
          </p>
        )}
      </div>

      {/* 正确顺序 */}
      {value.correctOrder.length > 1 && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('editor.ordering.correctOrder')}
          </span>
          {value.correctOrder.map((key, index) => (
            <div
              key={key}
              className="flex min-h-8 items-center gap-1.5 rounded-md border border-border/40 bg-muted/10 px-1.5"
            >
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">
                <span className="font-semibold text-muted-foreground">{key}</span>
                {contentByKey.get(key)?.trim() ? ` · ${contentByKey.get(key)}` : ''}
              </span>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                disabled={index === 0}
                onClick={() => moveCorrect(index, index - 1)}
                aria-label={t('editor.ordering.moveUp')}
                className="!h-6 !w-6 !p-0 flex-shrink-0 text-muted-foreground [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10"
              >
                <CaretUp size={12} />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                disabled={index === value.correctOrder.length - 1}
                onClick={() => moveCorrect(index, index + 1)}
                aria-label={t('editor.ordering.moveDown')}
                className="!h-6 !w-6 !p-0 flex-shrink-0 text-muted-foreground [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10"
              >
                <CaretDown size={12} />
              </DsButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default OrderingEditor;
