/**
 * MCP 配置相关状态 Hook
 * 从 Settings.tsx 拆分
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { McpService, type McpStatusInfo } from '../../../mcp/mcpService';
import { getErrorMessage } from '../../../utils/errorUtils';
import { showGlobalNotification } from '../../UnifiedNotification';

const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

const DEFAULT_STDIO_ARGS = (() => {
  const isWin = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
  return isWin ? ['-y', '@anthropic-ai/server-everything'] : ['-y', '@anthropic-ai/server-everything'];
})();

const MCP_BACKEND_DISABLED_CODE = 'backend_mcp_disabled';
const MCP_BACKEND_DISABLED_HINT = '当前构建未启用后端 MCP 测试命令，请在 Cargo.toml 中开启 mcp 特性后重试。';

export interface McpToolDraft {
  id: string;
  name: string;
  transportType: 'stdio' | 'websocket' | 'sse' | 'streamable_http';
  fetch?: { type: 'sse' | 'streamable_http'; url: string };
  url?: string;
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  endpoint?: string;
  apiKey?: string;
  serverId?: string;
  region?: string;
  hosted?: boolean;
  cwd?: string;
  framing?: 'jsonl' | 'content_length';
  mcpServers?: Record<string, any>;
  namespace?: string;
}

export interface McpToolModalState {
  open: boolean;
  index: number | null;
  mode: 'form' | 'json';
  jsonInput: string;
  draft: McpToolDraft;
  error?: string | null;
}

export interface McpPolicyModalState {
  open: boolean;
  advertiseAll: boolean;
  whitelist: string;
  blacklist: string;
  timeoutMs: number;
  rateLimit: number;
  cacheMax: number;
  cacheTtlMs: number;
}

export interface McpPreviewState {
  open: boolean;
  loading: boolean;
  serverId?: string;
  serverName?: string;
  error?: string;
  tools: any[];
  prompts: any[];
  resources: any[];
}

export interface McpCachedDetails {
  toolsByServer: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }>;
  prompts: { items: Array<{ name: string; description?: string }>; at?: number };
  resources: { items: Array<{ uri: string; name?: string; description?: string; mime_type?: string }>; at?: number };
}

export interface McpSettingsState {
  mcpToolModal: McpToolModalState;
  setMcpToolModal: React.Dispatch<React.SetStateAction<McpToolModalState>>;
  mcpPolicyModal: McpPolicyModalState;
  setMcpPolicyModal: React.Dispatch<React.SetStateAction<McpPolicyModalState>>;
  mcpPreview: McpPreviewState;
  setMcpPreview: React.Dispatch<React.SetStateAction<McpPreviewState>>;
  mcpCachedDetails: McpCachedDetails;
  setMcpCachedDetails: React.Dispatch<React.SetStateAction<McpCachedDetails>>;
  mcpStatusInfo: McpStatusInfo | null;
  setMcpStatusInfo: React.Dispatch<React.SetStateAction<McpStatusInfo | null>>;
  
  // 辅助函数
  isBackendDisabled: (value: any) => boolean;
  normalizeFrontendResult: (r: any) => { success: boolean; tools_count?: number; tools?: any[] };
  describeToolCount: (res: any) => string;
  handleMcpTestResult: (res: any, failureLabel: string) => boolean;
  handleMcpTestError: (error: any, failureLabel: string) => void;
  rebuildCachedDetailsFromSnapshots: (
    toolSnap?: Record<string, { at: number; tools: Array<{ name: string; description?: string; input_schema?: any }> }>,
    promptSnap?: Record<string, { at: number; prompts: Array<{ name: string; description?: string; arguments?: any }> }>,
    resourceSnap?: Record<string, { at: number; resources: Array<{ uri: string; name?: string; description?: string; mime_type?: string }> }>
  ) => void;
  
  // 常量
  DEFAULT_STDIO_ARGS: string[];
  MCP_BACKEND_DISABLED_CODE: string;
  MCP_BACKEND_DISABLED_HINT: string;
}

export function useMcpSettings(): McpSettingsState {
  const { t } = useTranslation(['settings', 'common']);
  
  // MCP 工具编辑模态
  const [mcpToolModal, setMcpToolModal] = useState<McpToolModalState>({
    open: false,
    index: null,
    mode: 'json',
    jsonInput: '',
    draft: {
      id: '',
      name: '',
      transportType: 'stdio',
      command: 'npx',
      args: [...DEFAULT_STDIO_ARGS],
      env: {},
      cwd: '',
      framing: 'jsonl'
    },
    error: null
  });
  
  // MCP 全局策略模态
  const [mcpPolicyModal, setMcpPolicyModal] = useState<McpPolicyModalState>({
    open: false,
    advertiseAll: false,
    whitelist: '',
    blacklist: '',
    timeoutMs: 15000,
    rateLimit: 10,
    cacheMax: 100,
    cacheTtlMs: 300000
  });
  
  // MCP 快速体检/预览状态
  const [mcpPreview, setMcpPreview] = useState<McpPreviewState>({
    open: false,
    loading: false,
    tools: [],
    prompts: [],
    resources: []
  });
  
  // 缓存详情
  const [mcpCachedDetails, setMcpCachedDetails] = useState<McpCachedDetails>({
    toolsByServer: {},
    prompts: { items: [], at: undefined },
    resources: { items: [], at: undefined }
  });
  
  // MCP 状态信息
  const [mcpStatusInfo, setMcpStatusInfo] = useState<McpStatusInfo | null>(null);
  
  // 辅助函数
  const isBackendDisabled = useCallback((value: any): boolean => {
    if (value && typeof value === 'object') {
      if (value.error === MCP_BACKEND_DISABLED_CODE) return true;
    }
    const msg = getErrorMessage(value);
    return typeof msg === 'string' && msg.includes(MCP_BACKEND_DISABLED_CODE);
  }, []);
  
  const normalizeFrontendResult = useCallback((r: any) => ({
    success: !!r?.success,
    tools_count: typeof r?.tools_count === 'number' ? r.tools_count : (Array.isArray(r?.tools) ? r.tools.length : undefined),
    tools: r?.tools
  }), []);
  
  const describeToolCount = useCallback((res: any): string => {
    const count = typeof res?.tools_count === 'number'
      ? res.tools_count
      : Array.isArray(res?.tools) ? res.tools.length : undefined;
    if (typeof count !== 'number') return '';
    return ` (${t('settings:mcp_server_list.tools')}: ${count})`;
  }, [t]);
  
  const handleMcpTestResult = useCallback((res: any, failureLabel: string): boolean => {
    if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
      if (res.success) {
        return true;
      }
      if (res.error === MCP_BACKEND_DISABLED_CODE) {
        showGlobalNotification('warning', MCP_BACKEND_DISABLED_HINT);
        return false;
      }
      const errorMessage = res.error !== undefined ? getErrorMessage(res.error) || t('common:error.unknown_error') : t('common:error.unknown_error');
      showGlobalNotification('error', `${failureLabel}: ${errorMessage}`);
      return false;
    }
    return true;
  }, [t]);
  
  const handleMcpTestError = useCallback((error: any, failureLabel: string) => {
    const message = getErrorMessage(error) || t('common:error.unknown_error');
    if (message.includes(MCP_BACKEND_DISABLED_CODE)) {
      showGlobalNotification('warning', MCP_BACKEND_DISABLED_HINT);
      return;
    }
    showGlobalNotification('error', `${failureLabel}: ${message}`);
  }, [t]);
  
  const rebuildCachedDetailsFromSnapshots = useCallback((
    toolSnap: Record<string, { at: number; tools: Array<{ name: string; description?: string; input_schema?: any }> }> = {},
    promptSnap: Record<string, { at: number; prompts: Array<{ name: string; description?: string; arguments?: any }> }> = {},
    resourceSnap: Record<string, { at: number; resources: Array<{ uri: string; name?: string; description?: string; mime_type?: string }> }> = {}
  ) => {
    const toolMap: McpCachedDetails['toolsByServer'] = {};
    for (const [serverId, snap] of Object.entries(toolSnap)) {
      toolMap[serverId] = { items: snap.tools.map(t => ({ name: t.name, description: t.description })), at: snap.at };
    }
    
    const promptItems: Array<{ name: string; description?: string }> = [];
    let promptAt: number | undefined;
    for (const snap of Object.values(promptSnap)) {
      promptItems.push(...snap.prompts.map(p => ({ name: p.name, description: p.description })));
      promptAt = promptAt == null ? snap.at : Math.max(promptAt, snap.at);
    }
    
    const resourceItems: Array<{ uri: string; name?: string; description?: string; mime_type?: string }> = [];
    let resourceAt: number | undefined;
    for (const snap of Object.values(resourceSnap)) {
      resourceItems.push(...snap.resources);
      resourceAt = resourceAt == null ? snap.at : Math.max(resourceAt, snap.at);
    }
    
    setMcpCachedDetails({
      toolsByServer: toolMap,
      prompts: { items: promptItems, at: promptAt },
      resources: { items: resourceItems, at: resourceAt }
    });
  }, []);
  
  // 监听 MCP 状态
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    
    (async () => {
      try {
        const status = await McpService.status().catch(() => null);
        if (!cancelled && status) setMcpStatusInfo(status);
        unsub = McpService.onStatus((s) => setMcpStatusInfo(s));
      } catch {}
    })();
    
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);
  
  return {
    mcpToolModal,
    setMcpToolModal,
    mcpPolicyModal,
    setMcpPolicyModal,
    mcpPreview,
    setMcpPreview,
    mcpCachedDetails,
    setMcpCachedDetails,
    mcpStatusInfo,
    setMcpStatusInfo,
    isBackendDisabled,
    normalizeFrontendResult,
    describeToolCount,
    handleMcpTestResult,
    handleMcpTestError,
    rebuildCachedDetailsFromSnapshots,
    DEFAULT_STDIO_ARGS,
    MCP_BACKEND_DISABLED_CODE,
    MCP_BACKEND_DISABLED_HINT,
  };
}
