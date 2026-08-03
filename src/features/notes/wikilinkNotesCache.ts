/**
 * 宿主侧 wikilink 同步笔记索引（供 CrepeEditor plugins.wikilink 注入）。
 * resolve 必须同步，故维护内存缓存。
 *
 * 生命周期（B3/B4）：
 * - 首次 refresh 时惰性挂一个全局 dstu.watch('*')：创建 / 重命名 / 移动 / 恢复
 *   直接 upsert；删除 / 清除移除对应条目；无法定位具体节点的批量事件走节流全量刷新。
 * - 全量刷新分页拉取（每页 1000，总上限 20000），突破旧的 listNotes 2000 单页上限；
 *   截断时记录 truncated 标志（`isWikilinkNotesCacheTruncated`）。
 * - resolve 侧兜底：缓存超过 TTL 时后台节流刷新一次，覆盖 watch 不可用的环境。
 */

import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import type { DstuNode, DstuWatchEvent } from '@/dstu/types';
import {
  createWikiLinkIndex,
  type WikiLinkIndex,
  type WikiLinkNoteReference,
} from '@/features/notes/wikilinks';

/** 缓存条目：在解析所需的 id/title 之外携带补全 UI 用的路径与最近编辑时间。 */
export interface WikilinkCachedNote extends WikiLinkNoteReference {
  /** DSTU 文件夹路径（如 `/folder/note_1`），用于同名笔记消歧展示 */
  path?: string;
  /** 最近编辑时间戳，用于补全按最近排序 */
  updatedAt?: number;
}

const PAGE_SIZE = 1000;
const MAX_CACHED_NOTES = 20000;
const STALE_REFRESH_THROTTLE_MS = 3000;
const RESOLVE_FALLBACK_TTL_MS = 30000;

let cache: WikilinkCachedNote[] = [];
let refreshPromise: Promise<void> | null = null;
let truncated = false;
let lastRefreshAt = 0;
let watcherStarted = false;
let staleRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 已构建的解析索引；随 cache 变更失效。
 * resolve 在 NodeView 渲染时对每个 wikilink 同步调用，
 * 惰性缓存索引避免每次都重建整表。
 */
let index: WikiLinkIndex | null = null;

function invalidateIndex(): void {
  index = null;
}

function getIndex(): WikiLinkIndex {
  if (!index) {
    index = createWikiLinkIndex(cache);
  }
  return index;
}

export function getWikilinkNotesCache(): readonly WikilinkCachedNote[] {
  return cache;
}

/** True when the last full refresh hit MAX_CACHED_NOTES and stopped early. */
export function isWikilinkNotesCacheTruncated(): boolean {
  return truncated;
}

export function upsertWikilinkNoteCache(note: WikilinkCachedNote): void {
  const { id, title } = note;
  if (!id) return;
  const entry: WikilinkCachedNote = {
    id,
    title,
    ...(note.path ? { path: note.path } : {}),
    ...(typeof note.updatedAt === 'number' ? { updatedAt: note.updatedAt } : {}),
  };
  const idx = cache.findIndex((n) => n.id === id);
  if (idx >= 0) {
    cache = [...cache.slice(0, idx), { ...cache[idx], ...entry }, ...cache.slice(idx + 1)];
  } else {
    cache = [...cache, entry];
  }
  invalidateIndex();
}

export function removeWikilinkNoteFromCache(noteId: string): void {
  if (!noteId) return;
  const next = cache.filter((n) => n.id !== noteId);
  if (next.length === cache.length) return;
  cache = next;
  invalidateIndex();
}

function cachedNoteFromDstuNode(node: DstuNode): WikilinkCachedNote {
  return {
    id: node.id,
    title: node.name || node.id,
    ...(node.path ? { path: node.path } : {}),
    ...(typeof node.updatedAt === 'number' ? { updatedAt: node.updatedAt } : {}),
  };
}

/** 从 DSTU 事件路径提取资源 ID（末段，如 '/folder/note_1' → 'note_1'）。 */
function noteIdFromEventPath(path: string | undefined): string | null {
  if (!path) return null;
  const segment = path.split('/').filter(Boolean).pop();
  return segment || null;
}

/** 批量 / 文件夹级事件无法逐条修正缓存，节流后全量刷新。 */
function scheduleStaleRefresh(): void {
  if (staleRefreshTimer !== null) return;
  const elapsed = Date.now() - lastRefreshAt;
  const wait = Math.max(0, STALE_REFRESH_THROTTLE_MS - elapsed);
  staleRefreshTimer = setTimeout(() => {
    staleRefreshTimer = null;
    void refreshWikilinkNotesCache();
  }, wait);
}

