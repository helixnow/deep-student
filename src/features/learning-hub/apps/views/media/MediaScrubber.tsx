/**
 * MediaScrubber — 媒体进度条
 *
 * 相比通用 Slider 额外支持：
 * - 缓冲区间显示（双层轨道）
 * - hover/拖拽时轨道增高 + 显示 thumb（IINA 式安静默认态）
 * - overlay 外观（视频黑底悬浮控制条上使用白色系）
 * - 键盘 ←/→ ±5s、Home/End
 * - 时间标记（课中检查点 / 章节起点）与区间高亮（薄弱片段），只做展示不拦截拖动
 * - YouTube/Bilibili 级 160ms 延迟防抖缩略图预览 + 160px 横竖屏封顶尺寸 + 首帧未就绪防黑块闪烁
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import { formatMediaTime } from '../previewUtils';
import {
  HoverThumbnailPreviewController,
  type HoverPreviewSnapshot,
} from './playerMicroInteractions';

export interface MediaScrubberMarker {
  /** 秒 */
  at: number;
  /** checkpoint=课中检查点（按作答状态着色）；chapter=章节起点 */
  kind: 'checkpoint' | 'chapter';
  state?: 'pending' | 'correct' | 'wrong';
}

export interface MediaScrubberRange {
  /** 秒 */
  from: number;
  to: number;
}

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
  markers?: readonly MediaScrubberMarker[];
  /** 需要回看的区间（答错的检查点附近） */
  highlightRanges?: readonly MediaScrubberRange[];
  /** 可选：用于悬停 160ms 后解码预览帧的视频源 URL */
  previewSrc?: string;
  /** 可选：预览视频跨域属性 */
  previewCrossOrigin?: 'anonymous';
}

const MARKER_TONE: Record<NonNullable<MediaScrubberMarker['state']>, string> = {
  pending: 'bg-amber-400',
  correct: 'bg-emerald-500',
  wrong: 'bg-destructive',
};

