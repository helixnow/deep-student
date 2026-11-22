/**
 * 数值题作答组件：带单位的数值输入
 *
 * - inputMode="text" + 快捷符号条（− / π √ ^ ()），解决移动端数字键盘打不出负号与分数的问题
 * - 非法输入即时提示；提交后展示参考答案（含容差与单位）
 *
 * 2026-07 题库题型扩展
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Check, X, WarningCircle } from '@phosphor-icons/react';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import type { NumericStructuredData } from './structured';
import { formatNumericAnswer } from './structured';
import { parseNumericInput } from '@/api/questionBankApi';

export interface NumericQuickSymbol {
  label: string;
  insert: string;
  cursorOffset?: number;
  ariaLabelKey: string;
  defaultAriaLabel: string;
}

export const NUMERIC_QUICK_SYMBOLS: readonly NumericQuickSymbol[] = [
  { label: '−', insert: '-', ariaLabelKey: 'editor.numeric.symbolMinus', defaultAriaLabel: '负号' },
  { label: '/', insert: '/', ariaLabelKey: 'editor.numeric.symbolSlash', defaultAriaLabel: '分数斜杠' },
  { label: 'π', insert: 'π', ariaLabelKey: 'editor.numeric.symbolPi', defaultAriaLabel: '圆周率 π' },
  { label: '√', insert: '√', ariaLabelKey: 'editor.numeric.symbolSqrt', defaultAriaLabel: '根号' },
  { label: '^', insert: '^', ariaLabelKey: 'editor.numeric.symbolPower', defaultAriaLabel: '乘方' },
  { label: '()', insert: '()', cursorOffset: 1, ariaLabelKey: 'editor.numeric.symbolParens', defaultAriaLabel: '括号' },
];

export interface NumericQuickSymbolBarProps {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  className?: string;
}

export const NumericQuickSymbolBar: React.FC<NumericQuickSymbolBarProps> = ({
  value,
  onChange,
  inputRef,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation('practice');

  const handleInsert = useCallback(
    (symbol: NumericQuickSymbol) => {
      if (disabled) return;
      const input = inputRef.current;
      const start = input?.selectionStart ?? value.length;
      const end = input?.selectionEnd ?? value.length;
      const nextValue = `${value.slice(0, start)}${symbol.insert}${value.slice(end)}`;
      onChange(nextValue);
      const nextCursor = start + (symbol.cursorOffset ?? symbol.insert.length);
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        try {
          inputRef.current.setSelectionRange(nextCursor, nextCursor);
        } catch {
          // Ignore unsupported selection APIs in non-standard inputs
        }
      });
    },
    [disabled, inputRef, onChange, value],
  );

  if (disabled) return null;

  return (
    <div
      data-testid="numeric-quick-symbols"
      role="group"
      aria-label={t('editor.numeric.quickSymbols', { defaultValue: '常用数学符号' })}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {NUMERIC_QUICK_SYMBOLS.map((symbol) => (
        <button
          key={symbol.label}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => handleInsert(symbol)}
          aria-label={t(symbol.ariaLabelKey, { defaultValue: symbol.defaultAriaLabel })}
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.03] px-2.5 font-mono text-sm text-foreground/85 transition-colors hover:border-border hover:bg-foreground/[0.07] active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          {symbol.label}
        </button>
      ))}
    </div>
  );
};

export interface NumericAnswerProps {
  value: string;
  onChange: (value: string) => void;
  /** structured_data 缺失时可为 null，仅提供纯数值输入 */
  spec?: NumericStructuredData | null;
  /** 已提交：禁用输入并进入揭示态 */
  submitted?: boolean;
  /** 后端判定结果（提交后） */
  isCorrect?: boolean | null;
  /** Enter 主操作；由父层决定是否 preventDefault 标记已处理 */
  onPrimaryAction?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}

export const NumericAnswer: React.FC<NumericAnswerProps> = ({
  value,
  onChange,
  spec,
  submitted = false,
  isCorrect,
  onPrimaryAction,
  className,
}) => {
  const { t } = useTranslation('practice');
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  // 与后端 parse_numeric_input 同口径的宽松校验（接受 "3.14 m"、"1/2"、全角数字等），
  // 纯符号中间态（"-"、"."）不提示，避免正常输入过程中的警告抖动
  const isInvalid = trimmed.length > 0
    && parseNumericInput(trimmed) == null
    && !/^[-+]?\.?$/.test(trimmed);

  const answerDisplay = useMemo(() => (spec ? formatNumericAnswer(spec) : null), [spec]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      submitted
      || event.key !== 'Enter'
      || event.defaultPrevented
      || event.repeat
      || event.ctrlKey
      || event.metaKey
      || event.altKey
      || event.shiftKey
      || isComposingKeyEvent(event)
    ) return;

    onPrimaryAction?.(event);
  }, [onPrimaryAction, submitted]);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative max-w-sm">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={submitted}
          type="text"
          inputMode="text"
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

      {/* 快捷数学符号条（解决手机数字键盘缺负号与分数斜杠问题） */}
      <NumericQuickSymbolBar
        value={value}
        onChange={onChange}
        inputRef={inputRef}
        disabled={submitted}
      />

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
