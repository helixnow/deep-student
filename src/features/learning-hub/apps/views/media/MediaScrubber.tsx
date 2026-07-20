/**
 * MediaScrubber — 媒体进度条
 *
 * 相比通用 Slider 额外支持：
 * - 缓冲区间显示（双层轨道）
 * - hover/拖拽时轨道增高 + 显示 thumb（IINA 式安静默认态）
 * - overlay 外观（视频黑底悬浮控制条上使用白色系）
 * - 键盘 ←/→ ±5s、Home/End
 */

import React, { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface MediaScrubberProps {
  currentTime: number;
  duration: number;
  /** 已缓冲末端（秒） */
  bufferedEnd?: number;
  disabled?: boolean;
  /** default=安静原生风（语义色）；overlay=视频悬浮控制条（白色系） */
  appearance?: 'default' | 'overlay';
  ariaLabel: string;
  onSeek: (time: number) => void;
  className?: string;
}

export const MediaScrubber: React.FC<MediaScrubberProps> = ({
  currentTime,
  duration,
  bufferedEnd = 0,
  disabled = false,
  appearance = 'default',
  ariaLabel,
  onSeek,
  className,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const seekable = !disabled && isFinite(duration) && duration > 0;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || !isFinite(duration) || duration <= 0) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!seekable) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // pointer capture 不可用时退化为点击定位
      }
      setIsDragging(true);
      seekFromClientX(event.clientX);
    },
    [seekable, seekFromClientX],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      seekFromClientX(event.clientX);
    },
    [isDragging, seekFromClientX],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      setIsDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // capture 已释放时忽略
      }
    },
    [isDragging],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!seekable) return;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          onSeek(Math.max(0, currentTime - 5));
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          onSeek(Math.min(duration, currentTime + 5));
          break;
        case 'Home':
          event.preventDefault();
          onSeek(0);
          break;
        case 'End':
          event.preventDefault();
          onSeek(duration);
          break;
        default:
          break;
      }
    },
    [seekable, currentTime, duration, onSeek],
  );

  const playedPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0;
  const overlay = appearance === 'overlay';

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.floor(duration))}
      aria-valuenow={Math.max(0, Math.floor(currentTime))}
      aria-disabled={!seekable || undefined}
      tabIndex={seekable ? 0 : -1}
      className={cn(
        'group/scrubber relative flex h-4 w-full touch-none select-none items-center outline-none',
        'rounded-full focus-visible:ring-2 focus-visible:ring-ring/40',
        seekable ? 'cursor-pointer' : 'cursor-default opacity-50',
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          'relative h-1 w-full overflow-hidden rounded-full transition-[height] duration-150 motion-reduce:transition-none',
          'group-hover/scrubber:h-1.5',
          isDragging && 'h-1.5',
          overlay ? 'bg-white/20' : 'bg-muted',
        )}
      >
        {/* 缓冲层 */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            overlay ? 'bg-white/30' : 'bg-muted-foreground/25',
          )}
          style={{ width: `${bufferedPct}%` }}
        />
        {/* 已播放层 */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            overlay ? 'bg-white' : 'bg-primary',
          )}
          style={{ width: `${playedPct}%` }}
        />
      </div>
      {/* Thumb：默认隐藏，hover/拖拽/聚焦时淡入 */}
      <div
        className={cn(
          'pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full',
          'opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
          'group-hover/scrubber:opacity-100 group-focus-visible/scrubber:opacity-100',
          isDragging && 'opacity-100',
          overlay ? 'bg-white' : 'bg-primary',
        )}
        style={{ left: `${playedPct}%` }}
      />
    </div>
  );
};

export default MediaScrubber;
