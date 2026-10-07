/**
 * QualityMenu — 清晰度选择（视频悬浮控制条，外观与倍速菜单一致）
 *
 * 全屏时 body portal 不在 top layer 内，所以与倍速菜单一样 portal={false}、锚定在触发器上方。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from '@phosphor-icons/react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/shad/Popover';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';

export interface QualityMenuOption {
  value: number;
  label: string;
}

export interface QualityMenuProps {
  options: QualityMenuOption[];
  /** 正在播放的档位（可能是降档后的实际档位） */
  value: number;
  onChange: (value: number) => void;
  /** 菜单开合通知（视频控制条据此在菜单打开期间暂停自动隐藏） */
  onOpenChange?: (open: boolean) => void;
}

export const QualityMenu: React.FC<QualityMenuProps> = ({ options, value, onChange, onOpenChange }) => {
  const { t } = useTranslation(['learningHub']);
  const [open, setOpen] = useState(false);
  const label = t('learningHub:mediaBilibili.playback.quality');
  const currentLabel = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={`${label}: ${currentLabel}`}
          title={label}
          data-media-quality={value}
          className="h-8 px-2 text-xs font-medium tabular-nums text-white hover:bg-[var(--overlay-control-hover)] hover:text-white"
        >
          {currentLabel}
        </DsButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" portal={false} className="bottom-full mb-2 min-w-[104px] p-1">
        <div role="menu" aria-label={label}>
          {options.map((option) => (
            <DsButton
              key={option.value}
              variant="ghost"
              size="sm"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                handleOpenChange(false);
                if (option.value !== value) onChange(option.value);
              }}
              className={cn(
                'flex h-auto w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-xs tabular-nums',
                'hover:bg-[var(--interactive-hover)]',
                option.value === value ? 'font-medium text-primary' : 'text-foreground',
              )}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </DsButton>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default QualityMenu;
