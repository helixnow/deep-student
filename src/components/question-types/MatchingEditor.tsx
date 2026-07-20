/**
 * 匹配题编辑器：左右列条目编辑 + 标准答案配对
 *
 * - 左右两列各自增删条目（key 自动生成 L1.. / R1..）
 * - 每个左列条目通过下拉选择其标准配对的右列条目
 *
 * 2026-07 题库题型扩展
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { AppSelect } from '@/components/ui/app-menu';
import { Plus, X, ArrowRight } from '@phosphor-icons/react';
import type { StructuredItem, MatchingPair } from './structured';

export interface MatchingEditorValue {
  left: StructuredItem[];
  right: StructuredItem[];
  pairs: MatchingPair[];
}

export interface MatchingEditorProps {
  value: MatchingEditorValue;
  onChange: (value: MatchingEditorValue) => void;
  className?: string;
}

const MAX_ITEMS = 12;

function nextKey(prefix: 'L' | 'R', items: StructuredItem[]): string {
  let n = items.length + 1;
  while (items.some((item) => item.key === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export const MatchingEditor: React.FC<MatchingEditorProps> = ({ value, onChange, className }) => {
  const { t } = useTranslation('practice');

  const updateSide = useCallback((side: 'left' | 'right', items: StructuredItem[]) => {
    const validKeys = new Set(items.map((item) => item.key));
    // 删除条目时同步清掉引用它的配对
    const pairs = value.pairs.filter((pair) =>
      side === 'left' ? validKeys.has(pair.left) : validKeys.has(pair.right)
    );
    onChange({ ...value, [side]: items, pairs });
  }, [value, onChange]);

  const handleItemChange = useCallback((side: 'left' | 'right', index: number, content: string) => {
    const items = [...value[side]];
    items[index] = { ...items[index], content };
    onChange({ ...value, [side]: items });
  }, [value, onChange]);

  const handleAdd = useCallback((side: 'left' | 'right') => {
    const items = value[side];
    if (items.length >= MAX_ITEMS) return;
    updateSide(side, [...items, { key: nextKey(side === 'left' ? 'L' : 'R', items), content: '' }]);
  }, [value, updateSide]);

  const handleRemove = useCallback((side: 'left' | 'right', index: number) => {
    updateSide(side, value[side].filter((_, i) => i !== index));
  }, [value, updateSide]);

  const handlePairChange = useCallback((leftKey: string, rightKey: string) => {
    // 一对一约束：先移除该左项与该右项的旧配对
    const pairs = value.pairs.filter((p) => p.left !== leftKey && (rightKey === '__none__' || p.right !== rightKey));
    if (rightKey !== '__none__') pairs.push({ left: leftKey, right: rightKey });
    onChange({ ...value, pairs });
  }, [value, onChange]);

  const renderColumn = (side: 'left' | 'right') => {
    const items = value[side];
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {side === 'left' ? t('editor.matching.leftColumn') : t('editor.matching.rightColumn')}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => handleAdd(side)}
            disabled={items.length >= MAX_ITEMS}
            className="ui-press h-5 px-1.5 text-[10px]"
          >
            <Plus size={10} className="mr-0.5" />
            {t('editor.structEdit.addItem')}
          </DsButton>
        </div>
        {items.map((item, index) => (
          <div
            key={item.key}
            className="group flex min-h-8 items-center gap-1.5 rounded-md border border-border/40 bg-muted/10 px-1.5 transition-colors hover:border-border/70"
          >
            <span className="w-6 flex-shrink-0 text-center text-[10px] font-semibold text-muted-foreground">
              {item.key}
            </span>
            <Input
              value={item.content}
              onChange={(e) => handleItemChange(side, index, e.target.value)}
              placeholder={`${item.key} ...`}
              className="min-w-0 flex-1 bg-transparent text-xs"
            />
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => handleRemove(side, index)}
              aria-label={t('editor.structEdit.removeItem')}
              className="!h-4 !w-4 !p-0 flex-shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:opacity-70"
            >
              <X size={10} />
            </DsButton>
          </div>
        ))}
        {items.length === 0 && (
          <p className="rounded-md border border-dashed border-border/40 px-2 py-2 text-center text-xs text-muted-foreground/60">
            {t('editor.structEdit.emptyItems')}
          </p>
        )}
      </div>
    );
  };

  const rightOptions = [
    { value: '__none__', label: t('editor.structEdit.unpaired') },
    ...value.right.map((item) => ({
      value: item.key,
      label: item.content.trim() ? `${item.key} · ${item.content}` : item.key,
    })),
  ];

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        {renderColumn('left')}
        {renderColumn('right')}
      </div>

      {/* 标准答案配对：每个左项选择其正确的右项 */}
      {value.left.length > 0 && value.right.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('editor.structEdit.standardPairs')}
          </span>
          {value.left.map((item) => {
            const paired = value.pairs.find((p) => p.left === item.key);
            return (
              <div key={item.key} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border px-2 py-1.5 text-xs',
                    paired ? 'border-primary/40 bg-primary/[0.05]' : 'border-border/40 bg-muted/10'
                  )}
                >
                  <span className="flex-shrink-0 font-semibold text-muted-foreground">{item.key}</span>
                  <span className="truncate">{item.content || '…'}</span>
                </span>
                <ArrowRight size={12} className="flex-shrink-0 text-muted-foreground" aria-hidden />
                <div className="w-[45%] flex-shrink-0">
                  <AppSelect
                    value={paired?.right ?? '__none__'}
                    onValueChange={(v) => handlePairChange(item.key, v)}
                    options={rightOptions}
                    variant="outline"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MatchingEditor;
