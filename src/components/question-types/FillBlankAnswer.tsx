/**
 * 填空题作答组件：多空逐空输入
 *
 * - 单空/多空统一渲染；Enter 在空位间顺移（最后一空交还给全局提交）
 * - 有 structured blanks 时提交后逐空揭示正误 + 可接受答案对照
 *
 * 2026-07 题库题型扩展
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Check, X } from '@phosphor-icons/react';
import type { FillBlankStructuredData } from './structured';
import { isBlankAnswerCorrect } from './structured';

export interface FillBlankAnswerProps {
  answers: string[];
  onChange: (answers: string[]) => void;
  /** structured 空位规格（可为 null，则不做逐空揭示） */
  blanks?: FillBlankStructuredData | null;
  /** 已提交：禁用输入并进入揭示态 */
  submitted?: boolean;
  className?: string;
}

export const FillBlankAnswer: React.FC<FillBlankAnswerProps> = ({
  answers,
  onChange,
  blanks,
  submitted = false,
  className,
}) => {
  const { t } = useTranslation('practice');

  const handleChange = useCallback((index: number, value: string) => {
    const next = [...answers];
    next[index] = value;
    onChange(next);
  }, [answers, onChange]);

  // Enter 顺移到下一空（最后一空不拦截，交给全局 Enter 提交）
  const handleKeyDown = useCallback((index: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || index >= answers.length - 1) return;
    e.preventDefault();
    e.stopPropagation();
    const form = (e.currentTarget.closest('[data-fill-blank-root]') ?? document);
    const inputs = form.querySelectorAll<HTMLInputElement>('input[data-blank-index]');
    inputs[index + 1]?.focus();
  }, [answers.length]);

  return (
    <div data-fill-blank-root className={cn('space-y-2.5', className)}>
      {answers.map((answer, index) => {
        const spec = blanks?.blanks[index] ?? null;
        const revealCorrect = submitted && spec ? isBlankAnswerCorrect(answer, spec) : null;
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2.5">
              {answers.length > 1 && (
                <span className="w-8 flex-shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  ({index + 1})
                </span>
              )}
              <div className="relative min-w-0 flex-1">
                <Input
                  value={answer}
                  data-blank-index={index}
                  onChange={(e) => handleChange(index, e.target.value)}
                  onKeyDown={handleKeyDown(index)}
                  placeholder={t('editor.fillBlankPlaceholder', { n: index + 1 })}
                  disabled={submitted}
                  autoComplete="off"
                  className={cn(
                    'h-11 transition-colors',
                    revealCorrect === true && 'border-success/60 bg-success/[0.05] text-success pr-9',
                    revealCorrect === false && 'border-destructive/60 bg-destructive/[0.05] text-destructive qbank-anim-shake pr-9'
                  )}
                />
                {revealCorrect !== null && (
                  <span className="absolute inset-y-0 right-3 flex items-center">
                    {revealCorrect ? (
                      <Check size={15} weight="bold" className="qbank-anim-pop text-success" />
                    ) : (
                      <X size={15} className="text-destructive" />
                    )}
                  </span>
                )}
              </div>
            </div>
            {/* 答错的空展示可接受答案 */}
            {revealCorrect === false && spec && spec.answers.length > 0 && (
              <p className={cn('ui-rise-in text-xs text-muted-foreground', answers.length > 1 && 'pl-[42px]')}>
                {t('editor.fillBlank.acceptedAnswers', { answers: spec.answers.join(' / ') })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default FillBlankAnswer;
