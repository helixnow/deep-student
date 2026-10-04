/**
 * 媒体转写 / 字幕 / 播放进度的类型化 Tauri 命令封装
 *
 * 契约：docs/dev/media-learning/README.md §1.3（命令）与 §1.3 事件
 * （media-processing-progress / -completed / -error，mediaType 'audio'|'video'）。
 *
 * 后端返回经 normalize* 宽松归一（数字 / 字符串状态都接受，缺字段给安全默认），
 * 视图层只消费这里导出的规范类型。
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// 类型
// ============================================================================

export type TranscriptSegmentStatus = 'pending' | 'done' | 'failed';

export interface TranscriptSegment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  status: TranscriptSegmentStatus;
}

/**
 * 整体转写状态：
 * - none：从未转写（也无导入字幕）
 * - queued / running：已入队 / 处理中
 * - completed：全部段完成（含导入字幕）
 * - partial：有失败段或被取消（已完成段保留，可「重试失败段」续做）
 * - failed：整体失败（解码不支持等）
 */
export type TranscriptStatus = 'none' | 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface TranscriptProgress {
  stage: string;
  completedSegments: number;
  totalSegments: number;
  /** 0-100 */
  percent: number;
  error?: string;
}

export interface MediaTranscript {
  status: TranscriptStatus;
  segments: TranscriptSegment[];
  progress: TranscriptProgress | null;
  source?: 'asr' | 'import';
}

export interface TranscribeEstimate {
  /** 未能探测到时长时为 null */
  durationMs: number | null;
  plannedSegments: number | null;
  asrModel: string | null;
  /** 语音识别（与语音输入共用的 API Key）是否已配置；未配置时后端 start 会报 settings-required */
  asrConfigured: boolean;
  /** true = 解码 + VAD 精确估算；false = 容器头快速探测 + 经验段长 */
  exact: boolean;
}

/**
 * 媒体命令错误：后端以 `{"code","message"}` JSON 字符串返回（MediaError::to_payload_string）。
 * 包装为带 code 的 Error，message 直接可展示。
 */
export class MediaCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MediaCommandError';
  }
}

export function toMediaCommandError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { code?: unknown; message?: unknown };
        if (typeof parsed.message === 'string') {
          return new MediaCommandError(typeof parsed.code === 'string' ? parsed.code : 'unknown', parsed.message);
        }
      } catch {
        /* 非 JSON：按普通文本 */
      }
    }
    return new MediaCommandError('unknown', trimmed);
  }
  if (raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string') {
    const r = raw as { code?: unknown; message: string };
    return new MediaCommandError(typeof r.code === 'string' ? r.code : 'unknown', r.message);
  }
  return new MediaCommandError('unknown', String(raw));
}

async function invoke<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (err: unknown) {
    throw toMediaCommandError(err);
  }
}

export type TranscriptExportFormat = 'srt' | 'vtt' | 'txt';

export interface MediaPlaybackProgress {
  lastPositionMs: number;
  durationMs: number | null;
  watchedMs: number;
  finished: boolean;
}

export interface MediaProgressUpdate {
  positionMs: number;
  durationMs?: number | null;
  /** 自上次上报以来新增的实际观看时长（毫秒，后端累加） */
  watchedDeltaMs: number;
  finished?: boolean;
}

// ============================================================================
// 归一化
// ============================================================================

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function normalizeSegmentStatus(raw: unknown): TranscriptSegmentStatus {
  if (raw === 1 || raw === 'done' || raw === 'completed' || raw === 'ok') return 'done';
  if (raw === 2 || raw === 'failed' || raw === 'error') return 'failed';
  return 'pending';
}

export function normalizeTranscriptStatus(raw: unknown): TranscriptStatus {
  switch (typeof raw === 'string' ? raw.toLowerCase() : raw) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'processing':
    case 'in_progress':
    case 'decode':
    case 'vad':
    case 'asr':
    case 'indexing':
      return 'running';
    case 'completed':
    case 'complete':
    case 'done':
    case 'ready':
      return 'completed';
    case 'partial':
    case 'cancelled':
    case 'canceled':
    case 'completed_with_issues':
      return 'partial';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'none';
  }
}

