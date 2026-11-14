/**
 * 本地草稿持久化：localStorage 主通道 + sessionStorage 降级（读取取较新一份）。
 */

import i18next from 'i18next';
import type { MindMapDocument, LayoutDirection, EdgeType, MindMapViewType } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';

const DRAFT_KEY_PREFIX = 'mindmap:draft:';

export interface MindMapDraftPayload {
  mindmapId: string;
  document: MindMapDocument;
  currentView: MindMapViewType;
  focusedNodeId: string | null;
  savedAt: string;
  baseUpdatedAt?: string;
  layoutId?: string;
  layoutDirection?: LayoutDirection;
  styleId?: string;
  edgeType?: EdgeType;
}

/** 访问 storage 本身也可能抛 SecurityError（隐私模式等），统一吞掉 */
const getDraftStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const getDraftSessionStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const getDraftKey = (mindmapId: string): string => `${DRAFT_KEY_PREFIX}${mindmapId}`;

const readDraftFromStorage = (
  storage: Storage | null,
  mindmapId: string,
): MindMapDraftPayload | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(getDraftKey(mindmapId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MindMapDraftPayload;
    if (!parsed?.document?.root?.id || !Array.isArray(parsed.document.root.children)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

/**
 * 读取草稿：localStorage 与 sessionStorage（写失败时的降级目标）都读，
 * 取 savedAt 更新的一份——否则降级写入的新草稿会被旧的 localStorage 草稿盖掉。
 */
export const readDraft = (mindmapId: string): MindMapDraftPayload | null => {
  const local = readDraftFromStorage(getDraftStorage(), mindmapId);
  const session = readDraftFromStorage(getDraftSessionStorage(), mindmapId);
  if (!local) return session;
  if (!session) return local;
  const localAt = Date.parse(local.savedAt || '');
  const sessionAt = Date.parse(session.savedAt || '');
  if (Number.isNaN(sessionAt)) return local;
  if (Number.isNaN(localAt)) return session;
  return sessionAt > localAt ? session : local;
};

export const writeDraft = (payload: MindMapDraftPayload): void => {
  const storage = getDraftStorage();
  const key = getDraftKey(payload.mindmapId);
  const serialized = JSON.stringify(payload);
  if (storage) {
    try {
      storage.setItem(key, serialized);
      // 主通道成功后清掉降级副本，避免残留旧 sessionStorage 草稿参与新旧比较
      try {
        getDraftSessionStorage()?.removeItem(key);
      } catch {
        // ignore
      }
      return;
    } catch (error) {
      console.error('[MindMapStore] Failed to write draft to localStorage:', error);
    }
  }
  // 尝试降级到 sessionStorage
  try {
    const session = getDraftSessionStorage();
    if (!session) throw new Error('sessionStorage unavailable');
    session.setItem(key, serialized);
  } catch (sessionError) {
    console.error('[MindMapStore] Failed to write draft to sessionStorage as well:', sessionError);
    // 打破用户的安全幻觉，通知用户草稿保存失败
    showGlobalNotification('error', i18next.t('mindmap:store.draftSaveFailed'));
  }
};

export const removeDraftFromStorage = (mindmapId: string): void => {
  const key = getDraftKey(mindmapId);
  try {
    getDraftStorage()?.removeItem(key);
  } catch {
    // ignore
  }
  try {
    getDraftSessionStorage()?.removeItem(key);
  } catch {
    // ignore
  }
};
