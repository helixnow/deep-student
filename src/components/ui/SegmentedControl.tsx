import React from 'react';

import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';

/**
 * Single option inside a {@link SegmentedControl}. `label` accepts any
 * `ReactNode`, so icons/badges/custom layouts should be composed into the
 * label directly — this keeps the primitive API small and avoids the "two
 * ways to do the same thing" trap.
 */
export interface SegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * Props for {@link SegmentedControl}.
 *
 * Notes:
 * - `ariaLabel` is REQUIRED — the control exposes `role="radiogroup"` and
 *   assistive tech needs a name for the group.
 * - When `value` does not match any option, no option is marked selected.
 *   The first enabled option becomes the focus entry point (or the first
 *   option when every option is disabled), keeping the group reachable by
 *   keyboard per WAI-ARIA Radio Group authoring practices.
 */
export interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  value: T;
  onValueChange: (value: T) => void;
  options: Array<SegmentedControlOption<T>>;
  size?: 'default' | 'compact';
  stretch?: boolean;
  className?: string;
  itemClassName?: string;
}

const rootClassNames = {
  default:
    'w-full max-w-full flex-wrap rounded-full border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-2 sm:w-auto sm:flex-nowrap',
  compact: 'rounded-md border-transparent bg-muted/40 p-0.5',
} as const;

const itemClassNames = {
  default:
    '!h-11 rounded-full !border-transparent px-4 text-[15px] font-semibold text-foreground/70 hover:!bg-[color:var(--interactive-hover)] hover:text-foreground sm:px-5',
  compact: '!h-auto rounded px-3 py-1 text-xs',
} as const;

const selectedItemClassNames = {
  default:
    '!bg-[color:var(--interactive-selected)] text-foreground shadow-none hover:!bg-[color:var(--interactive-selected)]',
  compact: 'bg-background text-foreground shadow-sm hover:bg-background',
} as const;

const unselectedItemClassNames = {
  default: 'bg-transparent',
  compact: 'bg-transparent text-muted-foreground hover:text-foreground',
} as const;

function getNextEnabledIndex<T extends string>(
  options: Array<SegmentedControlOption<T>>,
  startIndex: number,
  direction: 1 | -1
) {
  if (!options.length) {
    return -1;
  }

  for (let step = 1; step <= options.length; step += 1) {
    const nextIndex = (startIndex + direction * step + options.length) % options.length;
    if (!options[nextIndex]?.disabled) {
      return nextIndex;
    }
  }

  return -1;
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onValueChange,
  options,
  size = 'default',
  stretch = false,
  className,
  itemClassName,
}: SegmentedControlProps<T>) {
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const firstEnabledIndex = options.findIndex((option) => !option.disabled);
  // When every option is disabled, fall back to index 0 so the radiogroup
  // remains focusable for screen reader users (WAI-ARIA APG recommendation:
  // the group must always have a reachable entry point). All radios still
  // advertise their disabled state via `aria-disabled` + the native
  // `disabled` attribute below.
  const focusableIndex =
    selectedIndex >= 0
      ? selectedIndex
      : firstEnabledIndex >= 0
        ? firstEnabledIndex
        : options.length > 0
          ? 0
          : -1;

  const selectIndex = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) {
      return;
    }

    optionRefs.current[index]?.focus();
    if (option.value !== value) {
      onValueChange(option.value);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!options.length) {
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(options, index, 1);
      if (nextIndex >= 0) {
        selectIndex(nextIndex);
      }
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(options, index, -1);
      if (nextIndex >= 0) {
        selectIndex(nextIndex);
      }
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      if (firstEnabledIndex >= 0) {
        selectIndex(firstEnabledIndex);
      }
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      const lastEnabledIndex = [...options]
        .map((option, optionIndex) => ({ option, optionIndex }))
        .reverse()
        .find(({ option }) => !option.disabled)?.optionIndex ?? -1;

      if (lastEnabledIndex >= 0) {
        selectIndex(lastEnabledIndex);
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('study-shell-segmented', rootClassNames[size], className)}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;

        return (
          <NotionButton
            key={option.value}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            variant="ghost"
            size="sm"
            role="radio"
            title={option.title}
            aria-label={option.ariaLabel}
            aria-checked={isSelected}
            aria-disabled={option.disabled || undefined}
            data-selected={isSelected ? 'true' : 'false'}
            disabled={option.disabled}
            tabIndex={index === focusableIndex ? 0 : -1}
            onClick={() => selectIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'study-shell-segmented-button',
              itemClassNames[size],
              stretch && size === 'default' && 'flex-1 sm:flex-none',
              isSelected ? selectedItemClassNames[size] : unselectedItemClassNames[size],
              itemClassName
            )}
          >
            {option.label}
          </NotionButton>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
