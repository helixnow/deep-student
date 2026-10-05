/**
 * 音视频库：筛选 / 搜索 / 排序 / 状态徽章（纯函数，便于单测）
 */
import type { MediaLibraryItem } from './api';

export type MediaLibraryFilter = 'all' | 'watching' | 'untranscribed' | 'transcribed';

export const MEDIA_LIBRARY_FILTERS: readonly MediaLibraryFilter[] = [
  'all',
  'watching',
  'untranscribed',
  'transcribed',
];

/** 在看：播放过（有位置或观看时长）且未看完 */
export function isWatching(item: MediaLibraryItem): boolean {
  const p = item.progress;
  if (!p || p.finished) return false;
  return p.lastPositionMs > 0 || p.watchedMs > 0;
}

/** 已转写：全部完成，或已有可用字幕（部分完成也已可检索 / 提问） */
export function hasUsableTranscript(item: MediaLibraryItem): boolean {
  const { status, completedSegments } = item.transcript;
  return status === 'completed' || (status === 'partial' && completedSegments > 0);
}

export function matchesFilter(item: MediaLibraryItem, filter: MediaLibraryFilter): boolean {
  switch (filter) {
    case 'watching':
      return isWatching(item);
    case 'untranscribed':
      return !hasUsableTranscript(item);
    case 'transcribed':
      return hasUsableTranscript(item);
    default:
      return true;
  }
}

export function matchesQuery(item: MediaLibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return item.name.toLowerCase().includes(q) || (item.folderName ?? '').toLowerCase().includes(q);
}

/** 最近活动：最后观看与最后修改（导入 / 重命名）取较晚者 */
export function lastActivityAt(item: MediaLibraryItem): number {
  return Math.max(item.lastWatchedAt ?? 0, item.updatedAt, item.createdAt);
}

export function sortByRecent(items: readonly MediaLibraryItem[]): MediaLibraryItem[] {
  return [...items].sort(
    (a, b) => lastActivityAt(b) - lastActivityAt(a) || a.name.localeCompare(b.name),
  );
}

export function selectLibraryItems(
  items: readonly MediaLibraryItem[],
  filter: MediaLibraryFilter,
  query: string,
): MediaLibraryItem[] {
  return sortByRecent(items.filter((item) => matchesFilter(item, filter) && matchesQuery(item, query)));
}

export function countByFilter(items: readonly MediaLibraryItem[]): Record<MediaLibraryFilter, number> {
  const counts: Record<MediaLibraryFilter, number> = { all: 0, watching: 0, untranscribed: 0, transcribed: 0 };
  for (const item of items) {
    for (const filter of MEDIA_LIBRARY_FILTERS) {
      if (matchesFilter(item, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/** 观看进度 0..1；时长未知时 null（不画进度条） */
export function watchRatio(item: MediaLibraryItem): number | null {
  if (item.progress?.finished) return 1;
  const duration = item.durationMs;
  // 后端对从未播放的媒体返回零值进度：未开始不画进度条
  if (!duration || duration <= 0 || !item.progress || item.progress.lastPositionMs <= 0) return null;
  return Math.min(1, Math.max(0, item.progress.lastPositionMs / duration));
}

export type StatusChipTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface TranscriptChip {
  /** mediaStudio:status.* */
  key: 'none' | 'queued' | 'running' | 'completed' | 'imported' | 'partial' | 'failed';
  tone: StatusChipTone;
  /** 运行中 / 部分完成时的段计数 */
  completed?: number;
  total?: number;
  busy?: boolean;
}

export function transcriptChip(item: MediaLibraryItem): TranscriptChip {
  const { status, completedSegments, totalSegments, source } = item.transcript;
  switch (status) {
    case 'queued':
      return { key: 'queued', tone: 'primary', busy: true };
    case 'running':
      return totalSegments > 0
        ? { key: 'running', tone: 'primary', busy: true, completed: completedSegments, total: totalSegments }
        : { key: 'running', tone: 'primary', busy: true };
    case 'completed':
      return { key: source === 'import' ? 'imported' : 'completed', tone: 'success' };
    case 'partial':
      return { key: 'partial', tone: 'warning', completed: completedSegments, total: totalSegments };
    case 'failed':
      return { key: 'failed', tone: 'danger' };
    default:
      return { key: 'none', tone: 'neutral' };
  }
}

/** 时长 `m:ss` / `h:mm:ss` */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 观看时长（较粗粒度）：分钟，<1 分钟按 1 分钟显示（有观看时） */
export function watchedMinutes(ms: number | null | undefined): number {
  if (!ms || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 60_000));
}

/** 相对时间（「3 分钟前」/「昨天」）；Intl 不可用时退回本地日期 */
export function formatRelativeTime(at: number, now: number, locale: string): string {
  const diffSec = Math.round((at - now) / 1000);
  const abs = Math.abs(diffSec);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < 60) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), 'day');
  } catch {
    /* 退回日期 */
  }
  return new Date(at).toLocaleDateString(locale);
}
