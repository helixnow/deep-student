/**
 * Super-agent 是否启用（前端镜像）。
 *
 * 权威状态在后端（superagent.db 的 `enabled`，默认 false）。前端只做镜像，用于
 * 决定侧栏入口是否出现——**默认关闭，只有在“设置 → 自动化”里打开开关后才出现**。
 * 镜像缓存在 localStorage 以避免启动时入口闪烁，随后以后端状态为准校正一次。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// 只用到两条命令，直接 invoke：本 store 位于 platform 层，供侧栏（ui 层）读取，不能反向依赖 features/super-agent。
const superAgentApi = {
  status: () => invoke<{ enabled: boolean }>('superagent_status'),
  setEnabled: (enabled: boolean) => invoke<void>('superagent_set_enabled', { enabled }),
};

const STORAGE_KEY = 'ds.superAgent.enabled';

function readCached(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCached(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // 隐私模式 / 禁用存储：忽略，镜像仅是体验优化
  }
}

interface SuperAgentEnabledState {
  enabled: boolean;
  /** 后端是否已校正过镜像 */
  synced: boolean;
  /** 仅更新镜像（后端状态已由别处写入时使用） */
  setMirror: (enabled: boolean) => void;
  /** 设置页开关：写后端，成功后更新镜像；失败则抛出且镜像不变 */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** 从后端校正镜像；后端不可用（如非 Tauri 环境）时保持现状 */
  syncFromBackend: () => Promise<void>;
}

let syncing: Promise<void> | null = null;

export const useSuperAgentEnabledStore = create<SuperAgentEnabledState>()((set, get) => ({
  enabled: readCached(),
  synced: false,
  setMirror: (enabled) => {
    writeCached(enabled);
    set({ enabled });
  },
  setEnabled: async (enabled) => {
    await superAgentApi.setEnabled(enabled);
    get().setMirror(enabled);
  },
  syncFromBackend: () => {
    if (get().synced) return Promise.resolve();
    syncing ??= superAgentApi
      .status()
      .then((s) => {
        writeCached(s.enabled);
        set({ enabled: s.enabled, synced: true });
      })
      .catch(() => {
        // 后端未就绪：保持缓存值，下次挂载再试
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  },
}));

/** 侧栏等处使用：只读镜像，不发起后端调用（校正由 useSyncSuperAgentEnabled 负责）。 */
export function useSuperAgentEnabled(): boolean {
  return useSuperAgentEnabledStore((s) => s.enabled);
}

/** 挂载后从后端校正一次镜像（应用壳与设置页调用；渲染期间不做副作用）。 */
export function useSyncSuperAgentEnabled(): void {
  useEffect(() => {
    void useSuperAgentEnabledStore.getState().syncFromBackend();
  }, []);
}
