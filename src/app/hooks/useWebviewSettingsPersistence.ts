import { useEffect } from 'react';
import { TauriAPI } from '@/utils/tauriApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ debugLog 别名：与 App.tsx 相同，console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * App 壳层：启动时回填 localStorage 缺失的偏好，并每 10 分钟（及启动时）把
 * WebView localStorage 设置快照持久化，供自动备份读取。
 *
 * ★ BUG-15:
 * - 启动先 `hydrateWebviewSettingsFromBackup()`：Tauri→Electron origin 变更、
 *   Android WebView 缓存清理后 localStorage 可能是空库，必须先回填再快照，
 *   否则首轮快照会用空库覆盖掉 SQLite/文件里的备份。
 * - 快照经 `saveWebviewSettings()` 同时写入后端文件与 SQLite
 *   `settings['webview.localstorage.backup']`。
 */
export function useWebviewSettingsPersistence() {
  // 🔧 定期持久化 WebView 设置，确保自动备份可获取
  useEffect(() => {
    let lastSnapshot = '';
    let cancelled = false;
    let hydrationAttempted = false;

    const persistWebviewSettings = async () => {
      if (cancelled) return;
      // 首轮：先回填再快照，避免空 localStorage 覆盖真正的备份
      if (!hydrationAttempted) {
        hydrationAttempted = true;
        try {
          const restored = await TauriAPI.hydrateWebviewSettingsFromBackup();
          if (restored > 0) {
            console.log(`[App] 已从备份回填 ${restored} 个 WebView 设置键`);
          }
        } catch (error) {
          console.warn('[App] WebView 设置回填失败:', error);
        }
        if (cancelled) return;
      }
      try {
        const data = TauriAPI.collectLocalStorageForBackup();
        const snapshot = JSON.stringify(data);
        if (snapshot === lastSnapshot) {
          return;
        }
        lastSnapshot = snapshot;
        // saveWebviewSettings 内部同时镜像到 SQLite settings.webview.localstorage.backup
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
