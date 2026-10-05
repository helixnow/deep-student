/**
 * useMediaTranscript — 单个音视频资源的转写状态机
 *
 * - 挂载时 media_transcript_get 拉现状（转写可能在别处已开始/完成）
 * - 订阅 media-processing-*（mediaType audio/video）：进度即时更新，
 *   段列表节流回拉（新完成的段增量进入字幕轨与面板）
 * - 运行中兜底慢轮询（事件丢失 / 应用重启后恢复的任务）
 * - 动作：估算 → 确认 → 开始；取消；重试失败段（后端跳过 status=1 段续做）；
 *   导入字幕文件；导出 srt/vtt/txt
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import {
  mediaTranscriptApi,
  subscribeMediaProcessingEvents,
  type MediaTranscript,
  type TranscribeEstimate,
  type TranscriptExportFormat,
  type TranscriptProgress,
} from './mediaTranscriptApi';
import { getErrorMessage } from '@/utils/errorUtils';

/** 进度事件后回拉段列表的最小间隔 */
export const TRANSCRIPT_REFETCH_THROTTLE_MS = 1500;
/** 运行中无事件时的兜底轮询间隔 */
export const TRANSCRIPT_POLL_INTERVAL_MS = 5000;

export interface UseMediaTranscriptOptions {
  resourceId: string;
  /** 事件里的 id 可能是 sourceId（与 node.id 不同时一并匹配） */
  aliasIds?: Array<string | undefined>;
  enabled?: boolean;
}

export interface UseMediaTranscriptResult {
  transcript: MediaTranscript | null;
  /** 首次拉取中 */
  loading: boolean;
  /** 最近一次错误（拉取 / 后端 error 事件） */
  error: string | null;
  estimate: TranscribeEstimate | null;
  estimating: boolean;
  starting: boolean;
  cancelling: boolean;
  requestEstimate: () => Promise<ActionResult<TranscribeEstimate>>;
  clearEstimate: () => void;
  start: () => Promise<ActionResult<MediaTranscript>>;
  cancel: () => Promise<void>;
  refresh: () => Promise<void>;
  /** @returns 导入后已完成的字幕段数 */
  importFromPath: (path: string) => Promise<number>;
  exportToPath: (format: TranscriptExportFormat, dest: string) => Promise<void>;
}

export interface ActionResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const EMPTY_TRANSCRIPT: MediaTranscript = { status: 'none', segments: [], progress: null };

