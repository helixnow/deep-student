import '../styles/mcp-preset-oauth.css';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import {
  resolveSettingsStdioFraming,
} from './constants';
import { Info as InfoIcon } from '@phosphor-icons/react';
import { saveSetting } from '@/utils/settingsApi';
import { useUnifiedErrorHandler } from '@/components/UnifiedErrorHandler';
import type { UseMcpEditorSectionDeps, McpToolConfig } from './hookDepsTypes';
import { invoke } from './mcp-editor/runtime';
import { buildToolJson, resolveServerId } from './mcp-editor/utils';
import type { McpCachedDetailsState, McpPolicyModalState, McpPreviewState, McpTestResult, McpToolModalState } from './mcp-editor/types';
import { renderMcpToolEditorModal } from './mcp-editor/McpToolEditorModal';
import { renderMcpToolEditorEmbedded as renderMcpToolEditorEmbeddedPanel } from './mcp-editor/McpToolEditorEmbedded';
import { renderMcpPolicyEditorEmbedded as renderMcpPolicyEditorEmbeddedPanel } from './mcp-editor/McpPolicyEditorEmbedded';
import { createMcpServerOps } from './mcp-editor/mcpServerOps';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function useMcpEditorSection(deps: UseMcpEditorSectionDeps) {
  const { config, setConfig, isSmallScreen, activeTab, setActiveTab, setScreenPosition, setRightPanelType, t, extra, setExtra, handleSave, normalizedMcpServers, setMcpStatusInfo, mcpStatusInfo } = deps;

  const closeRightPanel = useCallback(() => {
    setRightPanelType('none');
    setScreenPosition('center');
  }, [setRightPanelType, setScreenPosition]);

  const { errors: mcpErrors, addError: addMcpError, dismissError: dismissMcpError, clearAllErrors: clearMcpErrors } = useUnifiedErrorHandler();

  // 移动端统一顶栏保存出口（P1-7）：嵌入式编辑器每次渲染把最新提交闭包写进 ref，
  // 顶栏 Check 按钮经 ref 调用，无需把表单状态提升到 Settings
  const mcpToolSubmitRef = useRef<(() => Promise<void>) | null>(null);
  const mcpPolicySaveRef = useRef<(() => Promise<void>) | null>(null);

  // MCP 工具编辑模态
  const [mcpToolModal, setMcpToolModal] = useState<McpToolModalState>({ open: false, index: null, mode: 'json', jsonInput: '', draft: { id: '', name: '', transportType: 'stdio', command: 'npx', args: [], env: {}, cwd: '', framing: 'jsonl' }, error: null });
  // MCP 全局策略模态（白/黑名单等）
  const [mcpPolicyModal, setMcpPolicyModal] = useState<McpPolicyModalState>({
    open: false,
    advertiseAll: false,
    whitelist: '',
    blacklist: '',
    timeoutMs: 15000,
    rateLimit: 10,
    cacheMax: 500,
    cacheTtlMs: 300000
  });
  // MCP 快速体检/预览状态
  const [mcpPreview, setMcpPreview] = useState<McpPreviewState>({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  // stdio 测试细粒度进度步骤（null = 未在测试）
  const [mcpTestStep, setMcpTestStep] = useState<string | null>(null);
  // MCP API Key 输入框的显示/隐藏切换
  const [showMcpApiKey, setShowMcpApiKey] = useState(false);
  // 缓存详情（不触发新体检）：按照服务器聚合的工具清单 + 全局提示/资源
  const [mcpCachedDetails, setMcpCachedDetails] = useState<McpCachedDetailsState>({ toolsByServer: {}, prompts: { items: [], at: undefined }, resources: { items: [], at: undefined } });
  const MCP_BACKEND_DISABLED_CODE = 'backend_mcp_disabled';
  const MCP_BACKEND_DISABLED_HINT = t('settings:mcp.backend_disabled_hint');

  const isBackendDisabled = (value: unknown): boolean => {
    if (value && typeof value === 'object' && 'error' in value) {
      if ((value as { error?: unknown }).error === MCP_BACKEND_DISABLED_CODE) return true;
    }
    const msg = getErrorMessage(value);
    return typeof msg === 'string' && msg.includes(MCP_BACKEND_DISABLED_CODE);
  };

  const describeToolCount = (res: McpTestResult | null): string => {
    const count = typeof res?.tools_count === 'number'
      ? res.tools_count
      : Array.isArray(res?.tools) ? res.tools.length : undefined;
    return typeof count === 'number' ? `, ${t('settings:mcp_descriptions.tools_count', { count })}` : '';
  };

  const handleMcpTestResult = (res: McpTestResult | null, failureLabel: string): boolean => {
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

  const handleMcpTestError = (error: unknown, failureLabel: string) => {
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
            <DsButton type="button" variant="ghost" iconOnly size="sm" className="h-6 w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground">
              <InfoIcon size={16} />
            </DsButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-sm text-xs leading-relaxed">
            {description}
          </PopoverContent>
        </Popover>
      </div>
    ),
    []
  );
  const rebuildCachedDetailsFromSnapshots = useCallback((
    toolSnap: Record<string, { at: number; tools: Array<{ name: string; description?: string; input_schema?: unknown }> }> = {},
    promptSnap: Record<string, { at: number; prompts: Array<{ name: string; description?: string; arguments?: unknown }> }> = {},
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
    const { McpService } = await import('@/mcp/mcpService');
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

  // agent 侧修改 mcp.tools.list（propose/update/set_enabled/remove）后，
  // 经 chat_v2://settings_changed → systemSettingsChanged 同步刷新设置页服务器列表，
  // 不必重开设置页。value 缺失（如 mcpReloaded 广播）时回读一次 setting。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ settingKey?: string; value?: unknown }>)?.detail;
      if (detail?.settingKey !== 'mcp.tools.list') return;
      void (async () => {
        try {
          const raw = typeof detail.value === 'string'
            ? detail.value
            : (invoke ? await invoke<string | null>('get_setting', { key: 'mcp.tools.list' }) : null);
          const parsed = (() => {
            try { return raw ? JSON.parse(raw) : []; } catch { return null; }
          })();
          if (Array.isArray(parsed)) {
            setConfig(prev => ({ ...prev, mcpTools: parsed }));
          }
        } catch (e) {
          console.warn('[Settings] 同步外部 MCP 配置变更失败:', e);
        }
      })();
    };
    window.addEventListener('systemSettingsChanged', handler);
    return () => window.removeEventListener('systemSettingsChanged', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConfig]);

  // ★ 2026-01-15: 导师模式已迁移到 Skills 系统，相关状态和处理函数已删除
  // ★ 2026-01-19: Irec 模块已废弃，相关预设加载/保存逻辑已删除

  // ★ 2026-07: CHAT_STREAM_SETTINGS_EVENT 广播已删除——全仓无监听者，
  // 聊天流超时设置改为 Rust 端每次请求时从 settings 读取，无需前端事件通知。
  const findSnapshotKey = (tool: McpToolConfig, idx: number): string | undefined => {
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
  // 新增服务器入口：移动端走右滑面板（与编辑同一表单，index=null 即创建模式，
  // 保存出口在统一顶栏 Check）；桌面维持 McpToolsSection 的行内新建表单不变
  const handleCreateMcpTool = () => {
    setMcpToolModal({
      open: true,
      index: null,
      mode: 'form',
      jsonInput: '',
      draft: { id: '', name: '', transportType: 'stdio', command: 'npx', args: [], env: {}, cwd: '', framing: 'jsonl' },
      error: null,
    });
    if (isSmallScreen) {
      setRightPanelType('mcpTool');
      setScreenPosition('right');
    }
  };

  const handleAddMcpTool = async (newServer: Partial<McpToolConfig>): Promise<boolean> => {
    try {
      const toolToSave: McpToolConfig = {
        id: newServer.id || `mcp_${Date.now()}`,
        name: newServer.name || t('common:new_mcp_server'),
        transportType: newServer.transportType || 'sse',
        ...newServer,
        // 后端 stdio 门禁要求 enabled == true；新增条目默认启用
        enabled: newServer.enabled ?? true,
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
        await saveSetting('mcp.tools.list', JSON.stringify(newList));
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

  const handleEditMcpTool = (tool: McpToolConfig, idx: number) => {
    const jsonInput = buildToolJson(tool) || '{}';
    const transportType = tool.transportType || 'stdio';
    const rawCommand = (tool.command as string) || 'npx';
    const deriveArgs = (): string[] | undefined => {
      const rawArgs = tool.args;
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
        (!Array.isArray(tool.args) || (tool.args || []).length === 0) &&
        /@modelcontextprotocol\//.test(rawCommand);
      if (shouldMigrateInlineArgs) {
        const pieces = rawCommand.split(' ').filter(Boolean);
        if (pieces.length > 1) {
          normalizedCommand = pieces.shift() ?? rawCommand;
          normalizedArgs = pieces;
        }
      }
      // 空 args 保持为空：仅 UI placeholder 提示，不隐式注入默认 filesystem args
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
        url: (tool.url as string) || '',
        command: normalizedCommand,
        args: normalizedArgs,
        env: (tool.env as Record<string, string>) || {},
        fetch: tool.fetch as { type: 'sse' | 'streamable_http'; url: string } | undefined,
        endpoint: (tool.endpoint as string) || '',
        apiKey: (tool.apiKey as string) || '',
        serverId: (tool['serverId'] as string) || '',
        region: (tool['region'] as string) || 'cn-hangzhou',
        hosted: tool['hosted'] !== undefined ? !!(tool['hosted']) : true,
        mcpServers: tool.mcpServers as Record<string, unknown> | undefined,
        namespace: (tool['namespace'] as string) || '',
        cwd: (tool['cwd'] as string) || '',
        // 已存显式 CL 保留；缺省/未知 → jsonl（不迁移存量显式值）
        framing: resolveSettingsStdioFraming(
          typeof tool['framing'] === 'string' ? tool['framing'] : null,
        ),
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
    const next = (config.mcpTools || []).filter((tool: McpToolConfig) => tool.id !== serverId);
    try {
      if (invoke) {
        await saveSetting('mcp.tools.list', JSON.stringify(next));
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
  const handleSaveMcpServer = async (updatedData: Partial<McpToolConfig>, serverId: string): Promise<boolean> => {
    try {
      const currentList = [...(config.mcpTools || [])];
      const idx = currentList.findIndex((tool: McpToolConfig) => tool.id === serverId);
      
      if (idx === -1) {
        showGlobalNotification('error', t('settings:mcp_descriptions.server_not_found'));
        return false;
      }
      
      const existing = currentList[idx];

      // 合并更新数据，但清理非标准字段（如 mcpServers 残留）
      const { mcpServers: _discardMcpServers, ...cleanUpdatedData } = updatedData;
      const enabledChanged =
        typeof cleanUpdatedData.enabled === 'boolean' &&
        cleanUpdatedData.enabled !== (existing.enabled ?? true);

      const updated = {
        ...existing,
        ...cleanUpdatedData,
        id: existing.id || updatedData.id || `mcp_${Date.now()}`,
        // 编辑保留原 enabled；存量条目缺省视为启用（兼容无该字段的历史数据）
        enabled: cleanUpdatedData.enabled ?? existing.enabled ?? true,
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
        await saveSetting('mcp.tools.list', JSON.stringify(currentList));
      }
      setConfig(prev => ({ ...prev, mcpTools: currentList }));
      if (enabledChanged) {
        // 启停切换需要重建前端连接（停用 → 断开；启用 → 建连），
        // 交给 main.tsx 的 systemSettingsChanged → bootstrapMcpFromSettings 统一处理
        try {
          window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { mcpChanged: true } }));
        } catch {
          // 事件派发失败不影响保存结果
        }
      }
      try {
        await refreshSnapshots({ reload: true });
      } catch (e) {
        const errMsg = getErrorMessage(e);
        showGlobalNotification('warning', t('settings:mcp_descriptions.refresh_failed', { error: errMsg }));
      }
      showGlobalNotification('success', t('common:mcp_tool_saved'));

      // 编辑保存后自动运行一次连通性测试以刷新工具列表（已停用的 server 不再拉起测试）
      if (updated.enabled !== false) {
        handleTestServer(updated).catch(() => { /* 静默处理测试失败 */ });
      }

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
  const renderMcpToolEditor = () => renderMcpToolEditorModal({
    config, setConfig, isSmallScreen, t, mcpToolModal, setMcpToolModal, showMcpApiKey, setShowMcpApiKey,
    describeToolCount, handleMcpTestResult, handleMcpTestError, renderInfoPopover, refreshSnapshots,
  });

  // ===== 移动端嵌入式 MCP 工具编辑器 =====
  const renderMcpToolEditorEmbedded = () => renderMcpToolEditorEmbeddedPanel({
    config, setConfig, isSmallScreen, t, closeRightPanel, mcpToolSubmitRef, mcpToolModal, setMcpToolModal,
    showMcpApiKey, setShowMcpApiKey, refreshSnapshots,
  });

  // ===== 移动端嵌入式 MCP 策略编辑器 =====
  const renderMcpPolicyEditorEmbedded = () => renderMcpPolicyEditorEmbeddedPanel({
    setConfig, isSmallScreen, t, closeRightPanel, mcpPolicySaveRef, mcpPolicyModal, setMcpPolicyModal,
  });

  const { handleReconnectClient, handleRefreshRegistry, handleRunHealthCheck, handleClearCaches, handlePreviewServer, handleTestServer } = createMcpServerOps({
    t, normalizedMcpServers, addMcpError, setMcpPreview, setMcpTestStep, setMcpCachedDetails,
    describeToolCount, handleMcpTestResult, handleMcpTestError, refreshSnapshots,
  });

  // 必须保持引用稳定：Settings.tsx 的 dismissRightPanel → handleMobileSettingsBack →
  // useMobileHeader deps 依赖此函数，若每次渲染新建会导致顶栏配置 effect 无限重跑
  const handleClosePreview = useCallback(() => {
    setMcpPreview({ open: false, loading: false, tools: [], prompts: [], resources: [] });
  }, []);

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

  return { mcpToolModal, setMcpToolModal, mcpPolicyModal, setMcpPolicyModal, mcpToolSubmitRef, mcpPolicySaveRef, mcpPreview, mcpTestStep, stripMcpPrefix, refreshSnapshots, handleDeleteMcpTool, handleSaveMcpServer, handleTestServer, handleReconnectClient, handleAddMcpTool, handleCreateMcpTool, handleEditMcpTool, handleOpenMcpPolicy, handleClosePreview, renderMcpToolEditor, renderMcpToolEditorEmbedded, renderMcpPolicyEditorEmbedded, mcpCachedDetails, mcpServers, serverStatusMap, lastError, cacheCapacity, lastCacheUpdatedAt, lastCacheUpdatedText, connectedServers, totalServers, totalCachedTools, promptsCount, resourcesCount, cacheUsagePercent, latestPrompts, latestResources, mcpErrors, clearMcpErrors, dismissMcpError, handleRunHealthCheck, handleClearCaches, handleRefreshRegistry };
}
