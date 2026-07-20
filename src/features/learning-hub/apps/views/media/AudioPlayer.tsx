/**
 * AudioPlayer — 音频预览播放器（Learning Hub 文件预览）
 *
 * 居中卡片式布局：封面占位 + 文件名 + 进度条 + 控制条。
 * 能力：播放/暂停、±10s、可拖进度、倍速、循环、音量+静音（记忆）、
 * 快捷键（空格 / ← → / M）、缓冲指示。
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MusicNotes,
  Play,
  Pause,
  ArrowCounterClockwise,
  ArrowClockwise,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
  Repeat,
  CircleNotch,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Slider } from '@/components/ui/shad/Slider';
import { formatMediaTime } from '../previewUtils';
import { useMediaPlayback } from './useMediaPlayback';
import { MediaScrubber } from './MediaScrubber';
import { PlaybackRateMenu } from './PlaybackRateMenu';
import { isInteractiveShortcutTarget, SKIP_SECONDS } from './mediaShortcuts';

export interface AudioPlayerProps {
  src: string;
  fileName: string;
  /** 文件大小等附加信息（已格式化） */
  meta?: string;
  /** 格式兼容性提示（可能无法播放的容器/编码） */
  compatibilityHint?: string;
  /** 所属标签页是否活跃；false 时自动暂停 */
  isActive?: boolean;
  onError: () => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  src,
  fileName,
  meta,
  compatibilityHint,
  isActive = true,
  onError,
}) => {
  const { t } = useTranslation(['learningHub']);
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
  } = useMediaPlayback<HTMLAudioElement>({ src, isActive, onError });

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
        default:
          break;
      }
    },
    [togglePlay, seekBy, toggleMute],
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
  const showSpinner = !isReady || isBuffering;

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-background p-6">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 播放器容器承载快捷键 */}
      <div
        role="group"
        aria-label={fileName}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn(
          'ui-rise-in w-full max-w-md rounded-2xl border border-border bg-background p-6',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        )}
      >
        <audio ref={mediaRef} src={src} preload="metadata" />

        <div className="flex flex-col items-center gap-5">
          {/* 封面占位 */}
          <div className="flex h-36 w-36 items-center justify-center rounded-2xl bg-muted">
            <MusicNotes size={56} className="text-muted-foreground/60" aria-hidden="true" />
          </div>

          {/* 文件名 + 附加信息 */}
          <div className="w-full space-y-1 text-center">
            <h3 className="truncate text-sm font-medium text-foreground" title={fileName}>
              {fileName}
            </h3>
            {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
            {compatibilityHint && (
              <p className="text-xs text-warning">{compatibilityHint}</p>
            )}
          </div>

          {/* 进度条 + 时间 */}
          <div className="w-full space-y-1.5">
            <MediaScrubber
              currentTime={currentTime}
              duration={duration}
              bufferedEnd={bufferedEnd}
              disabled={!isReady}
              ariaLabel={t('learningHub:mediaPreview.progress')}
              onSeek={seekTo}
            />
            <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>{formatMediaTime(currentTime)}</span>
              <span>{isReady ? formatMediaTime(duration) : '--:--'}</span>
            </div>
          </div>

          {/* 控制条：左（倍速/循环）中（±10s/播放）右（音量） */}
          <div className="grid w-full grid-cols-3 items-center">
            <div className="flex items-center justify-start gap-0.5">
              <PlaybackRateMenu rate={rate} onRateChange={setRate} />
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('learningHub:mediaPreview.loop')}
                aria-pressed={loop}
                title={t('learningHub:mediaPreview.loop')}
                onClick={toggleLoop}
                className={cn('h-8 w-8', loop && 'bg-[var(--interactive-hover)] text-primary')}
              >
                <Repeat size={16} aria-hidden="true" />
              </DsButton>
            </div>

            <div className="flex items-center justify-center gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('learningHub:mediaPreview.skipBackward')}
                title={t('learningHub:mediaPreview.skipBackward')}
                onClick={() => seekBy(-SKIP_SECONDS)}
                disabled={!isReady}
                className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                <ArrowCounterClockwise size={16} aria-hidden="true" />
              </DsButton>

              <DsButton
                variant="primary"
                size="md"
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
                className="h-12 w-12 rounded-full"
              >
                {showSpinner ? (
                  <CircleNotch size={20} className="animate-spin" aria-hidden="true" />
                ) : isPlaying ? (
                  <Pause size={20} weight="fill" aria-hidden="true" />
                ) : (
                  <Play size={20} weight="fill" className="ml-0.5" aria-hidden="true" />
                )}
              </DsButton>

              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('learningHub:mediaPreview.skipForward')}
                title={t('learningHub:mediaPreview.skipForward')}
                onClick={() => seekBy(SKIP_SECONDS)}
                disabled={!isReady}
                className="h-9 w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                <ArrowClockwise size={16} aria-hidden="true" />
              </DsButton>
            </div>

            <div className="flex items-center justify-end gap-1">
              <DsButton
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
                className="h-8 w-8"
              >
                <VolumeIcon size={16} aria-hidden="true" />
              </DsButton>
              {/* 触屏隐藏 64px 微型滑杆（手指不可精确操作），保留静音钮；音量走系统控制 */}
              <Slider
                value={[muted ? 0 : volume]}
                max={1}
                step={0.05}
                onValueChange={handleVolumeSlider}
                aria-label={t('learningHub:mediaPreview.volume')}
                className="w-16 [@media(pointer:coarse)]:hidden"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AudioPlayer;
