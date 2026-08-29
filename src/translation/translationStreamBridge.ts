/**
 * 翻译流式状态桥 — 工作台内 useTranslationStream 的对外订阅通道
 *
 * TranslateWorkbench 通过 publishKey 发布快照；外部视图通过 streamKey 订阅。
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/** 流阶段语义：空闲（挂载未开始）/流式中/终态完成/终态出错 */
export type TranslationStreamPhase = 'idle' | 'streaming' | 'done' | 'error';

export interface TranslationStreamSnapshot {
  isTranslating: boolean;
  translatedText: string;
  charCount: number;
  wordCount: number;
  detectedLang: string | null;
  isPartialResult: boolean;
  /**
   * 阶段语义（可选：旧调用方/测试未传时为 undefined）。
   * 「有快照」≠「有活跃流」——挂载即发布 idle 快照，订阅方需按 phase /
   * isTranslating 区分，而非以快照存在与否判断流是否进行中。
   */
  phase?: TranslationStreamPhase;
  updatedAt: number;
}

/**
 * key → 最后发布者的所有权 token。
 * 同 key 双实例（分屏同一资源）时防止先卸载的一方清掉后发布者的快照：
 * publish 携带 token 即登记所有权（后写者胜），clear 携带 token 时仅所有者生效。
 * 存于模块级 Map 而非 zustand state：所有权是发布协调元数据，不驱动渲染。
 */
const snapshotOwners = new Map<string, string>();

interface TranslationStreamBridgeState {
  snapshots: Record<string, TranslationStreamSnapshot>;
  actions: {
    publish: (
      key: string,
      patch: Omit<TranslationStreamSnapshot, 'updatedAt'>,
      ownerToken?: string,
    ) => void;
    clear: (key: string, ownerToken?: string) => void;
    clearAll: () => void;
  };
}

export const useTranslationStreamBridge = create<TranslationStreamBridgeState>()(
  subscribeWithSelector((set) => ({
    snapshots: {},
    actions: {
      publish: (key, patch, ownerToken) => {
        if (ownerToken) {
          snapshotOwners.set(key, ownerToken);
        }
        set((state) => ({
          snapshots: {
            ...state.snapshots,
            [key]: { ...patch, updatedAt: Date.now() },
          },
        }));
      },
      clear: (key, ownerToken) => {
        // 带 token 的清理仅在仍持有所有权时生效；无 token 的调用
        // （测试/命令式重置）保持原语义无条件清除
        if (ownerToken) {
          const currentOwner = snapshotOwners.get(key);
          if (currentOwner !== undefined && currentOwner !== ownerToken) return;
        }
        snapshotOwners.delete(key);
        set((state) => {
          if (!(key in state.snapshots)) return state;
          const next = { ...state.snapshots };
          delete next[key];
          return { snapshots: next };
        });
      },
      clearAll: () => {
        snapshotOwners.clear();
        set({ snapshots: {} });
      },
    },
  })),
);

/**
 * 订阅指定 resourceId 的流式快照；该 key 从未发布过（或已清除）时返回 null。
 * 注意快照存在不代表流进行中（挂载即发布 idle），判活跃请看 phase/isTranslating。
 */
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
  ownerToken?: string,
): void {
  useTranslationStreamBridge.getState().actions.publish(key, patch, ownerToken);
}

export function clearTranslationStreamSnapshot(key: string, ownerToken?: string): void {
  useTranslationStreamBridge.getState().actions.clear(key, ownerToken);
}
