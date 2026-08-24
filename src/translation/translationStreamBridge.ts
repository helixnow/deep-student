/**
 * 翻译流式状态桥 — 供 TranslationGenerativeBriefing 订阅工作台内 useTranslationStream
 *
 * TranslateWorkbench 通过 publishKey 发布快照；ContentView 简报通过 streamKey 订阅。
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface TranslationStreamSnapshot {
  isTranslating: boolean;
  translatedText: string;
  charCount: number;
  wordCount: number;
  detectedLang: string | null;
  isPartialResult: boolean;
  updatedAt: number;
}

interface TranslationStreamBridgeState {
  snapshots: Record<string, TranslationStreamSnapshot>;
  actions: {
    publish: (key: string, patch: Omit<TranslationStreamSnapshot, 'updatedAt'>) => void;
    clear: (key: string) => void;
    clearAll: () => void;
  };
}

export const useTranslationStreamBridge = create<TranslationStreamBridgeState>()(
  subscribeWithSelector((set) => ({
    snapshots: {},
    actions: {
      publish: (key, patch) => {
        set((state) => ({
          snapshots: {
            ...state.snapshots,
            [key]: { ...patch, updatedAt: Date.now() },
          },
        }));
      },
      clear: (key) => {
        set((state) => {
          if (!(key in state.snapshots)) return state;
          const next = { ...state.snapshots };
          delete next[key];
          return { snapshots: next };
        });
      },
      clearAll: () => set({ snapshots: {} }),
    },
  })),
);

/** 订阅指定 resourceId 的流式快照；无活跃流时返回 null */
export function useTranslationStreamSnapshot(
  streamKey: string | null | undefined,
): TranslationStreamSnapshot | null {
  return useTranslationStreamBridge((state) =>
    streamKey ? (state.snapshots[streamKey] ?? null) : null,
  );
}

/** 测试 / 非 React 场景直接发布 */
export function publishTranslationStreamSnapshot(
  key: string,
  patch: Omit<TranslationStreamSnapshot, 'updatedAt'>,
): void {
  useTranslationStreamBridge.getState().actions.publish(key, patch);
}

export function clearTranslationStreamSnapshot(key: string): void {
  useTranslationStreamBridge.getState().actions.clear(key);
}
