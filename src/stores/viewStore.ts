import { create } from 'zustand';
import type { CurrentView } from '@/types/navigation';

interface ViewState {
  /** 当前活跃视图 */
  currentView: CurrentView;
  /** 上一个视图（可用于判断切换方向） */
  previousView: CurrentView | null;
  /** 由 App.tsx 调用，同步视图状态到 store */
  setCurrentView: (view: CurrentView) => void;
}

/**
 * 全局视图状态 store
 *
 * 职责：只读地暴露当前活跃视图，供子组件判断自身可见性。
 * 写入方：仅 App.tsx 在 `currentView` 变化时调用 `setCurrentView`。
 */
export const useViewStore = create<ViewState>()((set, get) => ({
  currentView: 'chat-v2',
  previousView: null,
  setCurrentView: (view: CurrentView) => {
    const prev = get().currentView;
    if (prev !== view) {
      set({ currentView: view, previousView: prev });
    }
  },
}));
