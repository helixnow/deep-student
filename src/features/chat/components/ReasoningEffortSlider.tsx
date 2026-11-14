// 1. React 核心
import React, { useCallback, useId, useMemo } from 'react';
// 2. 第三方库（按字母序）
import { useTranslation } from 'react-i18next';
// 3. @/ 路径别名
import { cn } from '@/utils/cn';

// ============================================================================
// 常量与类型定义
// ============================================================================

export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

const LEVEL_I18N_KEYS: Record<ReasoningEffortLevel, string> = {
  none: 'inputBar.thinkingOff',
  minimal: 'inputBar.thinkingDepth.minimal',
  low: 'inputBar.thinkingDepth.low',
  medium: 'inputBar.thinkingDepth.medium',
  high: 'inputBar.thinkingDepth.high',
  xhigh: 'inputBar.thinkingDepth.xhigh',
};

// ============================================================================
// Props 定义
// ============================================================================

export interface ReasoningEffortSliderProps {
  /** 当前选中的思考深度档位 */
  value: ReasoningEffortLevel;
  /** 当前模型支持的档位列表；未传入时默认支持全部 6 档 */
  supportedLevels?: readonly ReasoningEffortLevel[];
  /** 档位变更回调 */
  onChange: (level: ReasoningEffortLevel) => void;
  /** 是否整体禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const ReasoningEffortSlider: React.FC<ReasoningEffortSliderProps> = ({
  value,
  supportedLevels = REASONING_EFFORT_LEVELS,
  onChange,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const labelId = useId();

  const supportedSet = useMemo(
    () => new Set<ReasoningEffortLevel>(supportedLevels),
    [supportedLevels],
  );

  const activeIndex = useMemo(() => {
    const idx = REASONING_EFFORT_LEVELS.indexOf(value);
    return idx >= 0 ? idx : 0;
  }, [value]);

  const maxIndex = REASONING_EFFORT_LEVELS.length - 1;
  const fillPercent = maxIndex > 0 ? (activeIndex / maxIndex) * 100 : 0;

  const findAdjacentSupportedLevel = useCallback(
    (startIndex: number, step: 1 | -1): ReasoningEffortLevel | null => {
      for (
        let idx = startIndex;
        idx >= 0 && idx < REASONING_EFFORT_LEVELS.length;
        idx += step
      ) {
        const candidate = REASONING_EFFORT_LEVELS[idx];
        if (supportedSet.has(candidate)) {
          return candidate;
        }
      }
      return null;
    },
    [supportedSet],
  );

  const handleSelectLevel = useCallback(
    (level: ReasoningEffortLevel) => {
      if (disabled || !supportedSet.has(level) || level === value) return;
      onChange(level);
    },
    [disabled, onChange, supportedSet, value],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;

      let nextLevel: ReasoningEffortLevel | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        nextLevel = findAdjacentSupportedLevel(activeIndex + 1, 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        nextLevel = findAdjacentSupportedLevel(activeIndex - 1, -1);
      } else if (event.key === 'Home') {
        nextLevel = findAdjacentSupportedLevel(0, 1);
      } else if (event.key === 'End') {
        nextLevel = findAdjacentSupportedLevel(maxIndex, -1);
      } else {
        return;
      }

      event.preventDefault();
      if (nextLevel && nextLevel !== value) {
        onChange(nextLevel);
      }
    },
    [activeIndex, disabled, findAdjacentSupportedLevel, maxIndex, onChange, value],
  );

  const activeLabel = t(LEVEL_I18N_KEYS[value]);
  const sliderTitle = t('inputBar.thinkingDepthTitle');

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-2 select-none',
        disabled && 'opacity-50',
        className,
      )}
      data-testid="reasoning-effort-slider"
      data-disabled={disabled ? 'true' : 'false'}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-xs font-medium text-muted-foreground">
          {sliderTitle}
        </span>
        <span
          className="font-mono tabular-nums text-xs font-medium text-foreground"
          data-testid="reasoning-effort-value"
        >
          {activeLabel}
        </span>
      </div>

      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-label={sliderTitle}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={activeIndex}
        aria-valuetext={activeLabel}
        aria-disabled={disabled}
        className="relative flex items-center py-2 focus:outline-none"
      >
        {/* 6px 轨道 */}
        <div
          className="relative h-[6px] w-full rounded-full bg-muted"
          data-testid="reasoning-effort-track"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-150"
            style={{ width: `${fillPercent}%` }}
            data-testid="reasoning-effort-fill"
          />
        </div>

        {/* 6 档离散节点 */}
        <div className="absolute inset-x-0 flex items-center justify-between">
          {REASONING_EFFORT_LEVELS.map((level, index) => {
            const isSupported = supportedSet.has(level);
            const isStepDisabled = disabled || !isSupported;
            const isActive = level === value;
            const isFilled = index <= activeIndex;
            const stepLabel = t(LEVEL_I18N_KEYS[level]);

            return (
              <button
                key={level}
                type="button"
                disabled={isStepDisabled}
                aria-label={stepLabel}
                aria-pressed={isActive}
                aria-disabled={isStepDisabled}
                data-testid={`reasoning-effort-step-${level}`}
                data-level={level}
                data-active={isActive ? 'true' : 'false'}
                data-supported={isSupported ? 'true' : 'false'}
                onClick={() => handleSelectLevel(level)}
                className={cn(
                  'group relative flex flex-col items-center justify-center rounded-full p-1 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  isStepDisabled
                    ? 'cursor-not-allowed opacity-40 text-muted-foreground'
                    : 'cursor-pointer text-foreground',
                )}
              >
                <span
                  data-testid={`reasoning-effort-dot-${level}`}
                  className={cn(
                    'rounded-full transition-all duration-150',
                    isActive ? 'h-[8px] w-[8px]' : 'h-[6px] w-[6px]',
                    !isSupported
                      ? 'bg-muted-foreground/35'
                      : isActive
                        ? 'bg-primary ring-2 ring-primary/30'
                        : isFilled
                          ? 'bg-primary/80'
                          : 'bg-muted-foreground/50',
                  )}
                />
                <span className="mt-1 font-mono tabular-nums text-[10px] leading-none text-muted-foreground">
                  {index}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ReasoningEffortSlider;
