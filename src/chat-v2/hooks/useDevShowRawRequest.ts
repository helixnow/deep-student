/**
 * Hook: useDevShowRawRequest
 * 
 * 获取开发者选项中"显示消息请求体"和调试过滤级别的设置值
 */

import { useState, useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export type DebugFilterLevel = 'full' | 'standard' | 'compact';

export type ImageFilterMode = 'full' | 'placeholder' | 'remove';
export type ToolFilterMode = 'full' | 'summary' | 'names_only' | 'remove';
export type MessageFilterMode = 'full' | 'truncate' | 'summary';
export type ThinkingFilterMode = 'full' | 'remove';

export interface CopyFilterConfig {
  preset: DebugFilterLevel | 'custom';
  images: ImageFilterMode;
  tools: ToolFilterMode;
  messages: MessageFilterMode;
  messageTruncateLength: number;
  thinking: ThinkingFilterMode;
}

const PRESET_CONFIGS: Record<DebugFilterLevel, Omit<CopyFilterConfig, 'preset'>> = {
  full:     { images: 'full',        tools: 'full',       messages: 'full',     messageTruncateLength: 2000, thinking: 'full' },
  standard: { images: 'placeholder', tools: 'summary',    messages: 'full',     messageTruncateLength: 2000, thinking: 'full' },
  compact:  { images: 'remove',      tools: 'names_only', messages: 'summary',  messageTruncateLength: 500,  thinking: 'remove' },
};

export function getDefaultConfig(): CopyFilterConfig {
  return { preset: 'standard', ...PRESET_CONFIGS.standard };
}

export function configFromPreset(preset: DebugFilterLevel): CopyFilterConfig {
  return { preset, ...PRESET_CONFIGS[preset] };
}

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
// 模块级单例：调试过滤配置（避免每个 MessageItem 都发起 IPC）
// ============================================================================

type Listener = () => void;

let _filterConfig: CopyFilterConfig = getDefaultConfig();
let _filterConfigLoaded = false;
const _filterListeners = new Set<Listener>();

function _notifyFilterListeners() {
  _filterListeners.forEach(fn => fn());
}

function _subscribeFilter(listener: Listener): () => void {
  _filterListeners.add(listener);
  return () => { _filterListeners.delete(listener); };
}

function _getFilterSnapshot(): CopyFilterConfig {
  return _filterConfig;
}

function _initFilterConfig() {
  if (_filterConfigLoaded || !isTauri) return;
  _filterConfigLoaded = true;

  invoke<string>('get_setting', { key: 'debug.filter_config' })
    .then(v => {
      const raw = String(v ?? '').trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<CopyFilterConfig>;
        _filterConfig = { ..._filterConfig, ...parsed };
        _notifyFilterListeners();
      } catch {
        // 兼容旧版：纯字符串 level
        if (raw === 'full' || raw === 'compact') {
          _filterConfig = configFromPreset(raw);
          _notifyFilterListeners();
        }
      }
    })
    .catch(() => { /* keep default */ });

  // 兼容旧版 key
  invoke<string>('get_setting', { key: 'debug.filter_level' })
    .then(v => {
      const val = String(v ?? '').trim().toLowerCase();
      if (_filterConfig.preset === 'standard' && (val === 'full' || val === 'compact')) {
        _filterConfig = configFromPreset(val as DebugFilterLevel);
        _notifyFilterListeners();
      }
    })
    .catch(() => {});

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ copyFilterConfig?: CopyFilterConfig }>).detail;
    if (detail?.copyFilterConfig) {
      _filterConfig = detail.copyFilterConfig;
      _notifyFilterListeners();
    }
  };
  window.addEventListener('systemSettingsChanged', handler);
}

/** 获取调试复制过滤配置（所有组件共享同一份 IPC 结果） */
export function useCopyFilterConfig(): CopyFilterConfig {
  _initFilterConfig();
  return useSyncExternalStore(_subscribeFilter, _getFilterSnapshot);
}

/** @deprecated 兼容旧调用，映射到 config.preset */
export function useDebugFilterLevel(): DebugFilterLevel {
  const config = useCopyFilterConfig();
  return config.preset === 'custom' ? 'standard' : config.preset;
}
