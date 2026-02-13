import * as React from 'react';
import { cn } from '../../utils/cn';

type SnappySliderConfig = {
  snappingThreshold?: number;
  labelFormatter?: (value: number) => string;
};

export interface SnappySliderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  values: number[];
  defaultValue: number;
  value?: number;
  inputId?: string;
  resetKey?: number | string;
  snapping?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  config?: SnappySliderConfig;
  label?: string;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  /** 是否显示滑块上方的数值气泡，默认 false（编辑框已显示数值） */
  showBubble?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const quantizeValue = (value: number, step: number) => {
  if (step <= 0) return value;
  const decimals = step.toString().split('.')[1]?.length ?? 0;
  const scaled = Math.round(value / step) * step;
  return Number(scaled.toFixed(decimals));
};

const formatNumber = (value: number, step: number): string => {
  const decimals = step.toString().split('.')[1]?.length ?? 0;
  if (decimals === 0) return String(Math.round(value));
  return value.toFixed(decimals);
};

export const SnappySlider = React.forwardRef<HTMLDivElement, SnappySliderProps>((props, ref) => {
  const {
    values,
    defaultValue,
    value,
    inputId,
    resetKey,
    snapping = true,
    min: providedMin,
    max: providedMax,
    step,
    onChange,
    config,
    label,
    prefix,
    suffix,
    disabled = false,
    showBubble = false,
    className,
    ...rest
  } = props;

  const sliderRef = React.useRef<HTMLDivElement>(null);
  const computedStepRef = React.useRef(step ?? 0.1);
  computedStepRef.current = step ?? 0.1;
  const computedStep = computedStepRef.current;

  const internalConfig = React.useMemo<Required<SnappySliderConfig>>(() => ({
    snappingThreshold: config?.snappingThreshold ?? 0.05,
    labelFormatter: config?.labelFormatter ?? ((v: number) => formatNumber(v, computedStep)),
  }), [config, computedStep]);

  const defaultValueArray = React.useMemo(() => {
    const unique = new Set<number>([...values, defaultValue]);
    return Array.from(unique).sort((a, b) => a - b);
  }, [values, defaultValue]);

  const inputMin = React.useMemo(() => {
    const array = defaultValueArray;
    const candidate = providedMin ?? Math.min(...array);
    return Number.isFinite(candidate) ? candidate : 0;
  }, [defaultValueArray, providedMin]);

  const inputMax = React.useMemo(() => {
    const array = defaultValueArray;
    const candidate = providedMax ?? Math.max(...array);
    return Number.isFinite(candidate) ? candidate : 1;
  }, [defaultValueArray, providedMax]);

  const sliderValues = React.useMemo(() => {
    if (providedMin === undefined || providedMax === undefined) return defaultValueArray;
    return defaultValueArray.filter((v) => v >= providedMin && v <= providedMax);
  }, [defaultValueArray, providedMin, providedMax]);

  const sliderMin = React.useMemo(() => Math.min(...sliderValues), [sliderValues]);
  const sliderMax = React.useMemo(() => Math.max(...sliderValues), [sliderValues]);

  const [internalValue, setInternalValue] = React.useState(() => clamp(defaultValue, sliderMin, sliderMax));
  const [inputValue, setInputValue] = React.useState(() => formatNumber(internalValue, computedStepRef.current));

  const currentValue = value ?? internalValue;

  React.useEffect(() => {
    const clamped = clamp(defaultValue, sliderMin, sliderMax);
    setInternalValue(clamped);
    if (value === undefined) {
      setInputValue(formatNumber(clamped, computedStep));
    }
  }, [defaultValue, sliderMin, sliderMax, computedStep, value]);

  React.useEffect(() => {
    if (value === undefined) return;
    const clamped = clamp(value, sliderMin, sliderMax);
    setInternalValue(clamped);
    setInputValue(formatNumber(clamped, computedStep));
  }, [value, sliderMin, sliderMax, computedStep]);

  React.useEffect(() => {
    if (resetKey === undefined) return;
    const clamped = clamp(defaultValue, sliderMin, sliderMax);
    setInternalValue(clamped);
    setInputValue(formatNumber(clamped, computedStep));
  }, [resetKey, defaultValue, sliderMin, sliderMax, computedStep]);

  const handleValueChange = React.useCallback((next: number) => {
    const quantized = quantizeValue(clamp(next, sliderMin, sliderMax), computedStep);
    setInternalValue(quantized);
    setInputValue(formatNumber(quantized, computedStep));
    onChange(quantized);
  }, [computedStep, onChange, sliderMin, sliderMax]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
  };

  const handleInputBlur = () => {
    const next = Number(inputValue);
    if (Number.isNaN(next)) {
      setInputValue(formatNumber(currentValue, computedStep));
      return;
    }
    const clamped = clamp(next, inputMin, inputMax);
    const quantized = quantizeValue(clamped, computedStep);
    setInputValue(formatNumber(quantized, computedStep));
    handleValueChange(quantized);
  };

  const handleInteraction = React.useCallback((clientX: number) => {
    if (disabled) return;
    const slider = sliderRef.current;
    if (!slider) return;

    const rect = slider.getBoundingClientRect();
    const percentage = rect.width === 0 ? 0 : clamp((clientX - rect.left) / rect.width, 0, 1);
    const rawValue = sliderMin + percentage * (sliderMax - sliderMin);

    if (snapping) {
      const snapPoints = [...new Set([...defaultValueArray, currentValue])].sort((a, b) => a - b);
      const closest = snapPoints.reduce((prev, curr) => {
        return Math.abs(curr - rawValue) < Math.abs(prev - rawValue) ? curr : prev;
      }, snapPoints[0] ?? rawValue);
      if (Math.abs(closest - rawValue) <= internalConfig.snappingThreshold) {
        handleValueChange(closest);
        return;
      }
    }

    const quantized = quantizeValue(rawValue, computedStep);
    handleValueChange(quantized);
  }, [currentValue, defaultValueArray, disabled, handleValueChange, internalConfig.snappingThreshold, sliderMax, sliderMin, snapping, computedStep]);

  React.useEffect(() => {
    if (disabled) return;
    const slider = sliderRef.current;
    if (!slider) return;

    const handleMouseDown = (event: MouseEvent) => {
      event.preventDefault();
      handleInteraction(event.clientX);
      const originalUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';

      const handleMouseMove = (moveEvent: MouseEvent) => {
        handleInteraction(moveEvent.clientX);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.body.style.userSelect = originalUserSelect;
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp, { once: true });
    };

    const handleTouchStart = (event: TouchEvent) => {
      event.preventDefault();
      handleInteraction(event.touches[0]?.clientX ?? 0);

      const handleTouchMove = (moveEvent: TouchEvent) => {
        handleInteraction(moveEvent.touches[0]?.clientX ?? 0);
      };

      const handleTouchEnd = () => {
        document.removeEventListener('touchmove', handleTouchMove);
      };

      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd, { once: true });
    };

    slider.addEventListener('mousedown', handleMouseDown);
    slider.addEventListener('touchstart', handleTouchStart, { passive: false });

    return () => {
      slider.removeEventListener('mousedown', handleMouseDown);
      slider.removeEventListener('touchstart', handleTouchStart);
      document.body.style.userSelect = '';
    };
  }, [disabled, handleInteraction]);

  React.useEffect(() => {
    if (disabled) return;
    const slider = sliderRef.current;
    if (!slider) return;
    const handleDoubleClick = () => {
      handleValueChange(defaultValue);
    };
    slider.addEventListener('dblclick', handleDoubleClick);
    return () => slider.removeEventListener('dblclick', handleDoubleClick);
  }, [defaultValue, disabled, handleValueChange]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? computedStep : -computedStep;
    const next = quantizeValue(Number(inputValue) + delta, computedStep);
    const clamped = clamp(next, sliderMin, sliderMax);
    setInputValue(formatNumber(clamped, computedStep));
    onChange(clamped);
  };

  const sliderRange = sliderMax - sliderMin || 1;
  const clampedCurrent = clamp(currentValue, sliderMin, sliderMax);
  const sliderPercentage = ((clampedCurrent - sliderMin) / sliderRange) * 100;
  const isOutOfBounds = currentValue < sliderMin || currentValue > sliderMax;

  const displayedBubbleValue = React.useMemo(() => {
    if (isOutOfBounds) {
      if (currentValue < sliderMin) {
    return `<${internalConfig.labelFormatter(sliderMin)}>`;
      }
    return `>${internalConfig.labelFormatter(sliderMax)}`;
    }
    return internalConfig.labelFormatter(clampedCurrent);
  }, [clampedCurrent, currentValue, internalConfig, isOutOfBounds, sliderMax, sliderMin]);

  return (
    <div
      ref={ref}
      className={cn(
        '[--mark-slider-gap:0.125rem] [--mark-slider-height:0.375rem] [--mark-slider-track-height:0.25rem] [--mark-slider-marker-width:1px]',
        'flex flex-col gap-[--mark-slider-gap] pb-1',
        showBubble ? 'pt-4' : 'pt-1',
        className,
      )}
      {...rest}
    >
      <SnappySliderHeader>
        {label ? (
          <SnappySliderLabel htmlFor={inputId}>{label}</SnappySliderLabel>
        ) : (
          <span />
        )}
        <SnappySliderValue
          id={inputId}
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          prefix={prefix}
          suffix={suffix}
          aria-valuemin={inputMin}
          aria-valuemax={inputMax}
          aria-valuenow={clampedCurrent}
        />
      </SnappySliderHeader>
      <div className="relative h-[--mark-slider-height]">
        <div ref={sliderRef} className="absolute inset-0">
          <div className="absolute top-1/2 -translate-y-1/2 w-full h-[--mark-slider-track-height] rounded-sm overflow-hidden bg-primary/10 dark:bg-primary/20">
            <div
              className={cn('absolute top-0 h-full z-[1] bg-primary dark:bg-primary/80')}
              style={{ width: `${sliderPercentage}%` }}
            />
            {sliderValues.map((mark, index) => {
              if (mark === sliderMin || mark === sliderMax) return null;
              const markPercentage = ((mark - sliderMin) / sliderRange) * 100;
              if (!Number.isFinite(markPercentage) || markPercentage <= 0 || markPercentage >= 100) return null;
              return (
                <div
                  key={`${mark}-${index}`}
                  className="absolute top-0 h-full z-[2] w-[--mark-slider-marker-width] -translate-x-[calc(var(--mark-slider-marker-width)/2)] bg-foreground/20 dark:bg-foreground/30"
                  style={{ left: `${markPercentage}%` }}
                />
              );
            })}
          </div>
          {sliderValues.includes(0) && sliderRange > 0 && (
            <div
              className="absolute top-1/2 -translate-y-1/2 z-20"
              style={{ left: `${((0 - sliderMin) / sliderRange) * 100}%` }}
            >
              <div className="h-3 w-[--mark-slider-marker-width] -translate-x-[calc(var(--mark-slider-marker-width)/2)] bg-destructive" />
            </div>
          )}
          <div
            className={cn(
              'absolute z-30 top-1/2 -translate-y-1/2 -translate-x-1/2 cursor-grab active:cursor-grabbing',
              isOutOfBounds && 'opacity-75',
            )}
            style={{ left: `${sliderPercentage}%` }}
          >
            {showBubble && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-0.5 whitespace-nowrap">
                <span className={cn('text-[10px] font-medium text-muted-foreground', isOutOfBounds && 'opacity-75')}>
                  {displayedBubbleValue}
                </span>
              </div>
            )}
            <div 
              className={cn('bg-primary rounded-sm', isOutOfBounds && 'bg-primary/20 dark:bg-primary/30')}
              style={{
                // 固定尺寸，防止安卓上变形
                width: 8,
                height: 8,
                minWidth: 8,
                minHeight: 8,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

SnappySlider.displayName = 'SnappySlider';

const SnappySliderHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('mb-0.5 flex items-center justify-between', className)} {...props} />
));
SnappySliderHeader.displayName = 'SnappySliderHeader';

const SnappySliderLabel = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn('text-xs font-medium text-primary/60 dark:text-primary/70', className)} {...props} />
));
SnappySliderLabel.displayName = 'SnappySliderLabel';

const SnappySliderValue = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { prefix?: string; suffix?: string }
>(({ className, prefix, suffix, ...props }, ref) => {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const assignRef = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
      return;
    }
    if (ref) {
      (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    }
  };

  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      className="group inline-flex w-12 cursor-text items-center rounded bg-primary/5 px-1 py-[2px] focus-within:ring-1 focus-within:ring-primary/70 dark:bg-primary/10"
      onClick={handleContainerClick}
    >
      {prefix && <span className="shrink-0 select-none text-xs text-primary/75 dark:text-primary/80">{prefix}</span>}
      <input
        ref={assignRef}
        type="number"
        inputMode="decimal"
        className={cn(
          'min-w-0 flex-1 border-none bg-transparent text-right text-xs text-primary outline-none',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          'dark:text-primary/90',
          className,
        )}
        {...props}
      />
      {suffix && <span className="shrink-0 select-none text-xs text-primary/75 dark:text-primary/80">{suffix}</span>}
    </div>
  );
});

SnappySliderValue.displayName = 'SnappySliderValue';

export default SnappySlider;