function handleDstuWatchEvent(event: DstuWatchEvent): void {
  const node = event.node;

  if (event.type === 'deleted' || event.type === 'purged') {
    const noteId = noteIdFromEventPath(event.path || event.oldPath);
    if (noteId && noteId !== '_trash') {
      removeWikilinkNoteFromCache(noteId);
    }
    // 文件夹 / 批量删除只携带容器路径，后代条目靠节流刷新兜底
    scheduleStaleRefresh();
    return;
  }

  if (event.type === 'created' || event.type === 'updated' || event.type === 'moved' || event.type === 'restored') {
    if (node && node.type && node.type !== 'note') return;
    if (node?.id) {
      upsertWikilinkNoteCache(cachedNoteFromDstuNode(node));
    } else {
      scheduleStaleRefresh();
    }
  }
}

/**
 * 惰性启动全局 watch（幂等，跟随应用生命周期不解绑）。
 * dstu.watch 内部自行捕获后端不可用等错误，不会抛给调用方。
 */
function ensureDstuWatcher(): void {
  if (watcherStarted || typeof window === 'undefined') return;
  watcherStarted = true;
  void (async () => {
    try {
      const { dstu } = await import('@/dstu');
      dstu.watch('*', handleDstuWatchEvent);
    } catch (error: unknown) {
      console.warn('[wikilinkNotesCache] dstu watch unavailable:', error);
    }
  })();
}

let truncationNotified = false;

/** 每会话最多提示一次；通知组件懒加载，失败静默（不阻塞刷新）。 */
function notifyTruncationOnce(): void {
  if (truncationNotified) return;
  truncationNotified = true;
  void (async () => {
    try {
      const { showGlobalNotification } = await import('@/components/UnifiedNotification');
      showGlobalNotification(
        'warning',
        `笔记数量超过 ${MAX_CACHED_NOTES} 条上限，超出部分的双链可能显示为未解析`,
      );
    } catch {
      // 通知不可用时保留 console.warn 兜底
    }
  })();
}

export async function refreshWikilinkNotesCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  ensureDstuWatcher();
  refreshPromise = (async () => {
    try {
      const collected: WikilinkCachedNote[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let didTruncate = false;

      for (;;) {
        const result = await notesDstuAdapter.listNotes({ limit: PAGE_SIZE, offset });
        if (!result || !result.ok) {
          // 首页即失败：保留旧缓存；后续页失败：使用已取到的部分
          if (offset === 0) return;
          break;
        }
        for (const node of result.value) {
          if (!node?.id || seen.has(node.id)) continue;
          seen.add(node.id);
          collected.push(cachedNoteFromDstuNode(node));
        }
        if (result.value.length < PAGE_SIZE) break;
        if (collected.length >= MAX_CACHED_NOTES) {
          didTruncate = true;
          console.warn(
            `[wikilinkNotesCache] note index truncated at ${MAX_CACHED_NOTES}; titles beyond the cap stay unresolved`,
          );
          break;
        }
        offset += PAGE_SIZE;
      }

      // 首次进入截断状态时给用户可见提示（此前仅 console.warn，双链静默失解析）
      if (didTruncate && !truncated) {
        notifyTruncationOnce();
      }
      cache = collected;
      truncated = didTruncate;
      lastRefreshAt = Date.now();
      invalidateIndex();
    } catch (error: unknown) {
      console.warn('[wikilinkNotesCache] refresh failed:', error);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/** watch 不可用（或事件丢失）时的兜底：解析路径上超 TTL 后台补一次刷新。 */
function maybeRefreshInBackground(): void {
  if (refreshPromise || staleRefreshTimer !== null) return;
  if (lastRefreshAt === 0) return; // 尚未有宿主主动 refresh，避免测试 / SSR 环境误触发
  if (Date.now() - lastRefreshAt < RESOLVE_FALLBACK_TTL_MS) return;
  scheduleStaleRefresh();
}

export interface WikilinkHostResolveResult {
  resolved: boolean;
  noteId: string | null;
  /** 同名笔记多于一个时为 true，此时 candidateIds 为全部候选（字典序） */
  ambiguous?: boolean;
  candidateIds?: readonly string[];
}

export function resolveWikilinkTarget(target: string): WikilinkHostResolveResult {
  maybeRefreshInBackground();
  const r = getIndex().resolve(target);
  return {
    resolved: Boolean(r.noteId),
    noteId: r.noteId,
    // 仅在歧义时携带扩展字段，保持既有 { resolved, noteId } 断言不变
    ...(r.ambiguous ? { ambiguous: true, candidateIds: r.candidateIds } : {}),
  };
}

/** Crepe plugins.wikilink 最小配置（契约：返回形状固定为 { getNotes, resolve }，resolve 同步） */
export function buildWikilinkPluginHostConfig() {
  return {
    getNotes: () => getWikilinkNotesCache(),
    resolve: (target: string) => resolveWikilinkTarget(target),
  };
}
