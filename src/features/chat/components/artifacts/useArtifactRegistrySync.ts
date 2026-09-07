/**
 * 会话产物索引同步 hook：挂载时懒扫水合 + 订阅 registry 通知与 blocks 规模变化做增量补齐。
 *
 * 产物面板（列表/变更分段）与 ChatV2Page 入口（有产物才显示）共用本 hook，
 * 避免两份水合逻辑漂移。水合与增量补齐的触发条件见 artifactRegistry。
 */

import { useEffect, useState } from 'react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import { hydrateSessionArtifacts, subscribeArtifactRegistry } from '../../core/store/artifactRegistry';

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
  store: StoreApi<ChatStore> | null,
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
