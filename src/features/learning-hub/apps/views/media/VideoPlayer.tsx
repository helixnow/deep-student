/**
 * VideoPlayer — 视频预览播放器（Learning Hub 文件预览）
 *
 * 黑底沉浸式布局 + 悬浮控制条（播放时 2.5s 自动隐藏，隐藏时光标一并隐藏）。
 * 能力：播放/暂停、±10s、可拖进度（含缓冲显示）、倍速、循环、
 * 音量+静音（记忆，hover 展开滑杆）、全屏、快捷键（空格 / ← → / M / F）、
 * 缓冲指示、单击暂停 / 双击全屏。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Play,
  Pause,
  ArrowCounterClockwise,
  ArrowClockwise,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
  Repeat,
  ArrowsOut,
  ArrowsIn,
  CircleNotch,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Slider } from '@/components/ui/shad/Slider';
import { formatMediaTime } from '../previewUtils';
import { useMediaPlayback } from './useMediaPlayback';
import { MediaScrubber } from './MediaScrubber';
import { PlaybackRateMenu } from './PlaybackRateMenu';
import { isInteractiveShortcutTarget, SKIP_SECONDS } from './mediaShortcuts';

const HIDE_CONTROLS_DELAY_MS = 2500;

export interface VideoPlayerProps {
  src: string;
  fileName: string;
  /** 格式兼容性提示（可能无法播放的容器/编码） */
  compatibilityHint?: string;
  /** 所属标签页是否活跃；false 时自动暂停 */
  isActive?: boolean;
  onError: () => void;
}

