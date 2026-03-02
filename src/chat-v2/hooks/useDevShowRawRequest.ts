/**
 * Hook: useDevShowRawRequest
 * 
 * 获取开发者选项中"显示消息请求体"和调试过滤级别的设置值
 */

import { useState, useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export type DebugFilterLevel = 'full' | 'standard' | 'compact';

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

// ============================================================================
// 模块级单例：调试过滤级别（避免每个 MessageItem 都发起 IPC）
// ============================================================================

type Listener = () => void;

let _filterLevel: DebugFilterLevel = 'standard';
let _filterLevelLoaded = false;
const _filterListeners = new Set<Listener>();

function _notifyFilterListeners() {
  _filterListeners.forEach(fn => fn());
}

function _subscribeFilter(listener: Listener): () => void {
  _filterListeners.add(listener);
  return () => { _filterListeners.delete(listener); };
}

function _getFilterSnapshot(): DebugFilterLevel {
  return _filterLevel;
}

function _initFilterLevel() {
  if (_filterLevelLoaded || !isTauri) return;
  _filterLevelLoaded = true;

  invoke<string>('get_setting', { key: 'debug.filter_level' })
    .then(v => {
      const val = String(v ?? '').trim().toLowerCase();
      if (val === 'full' || val === 'compact') {
        _filterLevel = val;
        _notifyFilterListeners();
      }
    })
    .catch(() => { /* keep default */ });

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ debugFilterLevel?: DebugFilterLevel }>).detail;
    if (detail?.debugFilterLevel) {
      _filterLevel = detail.debugFilterLevel;
      _notifyFilterListeners();
    }
  };
  window.addEventListener('systemSettingsChanged', handler);
}

/** 获取调试复制过滤级别（所有组件共享同一份 IPC 结果） */
export function useDebugFilterLevel(): DebugFilterLevel {
  _initFilterLevel();
  return useSyncExternalStore(_subscribeFilter, _getFilterSnapshot);
}
