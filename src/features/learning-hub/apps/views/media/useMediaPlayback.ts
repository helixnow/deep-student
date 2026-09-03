/**
 * useMediaPlayback — 音视频播放器共享状态 Hook
 *
 * 封装 HTMLMediaElement 的播放状态与控制动作：
 * - 播放/暂停、进度、时长、缓冲区间
 * - 音量 + 静音（localStorage 记忆，音视频共享同一偏好）
 * - 倍速、循环
 * - 缓冲指示（waiting/playing）
 * - isActive=false 时自动暂停（非活跃标签页不出声）
 * - 卸载时释放媒体解码器资源（pause + removeAttribute + load）
 *
 * 使用方以 key={src} 重挂载组件，保证切源时状态从零开始。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 可选倍速档位 */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const VOLUME_STORAGE_KEY = 'dstu-media-player-volume';
const RATE_STORAGE_KEY = 'dstu-media-player-rate';

/** 播放进度写入 React state 的最小间隔（约 10Hz，避免 60fps 全量重渲染） */
export const PROGRESS_COMMIT_INTERVAL_MS = 100;

interface StoredVolume {
  volume: number;
  muted: boolean;
}

function loadStoredVolume(): StoredVolume {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredVolume>;
      if (typeof parsed.volume === 'number' && isFinite(parsed.volume)) {
        return {
          volume: Math.min(1, Math.max(0, parsed.volume)),
          muted: Boolean(parsed.muted),
        };
      }
    }
  } catch {
    // localStorage 不可用时使用默认音量
  }
  return { volume: 1, muted: false };
}

function saveStoredVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // 持久化失败不影响播放
  }
}

function loadStoredRate(): number {
  try {
    const parsed = Number(localStorage.getItem(RATE_STORAGE_KEY));
    // 仅接受当前档位集合内的值，避免旧版本残留的任意倍速
    if ((PLAYBACK_RATES as readonly number[]).includes(parsed)) {
      return parsed;
    }
  } catch {
    // localStorage 不可用时使用默认倍速
  }
  return 1;
}

function saveStoredRate(rate: number): void {
  try {
    localStorage.setItem(RATE_STORAGE_KEY, String(rate));
  } catch {
    // 持久化失败不影响播放
  }
}

export interface UseMediaPlaybackOptions {
  /** 媒体源 URL（filestream:// 转换后的 URL 或 blob URL） */
  src: string;
  /** 所属标签页是否活跃；变为 false 时自动暂停 */
  isActive?: boolean;
  /** 媒体加载/解码失败回调 */
  onError?: () => void;
}

