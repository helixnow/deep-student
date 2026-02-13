/**
 * Hook: useDevShowRawRequest
 * 
 * 获取开发者选项中"显示消息请求体"的设置值
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

/**
 * 获取开发者选项中"显示消息请求体"的设置值
 * @returns showRawRequest - 是否显示请求体
 */
export function useDevShowRawRequest(): boolean {
  const [showRawRequest, setShowRawRequest] = useState(false);

  useEffect(() => {
    if (!isTauri) return;

    const loadSetting = async () => {
      try {
        const v = await invoke<string>('get_setting', { key: 'dev.show_raw_request' });
        const value = String(v ?? '').trim().toLowerCase();
        setShowRawRequest(value === 'true' || value === '1');
      } catch {
        setShowRawRequest(false);
      }
    };

    loadSetting();

    // 监听设置变更事件
    const handleSettingsChanged = (e: CustomEvent<{ showRawRequest?: boolean }>) => {
      if (e.detail?.showRawRequest !== undefined) {
        setShowRawRequest(e.detail.showRawRequest);
      }
    };

    window.addEventListener('systemSettingsChanged', handleSettingsChanged as EventListener);
    return () => {
      window.removeEventListener('systemSettingsChanged', handleSettingsChanged as EventListener);
    };
  }, []);

  return showRawRequest;
}
