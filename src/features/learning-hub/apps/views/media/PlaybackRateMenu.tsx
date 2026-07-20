/**
 * PlaybackRateMenu — 倍速选择（Popover 菜单）
 *
 * 视频全屏时 body portal 不在 top layer 内，因此 overlay 外观使用
 * portal={false} 并锚定在触发器上方，保证全屏内可见。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from '@phosphor-icons/react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/shad/Popover';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { PLAYBACK_RATES } from './useMediaPlayback';

export interface PlaybackRateMenuProps {
  rate: number;
  onRateChange: (rate: number) => void;
  appearance?: 'default' | 'overlay';
  /** 菜单开合通知（视频控制条据此在菜单打开期间暂停自动隐藏） */
  onOpenChange?: (open: boolean) => void;
}

const formatRate = (rate: number): string => `${rate}×`;

export const PlaybackRateMenu: React.FC<PlaybackRateMenuProps> = ({
  rate,
  onRateChange,
  appearance = 'default',
  onOpenChange,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [open, setOpen] = useState(false);
  const overlay = appearance === 'overlay';
  const label = t('learningHub:mediaPreview.playbackRate');

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <NotionButton
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          className={cn(
            'h-8 px-2 text-xs font-medium tabular-nums',
            overlay && 'text-white hover:bg-[var(--overlay-control-hover)]',
          )}
        >
          {formatRate(rate)}
        </NotionButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        portal={!overlay}
        className={cn('min-w-[104px] p-1', overlay && 'bottom-full mb-2')}
      >
        {PLAYBACK_RATES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onRateChange(option);
              handleOpenChange(false);
            }}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs tabular-nums',
              'transition-colors duration-150 motion-reduce:transition-none',
              'hover:bg-[var(--interactive-hover)]',
              option === rate ? 'font-medium text-primary' : 'text-foreground',
            )}
          >
            <span>{formatRate(option)}</span>
            {option === rate && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
};

export default PlaybackRateMenu;
