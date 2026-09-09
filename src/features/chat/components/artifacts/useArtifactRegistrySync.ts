/**
 * 会话产物索引同步 hook：挂载时懒扫水合 + 订阅 registry 通知与 blocks 规模变化做增量补齐。
 *
 * 产物列表（AgentTaskPanel 底部产物分区）使用本 hook 做懒扫水合 + 增量补齐。
 * 水合与增量补齐的触发条件见 artifactRegistry。
 *
 * store 参数只要求「能读 blocks + 能订阅 blocks 变化」的结构化窄接口：
 * 完整 `StoreApi<ChatStore>` 与 AgentTaskPanel 的只读切片（AgentTaskStoreApi）都可直接传入。
 */

import { useEffect, useState } from 'react';
import type { Block } from '../../core/types/block';
import { hydrateSessionArtifacts, subscribeArtifactRegistry } from '../../core/store/artifactRegistry';

/** useArtifactRegistrySync 需要的最小 store 面（blocks 读取 + 订阅） */
export interface ArtifactRegistryStoreLike {
  getState: () => { blocks: Map<string, Block> };
  subscribe: (
    listener: (state: { blocks: Map<string, Block> }, prevState: { blocks: Map<string, Block> }) => void,
  ) => () => void;
}

/**
 * 终态工具块计数：size 不变的原地 toolOutput 落库也要覆盖；
 * 用计数而非 Map 引用比较，避免流式 chunk 更新触发全量重派生。
 */
function countTerminalToolBlocks(blocks: Map<string, { toolName?: string; status: string }>): number {
  let n = 0;
  for (const b of blocks.values()) {
    if (b.toolName && (b.status === 'success' || b.status === 'error')) n += 1;
  }
  return n;
}

export interface ArtifactRegistrySync {
  /** registry 通知版本号（产物登记/水合新增时 bump；作 render 重取触发器） */
  registryVersion: number;
  /** blocks 规模/终态计数版本号（变更分段等派生触发器；restore 分页 prepend 也会 bump） */
  blocksVersion: number;
}

export function useArtifactRegistrySync(
  sessionId: string | null,
  store: ArtifactRegistryStoreLike | null,
): ArtifactRegistrySync {
  const [registryVersion, setRegistryVersion] = useState(0);
  const [blocksVersion, setBlocksVersion] = useState(0);

  useEffect(() => {
    return subscribeArtifactRegistry((changedSessionId) => {
      if (changedSessionId === sessionId) setRegistryVersion((v) => v + 1);
    });
  }, [sessionId]);

  // 懒扫水合 + blocks 规模变化增量补齐（restore 分页 prepend 后新到旧块）
  useEffect(() => {
    if (!store || !sessionId) return;
    hydrateSessionArtifacts(sessionId, store.getState());
    let lastTerminalCount = countTerminalToolBlocks(store.getState().blocks);
    const unsub = store.subscribe((state, prev) => {
      if (state.blocks === prev.blocks) return;
      const terminalCount = countTerminalToolBlocks(state.blocks);
      if (state.blocks.size !== prev.blocks.size || terminalCount !== lastTerminalCount) {
        lastTerminalCount = terminalCount;
        hydrateSessionArtifacts(sessionId, state);
        setBlocksVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [sessionId, store]);

  return { registryVersion, blocksVersion };
}

export default useArtifactRegistrySync;
