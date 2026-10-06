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

// ---------------------------------------------------------------------------
// 多选与分组
// ---------------------------------------------------------------------------

/** 分组 = 媒体所在的 VFS 文件夹（与资源库一致）；根级文件归入「未分组」（folderId 为 null） */
export interface MediaLibraryGroup {
  /** 文件夹 id；null = 未分组 */
  folderId: string | null;
  /** 显示名：多级文件夹用「父 / 子」；未分组为空串（由界面翻译） */
  label: string;
  items: MediaLibraryItem[];
}

export interface MediaFolderOption {
  id: string;
  label: string;
}

/** 文件夹显示名：优先完整路径（区分不同父目录下的同名文件夹），退回文件夹名 */
export function folderLabel(item: MediaLibraryItem): string {
  if (item.folderPath.length > 0) return item.folderPath.join(' / ');
  return item.folderName ?? '';
}

const compareLabel = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * 按文件夹分组：组内保持输入顺序（已按最近活动排好），组按名称排序（数字自然序，
 * 「第 2 章」在「第 10 章」前），未分组固定在最后。
 */
export function groupLibraryItems(items: readonly MediaLibraryItem[]): MediaLibraryGroup[] {
  const groups = new Map<string, MediaLibraryGroup>();
  const loose: MediaLibraryItem[] = [];
  for (const item of items) {
    if (!item.folderId) {
      loose.push(item);
      continue;
    }
    let group = groups.get(item.folderId);
    if (!group) {
      group = { folderId: item.folderId, label: folderLabel(item), items: [] };
      groups.set(item.folderId, group);
    }
    group.items.push(item);
  }
  const sorted = [...groups.values()].sort((a, b) => compareLabel(a.label, b.label));
  if (loose.length > 0) sorted.push({ folderId: null, label: '', items: loose });
  return sorted;
}

/** 「移动到分组」可选目标：含有音视频的文件夹（按名称排序） */
export function listMediaFolders(items: readonly MediaLibraryItem[]): MediaFolderOption[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.folderId && !seen.has(item.folderId)) seen.set(item.folderId, folderLabel(item));
  }
  return [...seen.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => compareLabel(a.label, b.label));
}

export type SelectAllState = 'none' | 'some' | 'all';

/** 可见条目的勾选状态（全选按钮文案 / 分组头三态的依据） */
export function selectAllState(
  visible: readonly MediaLibraryItem[],
  selected: ReadonlySet<string>,
): SelectAllState {
  let count = 0;
  for (const item of visible) if (selected.has(item.id)) count += 1;
  if (count === 0) return 'none';
  return count === visible.length ? 'all' : 'some';
}

/**
 * 全选 / 取消全选只作用于给定的可见条目（筛选 + 搜索之后）：可见的已全选 → 取消这些；
 * 否则把可见的全部加入。被筛选隐藏的已选条目保持不变。
 */
export function toggleSelectAll(
  visible: readonly MediaLibraryItem[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (selectAllState(visible, selected) === 'all') {
    for (const item of visible) next.delete(item.id);
  } else {
    for (const item of visible) next.add(item.id);
  }
  return next;
}

/** 选中且当前可见的条目：批量操作只作用于它们，避免误删被筛掉的条目 */
export function selectedVisibleItems(
  visible: readonly MediaLibraryItem[],
  selected: ReadonlySet<string>,
): MediaLibraryItem[] {
  return visible.filter((item) => selected.has(item.id));
}

/** 去扩展名（`.bilibili` 链接条目与普通音视频扩展名） */
function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,10}$/, '');
}

/** 公共前缀末尾的分 P / 集数残片与分隔符：「线性代数 P」「课程 第」「Lecture 1」 */
const PREFIX_TAIL = /(?:[\s_\-–—·:：|/\\,，、.(（[【]|\b[Pp]\d*|第\d*|\d+)+$/u;

/**
 * 多个条目名称的公共标题前缀（「新建分组」预填名）：
 * 「线性代数 P2 矩阵」「线性代数 P3 向量」→「线性代数」。少于 2 个或前缀过短时返回空串。
 */
export function commonTitlePrefix(names: readonly string[]): string {
  if (names.length < 2) return '';
  const titles = names.map((name) => stripExtension(name.trim()));
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < title.length && prefix[i] === title[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) return '';
  }
  // 截在代理对中间时丢掉半个字符
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const trimmed = prefix.replace(PREFIX_TAIL, '').trim();
  return [...trimmed].length >= 2 ? trimmed : '';
}
