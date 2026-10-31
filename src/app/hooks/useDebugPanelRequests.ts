import { useCallback, useState } from 'react';
import { getDebugEnabled } from '@/utils/emitDebug';
import { useEventRegistry } from '@/hooks/useEventRegistry';

/**
 * App 壳层：全局调试面板的懒加载请求（DSTU_OPEN_DEBUGGER / DEV_TOGGLE_DEBUG_PANEL）。
 * 从 App.tsx 原样搬出。
 */
export function useDebugPanelRequests() {
  const [debugPanelRequested, setDebugPanelRequested] = useState(() => getDebugEnabled());
  const [debugPanelOpenRequest, setDebugPanelOpenRequest] = useState(0);

  // 生产包不会预先加载调试面板。设置页和命令面板都可能在面板尚未挂载时
  // 发起打开请求，因此由 App 保留请求并触发懒加载，避免事件落空。
  const openDebugPanel = useCallback(() => {
    setDebugPanelRequested(true);
    setDebugPanelOpenRequest((request) => request + 1);
  }, []);

  const toggleDebugPanel = useCallback(() => {
    const win = window as Window & { DSTU_TOGGLE_DEBUGGER?: () => void };
    if (typeof win.DSTU_TOGGLE_DEBUGGER === 'function') {
      win.DSTU_TOGGLE_DEBUGGER();
      return;
    }
    openDebugPanel();
  }, [openDebugPanel]);

  useEventRegistry([
    { target: 'window', type: 'DSTU_OPEN_DEBUGGER', listener: openDebugPanel },
    { target: 'window', type: 'DEV_TOGGLE_DEBUG_PANEL', listener: toggleDebugPanel },
  ], [openDebugPanel, toggleDebugPanel]);

  return { debugPanelRequested, debugPanelOpenRequest };
}