export function useMediaPlayback<T extends HTMLMediaElement>({
  src,
  isActive = true,
  onError,
}: UseMediaPlaybackOptions) {
  const mediaRef = useRef<T | null>(null);
  const storedRef = useRef<StoredVolume>(loadStoredVolume());
  const storedRateRef = useRef(loadStoredRate());

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolumeState] = useState(storedRef.current.volume);
  const [muted, setMutedState] = useState(storedRef.current.muted);
  const [rate, setRateState] = useState(storedRateRef.current);
  const [loop, setLoopState] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // 装载新媒体源时应用持久化的音量/倍速偏好
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = storedRef.current.volume;
    el.muted = storedRef.current.muted;
    el.playbackRate = storedRateRef.current;
  }, [src]);

  // 事件订阅：跟随 src 重建，保证状态与当前源一致
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    setIsReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setIsBuffering(false);

    const updateBuffered = () => {
      try {
        const ranges = el.buffered;
        if (ranges.length > 0) {
          setBufferedEnd(ranges.end(ranges.length - 1));
        }
      } catch {
        // 部分状态下 buffered ranges 不可读
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(isFinite(el.duration) ? el.duration : 0);
      setIsReady(true);
      updateBuffered();
    };
    const handleDurationChange = () => {
      setDuration(isFinite(el.duration) ? el.duration : 0);
    };
    const handleTimeUpdate = () => {
      setCurrentTime(el.currentTime);
      updateBuffered();
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    const handleWaiting = () => setIsBuffering(true);
    const handlePlaying = () => setIsBuffering(false);
    const handleCanPlay = () => setIsBuffering(false);
    const handleProgress = () => updateBuffered();
    const handleVolumeChange = () => {
      setVolumeState(el.volume);
      setMutedState(el.muted);
    };
    const handleError = () => {
      setIsBuffering(false);
      onErrorRef.current?.();
    };

    el.addEventListener('loadedmetadata', handleLoadedMetadata);
    el.addEventListener('durationchange', handleDurationChange);
    el.addEventListener('timeupdate', handleTimeUpdate);
    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);
    el.addEventListener('waiting', handleWaiting);
    el.addEventListener('playing', handlePlaying);
    el.addEventListener('canplay', handleCanPlay);
    el.addEventListener('progress', handleProgress);
    el.addEventListener('volumechange', handleVolumeChange);
    el.addEventListener('error', handleError);

    return () => {
      el.removeEventListener('loadedmetadata', handleLoadedMetadata);
      el.removeEventListener('durationchange', handleDurationChange);
      el.removeEventListener('timeupdate', handleTimeUpdate);
      el.removeEventListener('play', handlePlay);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
      el.removeEventListener('waiting', handleWaiting);
      el.removeEventListener('playing', handlePlaying);
      el.removeEventListener('canplay', handleCanPlay);
      el.removeEventListener('progress', handleProgress);
      el.removeEventListener('volumechange', handleVolumeChange);
      el.removeEventListener('error', handleError);
    };
  }, [src]);

  // 播放中刷新进度：timeupdate 仅约 4Hz（细进度条明显跳动），rAF 又是 60Hz
  // 的 React 重渲染（进度条/时间标签整棵子树每帧 render）。折中为 ~10Hz：
  // 视觉上足够平滑，渲染成本降为 rAF 直驱的 1/6。
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastCommit = 0;
    const tick = (now: number) => {
      if (now - lastCommit >= PROGRESS_COMMIT_INTERVAL_MS) {
        lastCommit = now;
        const el = mediaRef.current;
        if (el) {
          setCurrentTime(el.currentTime);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  // 卸载时释放媒体解码器与缓冲区
  useEffect(() => {
    return () => {
      const el = mediaRef.current;
      if (!el) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, []);

  // 非活跃标签页自动暂停
  useEffect(() => {
    if (!isActive) {
      mediaRef.current?.pause();
    }
  }, [isActive]);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch((err: unknown) => {
        // pause()/切源打断 play() 时以 AbortError reject，并非真正的播放失败
        if ((err as DOMException | null)?.name === 'AbortError') return;
        onErrorRef.current?.();
      });
    } else {
      el.pause();
    }
  }, []);

  const seekTo = useCallback((time: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const max = isFinite(el.duration) ? el.duration : time;
    const clamped = Math.min(Math.max(0, time), max);
    el.currentTime = clamped;
    setCurrentTime(clamped);
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const el = mediaRef.current;
      if (!el) return;
      seekTo(el.currentTime + delta);
    },
    [seekTo],
  );

  const setVolume = useCallback((next: number) => {
    const el = mediaRef.current;
    const clamped = Math.min(1, Math.max(0, next));
    if (el) {
      el.volume = clamped;
      if (clamped > 0 && el.muted) {
        el.muted = false;
      }
    }
    setVolumeState(clamped);
    const nextMuted = clamped > 0 ? false : (el?.muted ?? false);
    setMutedState(nextMuted);
    saveStoredVolume(clamped, nextMuted);
  }, []);

  const toggleMute = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    const nextMuted = !el.muted;
    el.muted = nextMuted;
    setMutedState(nextMuted);
    saveStoredVolume(el.volume, nextMuted);
  }, []);

  const setRate = useCallback((next: number) => {
    const el = mediaRef.current;
    if (el) {
      el.playbackRate = next;
    }
    storedRateRef.current = next;
    setRateState(next);
    saveStoredRate(next);
  }, []);

  const toggleLoop = useCallback(() => {
    const el = mediaRef.current;
    setLoopState((prev) => {
      const next = !prev;
      if (el) {
        el.loop = next;
      }
      return next;
    });
  }, []);

  return {
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
  };
}
