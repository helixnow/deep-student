/**
 * AudioPreview - 音频预览组件
 *
 * 使用 HTML5 <audio> 元素实现音频预览，支持：
 * - 播放/暂停控制
 * - 进度条拖动
 * - 音量控制
 * - 时长显示
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { Slider } from '@/components/ui/shad/Slider';
import {
  WarningCircle,
  MusicNote,
  Play,
  Pause,
  SpeakerHigh,
  SpeakerX,
  SpeakerLow,
  SkipBack,
  SkipForward,
} from '@phosphor-icons/react';
import type { AudioPreviewProps } from './types';
import { formatMediaTime as formatTime } from '@/features/learning-hub/apps/views/previewUtils';

/**
 * 音频预览骨架屏
 */
const AudioSkeleton: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
    <Skeleton className="h-24 w-24 rounded-full" />
    <Skeleton className="h-4 w-48" />
    <Skeleton className="h-2 w-full max-w-md" />
    <div className="flex gap-4">
      <Skeleton className="h-10 w-10 rounded-full" />
      <Skeleton className="h-10 w-10 rounded-full" />
      <Skeleton className="h-10 w-10 rounded-full" />
    </div>
  </div>
);

/**
 * 音频预览组件
 */
export const AudioPreview: React.FC<AudioPreviewProps> = ({
  audioUrl,
  title,
  mimeType,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes']);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  // 状态
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [audioLoading, setAudioLoading] = useState(true);

  // 播放/暂停
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {
        setAudioError(true);
      });
    }
  }, [isPlaying]);

  // 跳转到指定时间
  const seekTo = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  // 快退 10 秒
  const skipBackward = useCallback(() => {
    seekTo(Math.max(0, currentTime - 10));
  }, [currentTime, seekTo]);

  // 快进 10 秒
  const skipForward = useCallback(() => {
    seekTo(Math.min(duration, currentTime + 10));
  }, [currentTime, duration, seekTo]);

  // 设置音量
  const handleVolumeChange = useCallback((value: number[]) => {
    const newVolume = value[0];
    const audio = audioRef.current;
    if (audio) {
      audio.volume = newVolume;
    }
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
    }
  }, [isMuted]);

  // 切换静音
  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    
    if (isMuted) {
      audio.muted = false;
      setIsMuted(false);
    } else {
      audio.muted = true;
      setIsMuted(true);
    }
  }, [isMuted]);

  // 进度条拖动
  const handleProgressChange = useCallback((value: number[]) => {
    seekTo(value[0]);
  }, [seekTo]);

  // 音频事件处理
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleDurationChange = () => {
      setDuration(audio.duration);
    };

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      setAudioLoading(false);
      setAudioError(false);
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handleError = () => {
      setAudioLoading(false);
      setAudioError(true);
    };

    const handleCanPlay = () => {
      setAudioLoading(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    audio.addEventListener('canplay', handleCanPlay);

    return () => {
      // 🔒 审计修复: 卸载时释放媒体资源（暂停 + 清除 src + 强制释放缓冲）
      // 原代码仅移除事件监听器，未释放底层媒体解码器和网络连接
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // 强制释放缓冲区
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('canplay', handleCanPlay);
    };
  }, []);

  // 加载状态
  if (loading) {
    return (
      <div className={cn('h-full', className)}>
        <AudioSkeleton />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <WarningCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  // 空 URL
  if (!audioUrl) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <MusicNote className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t('notes:previewPanel.audio.noAudio')}
        </p>
      </div>
    );
  }

  // 获取音量图标
  const VolumeIcon = isMuted || volume === 0 ? SpeakerX : volume < 0.5 ? SpeakerLow : SpeakerHigh;

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center p-6',
        className
      )}
    >
      {/* 隐藏的音频元素 */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
      />

      {/* 音频可视化区域 */}
      <div className="flex flex-col items-center gap-6 w-full max-w-md">
        {/* 图标/封面 */}
        <div className="flex h-32 w-32 items-center justify-center rounded-full bg-primary/10">
          <MusicNote className="h-16 w-16 text-primary" />
        </div>

        {/* 标题 */}
        {title && (
          <h3 className="text-lg font-medium text-foreground text-center line-clamp-2">
            {title}
          </h3>
        )}

        {/* 音频加载失败 */}
        {audioError && (
          <div className="flex flex-col items-center gap-2 text-center">
            <WarningCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-muted-foreground">
              {t('notes:previewPanel.audio.loadError')}
            </p>
          </div>
        )}

        {/* 播放器控制 */}
        {!audioError && (
          <>
            {/* 进度条 */}
            <div className="w-full space-y-2">
              <Slider
                value={[currentTime]}
                max={duration || 100}
                step={0.1}
                onValueChange={handleProgressChange}
                disabled={audioLoading}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{audioLoading ? '--:--' : formatTime(duration)}</span>
              </div>
            </div>

            {/* 播放控制按钮 */}
            <div className="flex items-center gap-2">
              {/* 快退 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-10 w-10 p-0"
                onClick={skipBackward}
                disabled={audioLoading}
                title={t('notes:previewPanel.audio.skipBack')}
              >
                <SkipBack className="h-5 w-5" />
              </NotionButton>

              {/* 播放/暂停 */}
              <NotionButton
                variant="primary"
                size="md"
                className="h-14 w-14 rounded-full p-0"
                onClick={togglePlay}
                disabled={audioLoading}
                title={isPlaying 
                  ? t('notes:previewPanel.audio.pause') 
                  : t('notes:previewPanel.audio.play')
                }
              >
                {isPlaying ? (
                  <Pause className="h-7 w-7" />
                ) : (
                  <Play className="h-7 w-7 ml-1" />
                )}
              </NotionButton>

              {/* 快进 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-10 w-10 p-0"
                onClick={skipForward}
                disabled={audioLoading}
                title={t('notes:previewPanel.audio.skipForward')}
              >
                <SkipForward className="h-5 w-5" />
              </NotionButton>
            </div>

            {/* 音量控制 */}
            <div className="flex items-center gap-2 w-full max-w-[200px]">
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 shrink-0"
                onClick={toggleMute}
                title={isMuted 
                  ? t('notes:previewPanel.audio.unmute') 
                  : t('notes:previewPanel.audio.mute')
                }
              >
                <VolumeIcon className="h-4 w-4" />
              </NotionButton>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="flex-1"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default AudioPreview;
