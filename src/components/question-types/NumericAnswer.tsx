/**
 * 数值题作答组件：带单位的数值输入
 *
 * - inputMode="decimal" 触屏唤起数字键盘，单位作为输入框后缀展示
 * - 非法输入即时提示；提交后展示参考答案（含容差与单位）
 *
 * 2026-07 题库题型扩展
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Check, X, WarningCircle } from '@phosphor-icons/react';
import type { NumericStructuredData } from './structured';
import { formatNumericAnswer } from './structured';
import { parseNumericInput } from '@/api/questionBankApi';

export interface NumericAnswerProps {
  value: string;
  onChange: (value: string) => void;
  /** structured_data 缺失时可为 null，仅提供纯数值输入 */
  spec?: NumericStructuredData | null;
  /** 已提交：禁用输入并进入揭示态 */
  submitted?: boolean;
  /** 后端判定结果（提交后） */
  isCorrect?: boolean | null;
  className?: string;
}

export const NumericAnswer: React.FC<NumericAnswerProps> = ({
  value,
  onChange,
  spec,
  submitted = false,
  isCorrect,
  className,
}) => {
  const { t } = useTranslation('practice');

  const trimmed = value.trim();
  // 与后端 parse_numeric_input 同口径的宽松校验（接受 "3.14 m"、"1/2"、全角数字等），
  // 纯符号中间态（"-"、"."）不提示，避免正常输入过程中的警告抖动
  const isInvalid = trimmed.length > 0
    && parseNumericInput(trimmed) == null
    && !/^[-+]?\.?$/.test(trimmed);

  const answerDisplay = useMemo(() => (spec ? formatNumericAnswer(spec) : null), [spec]);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative max-w-sm">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={submitted}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={t('editor.numeric.placeholder')}
          aria-invalid={isInvalid}
          className={cn(
            'h-11 text-base tabular-nums transition-colors',
            spec?.unit && 'pr-14',
            isInvalid && !submitted && 'border-destructive/60 focus-visible:ring-destructive/30',
            submitted && isCorrect === true && 'border-success/60 bg-success/[0.05] text-success',
            submitted && isCorrect === false && 'border-destructive/60 bg-destructive/[0.05] text-destructive qbank-anim-shake'
          )}
        />
        {/* 单位后缀 */}
        {spec?.unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
            {spec.unit}
          </span>
        )}
        {/* 提交后正误图标 */}
        {submitted && isCorrect != null && (
          <span
            className={cn(
              'absolute inset-y-0 flex items-center',
              spec?.unit ? 'right-10' : 'right-3'
            )}
          >
            {isCorrect ? (
              <Check size={16} weight="bold" className="qbank-anim-pop text-success" />
            ) : (
              <X size={16} className="text-destructive" />
            )}
          </span>
        )}
      </div>

      {/* 非法输入即时提示 */}
      {isInvalid && !submitted && (
        <p className="ui-fade-in flex items-center gap-1 text-xs text-destructive">
          <WarningCircle size={12} className="flex-shrink-0" />
          {t('editor.numeric.invalidNumber')}
        </p>
      )}

      {/* 容差提示（作答时给出宽容度信息） */}
      {!submitted && spec?.tolerance != null && spec.tolerance > 0 && (
        <p className="text-xs text-muted-foreground/70">
          {spec.tolerance_mode === 'relative'
            ? t('editor.numeric.toleranceHintRelative', { tolerance: spec.tolerance * 100 })
            : t('editor.numeric.toleranceHint', { tolerance: spec.tolerance })}
        </p>
      )}

      {/* 提交后参考答案对照 */}
      {submitted && answerDisplay && (
        <p className="ui-rise-in text-sm text-muted-foreground">
          {t('editor.referenceAnswerLabel')}
          <span className="font-medium tabular-nums text-foreground">{answerDisplay}</span>
        </p>
      )}
    </div>
  );
};

export default NumericAnswer;
