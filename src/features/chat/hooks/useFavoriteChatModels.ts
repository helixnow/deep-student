/**
 * 聊天模型收藏（星标）
 *
 * 持久化复用设置页「模型」已有的 ModelProfile.isFavorite 字段：
 *   - 读：get_model_profiles → 取 isFavorite=true 的 profile id（与 get_api_configurations 的配置 id 同源）
 *   - 写：get_model_profiles 取最新全量 → 仅翻转目标 profile 的 isFavorite → save_model_profiles
 *     （与设置页 handleToggleFavorite 同一条持久化链路；后端已显式支持内置模型的收藏覆盖）
 *   - 写入成功后广播 api_configurations_changed，设置页 useVendorModels / ModelPicker 等会自动重载
 *
 * 不新增后端命令。收藏只是偏好：已删除/失效模型的收藏在 UI 层按可用模型过滤后静默忽略，
 * 切换一个已不存在的 profile 时同样静默回滚，不弹错误。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface FavoriteProfileRecord {
  id?: unknown;
  isFavorite?: unknown;
  is_favorite?: unknown;
  [key: string]: unknown;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

/** 后端快照（最近一次 get_model_profiles 的收藏集合） */
let persistedIds: ReadonlySet<string> = EMPTY_IDS;
/** 乐观更新：id → 期望的收藏状态（写入完成或失败后移除） */
const optimistic = new Map<string, boolean>();
let snapshot: ReadonlySet<string> = EMPTY_IDS;
let loadSequence = 0;
let loadedOnce = false;
/** 串行化写入，避免并发 read-modify-write 互相覆盖 */
let writeChain: Promise<unknown> = Promise.resolve();

function isFavoriteRecord(profile: FavoriteProfileRecord): boolean {
  return profile.isFavorite === true || profile.is_favorite === true;
}

function recomputeSnapshot(): void {
  const next = new Set(persistedIds);
  optimistic.forEach((favorite, id) => {
    if (favorite) next.add(id);
    else next.delete(id);
  });
  snapshot = next;
  listeners.forEach((listener) => listener());
}

async function fetchProfiles(): Promise<FavoriteProfileRecord[]> {
  const profiles = await invoke<FavoriteProfileRecord[]>('get_model_profiles');
  return Array.isArray(profiles) ? profiles : [];
}

function collectFavoriteIds(profiles: FavoriteProfileRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (typeof profile?.id === 'string' && profile.id && isFavoriteRecord(profile)) {
      ids.add(profile.id);
    }
  }
  return ids;
}

export async function reloadFavoriteChatModels(): Promise<void> {
  const sequence = ++loadSequence;
  try {
    const profiles = await fetchProfiles();
    if (sequence !== loadSequence) return;
    persistedIds = collectFavoriteIds(profiles);
    loadedOnce = true;
    recomputeSnapshot();
  } catch {
    // 非 Tauri 环境 / 读取失败：保持现状，收藏只是排序偏好，不阻塞选模型
  }
}

function handleConfigurationsChanged(): void {
  void reloadFavoriteChatModels();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('api_configurations_changed', handleConfigurationsChanged);
    if (!loadedOnce) void reloadFavoriteChatModels();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('api_configurations_changed', handleConfigurationsChanged);
    }
  };
}

function getSnapshot(): ReadonlySet<string> {
  return snapshot;
}

function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY_IDS;
}

export type FavoriteToggleResult = 'saved' | 'missing' | 'failed';

/**
 * 切换收藏并持久化。返回值：
 *   - saved   已写入
 *   - missing 目标 profile 已不存在（被删除/失效）→ 静默回滚
 *   - failed  写入失败 → 回滚，由调用方决定是否提示
 */
export function toggleFavoriteChatModel(modelId: string): Promise<FavoriteToggleResult> {
  const id = modelId.trim();
  if (!id) return Promise.resolve('missing');
  const nextFavorite = !snapshot.has(id);
  optimistic.set(id, nextFavorite);
  recomputeSnapshot();

  const run = async (): Promise<FavoriteToggleResult> => {
    try {
      const profiles = await fetchProfiles();
      const index = profiles.findIndex((profile) => profile?.id === id);
      if (index < 0) {
        persistedIds = collectFavoriteIds(profiles);
        return 'missing';
      }
      const nextProfiles = profiles.map((profile, i) => (
        i === index ? { ...profile, isFavorite: nextFavorite } : profile
      ));
      await invoke<void>('save_model_profiles', { profiles: nextProfiles });
      persistedIds = collectFavoriteIds(nextProfiles);
      loadedOnce = true;
      try {
        window.dispatchEvent(new CustomEvent('api_configurations_changed'));
      } catch {
        // ignore broadcast failures
      }
      return 'saved';
    } catch (error: unknown) {
      console.warn('[useFavoriteChatModels] Failed to persist favorite:', error);
      return 'failed';
    } finally {
      // 仅当期间没有更新的同 id 切换时才清除乐观值
      if (optimistic.get(id) === nextFavorite) optimistic.delete(id);
      recomputeSnapshot();
    }
  };

  const result = writeChain.then(run, run);
  writeChain = result.catch(() => undefined);
  return result;
}

export interface FavoriteChatModelsResult {
  favoriteIds: ReadonlySet<string>;
  isFavorite: (modelId: string) => boolean;
  toggleFavorite: (modelId: string) => Promise<FavoriteToggleResult>;
}

export function useFavoriteChatModels(): FavoriteChatModelsResult {
  const favoriteIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isFavorite = useCallback((modelId: string) => favoriteIds.has(modelId), [favoriteIds]);
  const toggleFavorite = useCallback((modelId: string) => toggleFavoriteChatModel(modelId), []);
  return { favoriteIds, isFavorite, toggleFavorite };
}

/** 仅供测试：重置模块级状态 */
export function __resetFavoriteChatModelsForTests(): void {
  persistedIds = EMPTY_IDS;
  optimistic.clear();
  snapshot = EMPTY_IDS;
  loadSequence = 0;
  loadedOnce = false;
  writeChain = Promise.resolve();
  listeners.forEach((listener) => listener());
}
