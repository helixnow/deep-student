import { create } from 'zustand';

interface NetworkState {
  /** 当前是否在线 */
  isOnline: boolean;
  /** 上一次状态变化时间戳 */
  lastChangedAt: number;
}

interface NetworkActions {
  /** 内部使用：更新在线状态 */
  _setOnline: (online: boolean) => void;
}

type NetworkStore = NetworkState & NetworkActions;

export const useNetworkStore = create<NetworkStore>((set) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  lastChangedAt: Date.now(),
  _setOnline: (online) =>
    set({ isOnline: online, lastChangedAt: Date.now() }),
}));
