/**
 * 全局云同步运行状态
 *
 * 云同步有多个 UI 入口（设置页 SyncSettingsSection、数据治理面板 SyncTab 等），
 * 此前各入口用组件内 useState 各自维护 isSyncing，彼此不可见，用户可以在
 * 两个页面同时触发同步。后端已用 try_acquire 全局锁兜底（第二个请求立即
 * 失败），本 store 让所有入口共享同一份"正在同步"状态：
 * - 同步进行中时所有入口的按钮统一禁用；
 * - 重复触发在前端即被拦截，无需等后端报错。
 */
import { create } from 'zustand';

interface GlobalSyncState {
  /** 是否有同步正在进行（任意入口触发的都算） */
  isSyncing: boolean;
  /** 触发当前同步的入口标识（用于调试与提示） */
  source: string | null;
  /**
   * 尝试开始一次同步。
   * @returns true 表示成功占用；false 表示已有同步在进行，调用方应放弃本次触发
   */
  beginSync: (source: string) => boolean;
  /** 同步结束（无论成功失败）时调用，释放占用 */
  endSync: () => void;
}

export const useGlobalSyncStore = create<GlobalSyncState>((set, get) => ({
  isSyncing: false,
  source: null,
  beginSync: (source) => {
    if (get().isSyncing) {
      return false;
    }
    set({ isSyncing: true, source });
    return true;
  },
  endSync: () => set({ isSyncing: false, source: null }),
}));