export function normalizeSegment(raw: unknown): TranscriptSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const idx = toNumber(r.idx ?? r.index, NaN);
  const startMs = toNumber(r.startMs ?? r.start_ms, NaN);
  const endMs = toNumber(r.endMs ?? r.end_ms, NaN);
  if (!Number.isFinite(idx) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    idx,
    startMs,
    endMs: Math.max(endMs, startMs),
    text: typeof r.text === 'string' ? r.text : '',
    status: normalizeSegmentStatus(r.status),
  };
}

export function normalizeProgress(raw: unknown): TranscriptProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // 事件 payload 里进度可能嵌在 status 对象内（沿用 MediaProcessingProgressEvent 结构）
  const nested = r.status && typeof r.status === 'object' ? (r.status as Record<string, unknown>) : null;
  const pick = (key: string, alt: string): unknown => r[key] ?? r[alt] ?? nested?.[key] ?? nested?.[alt];
  const completed = toNumber(pick('completedSegments', 'completed_segments'));
  const total = toNumber(pick('totalSegments', 'total_segments'));
  const rawPercent = pick('percent', 'percent');
  const percent =
    rawPercent !== undefined
      ? toNumber(rawPercent)
      : total > 0
        ? (completed / total) * 100
        : 0;
  const stage = pick('stage', 'stage');
  const error = pick('error', 'error');
  return {
    stage: typeof stage === 'string' ? stage : '',
    completedSegments: completed,
    totalSegments: total,
    percent: Math.min(100, Math.max(0, percent)),
    ...(typeof error === 'string' && error ? { error } : {}),
  };
}

export function normalizeTranscript(raw: unknown): MediaTranscript {
  if (!raw || typeof raw !== 'object') {
    return { status: 'none', segments: [], progress: null };
  }
  const r = raw as Record<string, unknown>;
  const segments = (Array.isArray(r.segments) ? r.segments : [])
    .map(normalizeSegment)
    .filter((s): s is TranscriptSegment => s !== null)
    .sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
  let status = normalizeTranscriptStatus(r.status);
  // 老后端 / 导入字幕可能不给 status：有完成段即视为可用
  if (status === 'none' && segments.some((s) => s.status === 'done')) {
    status = segments.every((s) => s.status === 'done') ? 'completed' : 'partial';
  }
  // 取消于首段之前（后端 cancelled 且无段）：等同未转写，入口回到「转写」
  if (status === 'partial' && segments.length === 0 && normalizeTranscriptStatus(r.status) === 'partial') {
    const raw = typeof r.status === 'string' ? r.status.toLowerCase() : '';
    if (raw === 'cancelled' || raw === 'canceled') status = 'none';
  }
  const source = r.source === 'import' || r.source === 'asr' ? r.source : undefined;
  return {
    status,
    segments,
    progress: normalizeProgress(r.progress),
    ...(source ? { source } : {}),
  };
}

export function normalizeEstimate(raw: unknown): TranscribeEstimate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const model = r.asrModel ?? r.asr_model;
  const duration = r.durationMs ?? r.duration_ms;
  const planned = r.plannedSegments ?? r.planned_segments;
  const configured = r.asrConfigured ?? r.asr_configured;
  const asrModel = typeof model === 'string' && model ? model : null;
  return {
    durationMs: duration == null ? null : toNumber(duration),
    plannedSegments: planned == null ? null : toNumber(planned),
    asrModel,
    // 旧形态无该字段时以「有模型名」近似
    asrConfigured: typeof configured === 'boolean' ? configured : asrModel !== null,
    exact: Boolean(r.exact),
  };
}

export function normalizePlaybackProgress(raw: unknown): MediaPlaybackProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const duration = r.durationMs ?? r.duration_ms;
  return {
    lastPositionMs: toNumber(r.lastPositionMs ?? r.last_position_ms),
    durationMs: duration == null ? null : toNumber(duration),
    watchedMs: toNumber(r.watchedMs ?? r.watched_ms),
    finished: Boolean(r.finished),
  };
}

// ============================================================================
// 命令
// ============================================================================

/** media_progress_set 单次观看时长上限（与后端 MediaProgressUpdate 校验一致） */
export const MAX_WATCHED_DELTA_MS = 120_000;

