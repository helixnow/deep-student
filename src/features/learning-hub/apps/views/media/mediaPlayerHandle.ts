/**
 * 播放器对外句柄：转写面板 / 引用跳转 / 帧截取 / 断点续播需要直接驱动媒体元素，
 * 但播放状态仍由播放器内部的 useMediaPlayback 维护（单一状态源）。
 */

export interface MediaPlayerHandle {
  getElement(): HTMLMediaElement | null;
  /** 跳到指定秒（自动钳制到 [0, duration]） */
  seekTo(seconds: number): void;
  play(): void;
  pause(): void;
}

export interface MediaPlayerStatus {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isReady: boolean;
}
