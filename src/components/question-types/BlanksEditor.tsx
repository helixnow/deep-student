/**
 * 填空题增强编辑器：多空位、每空多可接受答案 + 匹配选项
 *
 * - 每个空位维护一组可接受答案（chip 形式，点击删除）
 * - 每空可独立配置大小写敏感 / 去首尾空格
 *
 * 2026-07 题库题型扩展
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Badge } from '@/components/ui/shad/Badge';
import { Plus, X, Trash } from '@phosphor-icons/react';
import type { FillBlankSpec } from './structured';

export interface BlanksEditorProps {
  blanks: FillBlankSpec[];
  onChange: (blanks: FillBlankSpec[]) => void;
  className?: string;
}

const MAX_BLANKS = 10;

export const BlanksEditor: React.FC<BlanksEditorProps> = ({ blanks, onChange, className }) => {
  const { t } = useTranslation('practice');
  // 每个空位一个待添加答案的输入草稿
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const updateBlank = useCallback((index: number, patch: Partial<FillBlankSpec>) => {
    const next = [...blanks];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }, [blanks, onChange]);

  const addAnswer = useCallback((index: number) => {
    const draft = (drafts[index] ?? '').trim();
    if (!draft) return;
    const blank = blanks[index];
    if (blank.answers.includes(draft)) {
      setDrafts((prev) => ({ ...prev, [index]: '' }));
      return;
    }
    updateBlank(index, { answers: [...blank.answers, draft] });
    setDrafts((prev) => ({ ...prev, [index]: '' }));
  }, [drafts, blanks, updateBlank]);

  const removeAnswer = useCallback((index: number, answer: string) => {
    updateBlank(index, { answers: blanks[index].answers.filter((a) => a !== answer) });
  }, [blanks, updateBlank]);

  const addBlank = useCallback(() => {
    if (blanks.length >= MAX_BLANKS) return;
    onChange([...blanks, { answers: [], case_sensitive: false, trim: true }]);
  }, [blanks, onChange]);

  const removeBlank = useCallback((index: number) => {
    onChange(blanks.filter((_, i) => i !== index));
    setDrafts((prev) => {
      const next: Record<number, string> = {};
      Object.entries(prev).forEach(([k, v]) => {
        const i = Number(k);
        if (i < index) next[i] = v;
        else if (i > index) next[i - 1] = v;
      });
      return next;
    });
  }, [blanks, onChange]);

  const renderToggle = (
    index: number,
    field: 'case_sensitive' | 'trim',
    label: string,
    active: boolean,
  ) => (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => updateBlank(index, { [field]: !active } as Partial<FillBlankSpec>)}
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] transition-colors',
        '[@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1.5',
        active
          ? 'bg-primary/10 text-primary'
          : 'bg-muted/40 text-muted-foreground hover:bg-[var(--interactive-hover)]'
      )}
    >
      {label}
    </button>
  );

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t('editor.structEdit.blanksTitle')}
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={addBlank}
          disabled={blanks.length >= MAX_BLANKS}
          className="ui-press h-5 px-1.5 text-[10px] [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!px-3 [@media(pointer:coarse)]:text-xs"
        >
          <Plus size={10} className="mr-0.5" />
          {t('editor.structEdit.addBlank')}
        </DsButton>
      </div>

      {blanks.map((blank, index) => {
        const missing = blank.answers.length === 0;
        return (
          <div
            key={index}
            className={cn(
              'space-y-1.5 rounded-md border p-2 transition-colors',
              missing ? 'border-warning/40 bg-warning/[0.04]' : 'border-border/40 bg-muted/10'
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="flex-shrink-0 text-xs font-medium text-muted-foreground">
                {t('editor.structEdit.blankLabel', { n: index + 1 })}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {renderToggle(index, 'case_sensitive', t('editor.structEdit.caseSensitive'), blank.case_sensitive === true)}
                {renderToggle(index, 'trim', t('editor.structEdit.trimSpaces'), blank.trim !== false)}
                {blanks.length > 1 && (
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={() => removeBlank(index)}
                    aria-label={t('editor.structEdit.removeBlank')}
                    className="!h-5 !w-5 !p-0 text-muted-foreground hover:text-destructive [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10"
                  >
                    <Trash size={11} />
                  </DsButton>
                )}
              </div>
            </div>

            {/* 可接受答案 chips */}
            {blank.answers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {blank.answers.map((answer) => (
                  <Badge
                    key={answer}
                    variant="secondary"
                    className="h-5 cursor-pointer text-xs hover:bg-destructive/20 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:px-2"
                    onClick={() => removeAnswer(index, answer)}
                  >
                    {answer}
                    <X size={10} className="ml-0.5" />
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <Input
                value={drafts[index] ?? ''}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [index]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addAnswer(index);
                  }
                }}
                placeholder={t('editor.structEdit.answerDraftPlaceholder')}
                className="h-7 flex-1 text-xs [@media(pointer:coarse)]:text-[16px]"
              />
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => addAnswer(index)}
                disabled={!(drafts[index] ?? '').trim()}
                aria-label={t('editor.structEdit.addAnswer')}
                className="ui-press !h-7 !w-7 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10"
              >
                <Plus size={12} />
              </DsButton>
            </div>

            {missing && (
              <p className="text-[11px] text-warning">
                {t('editor.structEdit.blankNeedsAnswer')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default BlanksEditor;
