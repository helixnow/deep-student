/**
 * 判断题作答组件：两个大按钮双选（正确 / 错误）
 *
 * - 触控目标 ≥ 44px，桌面 hover 反馈，选中描边 + 浅色填充
 * - 提交后正误揭示：正确 pop 动画，错选 shake + 标红
 *
 * 2026-07 题库题型扩展
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Check, X } from '@phosphor-icons/react';

export type TrueFalseValue = '' | 'true' | 'false';

export interface TrueFalseAnswerProps {
  value: TrueFalseValue;
  onChange: (value: TrueFalseValue) => void;
  /** 已提交：禁用点击并进入揭示态 */
  submitted?: boolean;
  /** 标准答案（提交后用于逐项揭示） */
  correctAnswer?: 'true' | 'false' | null;
  className?: string;
}

const CHOICES: { key: 'true' | 'false'; icon: React.ElementType; shortcut: string }[] = [
  { key: 'true', icon: Check, shortcut: '1' },
  { key: 'false', icon: X, shortcut: '2' },
];

export const TrueFalseAnswer: React.FC<TrueFalseAnswerProps> = ({
  value,
  onChange,
  submitted = false,
  correctAnswer,
  className,
}) => {
  const { t } = useTranslation('practice');

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)} role="radiogroup">
      {CHOICES.map(({ key, icon: Icon, shortcut }) => {
        const isSelected = value === key;
        const isThisCorrect = submitted && correctAnswer === key;
        const isWrongPick = submitted && isSelected && correctAnswer != null && correctAnswer !== key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={submitted}
            onClick={() => onChange(isSelected ? '' : key)}
            className={cn(
              'group relative flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-lg border-2 px-3 py-3 transition-colors ui-state-colors',
              !submitted && 'ui-press cursor-pointer',
              // 默认
              !submitted && !isSelected && 'border-border/60 bg-card/50 hover:border-foreground/25 hover:bg-foreground/[0.03]',
              // 选中
              !submitted && isSelected && (key === 'true'
                ? 'border-success/60 bg-success/[0.08] dark:bg-success/[0.15]'
                : 'border-destructive/50 bg-destructive/[0.07] dark:bg-destructive/[0.14]'),
              // 提交后揭示
              isThisCorrect && 'border-success bg-success/[0.1] dark:bg-success/[0.18] qbank-anim-pop',
              isWrongPick && 'border-destructive bg-destructive/[0.1] dark:bg-destructive/[0.18] qbank-anim-shake',
              submitted && !isSelected && !isThisCorrect && 'border-border/40 opacity-45',
              'disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
            )}
          >
            <span
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
                key === 'true' ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive',
                !submitted && isSelected && (key === 'true' ? 'bg-success text-success-foreground' : 'bg-destructive text-white'),
                isThisCorrect && 'bg-success text-success-foreground',
                isWrongPick && 'bg-destructive text-white'
              )}
            >
              <Icon size={20} weight="bold" />
            </span>
            <span
              className={cn(
                'text-sm font-medium',
                key === 'true' ? 'text-success' : 'text-destructive',
                submitted && !isSelected && !isThisCorrect && 'text-muted-foreground'
              )}
            >
              {key === 'true' ? t('editor.trueFalse.true') : t('editor.trueFalse.false')}
            </span>
            {/* 桌面端内联快捷键提示 */}
            {!submitted && (
              <kbd className="absolute right-2 top-2 hidden h-[18px] min-w-[18px] items-center justify-center rounded bg-muted px-1 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex">
                {shortcut}
              </kbd>
            )}
            {/* 揭示徽标 */}
            {isThisCorrect && (
              <span className="ui-rise-in absolute right-2 top-2 text-xs text-success">
                {t('editor.correct')}
              </span>
            )}
            {isWrongPick && (
              <span className="ui-rise-in absolute right-2 top-2 text-xs text-destructive">
                {t('editor.wrong')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default TrueFalseAnswer;
