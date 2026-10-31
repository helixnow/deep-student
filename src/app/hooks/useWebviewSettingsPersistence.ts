import { useEffect } from 'react';
import { TauriAPI } from '@/utils/tauriApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * App 壳层：每 10 分钟（及启动时）把 WebView localStorage 设置快照持久化，供自动备份读取。
 * 从 App.tsx 原样搬出。
 */
export function useWebviewSettingsPersistence() {
  // 🔧 定期持久化 WebView 设置，确保自动备份可获取
  useEffect(() => {
    let lastSnapshot = '';
    let cancelled = false;

    const persistWebviewSettings = async () => {
      if (cancelled) return;
      try {
        const data = TauriAPI.collectLocalStorageForBackup();
        const snapshot = JSON.stringify(data);
        if (snapshot === lastSnapshot) {
          return;
        }
        lastSnapshot = snapshot;
        await TauriAPI.saveWebviewSettings(data);
      } catch (error) {
        console.warn('[App] WebView 设置持久化失败:', error);
      }
    };

    void persistWebviewSettings();
    const intervalId = window.setInterval(persistWebviewSettings, 10 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
}
