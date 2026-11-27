import React, { useEffect, useRef, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { useImeSafeControlledValue } from '@/components/ui/shad/useImeSafeControlledValue';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { coarseHitClassFor28 } from '@/components/ui/coarseHit';

export interface DesktopHeaderSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** 外部递增触发自动展开并聚焦（如 Cmd/Ctrl+F） */
  expandSeq?: number;
  /** 透传到输入框的 data-* 属性，方便既有快捷键与测试定位 */
  inputDataAttrs?: Record<string, string | undefined>;
  className?: string;
}

/**
 * 桌面端右侧顶栏统一折叠搜索控件：
 * - 默认为 28px 透明 ghost 放大镜按钮，不占用顶栏拖拽区；
 * - 点击或触发快捷键后原地展开为 176px 紧凑输入框；
 * - Escape 清空并收起；失焦且输入为空时自动收起。
 */
export const DesktopHeaderSearch: React.FC<DesktopHeaderSearchProps> = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  expandSeq = 0,
  inputDataAttrs,
  className,
}) => {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastExpandSeqRef = useRef(expandSeq);

  const isOpen = !disabled && (expanded || value.length > 0);
  const resolvedLabel = ariaLabel || placeholder;

  const inputProps = useImeSafeControlledValue<HTMLInputElement>({
    value,
    onChange: (event) => onChange(event.target.value),
  });

  useEffect(() => {
    if (expandSeq !== lastExpandSeqRef.current) {
      lastExpandSeqRef.current = expandSeq;
      if (!disabled) {
        setExpanded(true);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    }
  }, [disabled, expandSeq]);

  if (!isOpen) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            disabled={disabled}
            aria-label={resolvedLabel}
            aria-expanded={false}
            data-desktop-header-search-trigger="true"
            className={cn(
              'desktop-shell-action-icon text-muted-foreground hover:text-foreground',
              coarseHitClassFor28,
              className,
            )}
            onClick={() => {
              setExpanded(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            <MagnifyingGlass size={15} />
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{resolvedLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      data-desktop-header-search="open"
      className={cn('relative flex w-44 min-w-[112px] shrink items-center', className)}
    >
      <MagnifyingGlass
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/65"
      />
      <input
        ref={inputRef}
        type="search"
        {...inputProps}
        {...inputDataAttrs}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={resolvedLabel}
        onKeyDown={(event) => {
          if (isComposingKeyEvent(event)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            if (value) {
              onChange('');
            }
            setExpanded(false);
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          // 点击自身清空按钮时不提前折叠
          const related = event.relatedTarget as HTMLElement | null;
          if (related && event.currentTarget.parentElement?.contains(related)) {
            return;
          }
          if (!value) {
            setExpanded(false);
          }
        }}
        className={cn(
          'desktop-shell-header-search-input w-full appearance-none rounded-lg border border-transparent',
          'bg-[color:var(--interactive-hover)]/75 pl-8 text-ui text-foreground outline-none',
          'placeholder:text-muted-foreground/55 transition-colors',
          'focus:border-[color:var(--border)] focus:bg-background',
          '[&::-webkit-search-cancel-button]:hidden',
          value ? 'pr-7' : 'pr-2.5',
        )}
      />
      {value ? (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('common:actions.clear', { defaultValue: '清空' })}
          className={cn(
            'desktop-shell-search-clear absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground',
            coarseHitClassFor28,
          )}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <X size={12} />
        </DsButton>
      ) : null}
    </div>
  );
};
