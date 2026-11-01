import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * App 壳层：桌面窗口最大化 / 还原切换（标题栏双击、工具栏按钮双击共用）。从 App.tsx 原样搬出。
 */
export function useDesktopWindowMaximizeToggle() {
  const toggleDesktopWindowMaximize = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
        return;
      }

      await appWindow.maximize();
    } catch (error: unknown) {
      console.error('Failed to toggle desktop window maximize:', error);
    }
  }, []);

  return { toggleDesktopWindowMaximize };
}
