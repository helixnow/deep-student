// @ts-nocheck
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from './ui/NotionDialog';
import UnifiedModal from './UnifiedModal';
import { Input } from './ui/shad/Input';
import { AppSelect } from './ui/app-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/shad/Popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/shad/Tabs';
import { Checkbox } from './ui/shad/Checkbox';
import { cn } from '../lib/utils';
import { UnifiedCodeEditor } from './shared/UnifiedCodeEditor';
import { CustomScrollArea } from './custom-scroll-area';
import { Alert, AlertDescription, AlertTitle } from './ui/shad/Alert';
import { isTauriStdioSupported } from '../mcp/tauriStdioTransport';
import { type McpStatusInfo } from '../mcp/mcpService';
import { testMcpSseFrontend, testMcpHttpFrontend, testMcpWebsocketFrontend } from '../mcp/mcpFrontendTester';
import { DEFAULT_STDIO_ARGS, DEFAULT_STDIO_ARGS_PLACEHOLDER, CHAT_STREAM_SETTINGS_EVENT } from './settings/constants';
import { Info as InfoIcon, Plus, Trash2, X, Check, RefreshCcw } from 'lucide-react';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { useUnifiedErrorHandler } from './UnifiedErrorHandler';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

export function useMcpEditorSection(deps: any) {
  const { config, setConfig, isSmallScreen, activeTab, setActiveTab, setScreenPosition, setRightPanelType, t, extra, setExtra, handleSave, normalizedMcpServers, setMcpStatusInfo } = deps;

  const { errors: mcpErrors, addError: addMcpError, dismissError: dismissMcpError, clearAllErrors: clearMcpErrors } = useUnifiedErrorHandler();

  // MCP 工具编辑模态
  const [mcpToolModal, setMcpToolModal] = useState<{
    open: boolean;
    index: number | null; // null 表示新增
    mode: 'form' | 'json'; // 编辑模式
    jsonInput: string; // JSON输入内容
    draft: { 
      id: string; 
      name: string; 
      transportType: 'stdio'|'websocket'|'sse'|'streamable_http'; 
      // SSE/Streamable HTTP 配置
      fetch?: {
        type: 'sse'|'streamable_http';
        url: string;
      };
      // WebSocket 配置
      url?: string; 
      // Stdio 配置
      command?: string; 
      args?: string[] | string; 
      // 环境变量
      env?: Record<string, string>; 
      // HTTP 请求头
      headers?: Record<string, string>;
      // 旧版兼容字段
      endpoint?: string; 
      apiKey?: string; 
      serverId?: string; 
      region?: string; 
      hosted?: boolean; 
      cwd?: string; 
      framing?: 'jsonl' | 'content_length'; 
      // 新增字段支持
      mcpServers?: Record<string, any>;
      namespace?: string;
    };
    error?: string | null;
  }>({ open: false, index: null, mode: 'json', jsonInput: '', draft: { id: '', name: '', transportType: 'stdio', command: 'npx', args: [...DEFAULT_STDIO_ARGS], env: {}, cwd: '', framing: 'content_length' }, error: null });
  // MCP 全局策略模态（白/黑名单等）
  const [mcpPolicyModal, setMcpPolicyModal] = useState<{ open: boolean; advertiseAll: boolean; whitelist: string; blacklist: string; timeoutMs: number; rateLimit: number; cacheMax: number; cacheTtlMs: number }>({
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
  const [mcpPreview, setMcpPreview] = useState<{ open: boolean; loading: boolean; serverId?: string; serverName?: string; error?: string; tools: any[]; prompts: any[]; resources: any[] }>({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  // stdio 测试细粒度进度步骤（null = 未在测试）
  const [mcpTestStep, setMcpTestStep] = useState<string | null>(null);
  // 缓存详情（不触发新体检）：按照服务器聚合的工具清单 + 全局提示/资源
  const [mcpCachedDetails, setMcpCachedDetails] = useState<{
    toolsByServer: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }>;
    prompts: { items: Array<{ name: string; description?: string }>; at?: number };
    resources: { items: Array<{ uri: string; name?: string; description?: string; mime_type?: string }>; at?: number };
  }>({ toolsByServer: {}, prompts: { items: [], at: undefined }, resources: { items: [], at: undefined } });
  const MCP_BACKEND_DISABLED_CODE = 'backend_mcp_disabled';
  const MCP_BACKEND_DISABLED_HINT = t('settings:mcp.backend_disabled_hint');

  const isBackendDisabled = (value: any): boolean => {
    if (value && typeof value === 'object') {
      if (value.error === MCP_BACKEND_DISABLED_CODE) return true;
    }
    const msg = getErrorMessage(value);
    return typeof msg === 'string' && msg.includes(MCP_BACKEND_DISABLED_CODE);
  };

  const normalizeFrontendResult = (r: any) => ({ success: !!r?.success, tools_count: typeof r?.tools_count === 'number' ? r.tools_count : (Array.isArray(r?.tools) ? r.tools.length : undefined), tools: r?.tools });

  const describeToolCount = (res: any): string => {
    const count = typeof res?.tools_count === 'number'
      ? res.tools_count
      : Array.isArray(res?.tools) ? res.tools.length : undefined;
    return typeof count === 'number' ? `, ${t('settings:mcp_descriptions.tools_count', { count })}` : '';
  };

  const handleMcpTestResult = (res: any, failureLabel: string): boolean => {
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
  };

  const handleMcpTestError = (error: any, failureLabel: string) => {
    const message = getErrorMessage(error) || t('common:error.unknown_error');
    if (message.includes(MCP_BACKEND_DISABLED_CODE)) {
      showGlobalNotification('warning', MCP_BACKEND_DISABLED_HINT);
      return;
    }
    showGlobalNotification('error', `${failureLabel}: ${message}`);
  };
  const renderInfoPopover = React.useCallback(
    (label: string, description: string) => (
      <div className="flex items-center gap-2">
        <span>{label}</span>
        <Popover>
          <PopoverTrigger asChild>
            <NotionButton type="button" variant="ghost" iconOnly size="sm" className="h-6 w-6 text-muted-foreground">
              <InfoIcon className="h-4 w-4" />
            </NotionButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-sm text-xs leading-relaxed">
            {description}
          </PopoverContent>
        </Popover>
      </div>
    ),
    []
  );
  const [mcpStatusInfo, setMcpStatusInfo] = useState<McpStatusInfo | null>(null);
  const rebuildCachedDetailsFromSnapshots = useCallback((
    toolSnap: Record<string, { at: number; tools: Array<{ name: string; description?: string; input_schema?: any }> }> = {},
    promptSnap: Record<string, { at: number; prompts: Array<{ name: string; description?: string; arguments?: any }> }> = {},
    resourceSnap: Record<string, { at: number; resources: Array<{ uri: string; name?: string; description?: string; mime_type?: string }> }> = {}
  ) => {
    const toolMap: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }> = {};
    Object.entries(toolSnap).forEach(([sid, snap]) => {
      toolMap[sid] = {
        at: snap.at,
        items: (snap.tools || []).map(t => ({ name: t.name, description: t.description })),
      };
    });

    const promptItems = Object.values(promptSnap)
      .flatMap(snap => snap.prompts || [])
      .map(p => ({ name: p.name, description: p.description }));
    const promptAt = Object.values(promptSnap).reduce<number | undefined>((acc, snap) => {
      if (!snap.at) return acc;
      if (!acc || snap.at > acc) return snap.at;
      return acc;
    }, undefined);

    const resourceItems = Object.values(resourceSnap)
      .flatMap(snap => snap.resources || [])
      .map(r => ({ uri: r.uri, name: r.name, description: r.description, mime_type: r.mime_type }));
    const resourceAt = Object.values(resourceSnap).reduce<number | undefined>((acc, snap) => {
      if (!snap.at) return acc;
      if (!acc || snap.at > acc) return snap.at;
      return acc;
    }, undefined);

    setMcpCachedDetails({
      toolsByServer: toolMap,
      prompts: { items: promptItems, at: promptAt },
      resources: { items: resourceItems, at: resourceAt },
    });
  }, []);

  const refreshSnapshots = useCallback(async (options?: { reload?: boolean }) => {
    const { McpService } = await import('../mcp/mcpService');
    if (options?.reload) {
      await Promise.allSettled([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
    }
    const toolSnap = McpService.getCachedToolsSnapshot();
    const promptSnap = McpService.getCachedPromptsSnapshot();
    const resourceSnap = McpService.getCachedResourcesSnapshot();
    rebuildCachedDetailsFromSnapshots(toolSnap, promptSnap, resourceSnap);
  }, [rebuildCachedDetailsFromSnapshots]);

  const stripMcpPrefix = useCallback((raw?: string | null) => {
    if (typeof raw !== 'string') return raw ?? '';
    const idx = raw.indexOf(':');
    return idx > 0 ? raw.slice(idx + 1) : raw;
  }, []);

  // ★ 2026-01-15: 导师模式已迁移到 Skills 系统，相关状态和处理函数已删除
  // ★ 2026-01-19: Irec 模块已废弃，相关预设加载/保存逻辑已删除

  const emitChatStreamSettingsUpdate = useCallback((payload: { timeoutMs?: number | null; autoCancel?: boolean }) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CHAT_STREAM_SETTINGS_EVENT, { detail: payload }));
    }
  }, []);
  const resolveServerId = (tool: any, idx: number): string => {
    const transport = (tool?.transportType || tool?.draft?.transportType || 'sse') as string;
    const directId = tool?.id || tool?.name;
    if (directId) return String(directId);
    const fromServers = tool?.mcpServers ? Object.values(tool.mcpServers).find((srv: any) => (srv as any)?.url) as any : undefined;
    if (transport === 'websocket') {
      if (tool?.url) return String(tool.url);
    } else if (transport === 'streamable_http') {
      const httpUrl = tool?.fetch?.url || tool?.endpoint || tool?.url || (fromServers ? (fromServers as any).url : undefined);
      if (httpUrl) return String(httpUrl);
    } else if (transport === 'sse') {
      const sseUrl = tool?.fetch?.url || tool?.endpoint || (fromServers ? (fromServers as any).url : undefined) || tool?.url;
      if (sseUrl) return String(sseUrl);
    }
    if (tool?.command) {
      const args = Array.isArray(tool.args) ? tool.args.join(',') : (tool.args || '');
      return `${tool.command}:${args}`;
    }
    return `mcp_${idx}`;
  };

  const findSnapshotKey = (tool: any, idx: number): string | undefined => {
    const candidates = [
      tool?.id,
      tool?.name,
      tool?.serverId,
      tool?.fetch?.url,
      tool?.endpoint,
      tool?.url,
      tool?.namespace,
      tool?.mcpServers ? Object.keys(tool.mcpServers)[0] : undefined,
      resolveServerId(tool, idx),
    ]
      .map(candidate => (candidate != null && candidate !== '' ? String(candidate) : undefined));
    for (const candidate of candidates) {
      if (candidate && mcpCachedDetails.toolsByServer[candidate]) {
        return candidate;
      }
    }
    return undefined;
  };
  const buildToolJson = (tool: any) => {
    if (tool?.mcpServers) {
      return JSON.stringify({ mcpServers: tool.mcpServers }, null, 2);
    }
    const serverKey = tool?.name || tool?.id || 'mcp_server';
    const config: any = {};
    if (tool?.fetch) {
      config.mcpServers = {
        [serverKey]: {
          type: tool.fetch.type,
          url: tool.fetch.url,
        },
      };
    } else if (tool?.transportType === 'websocket') {
      config.mcpServers = {
        [serverKey]: {
          type: 'websocket',
          url: tool.url,
        },
      };
    } else if (tool?.transportType === 'sse' || tool?.transportType === 'streamable_http') {
      config.mcpServers = {
        [serverKey]: {
          type: tool.transportType,
          url: tool.endpoint || tool.url || '',
        },
      };
    } else if (tool?.transportType === 'stdio') {
      config.mcpServers = {
        [serverKey]: {
          command: tool.command,
      args: Array.isArray(tool.args) ? tool.args : (typeof tool.args === 'string' && tool.args.includes(',') ? tool.args.split(',').map((item: string) => item.trim()).filter((item: string) => item.length > 0) : (typeof tool.args === 'string' && tool.args.length > 0 ? [tool.args.trim()] : [])),
        },
      };
    }
    if (tool?.apiKey && typeof tool.apiKey === 'string') {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].apiKey = tool.apiKey;
    }
    if (tool?.namespace && typeof tool.namespace === 'string') {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].namespace = tool.namespace;
    }
    if (tool?.env && Object.keys(tool.env).length > 0) {
      if (!config.mcpServers) {
        config.mcpServers = { [serverKey]: {} };
      }
      config.mcpServers[serverKey].env = tool.env;
    }
    if (tool?.cwd) {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].cwd = tool.cwd;
    }
    if (tool?.framing) {
      config.mcpServers = config.mcpServers || { [serverKey]: {} };
      config.mcpServers[serverKey].framing = tool.framing;
    }
    return JSON.stringify(config, null, 2);
  };
  const handleAddMcpTool = async (newServer: Partial<any>): Promise<boolean> => {
    try {
      // 构建要保存的服务器数据
      const toolToSave: any = {
        id: newServer.id || `mcp_${Date.now()}`,
        name: newServer.name || t('common:new_mcp_server'),
        transportType: newServer.transportType || 'sse',
        ...newServer,
      };

      // 处理传输类型特定的字段
      if (toolToSave.transportType === 'sse' || toolToSave.transportType === 'streamable_http') {
        toolToSave.fetch = {
          type: toolToSave.transportType,
          url: toolToSave.url || '',
        };
      }

      // 先构建新列表用于持久化，再更新 React 状态（避免竞态）
      const currentList = [...(config.mcpTools || [])];
      currentList.push(toolToSave);
      const newList = currentList;

      // 先持久化
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(newList) });
      }
      // 再更新状态
      setConfig(prev => ({ ...prev, mcpTools: newList }));
      try {
        await refreshSnapshots({ reload: true });
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('common:mcp_tool_saved'));

      // 添加后自动运行一次连通性测试以获取工具列表
      handleTestServer(toolToSave).catch(() => { /* 静默处理测试失败 */ });

      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
      return false;
    }
  };

  const handleEditMcpTool = (tool: any, idx: number) => {
    const jsonInput = buildToolJson(tool) || '{}';
    const transportType = (tool as any).transportType || 'stdio';
    const rawCommand = (tool as any).command || 'npx';
    const deriveArgs = (): string[] | undefined => {
      const rawArgs = (tool as any).args;
      if (Array.isArray(rawArgs)) {
        return rawArgs;
      }
      if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
        return rawArgs
          .split(',')
          .map((segment: string) => segment.trim())
          .filter((segment: string) => segment.length > 0);
      }
      return undefined;
    };

    let normalizedCommand = rawCommand;
    let normalizedArgs = deriveArgs() ?? [];

    if (transportType === 'stdio') {
      const shouldMigrateInlineArgs =
        (!Array.isArray((tool as any).args) || ((tool as any).args || []).length === 0) &&
        /@modelcontextprotocol\//.test(rawCommand);
      if (shouldMigrateInlineArgs) {
        const pieces = rawCommand.split(' ').filter(Boolean);
        if (pieces.length > 1) {
          normalizedCommand = pieces.shift() ?? rawCommand;
          normalizedArgs = pieces;
        }
      }
      if (!normalizedArgs || normalizedArgs.length === 0) {
        normalizedArgs = [...DEFAULT_STDIO_ARGS];
      }
    }

    setMcpToolModal({
      open: true,
      index: idx,
      mode: 'json',
      jsonInput,
      draft: {
        id: tool.id,
        name: tool.name,
        transportType,
        url: (tool as any).url || '',
        command: normalizedCommand,
        args: normalizedArgs,
        env: (tool as any).env || {},
        fetch: (tool as any).fetch,
        endpoint: (tool as any).endpoint || '',
        apiKey: (tool as any).apiKey || '',
        serverId: (tool as any).serverId || '',
        region: (tool as any).region || 'cn-hangzhou',
        hosted: (tool as any).hosted !== undefined ? (tool as any).hosted : true,
        mcpServers: (tool as any).mcpServers,
        namespace: (tool as any).namespace || '',
        cwd: (tool as any).cwd || '',
        framing: (tool as any).framing?.toLowerCase() === 'jsonl' ? 'jsonl' : 'content_length',
      },
      error: null,
    });
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('mcpTool');
      setScreenPosition('right');
    }
  };

  const handleDeleteMcpTool = async (serverId: string): Promise<boolean> => {
    const next = (config.mcpTools || []).filter((tool: any) => tool.id !== serverId);
    try {
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(next) });
      }
      setConfig(prev => ({ ...prev, mcpTools: next }));
      try {
        await refreshSnapshots();
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('settings:common_labels.mcp_tool_deleted'));
      return true;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:notifications.delete_failed', { error: errorMessage }));
      return false;
    }
  };

  // 内联编辑保存 MCP 服务器
  const handleSaveMcpServer = async (updatedData: Partial<any>, serverId: string): Promise<boolean> => {
    try {
      const currentList = [...(config.mcpTools || [])];
      const idx = currentList.findIndex((tool: any) => tool.id === serverId);
      
      if (idx === -1) {
        showGlobalNotification('error', t('settings:mcp_descriptions.server_not_found'));
        return false;
      }
      
      const existing = currentList[idx];

      // 合并更新数据，但清理非标准字段（如 mcpServers 残留）
      const { mcpServers: _discardMcpServers, ...cleanUpdatedData } = updatedData as any;

      const updated = {
        ...existing,
        ...cleanUpdatedData,
        id: existing.id || updatedData.id || `mcp_${Date.now()}`,
      };

      // 处理传输类型特定的字段
      if (updatedData.transportType === 'sse' || updatedData.transportType === 'streamable_http') {
        updated.fetch = {
          type: updatedData.transportType,
          url: updatedData.url || '',
        };
      }

      // 清理存储中的 mcpServers 残留
      delete updated.mcpServers;

      currentList[idx] = updated;
      if (invoke) {
        await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(currentList) });
      }
      setConfig(prev => ({ ...prev, mcpTools: currentList }));
      try {
        await refreshSnapshots({ reload: true });
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('common:mcp_tool_saved'));

      // 编辑保存后自动运行一次连通性测试以刷新工具列表
      handleTestServer(updated).catch(() => { /* 静默处理测试失败 */ });

      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      showGlobalNotification('error', t('settings:mcp_descriptions.save_tool_failed', { error: message }));
      return false;
    }
  };

  const handleOpenMcpPolicy = () => {
    const normalizePositiveNumber = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : fallback;
    };
    const normalizeNonNegativeNumber = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed) : fallback;
    };
    setMcpPolicyModal({
      open: true,
      advertiseAll: config.mcpAdvertiseAll,
      whitelist: config.mcpWhitelist,
      blacklist: config.mcpBlacklist,
      timeoutMs: normalizePositiveNumber(config.mcpTimeoutMs, 15000),
      rateLimit: normalizePositiveNumber(config.mcpRateLimit, 10),
      cacheMax: normalizeNonNegativeNumber(config.mcpCacheMax, 500),
      cacheTtlMs: normalizeNonNegativeNumber(config.mcpCacheTtlMs, 300000),
    });
    // 移动端：使用右侧滑动面板
    if (isSmallScreen) {
      setRightPanelType('mcpPolicy');
      setScreenPosition('right');
    }
  };
  const renderMcpToolEditor = () => {
    // 移动端使用右侧滑动面板，不渲染模态框
    if (isSmallScreen) return null;
    if (!mcpToolModal.open) return null;

    const isEditing = mcpToolModal.index != null;
    const draft = mcpToolModal.draft;
    const transport = draft.transportType ?? 'stdio';
    const envEntries = Object.entries(draft.env || {});
    const argsInput = Array.isArray(draft.args)
      ? draft.args.join(', ')
      : typeof draft.args === 'string'
        ? draft.args
        : draft.args != null
          ? String(draft.args)
          : '';

    const handleClose = () => {
      setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
    };

    const updateDraft = (patch: Partial<typeof draft>) => {
      setMcpToolModal(prev => ({ ...prev, draft: { ...prev.draft, ...patch } }));
    };

    const convertDraftToJson = () => {
      const name = draft.name || t('common:unnamed_mcp_tool');
      const config: Record<string, any> = { mcpServers: {} };
      const server: Record<string, any> = {};
      if (transport === 'sse' || transport === 'streamable_http') {
        server.type = transport;
        server.url = draft.endpoint || draft.fetch?.url || '';
      } else if (transport === 'websocket') {
        server.type = 'websocket';
        server.url = draft.url || '';
      } else {
        server.command = (draft.command || '').trim();
        const argsSource = draft.args;
        const normalizedArgs = Array.isArray(argsSource)
          ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
          : typeof argsSource === 'string'
            ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
            : [];
        server.args = normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS];
        server.framing = draft.framing || 'content_length';
        if (draft.cwd) server.cwd = draft.cwd;
      }
      if (draft.apiKey) server.apiKey = draft.apiKey;
      if (draft.namespace) server.namespace = draft.namespace;
      if (draft.env && Object.keys(draft.env).length > 0) server.env = draft.env;
      config.mcpServers[name] = server;
      setMcpToolModal(prev => ({ ...prev, jsonInput: JSON.stringify(config, null, 2) }));
    };

    const handleModeChange = (value: string) => {
      if (value === 'json' && mcpToolModal.mode !== 'json') {
        convertDraftToJson();
      }
      setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
    };

    const handleEnvKeyChange = (key: string, nextKey: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      const val = next[key];
      delete next[key];
      if (nextKey) {
        next[nextKey] = val ?? '';
      }
      updateDraft({ env: next });
    };

    const handleEnvValueChange = (key: string, value: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      next[key] = value;
      updateDraft({ env: next });
    };

    const addEnvRow = () => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      let index = 1;
      let candidate = `ENV_${index}`;
      while (candidate in next) {
        index += 1;
        candidate = `ENV_${index}`;
      }
      next[candidate] = '';
      updateDraft({ env: next });
    };

    const removeEnvRow = (key: string) => {
      const next = { ...(draft.env || {}) } as Record<string, string>;
      delete next[key];
      updateDraft({ env: next });
    };

    const buildTestHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = {};
      const merge = (source?: Record<string, any>) => {
        if (!source) return;
        Object.entries(source).forEach(([key, value]) => {
          if (value == null) return;
          headers[key] = typeof value === 'string' ? value : String(value);
        });
      };
      // 仅合并 HTTP headers，不合并 env（env 是进程环境变量，不应发送给远程服务器）
      merge(draft.headers as Record<string, string> | undefined);
      return headers;
    };

    const handleTestConnection = async () => {
      try {
        // 改为纯前端体检：不再调用后端 Tauri MCP 测试
        if (transport === 'websocket') {
          const url = (draft.url || '').trim();
          if (!url) {
            showGlobalNotification('error', t('settings:notifications.websocket_url_required'));
            return;
          }
          const fr = await testMcpWebsocketFrontend(url, draft.apiKey || '', buildTestHeaders());
          const res = normalizeFrontendResult(fr);
          if (!handleMcpTestResult(res, t('settings:test_labels.websocket_failed'))) return;
          showGlobalNotification('success', t('settings:mcp_descriptions.test_success', { name: 'WebSocket', toolInfo: describeToolCount(res) }));
        } else if (transport === 'sse' || transport === 'streamable_http') {
          const endpoint = (draft.endpoint || draft.fetch?.url || '').trim();
          if (!endpoint) {
            showGlobalNotification('error', t('settings:notifications.sse_endpoint_required'));
            return;
          }
          const headersForTest = buildTestHeaders();
          const fr = transport === 'streamable_http'
            ? await testMcpHttpFrontend(endpoint, draft.apiKey || '', headersForTest)
            : await testMcpSseFrontend(endpoint, draft.apiKey || '', headersForTest);
          const res = normalizeFrontendResult(fr);
          const failure = transport === 'streamable_http' ? t('settings:test_labels.http_failed') : t('settings:test_labels.sse_failed');
          if (!handleMcpTestResult(res, failure)) return;
          showGlobalNotification('success', t('settings:mcp_descriptions.sse_http_success', { transport: transport === 'streamable_http' ? 'HTTP' : 'SSE', toolCount: describeToolCount(res) }));
        } else {
          // stdio - 检测包管理器环境
          const command = (draft.command || '').trim();
          if (!command) {
            showGlobalNotification('error', t('settings:mcp_descriptions.command_required'));
            return;
          }
          
          try {
            const check = await TauriAPI.checkPackageManager(command);
            if (!check.detected) {
              showGlobalNotification('info', check.message || t('settings:mcp_descriptions.unrecognized_package_manager'));
              return;
            }
            
            if (!check.is_available) {
              // 包管理器不可用，显示安装提示
              const hints = check.install_hints?.join('\n') || t('settings:mcp_descriptions.install_env_manually');
              showGlobalNotification('warning', t('settings:mcp_descriptions.package_manager_not_installed', { manager: check.manager_type, hints }));
              return;
            }
            
            // 包管理器可用，显示成功信息
            showGlobalNotification(
              'success', 
              t('settings:mcp_descriptions.package_manager_ready', { manager: check.manager_type, version: check.version || t('settings:mcp_descriptions.unknown_version') })
            );
          } catch (e) {
            showGlobalNotification('error', t('settings:mcp_descriptions.check_package_manager_failed', { error: e }));
          }
        }
      } catch (error) {
        handleMcpTestError(error, t('settings:messages.connection_test_error'));
      }
    };

    const handleSubmit = async () => {
      try {
        let toolToSave: any;
        if (mcpToolModal.mode === 'json') {
          try {
            const jsonConfig = JSON.parse(mcpToolModal.jsonInput || '{}');
            if (jsonConfig?.mcpServers && typeof jsonConfig.mcpServers === 'object') {
              const [serverName, serverConfig] = Object.entries(jsonConfig.mcpServers)[0] as [string, any];
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: serverName || draft.name || t('common:unnamed_mcp_tool'),
                mcpServers: jsonConfig.mcpServers,
              };
              if (serverConfig?.type === 'sse' || serverConfig?.type === 'streamable_http') {
                toolToSave.transportType = serverConfig.type;
                toolToSave.fetch = { type: serverConfig.type, url: serverConfig.url };
              } else if (serverConfig?.url && typeof serverConfig.url === 'string' && serverConfig.url.startsWith('ws')) {
                toolToSave.transportType = 'websocket';
                toolToSave.url = serverConfig.url;
              } else if (serverConfig?.command) {
                toolToSave.transportType = 'stdio';
                toolToSave.command = serverConfig.command;
                toolToSave.args = serverConfig.args || [];
              }
              if (serverConfig?.env) toolToSave.env = serverConfig.env;
              if (serverConfig?.apiKey) toolToSave.apiKey = serverConfig.apiKey;
              if (serverConfig?.namespace) toolToSave.namespace = serverConfig.namespace;
            } else {
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: jsonConfig.name || draft.name || t('common:unnamed_mcp_tool'),
                ...jsonConfig,
              };
            }
          } catch (err) {
            setMcpToolModal(prev => ({ ...prev, error: t('settings:mcp_errors.json_format_error') + (err as Error).message }));
            return;
          }
        } else {
          if (!draft.name.trim()) {
            showGlobalNotification('error', t('settings:validations.enter_tool_name'));
            return;
          }
          if (transport === 'websocket' && !draft.url?.trim()) {
            showGlobalNotification('error', t('settings:mcp_descriptions.websocket_url_required'));
            return;
          }
          if ((transport === 'sse' || transport === 'streamable_http') && !(draft.endpoint || draft.fetch?.url)?.trim()) {
            showGlobalNotification('error', transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *'));
            return;
          }
          if (transport === 'stdio' && !draft.command?.trim()) {
            showGlobalNotification('error', t('settings:validations.enter_command'));
            return;
          }

          const normalizedDraft: any = { ...draft };
          if (transport === 'sse' || transport === 'streamable_http') {
            normalizedDraft.fetch = {
              type: transport,
              url: draft.endpoint || draft.fetch?.url || '',
            };
          }
          if (transport === 'stdio') {
            const trimmedCommand = draft.command?.trim() ?? '';
            normalizedDraft.command = trimmedCommand;
            const argsSource = draft.args;
            normalizedDraft.args = Array.isArray(argsSource)
              ? argsSource.map(arg => (typeof arg === 'string' ? arg.trim() : String(arg))).filter(Boolean)
              : typeof argsSource === 'string'
                ? argsSource.split(',').map(segment => segment.trim()).filter(Boolean)
                : [];
            if (!Array.isArray(normalizedDraft.args) || normalizedDraft.args.length === 0) {
              normalizedDraft.args = [...DEFAULT_STDIO_ARGS];
            }
          }
          toolToSave = normalizedDraft;
        }

        const nextList = [...(config.mcpTools || [])];
        if (mcpToolModal.index == null) {
          nextList.push(toolToSave);
        } else {
          nextList[mcpToolModal.index] = toolToSave;
        }
        try {
          if (invoke) {
            await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(nextList) });
          }
          setConfig(prev => ({ ...prev, mcpTools: nextList }));
        } catch (error) {
          const message = getErrorMessage(error);
          showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
          return;
        }
        try {
          await refreshSnapshots({ reload: true });
        } catch (e) {
          const errMsg = getErrorMessage(e);
          showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
        }
        setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
        showGlobalNotification('success', t('common:mcp_tool_saved'));
      } catch (error) {
        setMcpToolModal(prev => ({ ...prev, error: getErrorMessage(error) }));
      }
    };

    const modalContentClassName = 'flex w-[min(96vw,960px)] max-h-[85vh] flex-col overflow-hidden p-0';

    return (
      <UnifiedModal isOpen={true} onClose={handleClose} closeOnOverlayClick={false} contentClassName={modalContentClassName}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <NotionDialogHeader>
            <NotionDialogTitle>{isEditing ? t('settings:mcp_descriptions.edit_tool_title') : t('settings:mcp_descriptions.add_tool_title')}</NotionDialogTitle>
            <NotionDialogDescription>{t('settings:mcp_descriptions.tool_modal_hint')}</NotionDialogDescription>
          </NotionDialogHeader>
          <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="mt-1.5 flex flex-1 flex-col justify-start px-3 pb-0 min-h-0">
            <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
            <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
            <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
          </TabsList>
            <div className="mt-1.5 flex-1 overflow-hidden min-h-0">
          <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
            <CustomScrollArea
              className="h-full"
              viewportClassName="pr-2"
              trackOffsetTop={8}
              trackOffsetBottom={8}
              viewportProps={{ style: { maxHeight: 'calc(85vh - 180px)' } }}
            >
            <div className="space-y-2">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:placeholders.server_name')} *</label>
                <Input value={draft.name} onChange={e => updateDraft({ name: e.target.value })} placeholder={t('settings:placeholders.server_name')} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">ID</label>
                <Input value={draft.id} onChange={e => updateDraft({ id: e.target.value })} placeholder="mcp_filesystem" />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.transport_type')}</label>
                <AppSelect value={transport} onValueChange={value => {
                  const nextTransport = value as 'stdio' | 'websocket' | 'sse' | 'streamable_http';
                  const nextDraft: any = { ...draft, transportType: nextTransport };
                  if (nextTransport === 'sse' || nextTransport === 'streamable_http') {
                    nextDraft.fetch = { type: nextTransport, url: draft.fetch?.url || draft.endpoint || '' };
                  } else {
                    delete nextDraft.fetch;
                  }
                  updateDraft(nextDraft);
                }}
                  placeholder={t('settings:mcp_descriptions.transport_type')}
                  options={[
                    { value: 'stdio', label: t('settings:mcp.transport.stdio') },
                    { value: 'websocket', label: t('settings:mcp.transport.websocket') },
                    { value: 'sse', label: t('settings:mcp.transport.sse') },
                    { value: 'streamable_http', label: t('settings:mcp.transport.streamable_http') },
                  ]}
                  variant="outline"
                  size="sm"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp.namespace')}</label>
                <Input value={draft.namespace || ''} onChange={e => updateDraft({ namespace: e.target.value })} placeholder={t('common:optional')} />
              </div>
            </div>

            {transport === 'websocket' && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp.websocket_url')}</label>
                <Input value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
              </div>
            )}

            {(transport === 'sse' || transport === 'streamable_http') && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                  <Input
                    value={draft.endpoint || draft.fetch?.url || ''}
                    onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                    placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp.api_key')}</label>
                  <Input type="password" value={draft.apiKey || ''} onChange={e => updateDraft({ apiKey: e.target.value })} placeholder={t('settings:placeholders.api_key')} />
                </div>
              </div>
            )}

            {transport === 'stdio' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.command_label')}</label>
                  <Input
                    value={draft.command || ''}
                    onChange={e => updateDraft({ command: e.target.value })}
                    placeholder={t('settings:mcp_descriptions.command_placeholder', 'npx')}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings:mcp_descriptions.command_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.args_label')}</label>
                  <Input
                    value={argsInput}
                    onChange={e => updateDraft({ args: e.target.value })}
                    placeholder={t('settings:mcp_descriptions.args_placeholder', DEFAULT_STDIO_ARGS_PLACEHOLDER)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings:mcp_descriptions.args_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm font-medium text-foreground">
                    {renderInfoPopover(t('settings:mcp_descriptions.cwd_label'), t('settings:mcp_descriptions.cwd_hint'))}
                  </div>
                  <Input value={draft.cwd || ''} onChange={e => updateDraft({ cwd: e.target.value })} placeholder="/Users/you/projects" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm font-medium text-foreground">
                    {renderInfoPopover(t('settings:mcp_descriptions.framing_label'), t('settings:mcp_descriptions.framing_hint'))}
                  </div>
                  <AppSelect
                    value={draft.framing || 'content_length'}
                    onValueChange={value => updateDraft({ framing: value as 'jsonl' | 'content_length' })}
                    options={[
                      { value: 'jsonl', label: t('settings:mcp.framing.json_lines') },
                      { value: 'content_length', label: 'Content-Length' },
                    ]}
                    variant="outline"
                    size="sm"
                  />
                </div>
                {!isTauriStdioSupported() && (
                  <Alert variant="warning" style={{ background: 'hsl(var(--warning-bg))', color: 'hsl(var(--warning))', borderColor: 'hsl(var(--warning) / 0.3)' }}>
                    <AlertTitle>{t('settings:mcp_descriptions.stdio_warning_title')}</AlertTitle>
                    <AlertDescription>{t('settings:mcp_descriptions.stdio_warning_desc')}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.env_title')}</span>
                <NotionButton variant="ghost" size="sm" onClick={addEnvRow}>+ {t('settings:mcp_descriptions.add_env')}</NotionButton>
              </div>
              <div className="space-y-2">
                {envEntries.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('settings:mcp_descriptions.env_hint')}</p>
                )}
                {envEntries.map(([key, value], index) => (
                  <div key={`${key}-${index}`} className="flex items-center gap-2">
                    <Input
                      value={key}
                      onChange={e => handleEnvKeyChange(key, e.target.value)}
                      placeholder={t('settings:placeholders.env_key')}
                      className="max-w-[160px]"
                    />
                    <Input
                      value={value}
                      onChange={e => handleEnvValueChange(key, e.target.value)}
                      placeholder={t('settings:placeholders.env_value')}
                    />
                    <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8" onClick={() => removeEnvRow(key)}>
                      <Trash2 className="h-4 w-4" />
                    </NotionButton>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border bg-muted p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.connection_test_title')}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('settings:mcp_descriptions.connection_test_desc')}</p>
                </div>
                <NotionButton variant="ghost" onClick={handleTestConnection}>{t('settings:mcp_descriptions.run_test')}</NotionButton>
              </div>
            </div>
            </div>
            </CustomScrollArea>
          </TabsContent>
          <TabsContent value="json" className="h-full min-h-0 data-[state=inactive]:hidden">
            <div className="space-y-1.5 flex flex-col h-full">
              <UnifiedCodeEditor
                value={mcpToolModal.jsonInput}
                onChange={(value) => setMcpToolModal(prev => ({ ...prev, jsonInput: value }))}
                language="json"
                height="calc(85vh - 200px)"
                lineNumbers
                foldGutter
                highlightActiveLine
                className="rounded-md border border-border"
              />
              <p className="text-xs text-muted-foreground">{t('settings:mcp_descriptions.json_mode_hint')}</p>
            </div>
          </TabsContent>
            </div>
          </Tabs>

          {mcpToolModal.error && (
            <Alert variant="destructive" className="mx-3 mt-1.5 flex-shrink-0">
              <AlertTitle>{t('common:messages.error.title')}</AlertTitle>
              <AlertDescription>{mcpToolModal.error}</AlertDescription>
            </Alert>
          )}

          <NotionDialogFooter>
            <NotionButton variant="ghost" size="sm" onClick={handleClose}>{t('common:actions.cancel')}</NotionButton>
            <NotionButton size="sm" onClick={handleSubmit}>{isEditing ? t('common:actions.save') : t('common:actions.create')}</NotionButton>
          </NotionDialogFooter>
        </div>
      </UnifiedModal>
    );
  };

  // ===== 移动端嵌入式 MCP 工具编辑器 =====
  const renderMcpToolEditorEmbedded = () => {
    if (!mcpToolModal.open) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:mcp_descriptions.select_tool_to_edit')}</p>
        </div>
      );
    }

    const isEditing = mcpToolModal.index != null;
    const draft = mcpToolModal.draft;
    const transport = draft.transportType ?? 'stdio';
    const envEntries = Object.entries(draft.env || {});
    const argsInput = Array.isArray(draft.args)
      ? draft.args.join(', ')
      : typeof draft.args === 'string'
        ? draft.args
        : draft.args != null
          ? String(draft.args)
          : '';

    const handleClose = () => {
      setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
      closeRightPanel();
    };

    const updateDraft = (patch: Partial<typeof draft>) => {
      setMcpToolModal(prev => ({ ...prev, draft: { ...prev.draft, ...patch } }));
    };

    const handleModeChange = (value: string) => {
      if (value === 'json' && mcpToolModal.mode !== 'json') {
        // 转换为 JSON
        const name = draft.name || t('common:unnamed_mcp_tool');
        const config: Record<string, any> = { mcpServers: {} };
        const server: Record<string, any> = {};
        if (transport === 'sse' || transport === 'streamable_http') {
          server.type = transport;
          server.url = draft.endpoint || draft.fetch?.url || '';
        } else if (transport === 'websocket') {
          server.type = 'websocket';
          server.url = draft.url || '';
        } else {
          server.command = (draft.command || '').trim();
          const argsSource = draft.args;
          const normalizedArgs = Array.isArray(argsSource)
            ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
            : typeof argsSource === 'string'
              ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
              : [];
          server.args = normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS];
          server.framing = draft.framing || 'content_length';
          if (draft.cwd) server.cwd = draft.cwd;
        }
        if (draft.apiKey) server.apiKey = draft.apiKey;
        if (draft.namespace) server.namespace = draft.namespace;
        if (draft.env && Object.keys(draft.env).length > 0) server.env = draft.env;
        config.mcpServers[name] = server;
        setMcpToolModal(prev => ({ ...prev, jsonInput: JSON.stringify(config, null, 2) }));
      }
      setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
    };

    const handleSubmit = async () => {
      try {
        let toolToSave: any;
        if (mcpToolModal.mode === 'json') {
          try {
            const jsonConfig = JSON.parse(mcpToolModal.jsonInput || '{}');
            if (jsonConfig?.mcpServers && typeof jsonConfig.mcpServers === 'object') {
              const [serverName, serverConfig] = Object.entries(jsonConfig.mcpServers)[0] as [string, any];
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: serverName,
                transportType: serverConfig.type || serverConfig.transportType || (serverConfig.command ? 'stdio' : 'sse'),
                command: serverConfig.command,
                args: serverConfig.args,
                env: serverConfig.env,
                url: serverConfig.url,
                endpoint: serverConfig.url,
                fetch: serverConfig.type === 'sse' || serverConfig.type === 'streamable_http' ? { type: serverConfig.type, url: serverConfig.url } : undefined,
                apiKey: serverConfig.apiKey,
                namespace: serverConfig.namespace,
                cwd: serverConfig.cwd,
                framing: serverConfig.framing,
              };
            } else {
              // 兼容非 mcpServers 格式的 JSON — 防止 toolToSave 为 undefined
              toolToSave = {
                id: draft.id || `mcp_${Date.now()}`,
                name: jsonConfig.name || draft.name || t('common:unnamed_mcp_tool'),
                transportType: jsonConfig.transportType || jsonConfig.type || 'sse',
                url: jsonConfig.url,
                command: jsonConfig.command,
                args: jsonConfig.args,
                env: jsonConfig.env,
                apiKey: jsonConfig.apiKey,
                namespace: jsonConfig.namespace,
              };
            }
          } catch (err) {
            setMcpToolModal(prev => ({ ...prev, error: t('settings:mcp_errors.json_format_error') + (err as Error).message }));
            return;
          }
        } else {
          const argsSource = draft.args;
          const normalizedArgs = Array.isArray(argsSource)
            ? argsSource.map(item => (typeof item === 'string' ? item.trim() : String(item))).filter(Boolean)
            : typeof argsSource === 'string'
              ? argsSource.split(',').map(item => item.trim()).filter(Boolean)
              : [];
          toolToSave = {
            id: draft.id || `mcp_${Date.now()}`,
            name: draft.name,
            transportType: transport,
            command: transport === 'stdio' ? draft.command : undefined,
            args: transport === 'stdio' ? (normalizedArgs.length > 0 ? normalizedArgs : [...DEFAULT_STDIO_ARGS]) : undefined,
            env: draft.env,
            url: transport === 'websocket' ? draft.url : undefined,
            endpoint: (transport === 'sse' || transport === 'streamable_http') ? (draft.endpoint || draft.fetch?.url) : undefined,
            fetch: (transport === 'sse' || transport === 'streamable_http') ? { type: transport, url: draft.endpoint || draft.fetch?.url || '' } : undefined,
            apiKey: draft.apiKey,
            namespace: draft.namespace,
            cwd: draft.cwd,
            framing: draft.framing,
          };
        }

        const nextList = [...(config.mcpTools || [])];
        if (mcpToolModal.index == null) {
          nextList.push(toolToSave);
        } else {
          nextList[mcpToolModal.index] = toolToSave;
        }
        try {
          if (invoke) {
            await invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify(nextList) });
          }
          setConfig(prev => ({ ...prev, mcpTools: nextList }));
        } catch (e) {
          const message = getErrorMessage(e);
          showGlobalNotification('error', `${t('settings:mcp_descriptions.save_failed')}: ${message}`);
          return;
        }
        try {
          await refreshSnapshots({ reload: true });
        } catch (e) {
          const errMsg = getErrorMessage(e);
          showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
        }
        setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
        closeRightPanel();
        showGlobalNotification('success', t('common:mcp_tool_saved'));
      } catch (error) {
        setMcpToolModal(prev => ({ ...prev, error: getErrorMessage(error) }));
      }
    };

    return (
      <div
        className="h-full flex flex-col bg-background"
        style={{
          paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
        }}
      >
        <div className="px-4 pt-4 pb-2 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold">{isEditing ? t('settings:mcp_descriptions.edit_tool_title') : t('settings:mcp_descriptions.add_tool_title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('settings:mcp_descriptions.tool_modal_hint')}</p>
        </div>

        <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="flex-1 flex flex-col min-h-0 px-4 pt-3">
          <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
            <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
            <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-hidden min-h-0 mt-3">
            <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
              <CustomScrollArea className="h-full" viewportClassName="pr-2">
                <div className="space-y-4 pb-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:placeholders.server_name')} *</label>
                    <Input value={draft.name} onChange={e => updateDraft({ name: e.target.value })} placeholder={t('settings:placeholders.server_name')} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">ID</label>
                    <Input value={draft.id} onChange={e => updateDraft({ id: e.target.value })} placeholder="mcp_filesystem" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp_descriptions.transport_type')}</label>
                    <AppSelect value={transport} onValueChange={value => {
                      const nextTransport = value as 'stdio' | 'websocket' | 'sse' | 'streamable_http';
                      const nextDraft: any = { ...draft, transportType: nextTransport };
                      if (nextTransport === 'sse' || nextTransport === 'streamable_http') {
                        nextDraft.fetch = { type: nextTransport, url: draft.fetch?.url || draft.endpoint || '' };
                      } else {
                        delete nextDraft.fetch;
                      }
                      updateDraft(nextDraft);
                    }}
                      placeholder={t('settings:mcp_descriptions.transport_type')}
                      options={[
                        { value: 'stdio', label: t('settings:mcp.transport.stdio') },
                        { value: 'websocket', label: t('settings:mcp.transport.websocket') },
                        { value: 'sse', label: t('settings:mcp.transport.sse') },
                        { value: 'streamable_http', label: t('settings:mcp.transport.streamable_http') },
                      ]}
                      variant="outline"
                      size="sm"
                    />
                  </div>

                  {transport === 'websocket' && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{t('settings:mcp.websocket_url')}</label>
                      <Input value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
                    </div>
                  )}

                  {(transport === 'sse' || transport === 'streamable_http') && (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                        <Input
                          value={draft.endpoint || draft.fetch?.url || ''}
                          onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                          placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp.api_key')}</label>
                        <Input type="password" value={draft.apiKey || ''} onChange={e => updateDraft({ apiKey: e.target.value })} placeholder={t('settings:placeholders.api_key')} />
                      </div>
                    </>
                  )}

                  {transport === 'stdio' && (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.command_label')}</label>
                        <Input
                          value={draft.command || ''}
                          onChange={e => updateDraft({ command: e.target.value })}
                          placeholder={t('settings:mcp_descriptions.command_placeholder', 'npx')}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.args_label')}</label>
                        <Input
                          value={argsInput}
                          onChange={e => updateDraft({ args: e.target.value })}
                          placeholder={t('settings:mcp_descriptions.args_placeholder', DEFAULT_STDIO_ARGS_PLACEHOLDER)}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{t('settings:mcp_descriptions.cwd_label')}</label>
                        <Input value={draft.cwd || ''} onChange={e => updateDraft({ cwd: e.target.value })} placeholder="/Users/you/projects" />
                      </div>
                    </>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp.namespace')}</label>
                    <Input value={draft.namespace || ''} onChange={e => updateDraft({ namespace: e.target.value })} placeholder={t('common:optional')} />
                  </div>

                  {/* 环境变量 */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp_descriptions.env_label')}</label>
                    {envEntries.map(([key, value], idx) => (
                      <div key={idx} className="flex gap-2">
                        <Input
                          value={key}
                          onChange={e => {
                            const newEnv = { ...draft.env };
                            delete newEnv[key];
                            newEnv[e.target.value] = value;
                            updateDraft({ env: newEnv });
                          }}
                          placeholder={t('settings:placeholders.env_key')}
                          className="flex-1"
                        />
                        <Input
                          value={value}
                          onChange={e => updateDraft({ env: { ...draft.env, [key]: e.target.value } })}
                          placeholder={t('settings:placeholders.env_value')}
                          className="flex-1"
                        />
                        <NotionButton
                          variant="ghost"
                          iconOnly size="sm"
                          onClick={() => {
                            const newEnv = { ...draft.env };
                            delete newEnv[key];
                            updateDraft({ env: newEnv });
                          }}
                        >
                          <X className="h-4 w-4" />
                        </NotionButton>
                      </div>
                    ))}
                    <NotionButton
                      variant="default"
                      size="sm"
                      onClick={() => updateDraft({ env: { ...draft.env, '': '' } })}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      {t('settings:mcp_descriptions.add_env')}
                    </NotionButton>
                  </div>
                </div>
              </CustomScrollArea>
            </TabsContent>

            <TabsContent value="json" className="h-full min-h-0 data-[state=inactive]:hidden">
              <div className="h-full flex flex-col">
                <UnifiedCodeEditor
                  value={mcpToolModal.jsonInput}
                  onChange={(value) => setMcpToolModal(prev => ({ ...prev, jsonInput: value }))}
                  language="json"
                  height="100%"
                  lineNumbers
                  foldGutter
                  highlightActiveLine
                  className="flex-1 rounded-md border border-border"
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {mcpToolModal.error && (
          <Alert variant="destructive" className="mx-4 mt-2 flex-shrink-0">
            <AlertTitle>{t('common:messages.error.title')}</AlertTitle>
            <AlertDescription>{mcpToolModal.error}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <NotionButton variant="ghost" onClick={handleClose} className="flex-1">{t('common:actions.cancel')}</NotionButton>
          <NotionButton onClick={handleSubmit} className="flex-1">{isEditing ? t('common:actions.save') : t('common:actions.create')}</NotionButton>
        </div>
      </div>
    );
  };

  // ===== 移动端嵌入式 MCP 策略编辑器 =====
  const renderMcpPolicyEditorEmbedded = () => {
    if (!mcpPolicyModal.open) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('settings:mcp_descriptions.select_policy_to_edit')}</p>
        </div>
      );
    }

    const handleClose = () => {
      setMcpPolicyModal(prev => ({ ...prev, open: false }));
      closeRightPanel();
    };

    const handleSave = async () => {
      const nextPolicy = {
        mcpAdvertiseAll: mcpPolicyModal.advertiseAll,
        mcpWhitelist: mcpPolicyModal.whitelist,
        mcpBlacklist: mcpPolicyModal.blacklist,
        mcpTimeoutMs: mcpPolicyModal.timeoutMs,
        mcpRateLimit: mcpPolicyModal.rateLimit,
        mcpCacheMax: mcpPolicyModal.cacheMax,
        mcpCacheTtlMs: mcpPolicyModal.cacheTtlMs,
      };
      try {
        if (invoke) {
          await Promise.all([
            invoke('save_setting', { key: 'mcp.tools.advertise_all_tools', value: mcpPolicyModal.advertiseAll.toString() }),
            invoke('save_setting', { key: 'mcp.tools.whitelist', value: mcpPolicyModal.whitelist }),
            invoke('save_setting', { key: 'mcp.tools.blacklist', value: mcpPolicyModal.blacklist }),
            invoke('save_setting', { key: 'mcp.performance.timeout_ms', value: String(mcpPolicyModal.timeoutMs) }),
            invoke('save_setting', { key: 'mcp.performance.rate_limit_per_second', value: String(mcpPolicyModal.rateLimit) }),
            invoke('save_setting', { key: 'mcp.performance.cache_max_size', value: String(mcpPolicyModal.cacheMax) }),
            invoke('save_setting', { key: 'mcp.performance.cache_ttl_ms', value: String(mcpPolicyModal.cacheTtlMs) }),
          ]);
        }
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        console.error('保存MCP安全策略失败:', err);
        showGlobalNotification('error', t('settings:mcp_descriptions.policy_save_failed', { error: errorMessage }));
        return;
      }
      setConfig(prev => ({ ...prev, ...nextPolicy }));
      showGlobalNotification('success', t('settings:mcp_descriptions.policy_saved'));
      handleClose();
    };

    return (
      <div
        className="h-full flex flex-col bg-background"
        style={{
          paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
        }}
      >
        <div className="px-4 pt-4 pb-2 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold">{t('settings:mcp_descriptions.policy_title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('settings:mcp_descriptions.policy_subtitle')}</p>
        </div>

        <CustomScrollArea className="flex-1" viewportClassName="px-4 py-4">
          <div className="space-y-4">
            {/* 广告所有工具 */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="advertiseAll"
                checked={mcpPolicyModal.advertiseAll}
                onCheckedChange={(checked) => setMcpPolicyModal(prev => ({ ...prev, advertiseAll: checked === true }))}
              />
              <label htmlFor="advertiseAll" className="text-sm font-medium cursor-pointer">
                {t('settings:mcp_descriptions.advertise_all')}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings:mcp_descriptions.advertise_all_hint')}
            </p>

            {/* 白名单 */}
            {!mcpPolicyModal.advertiseAll && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.whitelist_label')}</label>
                <Input
                  value={mcpPolicyModal.whitelist}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, whitelist: e.target.value }))}
                  placeholder="read_file, write_file, list_directory"
                />
              </div>
            )}

            {/* 黑名单 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.blacklist_label')}</label>
              <Input
                value={mcpPolicyModal.blacklist}
                onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, blacklist: e.target.value }))}
                placeholder="delete_file, execute_command, rm, sudo"
              />
            </div>

            {/* 性能参数 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.timeout_label')}</label>
                <Input
                  type="number"
                  min={1000}
                  value={mcpPolicyModal.timeoutMs}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.rate_limit_label')}</label>
                <Input
                  type="number"
                  min={1}
                  value={mcpPolicyModal.rateLimit}
                  onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_max_label')}</label>
                <Input
                  type="number"
                  min={0}
                  value={mcpPolicyModal.cacheMax}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    setMcpPolicyModal(prev => ({
                      ...prev,
                      cacheMax: Number.isFinite(parsed) ? Math.max(0, parsed) : 100,
                    }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_ttl_label')}</label>
                <Input
                  type="number"
                  min={0}
                  value={mcpPolicyModal.cacheTtlMs}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    setMcpPolicyModal(prev => ({
                      ...prev,
                      cacheTtlMs: Number.isFinite(parsed) ? Math.max(0, parsed) : 300000,
                    }));
                  }}
                />
              </div>
            </div>
          </div>
        </CustomScrollArea>

        <div className="flex gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <NotionButton variant="ghost" onClick={handleClose} className="flex-1">{t('common:actions.cancel')}</NotionButton>
          <NotionButton onClick={handleSave} className="flex-1">{t('common:actions.save')}</NotionButton>
        </div>
      </div>
    );
  };

  // ===== 移动端嵌入式供应商配置编辑器 =====
  const handleReconnectClient = async () => {
    try {
      // 重新从设置初始化（确保新增/删除的服务器生效），而不仅仅 connectAll
      const { bootstrapMcpFromSettings } = await import('../mcp/mcpService');
      await bootstrapMcpFromSettings({ force: true });
      try {
        await invoke('preheat_mcp_tools');
      } catch (e) {
        console.warn('[MCP] 预热工具缓存失败:', e);
      }
      await refreshSnapshots({ reload: true });
      try {
        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { mcpReloaded: true } }));
      } catch {
        // 事件派发失败不影响主流程，重连已完成
      }
      showGlobalNotification('success', t('settings:mcp_descriptions.reconnected'));
    } catch (e: any) {
      try {
        addMcpError('network', e, {
          title: t('settings:mcp_descriptions.frontend_connect_failed'),
          recoveryActions: [
            {
              type: 'retry',
              label: t('settings:mcp_descriptions.retry_connect'),
              icon: <RefreshCcw size={12} />,
              variant: 'primary',
              action: async () => {
                try {
                  const { bootstrapMcpFromSettings } = await import('../mcp/mcpService');
                  await bootstrapMcpFromSettings({ force: true });
                  await invoke('preheat_mcp_tools').catch(() => undefined);
                  await refreshSnapshots({ reload: true });
                  showGlobalNotification('success', t('settings:mcp_descriptions.reconnected_preheated'));
                } catch (err) {
                  console.error('重试连接失败:', err);
                }
              },
            },
            {
              type: 'cancel',
              label: t('common:close'),
              icon: <X size={12} />,
              variant: 'secondary',
              action: () => {},
            },
          ],
          additionalContext: { at: new Date().toISOString() },
        });
      } catch (innerErr) {
        console.warn('[Settings] 记录 MCP 连接错误时自身也失败:', innerErr);
      }
      showGlobalNotification('error', t('settings:mcp_descriptions.reconnect_failed', { error: e?.message || e }));
    }
  };

  const handleRefreshRegistry = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      const [tools, prompts, resources] = await Promise.all([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.refreshed_summary', { tools: tools.length, prompts: prompts.length, resources: resources.length }));
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.refresh_failed', { error: e?.message || e }));
    }
  };
  const handleRunHealthCheck = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      await McpService.connectAll().catch(() => undefined);
      const status = await McpService.status();
      if (!status.servers.length) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.no_servers_configured'));
        return;
      }
      const summaries: string[] = [];
      const failures: string[] = [];
      const configured = normalizedMcpServers.map((item: any, index: number) => ({ item, index }));
      for (const server of status.servers) {
        try {
          if (!server.connected) {
            await McpService.connectServerById(server.id).catch(() => undefined);
          }
          const [tools, prompts, resources] = await Promise.all([
            McpService.fetchServerTools(server.id).catch(() => []),
            McpService.fetchServerPrompts(server.id).catch(() => []),
            McpService.fetchServerResources(server.id).catch(() => []),
          ]);
          const match = configured.find(({ item, index }) => {
            const candidateId = resolveServerId(item, index);
            return candidateId === server.id || item?.id === server.id || item?.name === server.id;
          });
          const label = match?.item?.name || server.id;
          summaries.push(`✅ ${t('settings:mcp_descriptions.health_check_item', { label, tools: tools.length, prompts: prompts.length, resources: resources.length })}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`❌ ${server.id}: ${message}`);
        }
      }
      await refreshSnapshots();
      const message = [...summaries, ...failures].join('\n');
      if (failures.length > 0) {
        showGlobalNotification('warning', t('settings:mcp_descriptions.health_partial_failed', { message }));
      } else {
        showGlobalNotification('success', t('settings:mcp_descriptions.health_complete', { message }));
      }
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.health_failed', { error: e?.message || e }));
    }
  };

  const handleClearCaches = async () => {
    try {
      const { McpService } = await import('../mcp/mcpService');
      McpService.clearCaches();
      // 清缓存后自动重新获取，避免统计卡片归零让用户困惑
      await Promise.allSettled([
        McpService.refreshTools(true),
        McpService.refreshPrompts(true),
        McpService.refreshResources(true),
      ]);
      await refreshSnapshots();
      showGlobalNotification('success', t('settings:mcp_descriptions.cache_cleared'));
    } catch (e: any) {
      showGlobalNotification('error', t('settings:mcp_descriptions.clear_cache_failed', { error: e?.message || e }));
    }
  };

  const handlePreviewServer = async (tool: any, idx: number) => {
    const serverId = resolveServerId(tool, idx);
    const serverName = tool?.name || tool?.id || serverId;
    setMcpPreview({ open: true, loading: true, serverId, serverName, tools: [], prompts: [], resources: [] });
    try {
      const { McpService } = await import('../mcp/mcpService');
      const [toolList, promptList, resourceList] = await Promise.all([
        McpService.fetchServerTools(serverId).catch(() => []),
        McpService.fetchServerPrompts(serverId).catch(() => []),
        McpService.fetchServerResources(serverId).catch(() => []),
      ]);
      await refreshSnapshots();
      setMcpPreview(prev => ({ ...prev, loading: false, tools: toolList, prompts: promptList, resources: resourceList }));
    } catch (e: any) {
      setMcpPreview(prev => ({ ...prev, loading: false, error: e?.message || String(e) }));
    }
  };
  const handleTestServer = async (tool: any) => {
    try {
      const transport = (tool?.transportType || 'sse') as string;
      let failureLabel = t('settings:test_labels.connectivity_test_failed');
      let res: any = null;
      const headerCandidates: Record<string, string> = {};
      const mergeHeaders = (source?: Record<string, any>) => {
        if (!source) return;
        Object.entries(source).forEach(([key, value]) => {
          if (value == null) return;
          headerCandidates[key] = typeof value === 'string' ? value : String(value);
        });
      };
      // 仅合并 headers，不合并 env（env 是进程环境变量，不应发送到远程服务器）
      mergeHeaders(tool?.headers as Record<string, any> | undefined);
      // 改为仅使用前端体检
      if (transport === 'websocket') {
        failureLabel = t('settings:test_labels.websocket_failed');
        const fr = await testMcpWebsocketFrontend(String(tool?.url || ''), String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'streamable_http') {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.http_failed');
        const fr = await testMcpHttpFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      } else if (transport === 'stdio') {
        // stdio 走后端 test_mcp_connection，带细粒度进度
        failureLabel = t('settings:test_labels.connectivity_test_failed');
        const rawArgs = tool?.args;
        const argsArr: string[] = Array.isArray(rawArgs)
          ? rawArgs
          : typeof rawArgs === 'string'
            ? rawArgs.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await tauriListen<{ step: string }>('mcp-test-progress', (event) => {
            setMcpTestStep(event.payload.step);
          });
          setMcpTestStep('spawn_process');
          const backendRes: any = await tauriInvoke('test_mcp_connection', {
            command: String(tool?.command || ''),
            args: argsArr,
            env: tool?.env || null,
            cwd: tool?.cwd || null,
            framing: tool?.framing || null,
          });
          res = {
            success: !!backendRes?.success,
            tools_count: backendRes?.tools_count,
            tools: backendRes?.tools_preview,
            error: backendRes?.error,
          };
        } finally {
          unlisten?.();
          setMcpTestStep(null);
        }
      } else {
        const endpoint = String(tool?.fetch?.url || tool?.endpoint || tool?.url || '');
        failureLabel = t('settings:test_labels.sse_failed');
        const fr = await testMcpSseFrontend(endpoint, String(tool?.apiKey || ''), headerCandidates);
        res = normalizeFrontendResult(fr);
      }
      if (!handleMcpTestResult(res, failureLabel)) return;
      showGlobalNotification('success', t('settings:mcp_descriptions.test_success', { name: tool?.name || tool?.id || 'MCP', toolInfo: describeToolCount(res) }));

      // 将连通性测试发现的工具写回缓存，让 UI 立即显示正确的工具数量
      const serverId = tool?.id || tool?.name;
      if (serverId && Array.isArray(res?.tools) && res.tools.length > 0) {
        setMcpCachedDetails(prev => ({
          ...prev,
          toolsByServer: {
            ...prev.toolsByServer,
            [serverId]: {
              items: res.tools.map((t: any) => ({ name: t.name, description: t.description })),
              at: Date.now(),
            },
          },
        }));
      }
    } catch (e: any) {
      handleMcpTestError(e, t('settings:messages.connection_test_error'));
    }
  };

  const handleClosePreview = () => {
    setMcpPreview({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  };

  const mcpServers = normalizedMcpServers;
  const serverStatusMap = useMemo(() => {
    const map = new Map<string, { connected: boolean; error?: string }>();
    (mcpStatusInfo?.servers || []).forEach(s => {
      map.set(s.id, { connected: s.connected, error: s.error });
    });
    return map;
  }, [mcpStatusInfo]);
  const totalServers = mcpServers.length;
  const connectedServers = useMemo(() => {
    if (!totalServers) return 0;
    const entries = Array.from(serverStatusMap.values()).filter(s => s.connected);
    return entries.length;
  }, [serverStatusMap, totalServers]);
  const totalCachedTools = useMemo(() => {
    return Object.values(mcpCachedDetails.toolsByServer).reduce((acc, entry) => acc + (entry?.items?.length || 0), 0);
  }, [mcpCachedDetails.toolsByServer]);
  const promptsCount = mcpCachedDetails.prompts.items.length;
  const resourcesCount = mcpCachedDetails.resources.items.length;
  const lastCacheUpdatedAt = useMemo(() => {
    const toolTs = Object.values(mcpCachedDetails.toolsByServer)
      .map(entry => entry?.at)
      .filter((v): v is number => typeof v === 'number');
    const overviews = [mcpCachedDetails.prompts.at, mcpCachedDetails.resources.at].filter(
      (v): v is number => typeof v === 'number'
    );
    const all = [...toolTs, ...overviews];
    if (!all.length) return undefined;
    return Math.max(...all);
  }, [mcpCachedDetails]);
  const lastCacheUpdatedText = lastCacheUpdatedAt
    ? new Date(lastCacheUpdatedAt).toLocaleString()
    : '—';
  const lastError = mcpStatusInfo?.lastError;
  const displayedLastError = lastError && lastError.length > 96 ? `${lastError.slice(0, 96)}…` : lastError;
  const cacheCapacity = useMemo(() => {
    const candidate = Number(config.mcpCacheMax ?? 500);
    if (Number.isNaN(candidate) || candidate < 0) return 500;
    return candidate;
  }, [config.mcpCacheMax]);
  const cacheUsagePercent = useMemo(() => {
    if (!cacheCapacity) return 0;
    const ratio = (totalCachedTools / cacheCapacity) * 100;
    if (!Number.isFinite(ratio)) return 0;
    return Math.max(0, Math.min(100, Math.round(ratio)));
  }, [cacheCapacity, totalCachedTools]);
  const latestPrompts = useMemo(() => mcpCachedDetails.prompts.items.slice(0, 5), [mcpCachedDetails.prompts.items]);
  const latestResources = useMemo(() => mcpCachedDetails.resources.items.slice(0, 5), [mcpCachedDetails.resources.items]);

  return { mcpToolModal, setMcpToolModal, mcpPolicyModal, setMcpPolicyModal, mcpPreview, mcpTestStep, stripMcpPrefix, emitChatStreamSettingsUpdate, refreshSnapshots, handleDeleteMcpTool, handleSaveMcpServer, handleTestServer, handleReconnectClient, handleAddMcpTool, handleOpenMcpPolicy, handleClosePreview, renderMcpToolEditor, renderMcpToolEditorEmbedded, renderMcpPolicyEditorEmbedded, mcpCachedDetails, mcpServers, serverStatusMap, lastError, cacheCapacity, lastCacheUpdatedAt, lastCacheUpdatedText, connectedServers, totalServers, totalCachedTools, promptsCount, resourcesCount, cacheUsagePercent, latestPrompts, latestResources, mcpErrors, clearMcpErrors, dismissMcpError, handleRunHealthCheck, handleClearCaches, handleRefreshRegistry };
}
