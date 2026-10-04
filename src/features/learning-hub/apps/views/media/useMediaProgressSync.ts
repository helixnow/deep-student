/**
 * useMediaProgressSync — 断点续播 + 观看时长（media_progress_get / set）
 *
 * - 播放器首次就绪时读取上次位置并续播（距开头/结尾 < 5s、或已看完则从头）；
 *   若在此之前已有引用跳转等外部 seek，则不覆盖。
 * - 观看时长：仅在「播放中且页面可见」时按墙钟累加，单次 tick 封顶，
 *   避免休眠/卡顿把大段空白时间记入。
 * - 上报节流：播放中每 15s 一次；暂停、页面隐藏、卸载时立即 flush（≥ 1s 间隔去抖）。
 */

import { useCallback, useEffect, useRef } from 'react';
import { mediaTranscriptApi } from './mediaTranscriptApi';
import type { MediaPlayerHandle, MediaPlayerStatus } from './mediaPlayerHandle';

export const PROGRESS_FLUSH_INTERVAL_MS = 15_000;
export const RESUME_EDGE_MARGIN_SEC = 5;
const WATCH_TICK_MS = 1000;
/** 单 tick 最大计入时长（后台节流 / 休眠恢复时防止暴涨） */
const WATCH_TICK_CAP_MS = 2000;
const MIN_FLUSH_GAP_MS = 1000;
/** 播到距结尾 < 该秒数视为看完 */
const FINISHED_TAIL_SEC = 3;

/** 纯函数：给定上次进度与时长，决定续播位置（秒）；不续播返回 null */
export function resolveResumePosition(
  lastPositionMs: number,
  durationSec: number,
  finished: boolean,
): number | null {
  if (finished) return null;
  const pos = lastPositionMs / 1000;
  if (!Number.isFinite(pos) || pos < RESUME_EDGE_MARGIN_SEC) return null;
  if (durationSec > 0 && pos > durationSec - RESUME_EDGE_MARGIN_SEC) return null;
  return pos;
}

export interface UseMediaProgressSyncOptions {
  resourceId: string;
  enabled: boolean;
  handleRef: React.RefObject<MediaPlayerHandle | null>;
  /** 返回 true 表示外部（引用跳转）已接管首个位置，跳过续播 */
  hasExternalSeek: () => boolean;
}

export function useMediaProgressSync({
  resourceId,
  enabled,
  handleRef,
  hasExternalSeek,
}: UseMediaProgressSyncOptions): {
  onStatus: (status: MediaPlayerStatus) => void;
  resumedFromRef: React.MutableRefObject<number | null>;
} {
  const statusRef = useRef<MediaPlayerStatus>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    isReady: false,
  });
  const watchedPendingMsRef = useRef(0);
  const lastFlushAtRef = useRef(0);
  const resumeAttemptedRef = useRef(false);
  const resumedFromRef = useRef<number | null>(null);
  const hasExternalSeekRef = useRef(hasExternalSeek);
  hasExternalSeekRef.current = hasExternalSeek;
  const resourceIdRef = useRef(resourceId);
  resourceIdRef.current = resourceId;

  const flush = useCallback(
    (force = false, idOverride?: string) => {
      if (!enabled) return;
      const now = Date.now();
      if (!force && now - lastFlushAtRef.current < MIN_FLUSH_GAP_MS) return;
      const status = statusRef.current;
      if (!status.isReady) return;
      const watchedDeltaMs = watchedPendingMsRef.current;
      watchedPendingMsRef.current = 0;
      lastFlushAtRef.current = now;
      const finished =
        status.duration > 0 && status.currentTime >= status.duration - FINISHED_TAIL_SEC;
      void mediaTranscriptApi
        .setProgress(idOverride ?? resourceIdRef.current, {
          positionMs: status.currentTime * 1000,
          durationMs: status.duration > 0 ? status.duration * 1000 : null,
          watchedDeltaMs,
          finished,
        })
        .catch(() => {
          // 上报失败：把时长退回待上报池，下次再报（位置以最新为准无需回退）
          watchedPendingMsRef.current += watchedDeltaMs;
        });
    },
    [enabled],
  );

  // 切资源：重置续播与累计
  useEffect(() => {
    resumeAttemptedRef.current = false;
    resumedFromRef.current = null;
    watchedPendingMsRef.current = 0;
    lastFlushAtRef.current = 0;
  }, [resourceId]);

  const tryResume = useCallback(() => {
    if (resumeAttemptedRef.current || !enabled) return;
    resumeAttemptedRef.current = true;
    const id = resourceIdRef.current;
    void mediaTranscriptApi
      .getProgress(id)
      .then((progress) => {
        if (!progress || id !== resourceIdRef.current) return;
        if (hasExternalSeekRef.current()) return;
        const handle = handleRef.current;
        const el = handle?.getElement();
        // 用户已手动拖动/开始播放超过 1s：尊重用户操作
        if (!handle || !el || el.currentTime > 1) return;
        const target = resolveResumePosition(
          progress.lastPositionMs,
          statusRef.current.duration,
          progress.finished,
        );
        if (target === null) return;
        handle.seekTo(target);
        resumedFromRef.current = target;
      })
      .catch(() => {
        // 无进度 / 命令不可用：从头播放
      });
  }, [enabled, handleRef]);

  const onStatus = useCallback(
    (status: MediaPlayerStatus) => {
      const prev = statusRef.current;
      statusRef.current = status;
      if (status.isReady && !prev.isReady) tryResume();
      if (prev.isPlaying && !status.isPlaying) flush(true);
    },
    [tryResume, flush],
  );

  // 观看时长累加 + 周期上报
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    let sinceFlush = 0;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(now - last, WATCH_TICK_CAP_MS);
      last = now;
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      if (statusRef.current.isPlaying && visible) {
        watchedPendingMsRef.current += elapsed;
        sinceFlush += elapsed;
        if (sinceFlush >= PROGRESS_FLUSH_INTERVAL_MS) {
          sinceFlush = 0;
          flush(true);
        }
      }
    }, WATCH_TICK_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, flush]);

  // 卸载 / 切资源前 flush
  useEffect(() => {
    const id = resourceId;
    return () => flush(true, id);
  }, [flush, resourceId]);

  return { onStatus, resumedFromRef };
}
