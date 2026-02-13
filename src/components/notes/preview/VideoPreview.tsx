/**
 * VideoPreview - 视频预览组件
 *
 * 使用 HTML5 <video> 元素实现视频预览，支持：
 * - 播放/暂停控制
 * - 进度条拖动
 * - 音量控制
 * - 全屏播放
 * - 响应式布局
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '../../ui/shad/Skeleton';
import { NotionButton } from '../../ui/NotionButton';
import { Slider } from '../../ui/shad/Slider';
import {
  AlertCircle,
  Video,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Loader2,
} from 'lucide-react';
import type { VideoPreviewProps } from './types';
import { formatMediaTime as formatTime } from '../../learning-hub/apps/views/previewUtils';

/**
 * 视频预览骨架屏
 */
const VideoSkeleton: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
    <Skeleton className="aspect-video w-full max-w-2xl rounded-lg" />
    <div className="flex w-full max-w-2xl flex-col gap-2">
      <Skeleton className="h-2 w-full" />
      <div className="flex justify-center gap-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
    </div>
  </div>
);

/**
 * 视频预览组件
 */
export const VideoPreview: React.FC<VideoPreviewProps> = ({
  videoUrl,
  title,
  mimeType,
  posterUrl,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes']);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 状态
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [videoLoading, setVideoLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  
  // 控制栏自动隐藏计时器
  const hideControlsTimer = useRef<NodeJS.Timeout | null>(null);

  // 播放/暂停
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(() => {
        setVideoError(true);
      });
    }
  }, [isPlaying]);

  // 跳转到指定时间
  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
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
    const video = videoRef.current;
    if (video) {
      video.volume = newVolume;
    }
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
    }
  }, [isMuted]);

  // 切换静音
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    
    if (isMuted) {
      video.muted = false;
      setIsMuted(false);
    } else {
      video.muted = true;
      setIsMuted(true);
    }
  }, [isMuted]);

  // 进度条拖动
  const handleProgressChange = useCallback((value: number[]) => {
    seekTo(value[0]);
  }, [seekTo]);

  // 切换全屏
  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // 全屏 API 不可用，静默处理
    }
  }, []);

  // 显示控制栏
  const showControlsWithTimeout = useCallback(() => {
    setShowControls(true);
    
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    
    // 播放时 3 秒后自动隐藏
    if (isPlaying) {
      hideControlsTimer.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  // 视频事件处理
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
    };

    const handleDurationChange = () => {
      setDuration(video.duration);
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setVideoLoading(false);
      setVideoError(false);
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
      setShowControls(true);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      setShowControls(true);
    };

    const handleError = () => {
      setVideoLoading(false);
      setVideoError(true);
    };

    const handleCanPlay = () => {
      setVideoLoading(false);
      setIsBuffering(false);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
    };

    const handlePlaying = () => {
      setIsBuffering(false);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);

    return () => {
      // 🔒 审计修复: 卸载时释放视频媒体资源（暂停 + 清除 src + 强制释放缓冲）
      video.pause();
      video.removeAttribute('src');
      video.load(); // 强制释放缓冲区
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
    };
  }, []);

  // ★ 全屏状态监听（绑定在容器级）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    container.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      container.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // 清理计时器
  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) {
        clearTimeout(hideControlsTimer.current);
      }
    };
  }, []);

  // ★ 键盘快捷键 - 使用容器级事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        skipBackward();
        break;
      case 'ArrowRight':
        e.preventDefault();
        skipForward();
        break;
      case 'm':
        e.preventDefault();
        toggleMute();
        break;
      case 'f':
        e.preventDefault();
        toggleFullscreen();
        break;
    }
  }, [togglePlay, skipBackward, skipForward, toggleMute, toggleFullscreen]);

  // 加载状态
  if (loading) {
    return (
      <div className={cn('h-full', className)}>
        <VideoSkeleton />
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
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  // 空 URL
  if (!videoUrl) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <Video className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t('notes:previewPanel.video.noVideo')}
        </p>
      </div>
    );
  }

  // 获取音量图标
  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full flex-col items-center justify-center bg-black outline-none',
        isFullscreen && 'fixed inset-0 z-50',
        className
      )}
      onMouseMove={showControlsWithTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* 标题栏（仅全屏时显示） */}
      {isFullscreen && showControls && title && (
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-4 z-10">
          <h3 className="text-white text-lg font-medium line-clamp-1">{title}</h3>
        </div>
      )}

      {/* 视频元素 */}
      <video
        ref={videoRef}
        src={videoUrl}
        poster={posterUrl}
        preload="metadata"
        className="max-h-full max-w-full object-contain"
        onClick={togglePlay}
      />

      {/* 视频加载失败 */}
      {videoError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <p className="text-sm text-white">
            {t('notes:previewPanel.video.loadError')}
          </p>
        </div>
      )}

      {/* 缓冲指示器 */}
      {isBuffering && !videoError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-12 w-12 animate-spin text-white" />
        </div>
      )}

      {/* 中央播放按钮（暂停时显示） */}
      {!isPlaying && !videoError && !videoLoading && (
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onClick={togglePlay}
        >
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/90 hover:bg-primary transition-colors">
            <Play className="h-10 w-10 text-primary-foreground ml-1" />
          </div>
        </div>
      )}

      {/* 控制栏 */}
      {!videoError && (
        <div
          className={cn(
            'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-4 transition-opacity duration-300',
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        >
          {/* 进度条 */}
          <div className="mb-3">
            <Slider
              value={[currentTime]}
              max={duration || 100}
              step={0.1}
              onValueChange={handleProgressChange}
              disabled={videoLoading}
              className="w-full"
            />
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* 播放/暂停 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-white hover:bg-white/20"
                onClick={togglePlay}
                disabled={videoLoading}
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5 ml-0.5" />
                )}
              </NotionButton>

              {/* 快退 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-white hover:bg-white/20"
                onClick={skipBackward}
                disabled={videoLoading}
              >
                <SkipBack className="h-4 w-4" />
              </NotionButton>

              {/* 快进 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-white hover:bg-white/20"
                onClick={skipForward}
                disabled={videoLoading}
              >
                <SkipForward className="h-4 w-4" />
              </NotionButton>

              {/* 时间显示 */}
              <span className="text-sm text-white ml-2">
                {formatTime(currentTime)} / {videoLoading ? '--:--' : formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* 音量控制 */}
              <div className="flex items-center gap-1 group">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0 text-white hover:bg-white/20"
                  onClick={toggleMute}
                >
                  <VolumeIcon className="h-4 w-4" />
                </NotionButton>
                <div className="w-0 overflow-hidden group-hover:w-20 transition-all duration-200">
                  <Slider
                    value={[isMuted ? 0 : volume]}
                    max={1}
                    step={0.01}
                    onValueChange={handleVolumeChange}
                    className="w-full"
                  />
                </div>
              </div>

              {/* 全屏 */}
              <NotionButton
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-white hover:bg-white/20"
                onClick={toggleFullscreen}
              >
                {isFullscreen ? (
                  <Minimize className="h-4 w-4" />
                ) : (
                  <Maximize className="h-4 w-4" />
                )}
              </NotionButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPreview;
