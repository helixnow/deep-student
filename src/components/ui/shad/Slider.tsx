import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface SliderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onValueChange?: (value: number[]) => void;
}

export const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  (
    {
      className,
      value,
      defaultValue = [0],
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      onValueChange,
      ...props
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const currentValue = value ?? internalValue;
    const trackRef = React.useRef<HTMLDivElement>(null);
    const isDragging = React.useRef(false);

    const percentage = React.useMemo(() => {
      const val = currentValue[0] ?? 0;
      if (max === min) return 0;
      return ((val - min) / (max - min)) * 100;
    }, [currentValue, min, max]);

    const updateValue = React.useCallback(
      (clientX: number) => {
        if (disabled) return;
        const track = trackRef.current;
        if (!track) return;

        const rect = track.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        let newValue = min + percent * (max - min);

        // 按 step 量化
        if (step > 0) {
          newValue = Math.round(newValue / step) * step;
        }

        // 确保在范围内
        newValue = Math.max(min, Math.min(max, newValue));

        // 保留小数精度
        const decimals = step.toString().split('.')[1]?.length ?? 0;
        newValue = Number(newValue.toFixed(decimals));

        const newValueArray = [newValue];
        setInternalValue(newValueArray);
        onValueChange?.(newValueArray);
      },
      [disabled, min, max, step, onValueChange]
    );

    const handleMouseDown = React.useCallback(
      (e: React.MouseEvent) => {
        if (disabled) return;
        e.preventDefault();
        isDragging.current = true;
        updateValue(e.clientX);

        const handleMouseMove = (moveEvent: MouseEvent) => {
          if (isDragging.current) {
            updateValue(moveEvent.clientX);
          }
        };

        const handleMouseUp = () => {
          isDragging.current = false;
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      },
      [disabled, updateValue]
    );

    const handleTouchStart = React.useCallback(
      (e: React.TouchEvent) => {
        if (disabled) return;
        isDragging.current = true;
        const touch = e.touches[0];
        if (touch) {
          updateValue(touch.clientX);
        }

        const handleTouchMove = (moveEvent: TouchEvent) => {
          if (isDragging.current) {
            const moveTouch = moveEvent.touches[0];
            if (moveTouch) {
              updateValue(moveTouch.clientX);
            }
          }
        };

        const handleTouchEnd = () => {
          isDragging.current = false;
          document.removeEventListener('touchmove', handleTouchMove);
          document.removeEventListener('touchend', handleTouchEnd);
        };

        document.addEventListener('touchmove', handleTouchMove, { passive: true });
        document.addEventListener('touchend', handleTouchEnd);
      },
      [disabled, updateValue]
    );

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        if (disabled) return;

        let newValue = currentValue[0] ?? 0;
        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowUp':
            e.preventDefault();
            newValue = Math.min(max, newValue + step);
            break;
          case 'ArrowLeft':
          case 'ArrowDown':
            e.preventDefault();
            newValue = Math.max(min, newValue - step);
            break;
          case 'Home':
            e.preventDefault();
            newValue = min;
            break;
          case 'End':
            e.preventDefault();
            newValue = max;
            break;
          default:
            return;
        }

        const newValueArray = [newValue];
        setInternalValue(newValueArray);
        onValueChange?.(newValueArray);
      },
      [disabled, currentValue, min, max, step, onValueChange]
    );

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex w-full touch-none select-none items-center',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        {...props}
      >
        <div
          ref={trackRef}
          className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted cursor-pointer"
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
        >
          {/* Track fill */}
          <div
            className="absolute h-full bg-primary"
            style={{ width: `${percentage}%` }}
          />
        </div>
        {/* Thumb */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={currentValue[0]}
          aria-disabled={disabled}
          className={cn(
            'absolute block h-3 w-3 rounded-full bg-primary shadow-none transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
            'hover:scale-110',
            disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
          )}
          style={{
            left: `calc(${percentage}% - 10px)`,
          }}
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
          onKeyDown={handleKeyDown}
        />
      </div>
    );
  }
);

Slider.displayName = 'Slider';

export default Slider;
