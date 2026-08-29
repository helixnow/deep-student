/**
 * 配比行：标签 + 滑杆 + 步进器（-/+）
 *
 * 模拟考试题型/难度配比、组卷器题型配置共用。
 * 步进器保证移动端可以精确 ±1 调整（滑杆在窄屏上很难精确拖动），
 * 触控目标 ≥44px。注意：DsButton 在 lg 断点（如 iPad 横屏）会压缩到 ~30px，
 * 因此这里通过 [@media(pointer:coarse)] 显式保证触控设备上 ≥44px。
 */

import React, { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { Minus, Plus } from '@phosphor-icons/react';
import { Slider } from '@/components/ui/shad/Slider';
import { DsButton } from '@/components/ui/DsButton';

export interface CountStepperRowProps {
  /** 行标签（已翻译） */
  label: string;
  value: number;
  onChange: (value: number) => void;
  max?: number;
  min?: number;
  /** 标签附加类名（如难度色） */
  labelClassName?: string;
  className?: string;
}

export const CountStepperRow: React.FC<CountStepperRowProps> = ({
  label,
  value,
  onChange,
  max = 20,
  min = 0,
  labelClassName,
  className,
}) => {
  const { t } = useTranslation('practice');

  const clamp = useCallback(
    (next: number) => Math.max(min, Math.min(max, next)),
    [min, max],
  );

  return (
    <div className={cn('flex items-center gap-2 sm:gap-3', className)}>
      <span className={cn('w-16 shrink-0 truncate text-sm sm:w-20', labelClassName)} title={label}>
        {label}
      </span>
      <Slider
        value={[value]}
        onValueChange={(v) => onChange(clamp(v[0] ?? min))}
        max={max}
        min={min}
        step={1}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('stepper.decrease', { label })}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1))}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <Minus size={14} />
        </DsButton>
        <span
          className={cn(
            'w-7 text-center text-sm font-medium tabular-nums',
            value > 0 ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {value}
        </span>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('stepper.increase', { label })}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1))}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <Plus size={14} />
        </DsButton>
      </div>
    </div>
  );
};

export default CountStepperRow;