/** 视频悬浮控制条上的图标按钮统一样式（白色系 overlay） */
const overlayButtonClass =
  'h-8 w-8 text-white hover:bg-[var(--overlay-control-hover)] hover:text-white';

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  fileName,
  compatibilityHint,
  isActive = true,
  onError,
}) => {
  const { t } = useTranslation(['learningHub']);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 倍速菜单打开期间控制条不自动隐藏（否则菜单会随控制条一起消失）
  const [rateMenuOpen, setRateMenuOpen] = useState(false);

  const {
    mediaRef,
    isPlaying,
    currentTime,
    duration,
    bufferedEnd,
    volume,
    muted,
    rate,
    loop,
    isBuffering,
    isReady,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    toggleMute,
    setRate,
    toggleLoop,
  } = useMediaPlayback<HTMLVideoElement>({ src, isActive, onError });

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    setShowControls(true);
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setShowControls(false);
    }, HIDE_CONTROLS_DELAY_MS);
  }, [clearHideTimer]);

  // 暂停 / 倍速菜单打开时控制条常驻；播放中依赖 mousemove 重新调度隐藏
  useEffect(() => {
    if (!isPlaying || rateMenuOpen) {
      clearHideTimer();
      setShowControls(true);
      return;
    }
    scheduleHideControls();
    return clearHideTimer;
  }, [isPlaying, rateMenuOpen, scheduleHideControls, clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  const handleMouseMove = useCallback(() => {
    if (isPlaying && !rateMenuOpen) {
      scheduleHideControls();
    }
  }, [isPlaying, rateMenuOpen, scheduleHideControls]);

  const handleMouseLeave = useCallback(() => {
    if (isPlaying && !rateMenuOpen) {
      clearHideTimer();
      setShowControls(false);
    }
  }, [isPlaying, rateMenuOpen, clearHideTimer]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // 全屏 API 不可用时静默降级
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const onControl = isInteractiveShortcutTarget(event.target);
      switch (event.key) {
        case ' ':
          if (onControl) return;
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          if (onControl) return;
          event.preventDefault();
          seekBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          if (onControl) return;
          event.preventDefault();
          seekBy(SKIP_SECONDS);
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          toggleMute();
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          void toggleFullscreen();
          break;
        default:
          break;
      }
    },
    [togglePlay, seekBy, toggleMute, toggleFullscreen],
  );

  const handleVolumeSlider = useCallback(
    (value: number[]) => {
      if (typeof value[0] === 'number') {
        setVolume(value[0]);
      }
    },
    [setVolume],
  );

  const VolumeIcon = muted || volume === 0 ? SpeakerX : volume < 0.5 ? SpeakerLow : SpeakerHigh;
  const controlsVisible = showControls || !isPlaying;

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={fileName}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'group relative flex h-full flex-col overflow-hidden bg-black outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/40',
        !controlsVisible && 'cursor-none',
      )}
    >
      {/* 双击全屏只挂在 video 上，避免快速双击控制条按钮误触全屏 */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 本地文件预览无字幕轨 */}
      <video
        ref={mediaRef}
        src={src}
        preload="metadata"
        className="absolute inset-0 h-full w-full object-contain"
        onClick={togglePlay}
        onDoubleClick={() => void toggleFullscreen()}
      />

      {/* 顶部信息条：文件名 +（可选）兼容性提示 */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/60 to-transparent px-4 pb-8 pt-3',
          'transition-opacity duration-150 motion-reduce:transition-none',
          controlsVisible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <p className="truncate text-sm font-medium text-white/90">{fileName}</p>
        {compatibilityHint && (
          <p className="mt-0.5 text-xs text-amber-300/90">{compatibilityHint}</p>
        )}
      </div>

      {/* 缓冲指示 */}
      {(isBuffering || !isReady) && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <CircleNotch size={40} className="animate-spin text-white/80" aria-hidden="true" />
        </div>
      )}

      {/* 中央播放按钮（暂停且非缓冲时显示） */}
      {!isPlaying && isReady && !isBuffering && (
        <button
          type="button"
          aria-label={t('learningHub:mediaPreview.play')}
          onClick={togglePlay}
          className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center outline-none"
        >
          <span data-wb-blur-surface className="ui-rise-in flex h-16 w-16 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm transition-colors duration-150 hover:bg-white/25 motion-reduce:transition-none">
            <Play size={28} weight="fill" className="ml-1 text-white" aria-hidden="true" />
          </span>
        </button>
      )}

      {/* 底部悬浮控制条 */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 via-black/35 to-transparent px-4 pb-3 pt-10',
          'transition-opacity duration-150 motion-reduce:transition-none',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <MediaScrubber
          currentTime={currentTime}
          duration={duration}
          bufferedEnd={bufferedEnd}
          disabled={!isReady}
          appearance="overlay"
          ariaLabel={t('learningHub:mediaPreview.progress')}
          onSeek={seekTo}
        />

        <div className="mt-1.5 flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={
              isPlaying
                ? t('learningHub:mediaPreview.pause')
                : t('learningHub:mediaPreview.play')
            }
            title={
              isPlaying
                ? t('learningHub:mediaPreview.pause')
                : t('learningHub:mediaPreview.play')
            }
            onClick={togglePlay}
            disabled={!isReady}
            className={overlayButtonClass}
          >
            {isPlaying ? (
              <Pause size={16} weight="fill" aria-hidden="true" />
            ) : (
              <Play size={16} weight="fill" aria-hidden="true" />
            )}
          </NotionButton>

          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('learningHub:mediaPreview.skipBackward')}
            title={t('learningHub:mediaPreview.skipBackward')}
            onClick={() => seekBy(-SKIP_SECONDS)}
            disabled={!isReady}
            className={overlayButtonClass}
          >
            <ArrowCounterClockwise size={16} aria-hidden="true" />
          </NotionButton>

          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('learningHub:mediaPreview.skipForward')}
            title={t('learningHub:mediaPreview.skipForward')}
            onClick={() => seekBy(SKIP_SECONDS)}
            disabled={!isReady}
            className={overlayButtonClass}
          >
            <ArrowClockwise size={16} aria-hidden="true" />
          </NotionButton>

          <span className="ml-1.5 text-xs tabular-nums text-white/90">
            {formatMediaTime(currentTime)}
            <span className="text-white/50"> / {isReady ? formatMediaTime(duration) : '--:--'}</span>
          </span>

          <div className="flex-1" />

          {/* 音量：按钮 + hover 展开滑杆 */}
          <div className="group/volume flex items-center gap-1">
            <NotionButton
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={
                muted
                  ? t('learningHub:mediaPreview.unmute')
                  : t('learningHub:mediaPreview.mute')
              }
              title={
                muted
                  ? t('learningHub:mediaPreview.unmute')
                  : t('learningHub:mediaPreview.mute')
              }
              onClick={toggleMute}
              className={overlayButtonClass}
            >
              <VolumeIcon size={16} aria-hidden="true" />
            </NotionButton>
            <div className="w-0 overflow-hidden transition-all duration-150 group-hover/volume:w-20 motion-reduce:transition-none">
              <Slider
                value={[muted ? 0 : volume]}
                max={1}
                step={0.05}
                onValueChange={handleVolumeSlider}
                aria-label={t('learningHub:mediaPreview.volume')}
                className="w-20"
              />
            </div>
          </div>

          <PlaybackRateMenu
            rate={rate}
            onRateChange={setRate}
            appearance="overlay"
            onOpenChange={setRateMenuOpen}
          />

          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('learningHub:mediaPreview.loop')}
            aria-pressed={loop}
            title={t('learningHub:mediaPreview.loop')}
            onClick={toggleLoop}
            className={cn(overlayButtonClass, loop && 'bg-[var(--overlay-control-hover)]')}
          >
            <Repeat size={16} aria-hidden="true" />
          </NotionButton>

          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={
              isFullscreen
                ? t('learningHub:mediaPreview.exitFullscreen')
                : t('learningHub:mediaPreview.fullscreen')
            }
            title={
              isFullscreen
                ? t('learningHub:mediaPreview.exitFullscreen')
                : t('learningHub:mediaPreview.fullscreen')
            }
            onClick={() => void toggleFullscreen()}
            className={overlayButtonClass}
          >
            {isFullscreen ? (
              <ArrowsIn size={16} aria-hidden="true" />
            ) : (
              <ArrowsOut size={16} aria-hidden="true" />
            )}
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

export default VideoPlayer;