export const MediaScrubber: React.FC<MediaScrubberProps> = ({
  currentTime,
  duration,
  bufferedEnd = 0,
  disabled = false,
  appearance = 'default',
  ariaLabel,
  onSeek,
  className,
  markers,
  highlightRanges,
  previewSrc,
  previewCrossOrigin,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekTimeRef = useRef<number>(0);
  const [isDragging, setIsDragging] = useState(false);

  const applyPreviewSeek = useCallback((targetTime: number) => {
    pendingSeekTimeRef.current = targetTime;
    const video = previewVideoRef.current;
    if (!video) return;
    try {
      if (Math.abs(video.currentTime - targetTime) >= 0.05) {
        video.currentTime = targetTime;
      }
    } catch {
      // 元数据未就绪时由 onLoadedMetadata 补做一次 seek
    }
  }, []);

  const hoverControllerRef = useRef<HoverThumbnailPreviewController | null>(null);
  if (hoverControllerRef.current === null) {
    hoverControllerRef.current = new HoverThumbnailPreviewController({
      onDecodeRequest: (targetTime) => {
        applyPreviewSeek(targetTime);
      },
      onStateChange: (snapshot) => {
        setHoverSnapshot(snapshot);
      },
    });
  }

  const [hoverSnapshot, setHoverSnapshot] = useState<HoverPreviewSnapshot>(() =>
    hoverControllerRef.current!.getSnapshot(),
  );

  useEffect(() => {
    const controller = hoverControllerRef.current;
    return () => {
      controller?.dispose();
    };
  }, []);

  // 切换视频源时重置悬停预览状态
  useEffect(() => {
    hoverControllerRef.current?.leaveHover();
  }, [previewSrc]);

  // 预览解码激活且 DOM 挂载后，立即同步一次目标时间
  useEffect(() => {
    if (hoverSnapshot.isDecodeActive && previewSrc) {
      applyPreviewSeek(hoverSnapshot.targetTime);
    }
  }, [hoverSnapshot.isDecodeActive, hoverSnapshot.targetTime, previewSrc, applyPreviewSeek]);

  const seekable = !disabled && isFinite(duration) && duration > 0;

  const updateHoverFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || !isFinite(duration) || duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const trackWidth = rect.width > 0 ? rect.width : track.clientWidth || 160;
      const pointerOffsetX = clientX - rect.left;
      hoverControllerRef.current?.updateHover({
        pointerOffsetX,
        trackWidth,
        duration,
      });
    },
    [duration],
  );

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

  const handlePointerEnter = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!seekable) return;
      const pointerType =
        event.pointerType || (event.nativeEvent as { pointerType?: string })?.pointerType;
      if (pointerType === 'touch' && !isDragging) return;
      updateHoverFromClientX(event.clientX);
    },
    [seekable, isDragging, updateHoverFromClientX],
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
      updateHoverFromClientX(event.clientX);
      seekFromClientX(event.clientX);
    },
    [seekable, updateHoverFromClientX, seekFromClientX],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (seekable && (event.pointerType !== 'touch' || isDragging)) {
        updateHoverFromClientX(event.clientX);
      }
      if (!isDragging) return;
      seekFromClientX(event.clientX);
    },
    [seekable, isDragging, updateHoverFromClientX, seekFromClientX],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') {
        hoverControllerRef.current?.leaveHover();
      }
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

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') {
        hoverControllerRef.current?.leaveHover();
      }
      handlePointerUp(event);
      hoverControllerRef.current?.leaveHover();
    },
    [handlePointerUp],
  );

  const handlePointerLeave = useCallback(() => {
    hoverControllerRef.current?.leaveHover();
  }, []);

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
  const showHoverPreview = seekable && hoverSnapshot.isHovering;
  const showThumbnailVideo = Boolean(previewSrc) && hoverSnapshot.isDecodeActive;

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
        // 触屏命中区扩到 ≥44px（视觉轨道仍是细线，透明区域承担命中）
        '[@media(pointer:coarse)]:min-h-11',
        'rounded-full focus-visible:ring-2 focus-visible:ring-ring/40',
        seekable ? 'cursor-pointer' : 'cursor-default opacity-50',
        className,
      )}
      onPointerEnter={handlePointerEnter}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
    >
      {/* 悬停预览浮层：160ms 内仅展示时间胶囊，满 160ms 后挂载 160px 封顶缩略图解码器 */}
      {showHoverPreview && (
        <div
          aria-hidden="true"
          data-testid="scrubber-hover-preview"
          data-decode-active={showThumbnailVideo ? 'true' : 'false'}
          className="pointer-events-none absolute bottom-full z-30 mb-2.5 flex -translate-x-1/2 flex-col items-center"
          style={{ left: `${hoverSnapshot.clampedCenterX}px` }}
        >
          {showThumbnailVideo ? (
            <div
              data-testid="scrubber-preview-box"
              className="relative overflow-hidden rounded border border-white/40 bg-black shadow-lg"
              style={{
                width: `${hoverSnapshot.dimensions.width}px`,
                height: `${hoverSnapshot.dimensions.height}px`,
              }}
            >
              <video
                ref={previewVideoRef}
                data-testid="scrubber-preview-video"
                data-ready={hoverSnapshot.isFirstFrameReady ? 'true' : 'false'}
                src={previewSrc}
                crossOrigin={previewCrossOrigin}
                preload="metadata"
                muted
                playsInline
                className={cn(
                  'block h-full w-full object-cover transition-opacity duration-150 motion-reduce:transition-none',
                  hoverSnapshot.isFirstFrameReady ? 'opacity-100' : 'opacity-0',
                )}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth > 0 && video.videoHeight > 0) {
                    hoverControllerRef.current?.setVideoMetadata(
                      video.videoWidth,
                      video.videoHeight,
                    );
                  }
                  applyPreviewSeek(pendingSeekTimeRef.current);
                }}
                onLoadedData={() => {
                  hoverControllerRef.current?.markFirstFrameReady(true);
                }}
                onSeeked={() => {
                  hoverControllerRef.current?.markFirstFrameReady(true);
                }}
              />
              <span
                data-testid="scrubber-preview-time"
                className=" absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] leading-4 tabular-nums text-white"
              >
                {formatMediaTime(hoverSnapshot.targetTime)}
              </span>
            </div>
          ) : (
            <span
              data-testid="scrubber-preview-time"
              className="rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] leading-4 tabular-nums text-white shadow-sm"
            >
              {formatMediaTime(hoverSnapshot.targetTime)}
            </span>
          )}
        </div>
      )}

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
        {/* 需回看区间 */}
        {duration > 0 && highlightRanges?.map((range) => {
          const left = Math.max(0, Math.min(100, (range.from / duration) * 100));
          const right = Math.max(left, Math.min(100, (range.to / duration) * 100));
          return (
            <div
              key={`${range.from}-${range.to}`}
              aria-hidden="true"
              data-scrubber-range=""
              className="absolute inset-y-0 bg-destructive/45"
              style={{ left: `${left}%`, width: `${right - left}%` }}
            />
          );
        })}
        {/* 已播放层 */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            overlay ? 'bg-white' : 'bg-primary',
          )}
          style={{ width: `${playedPct}%` }}
        />
      </div>
      {/* 时间标记：检查点为圆点（按作答状态着色），章节为细竖线 */}
      {duration > 0 && markers?.map((marker, index) => (
        <span
          key={`${marker.kind}-${marker.at}-${index}`}
          aria-hidden="true"
          data-scrubber-marker={marker.kind}
          data-state={marker.state}
          className={cn(
            'pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2',
            marker.kind === 'checkpoint'
              ? cn('h-2 w-2 rounded-full ring-1', overlay ? 'ring-black/40' : 'ring-background', MARKER_TONE[marker.state ?? 'pending'])
              : cn('h-2.5 w-0.5 rounded-full', overlay ? 'bg-white/70' : 'bg-foreground/40'),
          )}
          style={{ left: `${Math.max(0, Math.min(100, (marker.at / duration) * 100))}%` }}
        />
      ))}
      {/* Thumb：默认隐藏，hover/拖拽/聚焦时淡入；触屏无 hover → 常显作为可拖提示 */}
      <div
        className={cn(
          'pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full',
          'opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
          'group-hover/scrubber:opacity-100 group-focus-visible/scrubber:opacity-100',
          seekable && '[@media(pointer:coarse)]:opacity-100',
          isDragging && 'opacity-100',
          overlay ? 'bg-white' : 'bg-primary',
        )}
        style={{ left: `${playedPct}%` }}
      />
    </div>
  );
};

export default MediaScrubber;
