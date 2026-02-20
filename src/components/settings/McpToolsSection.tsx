/**
 * MCP 工具协议管理 - Notion/deep-agent_new 风格重构
 *
 * 设计原则：
 * - 使用 bg-card rounded-lg border border-border 作为卡片基础
 * - 使用 bg-muted/50 rounded-md/lg 作为内嵌区域
 * - 状态使用小圆点 w-2 h-2 rounded-full
 * - 交互使用 hover:bg-accent/50，选中用 bg-accent
 * - 没有装饰性元素（顶部彩色条）
 * - 紧凑的间距和字体
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Plus,
  RefreshCw,
  Trash2,
  Edit3,
  Eye,
  FlaskConical,
  Plug,
  WifiOff,
  Ellipsis,
  Sparkles,
  Key,
  ChevronDown,
  ChevronUp,
  Code2,
  FileCode,
  Lock,
  Package,
  ExternalLink,
  Check,
  Shield,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { UnifiedCodeEditor } from '../shared/UnifiedCodeEditor';
import { isBuiltinServer, BUILTIN_SERVER_ID } from '../../mcp/builtinMcpServer';
import { SettingSection } from './SettingsCommon';
import { NotionButton } from '../ui/NotionButton';
import { showGlobalNotification } from '../UnifiedNotification';
import { CustomScrollArea } from '../custom-scroll-area';
import { 
  PRESET_MCP_SERVERS, 
  presetToMcpConfig, 
  CATEGORY_LABELS,
  type PresetMcpServer 
} from '../../mcp/presetMcpServers';

// Types
interface McpServer {
  id: string;
  name: string;
  transportType?: 'stdio' | 'websocket' | 'sse' | 'streamable_http' | 'builtin';
  url?: string;
  command?: string;
  args?: string | string[];
  namespace?: string;
  env?: Record<string, string>;
  apiKey?: string;
}

interface McpServerStatus {
  connected: boolean;
  error?: string;
}

interface McpCachedTool {
  name: string;
  description?: string;
}

interface McpToolsSectionProps {
  // 数据
  servers: McpServer[];
  serverStatusMap: Map<string, McpServerStatus>;
  toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>;
  prompts: { items: Array<{ name: string; description?: string }>; at?: number };
  resources: { items: Array<{ uri: string; name?: string }>; at?: number };
  lastCacheUpdatedAt?: number;
  cacheCapacity?: number;
  isLoading?: boolean;
  lastError?: string;

  // 操作回调
  onAddServer: (newServer: Partial<McpServer>) => boolean | Promise<boolean>;
  onSaveServer: (updatedServer: Partial<McpServer>, serverId: string) => boolean | Promise<boolean>;
  onDeleteServer: (serverId: string) => boolean | Promise<boolean>;
  onTestServer: (server: McpServer) => void | Promise<void>;
  onReconnect: () => void;
  onRefreshRegistry: () => void;
  onHealthCheck: () => void;
  onClearCache: () => void;
  onOpenPolicy: () => void;
}

// 辅助函数
function stripMcpPrefix(name?: string): string {
  if (!name) return '';
  // 处理多种 namespace 格式: mcp__xxx__, builtin-, xxx: 等
  // 第三条正则限制前缀最长 32 字符且不含 /，避免误匹配 URL
  return name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^builtin-/, '')
    .replace(/^[a-zA-Z0-9_-]{1,32}:/, '');
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  try {
    // 使用浏览器当前语言环境
    const locale = navigator.language || 'en-US';
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }
}

// 统计卡片组件
function StatItem({
  label,
  value,
  suffix,
  status
}: {
  label: string;
  value: string | number;
  suffix?: string;
  status?: 'success' | 'warning' | 'error' | 'neutral';
}) {
  const statusColors = {
    success: 'bg-green-500',
    warning: 'bg-yellow-500',
    error: 'bg-red-500',
    neutral: 'bg-muted-foreground'
  };

  return (
    <div className="p-3 bg-muted/30 rounded-lg border border-transparent hover:border-border/40 transition-colors">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        {status && (
          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[status])} />
        )}
        <span className="text-lg font-semibold text-foreground">{value}</span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

// 展开面板类型
type ExpandedPanelType = 'preview' | 'edit' | null;

// 服务器列表项组件
function ServerListItem({
  server,
  status,
  cachedToolCount,
  toolNames,
  expandedPanel,
  onSave,
  onDelete,
  onToggleExpand,
  onTest,
  isTesting,
  disableTest,
  isBuiltin = false
}: {
  server: McpServer;
  status?: McpServerStatus;
  cachedToolCount: number;
  toolNames: string[];
  expandedPanel: ExpandedPanelType;
  onSave: (data: Partial<McpServer>) => boolean | Promise<boolean>;
  onDelete: () => boolean | Promise<boolean>;
  onToggleExpand: (type: ExpandedPanelType) => void;
  onTest: () => void;
  isTesting: boolean;
  disableTest: boolean;
  isBuiltin?: boolean;
}) {
  const { t } = useTranslation(['settings']);
  const isConnected = isBuiltin ? true : (status?.connected ?? false);
  const displayName = server.name || server.id || t('settings:status_labels.unnamed_mcp');

  const transportLabel = useMemo(() => {
    switch (server.transportType) {
      case 'websocket': return t('settings:mcp_transport.websocket_label');
      case 'streamable_http': return t('settings:mcp_transport.http_label');
      case 'stdio': return t('settings:mcp_transport.stdio_label');
      case 'builtin': return t('settings:mcp_server_list.builtin');
      default: return t('settings:mcp_transport.sse_label');
    }
  }, [server.transportType, t]);

  const [showActions, setShowActions] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isExpanded = expandedPanel !== null;

  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return (
    <div
      className={cn(
        'rounded-lg overflow-hidden transition-all duration-200 border border-transparent',
        isExpanded ? 'bg-muted/30 border-border/40' : 'hover:bg-muted/30 hover:border-border/20'
      )}
    >
      {/* 删除确认栏 */}
      {confirmingDelete && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-destructive/10 border-b border-destructive/20">
          <span className="text-xs text-destructive font-medium">
            {t('settings:mcp_descriptions.confirm_delete', '确认删除此服务器？此操作不可撤销。')}
          </span>
          <div className="flex items-center gap-2">
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('settings:mcp_server_edit.cancel')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="danger"
              disabled={deleting}
              onClick={async () => {
                if (deleting) return;
                setDeleting(true);
                try {
                  const ok = await onDelete();
                  if (ok !== false && isMountedRef.current) setConfirmingDelete(false);
                } finally {
                  if (isMountedRef.current) setDeleting(false);
                }
              }}
            >
              {t('settings:mcp_descriptions.action_delete')}
            </NotionButton>
          </div>
        </div>
      )}
      {/* 主行 */}
      <div
        onClick={() => onToggleExpand(expandedPanel ? null : 'preview')}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
        className={cn(
          'group relative w-full text-left px-4 py-3 cursor-pointer',
          'transition-colors duration-100'
        )}
      >
        {/* 主要内容 */}
        <div className="flex items-start gap-4">
          {/* 状态指示点 */}
          <span className={cn(
            'w-2 h-2 rounded-full flex-shrink-0 mt-1.5',
            isConnected ? 'bg-green-500' : 'bg-muted-foreground/30'
          )} />

          {/* 服务器信息 */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground truncate">
                {displayName}
              </span>
              {isBuiltin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary flex-shrink-0 flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" />
                  {t('settings:mcp_server_list.builtin')}
                </span>
              )}
              {!isBuiltin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0 border border-border/50">
                  {transportLabel}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate font-mono opacity-70">
              {server.id}
            </div>

            {/* 工具预览 - 移到服务器信息下方 */}
            {cachedToolCount > 0 && toolNames.length > 0 && (
              <div className="pt-1">
                <div className="text-[11px] text-muted-foreground truncate opacity-80">
                  {toolNames.slice(0, 3).join(', ')}{cachedToolCount > 3 ? ' ...' : ''}
                </div>
              </div>
            )}

            {/* 错误信息 */}
            {status?.error && (
              <div className="pt-1 flex items-center gap-1.5 text-[10px] text-red-500">
                <WifiOff className="w-3 h-3" />
                <span className="truncate">{status.error}</span>
              </div>
            )}
          </div>

          {/* 右侧区域：工具数量 + 操作按钮 */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            {/* 工具数量 */}
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">{cachedToolCount}</div>
              <div className="text-[10px] text-muted-foreground">{t('settings:mcp_server_list.tools')}</div>
            </div>

            {/* 操作按钮 - 移到右下角 */}
            <div className={cn(
              'flex items-center gap-1',
              'transition-opacity duration-100',
              showActions || isExpanded ? 'opacity-100' : 'opacity-0'
            )}>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onToggleExpand(expandedPanel === 'preview' ? null : 'preview'); }} className={cn('!h-7 !w-7', expandedPanel === 'preview' && 'text-primary bg-primary/10')} title={t('settings:mcp_descriptions.action_preview')} aria-label="preview">
                <Eye className="w-3.5 h-3.5" />
              </NotionButton>
              {!isBuiltin && (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onTest(); }} disabled={disableTest || isTesting} className="!h-7 !w-7" title={t('settings:mcp_descriptions.action_test')} aria-label="test">
                  {isTesting ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FlaskConical className="w-3.5 h-3.5" />
                  )}
                </NotionButton>
              )}
              {!isBuiltin && (
                <>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onToggleExpand(expandedPanel === 'edit' ? null : 'edit'); }} className={cn('!h-7 !w-7', expandedPanel === 'edit' && 'text-primary bg-primary/10')} title={t('settings:mcp_descriptions.action_edit')} aria-label="edit">
                    <Edit3 className="w-3.5 h-3.5" />
                  </NotionButton>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }} className="!h-7 !w-7 hover:text-destructive" title={t('settings:mcp_descriptions.action_delete')} aria-label="delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </NotionButton>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 展开区域 - 仅预览 */}
      {isExpanded && expandedPanel === 'preview' && (
        <div className="border-t border-border/40 bg-muted/20">
          <ServerPreviewPanel server={server} toolNames={toolNames} cachedToolCount={cachedToolCount} />
        </div>
      )}
      {/* 展开区域 - 编辑 */}
      {isExpanded && expandedPanel === 'edit' && (
        <div className="border-t border-border/40 bg-muted/20">
          <ServerEditPanel server={server} onSave={onSave} onClose={() => onToggleExpand(null)} />
        </div>
      )}
    </div>
  );
}