export const mediaTranscriptApi = {
  async estimate(resourceId: string): Promise<TranscribeEstimate> {
    return normalizeEstimate(await invoke('media_transcribe_estimate', { resourceId }));
  },

  /** 入队；已在队 / 已完成时后端返回现状 */
  async start(resourceId: string): Promise<MediaTranscript> {
    return normalizeTranscript(await invoke('media_transcribe_start', { resourceId }));
  },

  async cancel(resourceId: string): Promise<void> {
    await invoke('media_transcribe_cancel', { resourceId });
  },

  async get(resourceId: string): Promise<MediaTranscript> {
    return normalizeTranscript(await invoke('media_transcript_get', { resourceId }));
  },

  /** 导入 .srt / .vtt / B 站 BCC .json（写 source='import' 段并触发索引） */
  async importFile(resourceId: string, path: string): Promise<MediaTranscript> {
    return normalizeTranscript(await invoke('media_transcript_import', { resourceId, path }));
  },

  /** 导出到用户选择的目标（含 Android content://） */
  async exportFile(resourceId: string, format: TranscriptExportFormat, dest: string): Promise<void> {
    await invoke('media_transcript_export', { resourceId, format, dest });
  },

  async getProgress(resourceId: string): Promise<MediaPlaybackProgress | null> {
    return normalizePlaybackProgress(await invoke('media_progress_get', { resourceId }));
  },

  async setProgress(resourceId: string, update: MediaProgressUpdate): Promise<void> {
    await invoke('media_progress_set', {
      resourceId,
      positionMs: Math.max(0, Math.round(update.positionMs)),
      durationMs:
        update.durationMs == null || !Number.isFinite(update.durationMs)
          ? null
          : Math.round(update.durationMs),
      // 后端单次上限 120s（防异常累计灌入）
      watchedDeltaMs: Math.min(MAX_WATCHED_DELTA_MS, Math.max(0, Math.round(update.watchedDeltaMs))),
      finished: Boolean(update.finished),
    });
  },
};

// ============================================================================
// 事件
// ============================================================================

export type MediaProcessingEvent =
  | { kind: 'progress'; resourceId: string; mediaType: string; progress: TranscriptProgress }
  | { kind: 'completed'; resourceId: string; mediaType: string; stage: string }
  | { kind: 'error'; resourceId: string; mediaType: string; stage: string; error: string };

const MEDIA_EVENT_TYPES = new Set(['audio', 'video']);

/** 解析 media-processing-* payload；非音视频（pdf/image）或无 id 返回 null */
export function parseMediaProcessingEvent(
  eventName: 'media-processing-progress' | 'media-processing-completed' | 'media-processing-error',
  payload: unknown,
): MediaProcessingEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const nested = p.status && typeof p.status === 'object' ? (p.status as Record<string, unknown>) : null;
  const mediaType = (p.mediaType ?? p.media_type ?? nested?.mediaType) as string | undefined;
  if (!mediaType || !MEDIA_EVENT_TYPES.has(mediaType)) return null;
  const resourceId = (p.resourceId ?? p.fileId ?? p.file_id) as string | undefined;
  if (typeof resourceId !== 'string' || !resourceId) return null;

  if (eventName === 'media-processing-progress') {
    const progress = normalizeProgress(p);
    if (!progress) return null;
    return { kind: 'progress', resourceId, mediaType, progress };
  }
  const stage = typeof p.stage === 'string' ? p.stage : '';
  if (eventName === 'media-processing-completed') {
    return { kind: 'completed', resourceId, mediaType, stage };
  }
  return {
    kind: 'error',
    resourceId,
    mediaType,
    stage,
    error: typeof p.error === 'string' ? p.error : '',
  };
}

/**
 * 订阅音视频转写事件（三类事件统一回调）。
 * @returns 同步取消函数（内部处理 listen 的异步注册竞态）
 */
export function subscribeMediaProcessingEvents(
  onEvent: (event: MediaProcessingEvent) => void,
): () => void {
  let disposed = false;
  const unlisteners: UnlistenFn[] = [];
  const names = [
    'media-processing-progress',
    'media-processing-completed',
    'media-processing-error',
  ] as const;
  for (const name of names) {
    void listen(name, (event) => {
      const parsed = parseMediaProcessingEvent(name, event.payload);
      if (parsed) onEvent(parsed);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      })
      .catch(() => {
        // 非 Tauri 环境（测试 / demo）无事件通道：静默
      });
  }
  return () => {
    disposed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}
