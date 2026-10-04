import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';

/**
 * 知识库文本嵌入就绪性（vfs_get_embedding_readiness）。
 * 未配置嵌入模型时索引会静默停摆——所有展示索引状态的入口共享这一份快照，
 * 以「知识库未启用 · 去配置」取代令人困惑的「N 项索引失败」。
 */
export interface EmbeddingReadiness {
  ready: boolean;
  modelConfigId?: string | null;
  modelName?: string | null;
  reason?: string | null;
  /**
   * 当前构建是否编入向量索引（后端 `lance` feature，与 isS3Enabled 同为编译期能力）。
   * Android mobile-slim 为 false：资料检索走关键词账本，向量索引/嵌入维度 UI 应隐藏。
   * 旧后端不返回该字段 → undefined，按可用处理。
   */
  vectorIndexAvailable?: boolean;
}

let snapshot: EmbeddingReadiness | null = null;
let inflight: Promise<void> | null = null;
let lastFetchedAt = 0;
const listeners = new Set<() => void>();
const STALE_MS = 30_000;

export function refreshEmbeddingReadiness(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && snapshot && Date.now() - lastFetchedAt < STALE_MS) return Promise.resolve();
  inflight = invoke<EmbeddingReadiness>('vfs_get_embedding_readiness')
    .then((next) => {
      snapshot = next;
      lastFetchedAt = Date.now();
      listeners.forEach((listener) => listener());
    })
    .catch(() => { /* 非 Tauri 环境或命令不可用：保持未知，不展示横幅 */ })
    .finally(() => { inflight = null; });
  return inflight;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** null = 尚未知（不展示）；回到窗口焦点时重新检查，配置完返回即刻消失 */
export function useEmbeddingReadiness(): EmbeddingReadiness | null {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => null);
  useEffect(() => {
    void refreshEmbeddingReadiness();
    const onFocus = () => { void refreshEmbeddingReadiness(true); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return value;
}

/** 仅当后端明确声明未编入向量索引时为 true（未知状态不隐藏任何 UI） */
export function isVectorIndexUnavailable(readiness: EmbeddingReadiness | null): boolean {
  return readiness?.vectorIndexAvailable === false;
}

/** 直达「设置 › 模型 › 嵌入维度管理」 */
export function openEmbeddingSettings(): void {
  setPendingSettingsRoute({ tab: 'models' });
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
  dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'models' });
}

/** 测试用 */
export function resetEmbeddingReadinessForTests(): void {
  snapshot = null; inflight = null; lastFetchedAt = 0;
}