// 服务器预览面板
function ServerPreviewPanel({
  server,
  toolNames,
  cachedToolCount
}: {
  server: McpServer;
  toolNames: string[];
  cachedToolCount: number;
}) {
  const { t } = useTranslation(['settings']);
  return (
    <div className="p-4 space-y-6">
      {/* 基本信息 */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.name')}</div>
          <div className="text-sm text-foreground">{server.name || t('settings:mcp_server_preview.not_set')}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.namespace')}</div>
          <div className="text-sm text-foreground font-mono">{server.namespace || server.id}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">{t('settings:mcp_server_preview.transport_type')}</div>
          <div className="text-sm text-foreground">{server.transportType || 'sse'}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
            {server.transportType === 'stdio' ? t('settings:mcp_server_preview.command') : t('settings:mcp_server_preview.url')}
          </div>
          <div className="text-sm text-foreground font-mono truncate">
            {server.transportType === 'stdio' ? server.command : server.url || '—'}
          </div>
        </div>
      </div>

      {/* 工具列表 */}
      {cachedToolCount > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-3">
            {t('settings:mcp_server_preview.available_tools')} ({cachedToolCount})
          </div>
          <div className="flex flex-wrap gap-2">
            {toolNames.slice(0, 20).map((name, i) => (
              <span
                key={i}
                className="px-2.5 py-1 bg-background border border-border/60 rounded text-xs text-muted-foreground"
              >
                {name}
              </span>
            ))}
            {cachedToolCount > 20 && (
              <span className="px-2.5 py-1 text-xs text-muted-foreground">
                +{cachedToolCount - 20} {t('settings:mcp_server_preview.more')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 服务器编辑面板 - 支持表单/JSON双模式
function ServerEditPanel({
  server,
  onSave,
  onClose
}: {
  server: McpServer;
  onSave: (data: Partial<McpServer>) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [editMode, setEditMode] = useState<'form' | 'json'>('form');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const normalizeTransportType = useCallback((raw: unknown): 'stdio' | 'websocket' | 'sse' | 'streamable_http' => {
    const v = String(raw ?? '').trim();
    if (v === 'streamable-http' || v === 'http') return 'streamable_http';
    if (v === 'ws') return 'websocket';
    if (v === 'stdio' || v === 'websocket' || v === 'sse' || v === 'streamable_http') return v;
    return 'sse';
  }, []);

  // 构建完整的服务器配置JSON
  const buildServerJson = (srv: McpServer) => {
    const transportType = srv.transportType || 'sse';
    const config: Record<string, unknown> = {
      mcpServers: {
        [srv.name || srv.id]: {
          type: transportType,
          ...(transportType === 'stdio' ? {
            command: srv.command || '',
            args: Array.isArray(srv.args) ? srv.args : (srv.args ? srv.args.split(',').map(s => s.trim()) : []),
          } : {
            url: srv.url || '',
          }),
          ...(srv.env && Object.keys(srv.env).length > 0 ? { env: srv.env } : {}),
          ...(srv.namespace ? { namespace: srv.namespace } : {}),
          ...(srv.apiKey ? { apiKey: srv.apiKey } : {}),
        }
      }
    };
    return JSON.stringify(config, null, 2);
  };

  const [formData, setFormData] = useState({
    name: server.name || '',
    transportType: server.transportType || 'sse',
    url: server.url || '',
    command: server.command || '',
    args: Array.isArray(server.args) ? server.args.join(', ') : (server.args || ''),
    namespace: server.namespace || '',
    apiKey: server.apiKey || '',
    env: server.env || {}
  });

  const [jsonInput, setJsonInput] = useState(() => buildServerJson(server));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 环境变量操作
  const envEntries = Object.entries(formData.env);

  const addEnvRow = () => {
    let index = 1;
    let candidate = `ENV_${index}`;
    while (candidate in formData.env) {
      index++;
      candidate = `ENV_${index}`;
    }
    setFormData({ ...formData, env: { ...formData.env, [candidate]: '' } });
  };

  const updateEnvKey = (oldKey: string, newKey: string) => {
    const next = { ...formData.env };
    const val = next[oldKey];
    delete next[oldKey];
    if (newKey) next[newKey] = val ?? '';
    setFormData({ ...formData, env: next });
  };

  const updateEnvValue = (key: string, value: string) => {
    setFormData({ ...formData, env: { ...formData.env, [key]: value } });
  };

  const removeEnvRow = (key: string) => {
    const next = { ...formData.env };
    delete next[key];
    setFormData({ ...formData, env: next });
  };

  // 切换编辑模式时同步数据
  const handleModeSwitch = (newMode: 'form' | 'json') => {
    if (newMode === editMode) return;

    if (newMode === 'json') {
      // 从表单同步到JSON
      const syncedServer: McpServer = {
        ...server,
        name: formData.name,
        transportType: formData.transportType as McpServer['transportType'],
        url: formData.url,
        command: formData.command,
        args: formData.args.split(',').map(s => s.trim()).filter(Boolean),
        namespace: formData.namespace,
        apiKey: formData.apiKey,
        env: formData.env
      };
      setJsonInput(buildServerJson(syncedServer));
      setJsonError(null);
    } else {
      // 从JSON同步到表单
      try {
        const parsed = JSON.parse(jsonInput);
        if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
          const [serverName, serverConfig] = Object.entries(parsed.mcpServers)[0] as [string, any];
          if (serverConfig) {
            setFormData({
              name: serverName || formData.name,
              transportType: normalizeTransportType(
                serverConfig.type ||
                  serverConfig.transportType ||
                  (serverConfig.command ? 'stdio' : 'sse')
              ),
              url: serverConfig.url || '',
              command: serverConfig.command || '',
              args: Array.isArray(serverConfig.args) ? serverConfig.args.join(', ') : (serverConfig.args || ''),
              namespace: serverConfig.namespace || '',
              apiKey: serverConfig.apiKey || '',
              env: serverConfig.env || {}
            });
          }
        }
        setJsonError(null);
      } catch (err) {
        setJsonError(`${t('settings:mcp_errors.json_parse_error')}${(err as Error).message}`);
        return; // 不切换模式
      }
    }
    setEditMode(newMode);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    const saveAndClose = async (payload: Partial<McpServer>) => {
      setIsSaving(true);
      try {
        const ok = await onSave(payload);
        if (ok !== false) onClose();
      } finally {
        if (isMountedRef.current) setIsSaving(false);
      }
    };

    if (editMode === 'json') {
      // JSON模式提交
      try {
        const parsed = JSON.parse(jsonInput);
        if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
          const [serverName, serverConfig] = Object.entries(parsed.mcpServers)[0] as [string, any];
          if (serverConfig) {
            const updatedServer: Partial<McpServer> = {
              id: server.id,
              name: serverName || server.name,
              transportType: normalizeTransportType(
                serverConfig.type ||
                  serverConfig.transportType ||
                  (serverConfig.command ? 'stdio' : 'sse')
              ),
              url: serverConfig.url,
              command: serverConfig.command,
              args: serverConfig.args,
              namespace: serverConfig.namespace,
              apiKey: serverConfig.apiKey,
              env: serverConfig.env,
            };
            await saveAndClose(updatedServer);
            return;
          }
        }

        // 兼容简单格式 — 同样不做宽泛展开
        const updatedServer: Partial<McpServer> = {
          id: server.id,
          name: parsed.name || formData.name,
          transportType: normalizeTransportType(parsed.transportType || parsed.type || (parsed.command ? 'stdio' : 'sse')),
          url: parsed.url,
          command: parsed.command,
          args: parsed.args,
          namespace: parsed.namespace,
          apiKey: parsed.apiKey,
          env: parsed.env,
        };
        await saveAndClose(updatedServer);
      } catch (err) {
        setJsonError(`${t('settings:mcp_errors.json_format_error')}${(err as Error).message}`);
      }
      return;
    }

    // 表单模式提交
    const updatedServer: Partial<McpServer> = {
      id: server.id,
      name: formData.name,
      transportType: formData.transportType as McpServer['transportType'],
      namespace: formData.namespace || undefined,
      apiKey: formData.apiKey || undefined,
      env: Object.keys(formData.env).length > 0 ? formData.env : undefined
    };

    if (formData.transportType === 'stdio') {
      updatedServer.command = formData.command;
      updatedServer.args = formData.args.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      updatedServer.url = formData.url;
    }

    await saveAndClose(updatedServer);
  };

  return (
    <div className="p-4 space-y-6">
      {/* 模式切换标签 */}
      <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg w-fit border border-border/40">
        <NotionButton variant="ghost" size="sm" onClick={() => handleModeSwitch('form')} className={cn(editMode === 'form' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <FileCode className="w-3.5 h-3.5" />
          {t('settings:mcp_server_edit.form_mode')}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" onClick={() => handleModeSwitch('json')} className={cn(editMode === 'json' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <Code2 className="w-3.5 h-3.5" />
          {t('settings:mcp_server_edit.json_config')}
        </NotionButton>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {editMode === 'form' ? (
          <>
            {/* 表单模式内容 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* 名称 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.server_name')} *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  placeholder={t('settings:mcp_server_edit.server_name_placeholder')}
                  required
                />
              </div>

              {/* 命名空间 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.namespace')}
                </label>
                <input
                  type="text"
                  value={formData.namespace}
                  onChange={(e) => setFormData({ ...formData, namespace: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  placeholder={t('settings:mcp_server_edit.namespace_placeholder')}
                />
              </div>
            </div>

            {/* 传输类型 */}
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                {t('settings:mcp_server_edit.transport_type')}
              </label>
              <select
                value={formData.transportType}
                onChange={(e) => setFormData({ ...formData, transportType: e.target.value as McpServer['transportType'] })}
                className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              >
                <option value="sse">{t('settings:mcp_transport.sse_server_events')}</option>
                <option value="websocket">{t('settings:mcp_transport.websocket')}</option>
                <option value="streamable_http">{t('settings:mcp_transport.http_streamable')}</option>
                <option value="stdio">{t('settings:mcp_transport.stdio_local_process')}</option>
              </select>
            </div>

            {/* URL / Command */}
            {formData.transportType === 'stdio' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.command')} *
                  </label>
                  <input
                    type="text"
                    value={formData.command}
                    onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                    className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                    placeholder="npx, node, python..."
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.args')}
                  </label>
                  <input
                    type="text"
                    value={formData.args}
                    onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                    className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                    placeholder="-y, @anthropic/mcp-server"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.server_url')} *
                </label>
                <input
                  type="url"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  placeholder="http://localhost:3000/sse"
                  required
                />
              </div>
            )}

            {/* 高级配置折叠区 */}
            <div className="border border-border/40 rounded-lg overflow-hidden">
              <NotionButton variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full !justify-between !px-4 !py-3 !rounded-none">
                <span>{t('settings:mcp_server_edit.advanced_config')}</span>
                {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </NotionButton>

              {showAdvanced && (
                <div className="px-4 pb-4 space-y-6 border-t border-border/40 pt-4 bg-muted/10">
                  {/* API Key */}
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                      {t('settings:mcp_server_edit.api_key')}
                    </label>
                    <input
                      type="password"
                      value={formData.apiKey}
                      onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                      className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                      placeholder={t('settings:mcp_server_edit.api_key_placeholder')}
                    />
                  </div>

                  {/* 环境变量 */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        {t('settings:mcp_server_edit.env_vars')}
                      </label>
                      <NotionButton variant="ghost" size="sm" onClick={addEnvRow} className="text-primary hover:text-primary/80 !h-auto !p-0">
                        + {t('settings:mcp_server_edit.add')}
                      </NotionButton>
                    </div>
                    {envEntries.length === 0 ? (
                      <div className="text-xs text-muted-foreground py-2 italic">{t('settings:mcp_server_edit.no_env_vars')}</div>
                    ) : (
                      <div className="space-y-2">
                        {envEntries.map(([key, value], envIdx) => (
                          <div key={`env-${envIdx}`} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={key}
                              onChange={(e) => updateEnvKey(key, e.target.value)}
                              className="flex-1 px-2 py-1.5 bg-background border border-border/60 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder={t('settings:placeholders.env_key')}
                            />
                            <span className="text-muted-foreground">=</span>
                            <input
                              type="text"
                              value={value}
                              onChange={(e) => updateEnvValue(key, e.target.value)}
                              className="flex-1 px-2 py-1.5 bg-background border border-border/60 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder="value"
                            />
                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => removeEnvRow(key)} className="!h-6 !w-6 hover:text-destructive" aria-label="remove">
                              <Trash2 className="w-3.5 h-3.5" />
                            </NotionButton>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* JSON编辑模式 */}
            <div className="space-y-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                {t('settings:mcp_json_config.label')}
              </div>
              <UnifiedCodeEditor
                value={jsonInput}
                onChange={(value) => {
                  setJsonInput(value);
                  setJsonError(null);
                }}
                language="json"
                height="280px"
                lineNumbers={true}
                foldGutter={true}
                highlightActiveLine={true}
                className="text-sm border border-border/60 rounded-md overflow-hidden"
              />
              {jsonError && (
                <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
                  {jsonError}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground mt-2">
                {t('settings:mcp_server_edit.json_hint')}
              </p>
            </div>
          </>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/40">
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isSaving}
          >
            {t('settings:mcp_server_edit.cancel')}
          </NotionButton>
          <NotionButton
            type="submit"
            variant="primary"
            size="sm"
            disabled={isSaving}
          >
            {t('settings:mcp_server_edit.save')}
          </NotionButton>
        </div>
      </form>
    </div>
  );
}

// 新建服务器编辑项组件
function NewServerEditItem({
  onSave,
  onCancel
}: {
  onSave: (data: Partial<McpServer>) => boolean | Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [editMode, setEditMode] = useState<'form' | 'json'>('form');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const normalizeTransportType = useCallback((raw: unknown): 'stdio' | 'websocket' | 'sse' | 'streamable_http' => {
    const v = String(raw ?? '').trim();
    if (v === 'streamable-http' || v === 'http') return 'streamable_http';
    if (v === 'ws') return 'websocket';
    if (v === 'stdio' || v === 'websocket' || v === 'sse' || v === 'streamable_http') return v;
    return 'sse';
  }, []);

  // 使用 useState 确保 ID 在组件生命周期内稳定
  const [newServerId] = useState(() => `mcp_${Date.now()}`);
  
  const [formData, setFormData] = useState({
    name: '',
    transportType: 'sse' as McpServer['transportType'],
    url: '',
    command: '',
    args: '',
    namespace: '',
    apiKey: '',
    env: {} as Record<string, string>
  });

  const buildServerJson = () => {
    const config: Record<string, unknown> = {
      mcpServers: {
        [formData.name || 'example']: {
          type: formData.transportType,
          ...(formData.transportType === 'stdio' ? {
            command: formData.command || '',
            args: formData.args.split(',').map(s => s.trim()).filter(Boolean),
          } : {
            url: formData.url || '',
          }),
          ...(formData.env && Object.keys(formData.env).length > 0 ? { env: formData.env } : {}),
          ...(formData.namespace ? { namespace: formData.namespace } : {}),
          ...(formData.apiKey ? { apiKey: formData.apiKey } : {}),
        }
      }
    };
    return JSON.stringify(config, null, 2);
  };

  const defaultJsonExample = JSON.stringify(
    {
      mcpServers: {
        example: {
          type: 'sse',
          url: 'https://mcp.api-inference.modelscope.net/sse',
        },
      },
    },
    null,
    2
  );

  const [jsonInput, setJsonInput] = useState(defaultJsonExample);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 环境变量操作
  const envEntries = Object.entries(formData.env);

  const addEnvRow = () => {
    let index = 1;
    let candidate = `ENV_${index}`;
    while (candidate in formData.env) {
      index++;
      candidate = `ENV_${index}`;
    }
    setFormData({ ...formData, env: { ...formData.env, [candidate]: '' } });
  };

  const updateEnvKey = (oldKey: string, newKey: string) => {
    const next = { ...formData.env };
    const val = next[oldKey];
    delete next[oldKey];
    if (newKey) next[newKey] = val ?? '';
    setFormData({ ...formData, env: next });
  };

  const updateEnvValue = (key: string, value: string) => {
    setFormData({ ...formData, env: { ...formData.env, [key]: value } });
  };

  const removeEnvRow = (key: string) => {
    const next = { ...formData.env };
    delete next[key];
    setFormData({ ...formData, env: next });
  };

  // 切换编辑模式时同步数据
  const handleModeSwitch = (newMode: 'form' | 'json') => {
    if (newMode === editMode) return;

    if (newMode === 'json') {
      setJsonInput(buildServerJson());
      setJsonError(null);
    } else {
      try {
        const parsed = JSON.parse(jsonInput);
        if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
          const [serverName, serverConfig] = Object.entries(parsed.mcpServers)[0] as [string, any];
          if (serverConfig) {
            setFormData({
              name: serverName || formData.name,
              transportType: normalizeTransportType(
                serverConfig.type ||
                  serverConfig.transportType ||
                  (serverConfig.command ? 'stdio' : 'sse')
              ),
              url: serverConfig.url || '',
              command: serverConfig.command || '',
              args: Array.isArray(serverConfig.args) ? serverConfig.args.join(', ') : (serverConfig.args || ''),
              namespace: serverConfig.namespace || '',
              apiKey: serverConfig.apiKey || '',
              env: serverConfig.env || {}
            });
          }
        }
        setJsonError(null);
      } catch (err) {
        setJsonError(`${t('settings:mcp_errors.json_parse_error')}${(err as Error).message}`);
        return;
      }
    }
    setEditMode(newMode);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    // 表单模式基础校验（避免直接进入 submitting 状态）
    if (editMode === 'form' && !formData.name.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (editMode === 'json') {
        const parsed = JSON.parse(jsonInput);
        if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
          const [serverName, serverConfig] = Object.entries(parsed.mcpServers)[0] as [string, any];
          if (serverConfig) {
            const newServer: Partial<McpServer> = {
              id: newServerId,
              name: serverName,
              transportType: normalizeTransportType(
                serverConfig.type || serverConfig.transportType || (serverConfig.command ? 'stdio' : 'sse')
              ),
              url: serverConfig.url,
              command: serverConfig.command,
              args: serverConfig.args,
              namespace: serverConfig.namespace,
              apiKey: serverConfig.apiKey,
              env: serverConfig.env
            };
            await onSave(newServer);
            return;
          }
        }
        // 兼容简单格式
        const newServer: Partial<McpServer> = {
          id: newServerId,
          name: parsed.name || 'Untitled',
          transportType: normalizeTransportType(parsed.transportType || parsed.type || (parsed.command ? 'stdio' : 'sse')),
          url: parsed.url,
          command: parsed.command,
          args: parsed.args,
          namespace: parsed.namespace,
          apiKey: parsed.apiKey,
          env: parsed.env,
        };
        await onSave(newServer);
        return;
      }

      // 表单模式提交
      const newServer: Partial<McpServer> = {
        id: newServerId,
        name: formData.name,
        transportType: formData.transportType,
        namespace: formData.namespace || undefined,
        apiKey: formData.apiKey || undefined,
        env: Object.keys(formData.env).length > 0 ? formData.env : undefined
      };

      if (formData.transportType === 'stdio') {
        newServer.command = formData.command;
        newServer.args = formData.args.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        newServer.url = formData.url;
      }

      await onSave(newServer);
    } catch (err) {
      setJsonError(`${t('settings:mcp_errors.json_format_error')}${(err as Error).message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg overflow-hidden bg-muted/30 border border-border/60">
      {/* 标题栏 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
        <span className="text-sm font-medium text-foreground">
          {t('settings:mcp_server_list.new_server')}
        </span>
      </div>

      {/* 编辑面板 */}
      <div className="p-4 space-y-6">
        {/* 模式切换标签 */}
        <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg w-fit border border-border/40">
          <NotionButton variant="ghost" size="sm" onClick={() => handleModeSwitch('form')} className={cn(editMode === 'form' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            <FileCode className="w-3.5 h-3.5" />
            {t('settings:mcp_server_edit.form_mode')}
          </NotionButton>
          <NotionButton variant="ghost" size="sm" onClick={() => handleModeSwitch('json')} className={cn(editMode === 'json' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            <Code2 className="w-3.5 h-3.5" />
            JSON
          </NotionButton>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {editMode === 'form' ? (
            <>
              {/* 表单模式内容 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* 名称 */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.server_name')} *
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                    placeholder={t('settings:mcp_server_edit.server_name_placeholder')}
                    required
                    autoFocus
                  />
                </div>

                {/* ID */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    ID
                  </label>
                  <input
                    type="text"
                    value={newServerId}
                    disabled
                    className="w-full px-3 py-2 bg-muted/50 border border-border/60 rounded-md text-sm text-muted-foreground font-mono"
                  />
                </div>
              </div>

              {/* 传输类型 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.transport_type')}
                </label>
                <select
                  value={formData.transportType}
                  onChange={(e) => setFormData({ ...formData, transportType: e.target.value as McpServer['transportType'] })}
                  className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                >
                  <option value="sse">{t('settings:mcp_transport.sse_server_events')}</option>
                  <option value="websocket">{t('settings:mcp_transport.websocket')}</option>
                  <option value="streamable_http">{t('settings:mcp_transport.http_streamable')}</option>
                  <option value="stdio">{t('settings:mcp_transport.stdio_local_process')}</option>
                </select>
              </div>

              {/* URL / Command */}
              {formData.transportType === 'stdio' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                      {t('settings:mcp_server_edit.command')} *
                    </label>
                    <input
                      type="text"
                      value={formData.command}
                      onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                      className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                      placeholder="npx, node, python..."
                      required
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                      {t('settings:mcp_server_edit.args')}
                    </label>
                    <input
                      type="text"
                      value={formData.args}
                      onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                      className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                      placeholder="-y, @anthropic/mcp-server"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.server_url')} *
                  </label>
                  <input
                    type="url"
                    value={formData.url}
                    onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                    className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                    placeholder="https://api.example.com/mcp"
                    required
                  />
                </div>
              )}

              {/* 高级配置折叠区 */}
              <div className="border border-border/40 rounded-lg overflow-hidden">
                <NotionButton variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full !justify-between !px-4 !py-3 !rounded-none">
                  <span>{t('settings:mcp_server_edit.advanced_config')}</span>
                  {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </NotionButton>

                {showAdvanced && (
                  <div className="px-4 pb-4 space-y-6 border-t border-border/40 pt-4 bg-muted/10">
                    {/* Namespace */}
                    <div>
                      <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {t('settings:mcp_server_edit.namespace')}
                      </label>
                      <input
                        type="text"
                        value={formData.namespace}
                        onChange={(e) => setFormData({ ...formData, namespace: e.target.value })}
                        className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                        placeholder={t('settings:mcp_server_edit.namespace_placeholder')}
                      />
                    </div>

                    {/* API Key */}
                    <div>
                      <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {t('settings:mcp_server_edit.api_key')}
                      </label>
                      <input
                        type="password"
                        value={formData.apiKey}
                        onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                        className="w-full px-3 py-2 bg-background border border-border/60 rounded-md text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                        placeholder={t('settings:mcp_server_edit.api_key_placeholder')}
                      />
                    </div>

                    {/* 环境变量 */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                          {t('settings:mcp_server_edit.env_vars')}
                        </label>
                        <NotionButton variant="ghost" size="sm" onClick={addEnvRow} className="text-primary hover:text-primary/80 !h-auto !p-0">
                          + {t('settings:mcp_server_edit.add')}
                        </NotionButton>
                      </div>
                      {envEntries.length === 0 ? (
                        <div className="text-xs text-muted-foreground py-2 italic">{t('settings:mcp_server_edit.no_env_vars')}</div>
                      ) : (
                        <div className="space-y-2">
                          {envEntries.map(([key, value], envIdx) => (
                            <div key={`new-env-${envIdx}`} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={key}
                                onChange={(e) => updateEnvKey(key, e.target.value)}
                                className="flex-1 px-2 py-1.5 bg-background border border-border/60 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                                placeholder={t('settings:placeholders.env_key')}
                              />
                              <span className="text-muted-foreground">=</span>
                              <input
                                type="text"
                                value={value}
                                onChange={(e) => updateEnvValue(key, e.target.value)}
                                className="flex-1 px-2 py-1.5 bg-background border border-border/60 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                                placeholder="value"
                              />
                              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => removeEnvRow(key)} className="!h-6 !w-6 hover:text-destructive" aria-label="remove">
                                <Trash2 className="w-3.5 h-3.5" />
                              </NotionButton>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* JSON编辑模式 */}
              <div className="space-y-2">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                  {t('settings:mcp_json_config.label')}
                </div>
                <UnifiedCodeEditor
                  value={jsonInput}
                  onChange={(value) => {
                    setJsonInput(value);
                    setJsonError(null);
                  }}
                  language="json"
                  height="280px"
                  lineNumbers={true}
                  foldGutter={true}
                  highlightActiveLine={true}
                  className="text-sm border border-border/60 rounded-md overflow-hidden"
                />
                {jsonError && (
                  <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
                    {jsonError}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-2">
                  {t('settings:mcp_server_edit.json_hint')}
                </p>
              </div>
            </>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/40">
            <NotionButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t('settings:mcp_server_edit.cancel')}
            </NotionButton>
            <NotionButton
              type="submit"
              variant="primary"
              size="sm"
              disabled={isSubmitting}
            >
              {t('settings:mcp_server_edit.create')}
            </NotionButton>
          </div>
        </form>
      </div>
    </div>
  );
}

// 空状态组件
function EmptyServerList({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation(['settings']);

  return (
    <div className="py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
        <Plug className="w-6 h-6 text-muted-foreground/60" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {t('settings:mcp_descriptions.no_mcp_configured')}
      </p>
      <p className="text-xs text-muted-foreground mb-6 max-w-xs mx-auto leading-relaxed">
        {t('settings:mcp_descriptions.click_add_to_start')}
      </p>
      <NotionButton
        onClick={onAdd}
        variant="primary"
        size="sm"
      >
        <Plus className="w-4 h-4 mr-1" />
        {t('settings:mcp_server_list.add_server')}
      </NotionButton>
    </div>
  );
}

// 操作菜单组件
function ActionMenu({
  onReconnect,
  onRefresh,
  onHealthCheck,
  onClearCache,
  onOpenPolicy
}: {
  onReconnect: () => void;
  onRefresh: () => void;
  onHealthCheck: () => void;
  onClearCache: () => void;
  onOpenPolicy: () => void;
}) {
  const { t } = useTranslation(['settings']);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <NotionButton variant="ghost" size="sm" onClick={() => setIsOpen(!isOpen)} className="bg-muted/50 hover:bg-muted">
        <Ellipsis className="w-4 h-4" />
        {t('settings:mcp_descriptions.quick_actions')}
      </NotionButton>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full right-0 mt-1 z-50 min-w-[180px] p-1.5 bg-popover border border-border rounded-lg shadow-lg animate-in fade-in zoom-in-95 duration-100">
            <NotionButton variant="ghost" size="sm" onClick={() => { onReconnect(); setIsOpen(false); }} className="w-full !justify-start">
              <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.reconnect')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onRefresh(); setIsOpen(false); }} className="w-full !justify-start">
              <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.refresh_list')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onHealthCheck(); setIsOpen(false); }} className="w-full !justify-start">
              <FlaskConical className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.health_check')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onClearCache(); setIsOpen(false); }} className="w-full !justify-start">
              <Sparkles className="w-3.5 h-3.5 text-muted-foreground rotate-45" />
              {t('settings:mcp.clear_cache')}
            </NotionButton>
            <div className="my-1 border-t border-border/50" />
            <NotionButton variant="ghost" size="sm" onClick={() => { onOpenPolicy(); setIsOpen(false); }} className="w-full !justify-start">
              <Key className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.security_policy')}
            </NotionButton>
          </div>
        </>
      )}
    </div>
  );
}

// 预置服务器选择器组件
function PresetServerSelector({
  existingServerIds,
  onAddPreset
}: {
  existingServerIds: string[];
  onAddPreset: (preset: PresetMcpServer) => void;
}) {
  const { t } = useTranslation(['settings']);
  const [isOpen, setIsOpen] = useState(false);

  // 按分类分组预置服务器
  const groupedPresets = useMemo(() => {
    const groups: Record<string, PresetMcpServer[]> = {};
    for (const preset of PRESET_MCP_SERVERS) {
      const category = preset.category;
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(preset);
    }
    return groups;
  }, []);

  // 检查服务器是否已存在 — 精确匹配，避免部分 ID 误命中
  const isPresetAdded = useCallback((presetId: string) => {
    return existingServerIds.some(id => 
      id === presetId || id.startsWith(`preset_${presetId}_`)
    );
  }, [existingServerIds]);

  return (
    <div className="relative">
      <NotionButton
        onClick={() => setIsOpen(!isOpen)}
        variant="default"
        size="sm"
      >
        <Package className="w-4 h-4 mr-1" />
        {t('settings:mcp_presets.add_preset')}
      </NotionButton>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full right-0 mt-1 z-50 w-[360px] max-h-[480px] overflow-y-auto p-2 bg-popover border border-border rounded-lg shadow-lg animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2 py-1.5 mb-2">
              <div className="text-sm font-medium text-foreground">{t('settings:mcp_presets.title')}</div>
              <div className="text-xs text-muted-foreground">{t('settings:mcp_presets.description')}</div>
            </div>

            {Object.entries(groupedPresets).map(([category, presets]) => (
              <div key={category} className="mb-3">
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  {t(CATEGORY_LABELS[category] || category)}
                </div>
                <div className="space-y-1">
                  {presets.map((preset) => {
                    const isAdded = isPresetAdded(preset.id);
                    return (
                      <NotionButton
                        key={preset.id}
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!isAdded) {
                            onAddPreset(preset);
                            setIsOpen(false);
                          }
                        }}
                        disabled={isAdded}
                        className={cn(
                          'w-full !justify-start !h-auto !py-2 text-left',
                          isAdded && 'opacity-50 bg-muted/30'
                        )}
                      >
                        <span className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0 mt-2',
                          isAdded ? 'bg-green-500' : 'bg-muted-foreground/30'
                        )} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{preset.name}</span>
                            {isAdded && (
                              <Check className="w-3.5 h-3.5 text-green-500" />
                            )}
                            {preset.source === 'community' && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                                {t('settings:mcp_presets.community')}
                              </span>
                            )}
                            {preset.requiresApiKey && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-500 font-medium">
                                <Key className="w-2.5 h-2.5 inline mr-0.5" />
                                API Key
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {t(preset.descriptionKey)}
                          </div>
                          {preset.homepage && (
                            <a
                              href={preset.homepage}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1"
                            >
                              <ExternalLink className="w-2.5 h-2.5" />
                              {new URL(preset.homepage).hostname}
                            </a>
                          )}
                        </div>
                      </NotionButton>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// 工具权限管理
// ============================================================================

type SensitivityLevel = 'low' | 'medium' | 'high';

interface ToolOverrideEntry {
  toolName: string;
  displayName: string;
  level: SensitivityLevel;
}

/** 敏感等级的颜色和标签配置 */
const SENSITIVITY_CONFIG: Record<SensitivityLevel, {
  badge: string;
  dot: string;
}> = {
  low: {
    badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    dot: 'bg-green-500',
  },
  medium: {
    badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    dot: 'bg-yellow-500',
  },
  high: {
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    dot: 'bg-red-500',
  },
};

/** 工具权限管理区域 - 非折叠，直接展示 */
function ToolPermissionsSection({ toolsByServer }: {
  toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [globalBypass, setGlobalBypass] = useState(false);
  const [toolOverrides, setToolOverrides] = useState<ToolOverrideEntry[]>([]);
  const [historyCount, setHistoryCount] = useState(0);

  /** 获取所有已注册工具的完整列表（去重） */
  const allTools = useMemo(() => {
    const toolMap = new Map<string, string>();
    for (const entry of Object.values(toolsByServer)) {
      for (const tool of entry.items || []) {
        if (tool.name && !toolMap.has(tool.name)) {
          toolMap.set(tool.name, stripMcpPrefix(tool.name));
        }
      }
    }
    return Array.from(toolMap.entries()).map(([name, display]) => ({ name, display }));
  }, [toolsByServer]);

  /** 从后端加载所有权限配置 */
  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await invoke<[string, string, string][]>('get_settings_by_prefix', {
        prefix: 'tool_approval.',
      });

      let bypass = false;
      const overrides: ToolOverrideEntry[] = [];
      let histCount = 0;

      for (const [key, value] of results) {
        if (key === 'tool_approval.global_bypass') {
          bypass = value === 'true';
        } else if (key.startsWith('tool_approval.override.')) {
          const toolName = key.slice('tool_approval.override.'.length);
          const level = (['low', 'medium', 'high'].includes(value) ? value : 'medium') as SensitivityLevel;
          overrides.push({
            toolName,
            displayName: stripMcpPrefix(toolName),
            level,
          });
        } else if (key.startsWith('tool_approval.scope.')) {
          histCount++;
        }
      }

      setGlobalBypass(bypass);
      setToolOverrides(overrides);
      setHistoryCount(histCount);
    } catch (err) {
      console.error('[ToolPermissions] Failed to load config:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 组件挂载时自动加载
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  /** 切换全局免审批开关 */
  const handleToggleGlobalBypass = useCallback(async () => {
    const newVal = !globalBypass;
    try {
      await invoke('save_setting', {
        key: 'tool_approval.global_bypass',
        value: newVal ? 'true' : 'false',
      });
      setGlobalBypass(newVal);
      showGlobalNotification(
        'success',
        t(newVal
          ? 'settings:tool_permissions.bypass_enabled'
          : 'settings:tool_permissions.bypass_disabled')
      );
    } catch (err) {
      console.error('[ToolPermissions] Toggle global bypass failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    }
  }, [globalBypass, t]);

  /** 设置单个工具的等级覆盖 */
  const handleSetOverride = useCallback(async (toolName: string, level: SensitivityLevel) => {
    const key = `tool_approval.override.${toolName}`;
    try {
      await invoke('save_setting', { key, value: level });
      setToolOverrides(prev => {
        const existing = prev.find(o => o.toolName === toolName);
        if (existing) {
          return prev.map(o => o.toolName === toolName ? { ...o, level } : o);
        }
        return [...prev, { toolName, displayName: stripMcpPrefix(toolName), level }];
      });
    } catch (err) {
      console.error('[ToolPermissions] Set override failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    }
  }, [t]);

  /** 删除单个工具的等级覆盖（恢复默认） */
  const handleRemoveOverride = useCallback(async (toolName: string) => {
    const key = `tool_approval.override.${toolName}`;
    try {
      await invoke('delete_setting', { key });
      setToolOverrides(prev => prev.filter(o => o.toolName !== toolName));
    } catch (err) {
      console.error('[ToolPermissions] Remove override failed:', err);
    }
  }, []);

  /** 清除所有历史审批记录 */
  const handleClearHistory = useCallback(async () => {
    if (!window.confirm(t('settings:tool_permissions.clear_history_confirm'))) return;
    try {
      const result = await invoke<number>('delete_settings_by_prefix', {
        prefix: 'tool_approval.scope.',
      });
      setHistoryCount(0);
      showGlobalNotification(
        'success',
        t('settings:tool_permissions.clear_history_success', { count: result })
      );
    } catch (err) {
      console.error('[ToolPermissions] Clear history failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.clear_all_failed'));
    }
  }, [t]);

  /** 获取工具已设定的覆盖等级（如果有） */
  const getOverrideLevel = useCallback((toolName: string): SensitivityLevel | null => {
    const found = toolOverrides.find(o => o.toolName === toolName);
    return found?.level ?? null;
  }, [toolOverrides]);

  /** 按钮组：等级选择器 */
  const LevelSelector = useCallback(({ toolName, currentLevel }: { toolName: string; currentLevel: SensitivityLevel | null }) => {
    const levels: SensitivityLevel[] = ['low', 'medium', 'high'];
    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5">
        {levels.map(level => {
          const isActive = currentLevel === level;
          const config = SENSITIVITY_CONFIG[level];
          return (
            <NotionButton
              key={level}
              variant="ghost"
              size="sm"
              onClick={() => {
                if (isActive) {
                  handleRemoveOverride(toolName);
                } else {
                  handleSetOverride(toolName, level);
                }
              }}
              className={cn(
                '!h-auto !px-2 !py-0.5 text-xs font-medium',
                isActive
                  ? config.badge
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
              )}
              title={isActive
                ? t('settings:tool_permissions.reset_to_default')
                : t(`settings:tool_permissions.set_to_${level}`)}
            >
              {t(`settings:tool_permissions.level_${level}`)}
            </NotionButton>
          );
        })}
      </div>
    );
  }, [handleSetOverride, handleRemoveOverride, t]);

  return (
    <div className="mt-8 pt-6 border-t border-border/40">
      {/* 标题栏 */}
      <h3 className="text-sm font-medium text-foreground mb-4">
        {t('settings:tool_permissions.title')}
      </h3>

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-16 bg-muted/30 rounded-lg animate-pulse" />
          <div className="h-40 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. 全局免审批开关 */}
          <div className="p-4 rounded-lg bg-muted/20 border border-border/40">
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <div className="flex items-center gap-2 mb-1">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {t('settings:tool_permissions.global_bypass_title')}
                  </span>
                  {globalBypass && (
                    <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded-full">
                      {t('settings:tool_permissions.bypass_badge')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('settings:tool_permissions.global_bypass_desc')}
                </p>
              </div>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleToggleGlobalBypass} className="!h-auto !w-auto" title={t('settings:tool_permissions.global_bypass_title')} aria-label="toggle bypass">
                {globalBypass ? (
                  <ToggleRight className="h-8 w-8 text-green-500" />
                ) : (
                  <ToggleLeft className="h-8 w-8 text-muted-foreground" />
                )}
              </NotionButton>
            </div>
          </div>

          {/* 2. 单工具等级覆盖 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('settings:tool_permissions.per_tool_title')}
                </h4>
                <span className="text-xs text-muted-foreground">
                  ({allTools.length} {t('settings:mcp_server_list.tools').toLowerCase()})
                </span>
              </div>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={fetchConfig}
                disabled={isLoading}
                className="text-xs"
              >
                <RefreshCw className={cn('h-3 w-3 mr-1', isLoading && 'animate-spin')} />
                {t('settings:tool_permissions.refresh')}
              </NotionButton>
            </div>

            <p className="text-xs text-muted-foreground mb-3">
              {t('settings:tool_permissions.per_tool_desc')}
            </p>

            {allTools.length === 0 ? (
              <div className="text-center py-6 rounded-lg border border-dashed border-border/60 bg-muted/5">
                <Shield className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t('settings:tool_permissions.no_tools')}
                </p>
              </div>
            ) : (
              <CustomScrollArea
                className="rounded-lg border border-border/30"
                style={{ maxHeight: 400 }}
              >
                <div className="space-y-1 p-1">
                  {allTools.map(({ name, display }) => {
                    const override = getOverrideLevel(name);
                    return (
                      <div
                        key={name}
                        className={cn(
                          'flex items-center justify-between px-3 py-2 rounded-lg transition-colors',
                          override ? 'bg-muted/30' : 'hover:bg-muted/20'
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1 mr-3">
                          <span
                            className={cn(
                              'w-1.5 h-1.5 rounded-full flex-shrink-0',
                              override
                                ? SENSITIVITY_CONFIG[override].dot
                                : 'bg-muted-foreground/40'
                            )}
                          />
                          <span className="text-sm text-foreground truncate font-mono" title={name}>
                            {display}
                          </span>
                          {override && (
                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveOverride(name)} className="!h-5 !w-5 !p-0 text-muted-foreground hover:text-foreground" title={t('settings:tool_permissions.reset_to_default')} aria-label="reset">
                              ✕
                            </NotionButton>
                          )}
                        </div>
                        <LevelSelector toolName={name} currentLevel={override} />
                      </div>
                    );
                  })}
                </div>
              </CustomScrollArea>
            )}
          </div>

          {/* 3. 历史审批记录清理 */}
          {historyCount > 0 && (
            <div className="p-3 rounded-lg bg-muted/10 border border-border/30 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t('settings:tool_permissions.history_records', { count: historyCount })}
              </span>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleClearHistory}
                className="text-xs text-red-500 hover:text-red-600"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                {t('settings:tool_permissions.clear_history')}
              </NotionButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 主组件
export function McpToolsSection({
  servers,
  serverStatusMap,
  toolsByServer,
  prompts,
  resources,
  lastCacheUpdatedAt,
  cacheCapacity = 500,
  isLoading,
  lastError,
  onAddServer,
  onSaveServer,
  onDeleteServer,
  onTestServer,
  onReconnect,
  onRefreshRegistry,
  onHealthCheck,
  onClearCache,
  onOpenPolicy
}: McpToolsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  // 展开面板状态：key 是服务器 index，value 是展开类型
  const [expandedPanels, setExpandedPanels] = useState<Map<number, ExpandedPanelType>>(new Map());
  // 是否正在添加新服务器
  const [isAddingNew, setIsAddingNew] = useState(false);
  // 正在测试的服务器 ID
  const [testingServerId, setTestingServerId] = useState<string | null>(null);

  // 切换展开面板
  const handleToggleExpand = useCallback((idx: number, type: ExpandedPanelType) => {
    setExpandedPanels(prev => {
      const next = new Map(prev);
      if (type === null || prev.get(idx) === type) {
        next.delete(idx);
      } else {
        // 关闭其他展开的面板
        next.clear();
        next.set(idx, type);
      }
      return next;
    });
  }, []);

  // 计算统计数据
  const totalServers = servers.length;
  const connectedServers = useMemo(() => {
    let count = 0;
    servers.forEach((server, idx) => {
      if (isBuiltinServer(server.id)) {
        count++;
        return;
      }
      const status = serverStatusMap.get(server.id) || serverStatusMap.get(`server_${idx}`);
      if (status?.connected) count++;
    });
    return count;
  }, [servers, serverStatusMap]);

  const totalCachedTools = useMemo(() => {
    return Object.values(toolsByServer).reduce((sum, entry) => sum + (entry.items?.length || 0), 0);
  }, [toolsByServer]);

  const cacheUsagePercent =
    cacheCapacity > 0 ? Math.min(100, Math.round((totalCachedTools / cacheCapacity) * 100)) : 0;
  const promptsCount = prompts.items?.length || 0;
  const resourcesCount = resources.items?.length || 0;

  // 加载状态
  if (isLoading) {
    return (
      <SettingSection title={t('settings:tabs.mcp_tools', 'MCP 工具协议')} hideHeader>
        <div className="space-y-4">
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 bg-muted/30 rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="h-64 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      </SettingSection>
    );
  }

  return (
    <SettingSection title={t('settings:tabs.mcp_tools', 'MCP 工具协议')} description={t('settings:mcp_descriptions.section_description', '管理 Model Context Protocol (MCP) 服务器与工具集成')} hideHeader>
      <div className="space-y-6">
        {/* 概览统计 - 紧凑的网格布局 */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatItem
            label={t('settings:mcp_server_list.connection_status')}
            value={`${connectedServers} / ${totalServers}`}
            status={connectedServers > 0 ? 'success' : totalServers > 0 ? 'error' : 'neutral'}
          />
          <StatItem
            label={t('settings:mcp_server_list.tools_cache')}
            value={totalCachedTools}
            suffix={`/ ${cacheCapacity}`}
            status={totalCachedTools > 0 ? 'success' : 'neutral'}
          />
          <div className="p-3 bg-muted/30 rounded-lg border border-transparent hover:border-border/40 transition-colors">
            <div className="text-xs text-muted-foreground mb-1">{t('settings:mcp_server_list.prompts_resources')}</div>
            <div className="flex items-center gap-3">
              <div>
                <span className="text-lg font-semibold text-foreground">{promptsCount}</span>
                <span className="text-[10px] text-muted-foreground ml-1">P</span>
              </div>
              <div className="w-px h-6 bg-border/60" />
              <div>
                <span className="text-lg font-semibold text-foreground">{resourcesCount}</span>
                <span className="text-[10px] text-muted-foreground ml-1">R</span>
              </div>
            </div>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg border border-transparent hover:border-border/40 transition-colors">
            <div className="text-xs text-muted-foreground mb-1">{t('settings:mcp_server_list.cache_update_time')}</div>
            <div className="text-sm font-medium text-foreground truncate mt-1">
              {formatDateTime(lastCacheUpdatedAt)}
            </div>
          </div>
        </div>

        {/* 错误提示 */}
        {lastError && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <div className="flex items-center gap-2 text-sm text-red-500">
              <WifiOff className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{lastError}</span>
            </div>
          </div>
        )}

        {/* 操作栏 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-medium text-foreground flex-shrink-0">{t('settings:mcp_server_list.server_list')}</h3>
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <ActionMenu
              onReconnect={onReconnect}
              onRefresh={onRefreshRegistry}
              onHealthCheck={onHealthCheck}
              onClearCache={onClearCache}
              onOpenPolicy={onOpenPolicy}
            />
            <PresetServerSelector
              existingServerIds={servers.map(s => s.id)}
              onAddPreset={(preset) => {
                const config = presetToMcpConfig(preset);
                void onAddServer(config);
              }}
            />
            <NotionButton
              onClick={() => {
                setIsAddingNew(true);
                setExpandedPanels(new Map()); // 关闭其他展开的面板
              }}
              disabled={isAddingNew}
              variant="primary"
              size="sm"
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('settings:mcp.add_server')}
            </NotionButton>
          </div>
        </div>

        {/* 服务器列表 */}
        <div className="space-y-2">
          {totalServers === 0 && !isAddingNew ? (
            <div className="rounded-lg border border-dashed border-border/60 bg-muted/5">
              <EmptyServerList onAdd={() => setIsAddingNew(true)} />
            </div>
          ) : (
            <div className="grid gap-3">
              {/* 新增服务器编辑项 */}
              {isAddingNew && (
                <NewServerEditItem
                  onSave={async (newServer) => {
                    const ok = await onAddServer(newServer);
                    if (ok !== false) setIsAddingNew(false);
                    return ok;
                  }}
                  onCancel={() => setIsAddingNew(false)}
                />
              )}
              
              {/* 现有服务器列表 */}
              {servers.map((server, idx) => {
                const serverId = server.id || `server_${idx}`;
                const status = serverStatusMap.get(serverId) || serverStatusMap.get(server.id);
                const snapshotEntry = toolsByServer[serverId] || toolsByServer[server.id];
                const cachedCount = snapshotEntry?.items?.length ?? 0;
                const toolNames = (snapshotEntry?.items || [])
                  .map(item => stripMcpPrefix(item?.name))
                  .filter((name): name is string => Boolean(name));

                return (
                  <ServerListItem
                    key={serverId}
                    server={server}
                    status={status}
                    cachedToolCount={cachedCount}
                    toolNames={toolNames}
                    expandedPanel={expandedPanels.get(idx) || null}
                    onSave={(data) => onSaveServer(data, server.id)}
                    onDelete={() => onDeleteServer(server.id)}
                    onToggleExpand={(type) => handleToggleExpand(idx, type)}
                    onTest={async () => {
                      if (testingServerId) return;
                      setTestingServerId(server.id);
                      try { await onTestServer(server); } finally { setTestingServerId(null); }
                    }}
                    isTesting={testingServerId === server.id}
                    disableTest={testingServerId != null && testingServerId !== server.id}
                    isBuiltin={isBuiltinServer(server.id)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Prompts & Resources 详情（可选展示） */}
        {(promptsCount > 0 || resourcesCount > 0) && (
          <div className="mt-8 pt-6 border-t border-border/40">
            <h3 className="text-sm font-medium text-foreground mb-4">{t('settings:mcp_server_list.prompts_resources_section')}</h3>
            <div className="grid gap-6 md:grid-cols-2">
              {/* Prompts */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:mcp_server_list.latest_prompts')}</div>
                <div className="space-y-2">
                  {prompts.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70 italic">{t('settings:mcp_server_list.none')}</span>
                  ) : (
                    prompts.items.slice(0, 5).map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md hover:bg-muted/30 transition-colors">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                        <span className="text-foreground truncate">{item.name}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              {/* Resources */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:mcp_server_list.latest_resources')}</div>
                <div className="space-y-2">
                  {resources.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70 italic">{t('settings:mcp_server_list.none')}</span>
                  ) : (
                    resources.items.slice(0, 5).map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md hover:bg-muted/30 transition-colors">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0" />
                        <span className="text-foreground truncate">{item.name || item.uri}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 工具权限管理 */}
        <ToolPermissionsSection toolsByServer={toolsByServer} />
      </div>
    </SettingSection>
  );
}

export default McpToolsSection;