export function useMediaTranscript({
  resourceId,
  aliasIds = [],
  enabled = true,
}: UseMediaTranscriptOptions): UseMediaTranscriptResult {
  const [transcript, setTranscript] = useState<MediaTranscript | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<TranscribeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const resourceIdRef = useRef(resourceId);
  resourceIdRef.current = resourceId;
  const idSetRef = useRef(new Set<string>());
  idSetRef.current = new Set([resourceId, ...aliasIds].filter((v): v is string => Boolean(v)));

  // 切资源后旧请求的回包丢弃
  const generationRef = useRef(0);
  const lastEventAtRef = useRef(0);
  const refetchTimerRef = useRef<number | null>(null);
  const lastFetchAtRef = useRef(0);

  const fetchTranscript = useCallback(async () => {
    const generation = generationRef.current;
    const id = resourceIdRef.current;
    lastFetchAtRef.current = Date.now();
    try {
      const next = await mediaTranscriptApi.get(id);
      if (generation !== generationRef.current) return;
      setTranscript((prev) => {
        // 进度来自事件时比 get 更新：保留更大的已完成数，避免进度条回退
        if (
          prev?.progress &&
          next.progress &&
          (next.status === 'running' || next.status === 'queued') &&
          prev.progress.completedSegments > next.progress.completedSegments
        ) {
          return { ...next, progress: prev.progress };
        }
        return next;
      });
      setError(null);
    } catch (err: unknown) {
      if (generation !== generationRef.current) return;
      // 后端尚未提供命令（旧版本）时退化为「未转写」，转写入口仍可见
      setTranscript((prev) => prev ?? EMPTY_TRANSCRIPT);
      setError(getErrorMessage(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  const scheduleRefetch = useCallback(
    (immediate = false) => {
      if (refetchTimerRef.current !== null) {
        if (!immediate) return;
        window.clearTimeout(refetchTimerRef.current);
      }
      const wait = immediate
        ? 0
        : Math.max(0, TRANSCRIPT_REFETCH_THROTTLE_MS - (Date.now() - lastFetchAtRef.current));
      refetchTimerRef.current = window.setTimeout(() => {
        refetchTimerRef.current = null;
        void fetchTranscript();
      }, wait);
    },
    [fetchTranscript],
  );

  // 初次加载 / 切换资源
  useEffect(() => {
    generationRef.current += 1;
    setTranscript(null);
    setEstimate(null);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchTranscript();
    return () => {
      if (refetchTimerRef.current !== null) {
        window.clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [enabled, resourceId, fetchTranscript]);

  // 事件订阅
  useEffect(() => {
    if (!enabled) return;
    return subscribeMediaProcessingEvents((event) => {
      if (!idSetRef.current.has(event.resourceId)) return;
      lastEventAtRef.current = Date.now();
      if (event.kind === 'progress') {
        const progress: TranscriptProgress = event.progress;
        setTranscript((prev) => ({
          ...(prev ?? EMPTY_TRANSCRIPT),
          // 后端 MediaStage::Queued 也经 progress 事件上报
          status: progress.stage === 'queued' ? 'queued' : 'running',
          progress,
        }));
        scheduleRefetch();
        return;
      }
      if (event.kind === 'error') {
        setError(event.error || null);
      } else {
        setError(null);
      }
      scheduleRefetch(true);
    });
  }, [enabled, scheduleRefetch]);

  // 运行中兜底轮询（事件静默超过一个周期才拉）
  const isRunning = transcript?.status === 'running' || transcript?.status === 'queued';
  useEffect(() => {
    if (!enabled || !isRunning) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastEventAtRef.current >= TRANSCRIPT_POLL_INTERVAL_MS) {
        void fetchTranscript();
      }
    }, TRANSCRIPT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, isRunning, fetchTranscript]);

  // 回到前台立即对账：Android 切后台期间 WebView 冻结，事件可能丢失，转写却在后端继续推进
  const handleVisibility = useCallback(() => {
    if (enabled && document.visibilityState === 'visible') scheduleRefetch(true);
  }, [enabled, scheduleRefetch]);
  useEventRegistry([
    { target: 'document', type: 'visibilitychange', listener: handleVisibility },
  ], [handleVisibility]);

  const requestEstimate = useCallback(async () => {
    setEstimating(true);
    try {
      const result = await mediaTranscriptApi.estimate(resourceIdRef.current);
      setEstimate(result);
      return { ok: true as const, value: result };
    } catch (err: unknown) {
      return { ok: false as const, error: getErrorMessage(err) };
    } finally {
      setEstimating(false);
    }
  }, []);

  const clearEstimate = useCallback(() => setEstimate(null), []);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const next = await mediaTranscriptApi.start(resourceIdRef.current);
      // start 返回现状；未给出状态时乐观进入 queued，等事件推进
      setTranscript((prev) => {
        const base = next.segments.length > 0 ? next : { ...(prev ?? EMPTY_TRANSCRIPT), progress: next.progress ?? prev?.progress ?? null };
        return { ...base, status: next.status === 'none' ? 'queued' : next.status };
      });
      setError(null);
      setEstimate(null);
      lastEventAtRef.current = Date.now();
      return { ok: true as const, value: next };
    } catch (err: unknown) {
      return { ok: false as const, error: getErrorMessage(err) };
    } finally {
      setStarting(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await mediaTranscriptApi.cancel(resourceIdRef.current);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setCancelling(false);
      void fetchTranscript();
    }
  }, [fetchTranscript]);

  const importFromPath = useCallback(async (path: string) => {
    const id = resourceIdRef.current;
    const generation = generationRef.current;
    let next = await mediaTranscriptApi.importFile(id, path);
    // 后端可能只回计数 / 空对象：以 get 的完整段列表为准
    if (next.segments.length === 0) next = await mediaTranscriptApi.get(id);
    if (generation === generationRef.current) {
      setTranscript(next);
      setError(null);
    }
    return next.segments.filter((seg) => seg.status === 'done').length;
  }, []);

  const exportToPath = useCallback(async (format: TranscriptExportFormat, dest: string) => {
    await mediaTranscriptApi.exportFile(resourceIdRef.current, format, dest);
  }, []);

  return {
    transcript,
    loading,
    error,
    estimate,
    estimating,
    starting,
    cancelling,
    requestEstimate,
    clearEstimate,
    start,
    cancel,
    refresh: fetchTranscript,
    importFromPath,
    exportToPath,
  };
}
