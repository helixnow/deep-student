import { useCallback } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { toggleDevtools } from '@/dev/devtools';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

/**
 * App 壳层：生产 web 部署下的开发者工具快捷键（Ctrl+Shift+I / Cmd+Alt+I → toggle_devtools）。
 * 从 App.tsx 原样搬出。
 */
export function useDevtoolsShortcut() {
  // 开发者工具快捷键支持 (仅生产模式，仅 Ctrl+Shift+I / Cmd+Alt+I)
  // 注：F12 由命令系统 dev.open-devtools 统一处理；debug 构建下 Cmd+Alt+I 由
  // Tauri 注入热键处理，此处仅覆盖生产 web 部署场景（统一走自有命令 toggle_devtools）
  const handleDevtoolsKeyDown = useCallback(async (event: Event) => {
    const isProduction = !window.location.hostname.includes('localhost') &&
                        !window.location.hostname.includes('127.0.0.1') &&
                        !window.location.hostname.includes('tauri.localhost');
    if (!isProduction) return;

    const keyboardEvent = event as KeyboardEvent;
    const isDevtoolsShortcut =
      (keyboardEvent.ctrlKey && keyboardEvent.shiftKey && keyboardEvent.key === 'I') ||
      (keyboardEvent.metaKey && keyboardEvent.altKey && keyboardEvent.key === 'I');

    if (!isDevtoolsShortcut) return;

    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    const opened = await toggleDevtools();
    if (opened === null) {
      debugLog.warn('[App] DevTools 不可用：当前构建未启用 devtools（需 debug 构建或 --features devtools）');
    }
  }, []);

  useEventRegistry([
    { target: 'document', type: 'keydown', listener: handleDevtoolsKeyDown },
  ], [handleDevtoolsKeyDown]);
}
