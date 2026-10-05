/**
 * 音视频子应用 IPC 边界（media_library_list / media_related_notes）。
 * 宽松归一化（camel / snake 均接受），单测只需 mock 本模块或 invoke。
 */
import { invoke } from '@tauri-apps/api/core';
import {
  normalizeTranscriptStatus,
  type TranscriptStatus,
} from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';

export type MediaKind = 'audio' | 'video';

export interface MediaLibraryTranscript {
  status: TranscriptStatus;
  completedSegments: number;
  totalSegments: number;
  failedSegments: number;
  source: 'asr' | 'import' | null;
}

export interface MediaLibraryProgress {
  lastPositionMs: number;
  watchedMs: number;
  finished: boolean;
}

export interface MediaLibraryItem {
  /** VFS File 资源 id（file_*） */
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  folderId: string | null;
  folderName: string | null;
  /** 毫秒时间戳 */
  createdAt: number;
  updatedAt: number;
  durationMs: number | null;
  transcript: MediaLibraryTranscript;
  progress: MediaLibraryProgress | null;
  /** 毫秒时间戳；从未播放为 null */
  lastWatchedAt: number | null;
  /** 由本媒体生成的讲义笔记数（后端未提供时为 null） */
  handoutCount: number | null;
}

export interface MediaRelatedNote {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

type Raw = Record<string, unknown>;

const pick = (r: Raw, camel: string, snake: string): unknown => r[camel] ?? r[snake];

function num(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 秒级时间戳（< 1e12）统一换算为毫秒；ISO 字符串解析为毫秒 */
export function toMillis(value: unknown): number | null {
  if (typeof value === 'string' && value && Number.isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = num(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|wma|opus)$/i;

export function inferMediaKind(kind: unknown, mimeType: string, name: string): MediaKind {
  if (kind === 'audio' || kind === 'video') return kind;
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return AUDIO_EXT.test(name) ? 'audio' : 'video';
}

export function normalizeLibraryItem(raw: unknown): MediaLibraryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const id = str(r.id);
  if (!id) return null;
  const name = str(r.name) ?? id;
  const mimeType = str(pick(r, 'mimeType', 'mime_type')) ?? '';
  const t = ((r.transcript && typeof r.transcript === 'object') ? r.transcript : {}) as Raw;
  const p = (r.progress && typeof r.progress === 'object') ? (r.progress as Raw) : null;
  const source = str(t.source);
  return {
    id,
    name,
    kind: inferMediaKind(r.kind, mimeType, name),
    mimeType,
    size: num(r.size) ?? 0,
    folderId: str(pick(r, 'folderId', 'folder_id')),
    folderName: str(pick(r, 'folderName', 'folder_name')),
    createdAt: toMillis(pick(r, 'createdAt', 'created_at')) ?? 0,
    updatedAt: toMillis(pick(r, 'updatedAt', 'updated_at')) ?? 0,
    durationMs: num(pick(r, 'durationMs', 'duration_ms')),
    transcript: {
      status: normalizeTranscriptStatus(t.status),
      completedSegments: num(pick(t, 'completedSegments', 'completed_segments')) ?? 0,
      totalSegments: num(pick(t, 'totalSegments', 'total_segments')) ?? 0,
      failedSegments: num(pick(t, 'failedSegments', 'failed_segments')) ?? 0,
      source: source === 'asr' || source === 'import' ? source : null,
    },
    progress: p
      ? {
          lastPositionMs: num(pick(p, 'lastPositionMs', 'last_position_ms')) ?? 0,
          watchedMs: num(pick(p, 'watchedMs', 'watched_ms')) ?? 0,
          finished: Boolean(p.finished),
        }
      : null,
    lastWatchedAt: toMillis(pick(r, 'lastWatchedAt', 'last_watched_at')),
    handoutCount: num(pick(r, 'handoutCount', 'handout_count')),
  };
}

export function normalizeRelatedNote(raw: unknown): MediaRelatedNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title) ?? '',
    createdAt: toMillis(pick(r, 'createdAt', 'created_at')) ?? 0,
    updatedAt: toMillis(pick(r, 'updatedAt', 'updated_at')) ?? 0,
  };
}

function normalizeList<T>(raw: unknown, fn: (item: unknown) => T | null): T[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Raw).items)
      ? ((raw as Raw).items as unknown[])
      : [];
  return list.map(fn).filter((item): item is T => item !== null);
}

export const mediaStudioApi = {
  async listLibrary(): Promise<MediaLibraryItem[]> {
    return normalizeList(await invoke('media_library_list'), normalizeLibraryItem);
  },

  async relatedNotes(resourceId: string): Promise<MediaRelatedNote[]> {
    return normalizeList(await invoke('media_related_notes', { resourceId }), normalizeRelatedNote);
  },
};
