/**
 * MCP 工具协议管理 - Notion/deep-agent_new 风格重构
 *
 * 设计原则：
 * - 使用 bg-card rounded-lg border border-border 作为卡片基础
 * - 使用 bg-muted/50 rounded-md/lg 作为内嵌区域
 * - 状态使用小圆点 w-2 h-2 rounded-full
 * - 交互使用 hover:bg-[var(--interactive-hover)]，选中用 bg-accent
 * - 没有装饰性元素（顶部彩色条）
 * - 紧凑的间距和字体
 */

import '../styles/mcp-preset-oauth.css';
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Plus,
  ArrowClockwise,
  Trash,
  PencilSimple,
  Eye,
  Flask,
  Plug,
  WifiSlash,
  DotsThree,
  Sparkle,
  Key,
  CaretDown,
  CaretUp,
  CodeBlock,
  FileCode,
  Lock,
  Package,
  ArrowSquareOut,
  Check,
  Shield,
  ShieldCheck,
  FolderOpen,
  Warning,
  MagnifyingGlass,
  Funnel,
  CaretRight,
  Stack,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { isAndroid } from '@/utils/platform';
import { UnifiedCodeEditor } from '@/components/shared/UnifiedCodeEditor';
import { isBuiltinServer, BUILTIN_SERVER_ID } from '@/mcp/builtinMcpServer';
import { SettingSection } from './SettingsCommon';
import { NotionButton } from '@/components/ui/NotionButton';
import { Switch } from '@/components/ui/shad/Switch';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { ApiKeyField } from './ApiKeyField';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { 
  PRESET_MCP_SERVERS, 
  presetToMcpConfig, 
  CATEGORY_LABELS,
  RISK_LABELS,
  isOAuthCapablePreset,
  type PresetMcpServer 
} from '@/mcp/presetMcpServers';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/shad/Sheet';
import { assessAuthorizedRootRisk, type AuthorizedRootRisk } from './runtimeRootRisk';
import {
  buildManagedPermissionTools,
  assessShellCommandRuleRisk,
  filterShellCommandRules,
  filterManagedPermissionTools,
  formatToolSource,
  parseShellCommandPolicy,
  previewShellCommandPolicy,
  resolveToolOverride,
  resolveToolOverrideEntry,
  serializeShellCommandPolicy,
  selectedOverrideKeysForReset,
  SHELL_COMMAND_POLICY_SETTING_KEYS,
  validateShellCommandPattern,
  type ShellCommandAction,
  type ShellCommandMatchType,
  type ShellCommandRule,
  type ToolCapability,
  type ToolLevelFilter,
  type ToolOverrideFilter,
  type ToolSensitivityLevel,
  type ManagedPermissionTool,
} from './toolPermissionModel';

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
  testStep?: string | null;
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
  testStepLabel,
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
  testStepLabel?: string | null;
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
        'rounded-lg overflow-hidden transition-colors duration-200 border border-transparent',
        isExpanded ? 'bg-muted/30 border-border/40' : 'hover:bg-[var(--interactive-hover)] hover:border-border/20'
      )}
    >
      {/* 删除确认栏 */}
      {confirmingDelete && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-destructive/10 border-b border-destructive/20">
          <span className="text-xs text-destructive font-medium">
            {t('settings:mcp_descriptions.confirm_delete')}
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
                <WifiSlash className="w-3 h-3" />
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
                    <ArrowClockwise className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Flask className="w-3.5 h-3.5" />
                  )}
                </NotionButton>
              )}
              {isTesting && testStepLabel && (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap animate-pulse">
                  {testStepLabel}
                </span>
              )}
              {!isBuiltin && (
                <>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onToggleExpand(expandedPanel === 'edit' ? null : 'edit'); }} className={cn('!h-7 !w-7', expandedPanel === 'edit' && 'text-primary bg-primary/10')} title={t('settings:mcp_descriptions.action_edit')} aria-label={t('settings:a11y.edit')}>
                    <PencilSimple className="w-3.5 h-3.5" />
                  </NotionButton>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }} className="!h-7 !w-7 hover:text-destructive" title={t('settings:mcp_descriptions.action_delete')} aria-label={t('settings:a11y.delete')}>
                    <Trash className="w-3.5 h-3.5" />
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
    const v = String(raw ?? '').trim().toLowerCase();
    if (v === 'streamable-http' || v === 'streamablehttp' || v === 'http') return 'streamable_http';
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
  const [showApiKey, setShowApiKey] = useState(false);

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
          <CodeBlock className="w-3.5 h-3.5" />
          {t('settings:mcp_server_edit.json_config')}
        </NotionButton>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {editMode === 'form' ? (
          <>
            {/* 表单模式内容 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 名称 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.server_name')} *
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('settings:mcp_server_edit.server_name_placeholder')}
                  required
                />
              </div>

              {/* 命名空间 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.namespace')}
                </label>
                <Input
                  value={formData.namespace}
                  onChange={(e) => setFormData({ ...formData, namespace: e.target.value })}
                  className="font-mono"
                  placeholder={t('settings:mcp_server_edit.namespace_placeholder')}
                />
              </div>
            </div>

            {/* 传输类型 */}
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                {t('settings:mcp_server_edit.transport_type')}
              </label>
              <Select value={formData.transportType} onValueChange={(val) => setFormData({ ...formData, transportType: val as McpServer['transportType'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sse">{t('settings:mcp_transport.sse_server_events')}</SelectItem>
                  <SelectItem value="websocket">{t('settings:mcp_transport.websocket')}</SelectItem>
                  <SelectItem value="streamable_http">{t('settings:mcp_transport.http_streamable')}</SelectItem>
                  <SelectItem value="stdio">{t('settings:mcp_transport.stdio_local_process')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* URL / Command */}
            {formData.transportType === 'stdio' ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.command')} *
                  </label>
                  <Input
                    value={formData.command}
                    onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                    className="font-mono"
                    placeholder="npx, node, python..."
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.args')}
                  </label>
                  <Input
                    value={formData.args}
                    onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                    className="font-mono"
                    placeholder="-y, @anthropic/mcp-server"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.server_url')} *
                </label>
                <Input
                  type="url"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  className="font-mono"
                  placeholder="http://localhost:3000/sse"
                  required
                />
              </div>
            )}

            {/* 高级配置折叠区 */}
            <div className="border border-border/40 rounded-lg overflow-hidden">
              <NotionButton variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full !justify-between !px-4 !py-3 !rounded-none">
                <span>{t('settings:mcp_server_edit.advanced_config')}</span>
                {showAdvanced ? <CaretUp className="w-4 h-4" /> : <CaretDown className="w-4 h-4" />}
              </NotionButton>

              {showAdvanced && (
                <div className="px-4 pb-4 space-y-6 border-t border-border/40 pt-4 bg-muted/10">
                  {/* API Key */}
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                      {t('settings:mcp_server_edit.api_key')}
                    </label>
                    <ApiKeyField
                      value={formData.apiKey}
                      onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                      placeholder={t('settings:mcp_server_edit.api_key_placeholder')}
                      inputClassName="font-mono"
                      revealed={showApiKey}
                      canReveal={formData.apiKey.trim().length > 0}
                      onToggle={() => setShowApiKey(!showApiKey)}
                      showLabel={t('common:securePassword.showPassword')}
                      hideLabel={t('common:securePassword.hidePassword')}
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
                            <Input
                              value={key}
                              onChange={(e) => updateEnvKey(key, e.target.value)}
                              className="flex-1 text-xs font-mono"
                              placeholder={t('settings:placeholders.env_key')}
                            />
                            <span className="text-muted-foreground">=</span>
                            <Input
                              value={value}
                              onChange={(e) => updateEnvValue(key, e.target.value)}
                              className="flex-1 text-xs font-mono"
                              placeholder="value"
                            />
                            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => removeEnvRow(key)} className="!h-6 !w-6 hover:text-destructive" aria-label="remove">
                              <Trash className="w-3.5 h-3.5" />
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
    const v = String(raw ?? '').trim().toLowerCase();
    if (v === 'streamable-http' || v === 'streamablehttp' || v === 'http') return 'streamable_http';
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
  const [showApiKey, setShowApiKey] = useState(false);

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
            <CodeBlock className="w-3.5 h-3.5" />
            JSON
          </NotionButton>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {editMode === 'form' ? (
            <>
              {/* 表单模式内容 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 名称 */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.server_name')} *
                  </label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
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
                  <Input
                    value={newServerId}
                    disabled
                    className="font-mono bg-muted/50 text-muted-foreground"
                  />
                </div>
              </div>

              {/* 传输类型 */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.transport_type')}
                </label>
                <Select value={formData.transportType} onValueChange={(val) => setFormData({ ...formData, transportType: val as McpServer['transportType'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sse">{t('settings:mcp_transport.sse_server_events')}</SelectItem>
                  <SelectItem value="websocket">{t('settings:mcp_transport.websocket')}</SelectItem>
                  <SelectItem value="streamable_http">{t('settings:mcp_transport.http_streamable')}</SelectItem>
                  <SelectItem value="stdio">{t('settings:mcp_transport.stdio_local_process')}</SelectItem>
                </SelectContent>
              </Select>
              </div>

              {/* URL / Command */}
              {formData.transportType === 'stdio' ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                      {t('settings:mcp_server_edit.command')} *
                    </label>
                  <Input
                    value={formData.command}
                    onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                    className="font-mono"
                    placeholder="npx, node, python..."
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.args')}
                  </label>
                  <Input
                    value={formData.args}
                    onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                    className="font-mono"
                    placeholder="-y, @anthropic/mcp-server"
                  />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.server_url')} *
                  </label>
                  <Input
                  type="url"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  className="font-mono"
                  placeholder="https://api.example.com/mcp"
                  required
                />
                </div>
              )}

              {/* 高级配置折叠区 */}
              <div className="border border-border/40 rounded-lg overflow-hidden">
                <NotionButton variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full !justify-between !px-4 !py-3 !rounded-none">
                  <span>{t('settings:mcp_server_edit.advanced_config')}</span>
                  {showAdvanced ? <CaretUp className="w-4 h-4" /> : <CaretDown className="w-4 h-4" />}
                </NotionButton>

                {showAdvanced && (
                  <div className="px-4 pb-4 space-y-6 border-t border-border/40 pt-4 bg-muted/10">
                    {/* Namespace */}
                    <div>
                      <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {t('settings:mcp_server_edit.namespace')}
                      </label>
                      <Input
                        value={formData.namespace}
                        onChange={(e) => setFormData({ ...formData, namespace: e.target.value })}
                        className="font-mono"
                        placeholder={t('settings:mcp_server_edit.namespace_placeholder')}
                      />
                    </div>

                    {/* API Key */}
                    <div>
                      <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {t('settings:mcp_server_edit.api_key')}
                      </label>
                      <ApiKeyField
                        value={formData.apiKey}
                        onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                        placeholder={t('settings:mcp_server_edit.api_key_placeholder')}
                        inputClassName="font-mono"
                        revealed={showApiKey}
                        canReveal={formData.apiKey.trim().length > 0}
                        onToggle={() => setShowApiKey(!showApiKey)}
                        showLabel={t('common:securePassword.showPassword')}
                        hideLabel={t('common:securePassword.hidePassword')}
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
                              <Input
                                value={key}
                                onChange={(e) => updateEnvKey(key, e.target.value)}
                                className="flex-1 text-xs font-mono"
                                placeholder={t('settings:placeholders.env_key')}
                              />
                              <span className="text-muted-foreground">=</span>
                              <Input
                                value={value}
                                onChange={(e) => updateEnvValue(key, e.target.value)}
                                className="flex-1 text-xs font-mono"
                                placeholder="value"
                              />
                              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => removeEnvRow(key)} className="!h-6 !w-6 hover:text-destructive" aria-label="remove">
                                <Trash className="w-3.5 h-3.5" />
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
      <NotionButton variant="ghost" size="sm" onClick={() => setIsOpen(!isOpen)} className="bg-muted/50 hover:bg-[var(--interactive-hover)]">
        <DotsThree className="w-4 h-4" />
        {t('settings:mcp_descriptions.quick_actions')}
      </NotionButton>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full right-0 mt-1 z-50 min-w-[180px] p-1.5 bg-popover border border-border rounded-lg shadow-lg ui-zoom-fade-in">
            <NotionButton variant="ghost" size="sm" onClick={() => { onReconnect(); setIsOpen(false); }} className="w-full !justify-start">
              <ArrowClockwise className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.reconnect')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onRefresh(); setIsOpen(false); }} className="w-full !justify-start">
              <Sparkle className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.refresh_list')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onHealthCheck(); setIsOpen(false); }} className="w-full !justify-start">
              <Flask className="w-3.5 h-3.5 text-muted-foreground" />
              {t('settings:mcp.health_check')}
            </NotionButton>
            <NotionButton variant="ghost" size="sm" onClick={() => { onClearCache(); setIsOpen(false); }} className="w-full !justify-start">
              <Sparkle className="w-3.5 h-3.5 text-muted-foreground rotate-45" />
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

// 预置服务器选择器 + 安装前权限 Drawer
export function PresetServerSelector({
  existingServerIds,
  onAddPreset
}: {
  existingServerIds: string[];
  onAddPreset: (preset: PresetMcpServer, options?: { apiKey?: string; enableOauth?: boolean }) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<PresetMcpServer | null>(null);
  const [pendingApiKey, setPendingApiKey] = useState('');
  const [enableOauth, setEnableOauth] = useState(false);
  const oauthSupported = !isAndroid();
  const addPresetBtnRef = useRef<HTMLButtonElement | null>(null);
  const selectorPanelRef = useRef<HTMLDivElement | null>(null);

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

  const isPresetAdded = useCallback((presetId: string) => {
    return existingServerIds.some(id => 
      id === presetId || id.startsWith(`preset_${presetId}_`)
    );
  }, [existingServerIds]);

  const closePermissionDrawer = useCallback(() => {
    setPendingPreset(null);
    setPendingApiKey('');
    setEnableOauth(false);
  }, []);

  const closeSelector = useCallback(() => {
    setIsOpen(false);
    // Defer until after unmount so the trigger is again focusable.
    queueMicrotask(() => {
      addPresetBtnRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const panel = selectorPanelRef.current;
    const focusFirst = () => {
      const first = panel?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel)?.focus({ preventScroll: true });
    };
    const raf = window.requestAnimationFrame(focusFirst);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSelector();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen, closeSelector]);

  const confirmInstall = useCallback(() => {
    if (!pendingPreset) return;
    if (pendingPreset.requiresApiKey && !pendingApiKey.trim() && !(oauthSupported && enableOauth)) {
      showGlobalNotification('error', t('settings:mcp_presets.api_key_required'));
      return;
    }
    onAddPreset(pendingPreset, {
      apiKey: pendingApiKey.trim() || undefined,
      enableOauth: oauthSupported && enableOauth && isOAuthCapablePreset(pendingPreset) && !pendingApiKey.trim(),
    });
    setIsOpen(false);
    closePermissionDrawer();
  }, [pendingPreset, pendingApiKey, enableOauth, oauthSupported, onAddPreset, closePermissionDrawer, t]);

  return (
    <div className="relative">
      <NotionButton
        ref={addPresetBtnRef}
        onClick={() => setIsOpen(!isOpen)}
        variant="default"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid="mcp-preset-add-btn"
      >
        <Package className="w-4 h-4 mr-1" aria-hidden="true" />
        {t('settings:mcp_presets.add_preset')}
      </NotionButton>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeSelector}
            aria-hidden="true"
            data-testid="mcp-preset-selector-backdrop"
          />
          <div
            ref={selectorPanelRef}
            className="absolute top-full right-0 mt-1 z-50 w-[380px] max-w-[calc(100vw-3rem)] max-h-[480px] overflow-y-auto p-2 bg-popover border border-border rounded-lg shadow-lg ui-zoom-fade-in mcp-preset-selector"
            role="dialog"
            aria-modal="true"
            aria-label={t('settings:mcp_presets.title')}
            tabIndex={-1}
            data-testid="mcp-preset-selector"
          >
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
                            setPendingPreset(preset);
                            setEnableOauth(oauthSupported && isOAuthCapablePreset(preset) && !preset.requiresApiKey);
                          }
                        }}
                        disabled={isAdded}
                        data-testid={`mcp-preset-item-${preset.id}`}
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
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-foreground">{preset.name}</span>
                            {isAdded && (
                              <Check className="w-3.5 h-3.5 text-green-500" />
                            )}
                            {preset.source === 'official' && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">
                                {t('settings:mcp_presets.official')}
                              </span>
                            )}
                            {preset.source === 'community' && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                                {t('settings:mcp_presets.community')}
                              </span>
                            )}
                            {(preset.requiresApiKey || preset.authKind === 'api_key' || preset.authKind === 'api_key_or_oauth') && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-500 font-medium">
                                <Key className="w-2.5 h-2.5 inline mr-0.5" />
                                API Key
                              </span>
                            )}
                            {oauthSupported && isOAuthCapablePreset(preset) && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/10 text-violet-500 font-medium">
                                OAuth
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {t(preset.descriptionKey)}
                          </div>
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

      <Sheet open={Boolean(pendingPreset)} onOpenChange={(open) => { if (!open) closePermissionDrawer(); }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md mcp-preset-permission-drawer"
          data-testid="mcp-preset-permission-drawer"
          aria-describedby="mcp-preset-permission-summary"
        >
          {pendingPreset && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" aria-hidden="true" />
                  {t('settings:mcp_presets.permission_title', { name: pendingPreset.name })}
                </SheetTitle>
                <SheetDescription>
                  {t(pendingPreset.descriptionKey)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <div
                  id="mcp-preset-permission-summary"
                  className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2"
                  role="region"
                  aria-label={t('settings:mcp_presets.permission_title', { name: pendingPreset.name })}
                  data-testid="mcp-preset-permission-summary"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('settings:mcp_presets.risk_label')}</span>
                    <span
                      className={cn(
                        'text-xs font-medium px-1.5 py-0.5 rounded',
                        pendingPreset.risk === 'high' && 'bg-red-500/10 text-red-500',
                        pendingPreset.risk === 'medium' && 'bg-amber-500/10 text-amber-600',
                        pendingPreset.risk === 'low' && 'bg-green-500/10 text-green-600',
                      )}
                      data-testid="mcp-preset-permission-risk"
                    >
                      {t(RISK_LABELS[pendingPreset.risk])}
                    </span>
                  </div>
                  <div data-testid="mcp-preset-permission-scope">
                    <div className="text-muted-foreground mb-1">{t('settings:mcp_presets.data_scope_label')}</div>
                    <p className="text-foreground">{t(pendingPreset.permissions.dataScopeKey)}</p>
                  </div>
                  <div className="flex items-center gap-2" data-testid="mcp-preset-permission-egress">
                    <span className="text-muted-foreground">{t('settings:mcp_presets.network_egress_label')}</span>
                    <span>{pendingPreset.permissions.networkEgress
                      ? t('settings:mcp_presets.network_egress_yes')
                      : t('settings:mcp_presets.network_egress_no')}</span>
                  </div>
                  {pendingPreset.permissions.notesKey && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="mcp-preset-permission-notes"
                    >
                      {t(pendingPreset.permissions.notesKey)}
                    </p>
                  )}
                  {pendingPreset.permissions.apiKeyUrl && (
                    <a
                      href={pendingPreset.permissions.apiKeyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      data-testid="mcp-preset-permission-api-key-link"
                    >
                      <ArrowSquareOut className="w-3 h-3" aria-hidden="true" />
                      {t('settings:mcp_presets.get_api_key')}
                    </a>
                  )}
                </div>

                {(pendingPreset.requiresApiKey || pendingPreset.authKind === 'api_key' || pendingPreset.authKind === 'api_key_or_oauth') && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp.api_key')}</label>
                    <Input
                      type="password"
                      value={pendingApiKey}
                      onChange={(e) => {
                        setPendingApiKey(e.target.value);
                        if (e.target.value.trim()) setEnableOauth(false);
                      }}
                      placeholder={pendingPreset.apiKeyHint ? t(pendingPreset.apiKeyHint) : t('settings:placeholders.api_key')}
                      className="font-mono"
                    />
                  </div>
                )}

                {oauthSupported && isOAuthCapablePreset(pendingPreset) && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <Checkbox
                      checked={enableOauth && !pendingApiKey.trim()}
                      onCheckedChange={(v) => {
                        setEnableOauth(Boolean(v));
                        if (v) setPendingApiKey('');
                      }}
                      disabled={Boolean(pendingApiKey.trim())}
                    />
                    <span className="text-sm leading-snug">
                      {t('settings:mcp_presets.enable_oauth_install')}
                    </span>
                  </label>
                )}
              </div>
              <SheetFooter className="mt-6 flex gap-2 sm:justify-end">
                <NotionButton variant="default" size="sm" onClick={closePermissionDrawer}>
                  {t('common:cancel')}
                </NotionButton>
                <NotionButton variant="primary" size="sm" onClick={confirmInstall}>
                  {t('settings:mcp_presets.confirm_install')}
                </NotionButton>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ============================================================================
// 工具权限管理
// ============================================================================

type SensitivityLevel = ToolSensitivityLevel;

interface RuntimeRootEntry {
  id: string;
  kind: string;
  path: string;
  access: 'read_only' | 'read_write' | string;
  label: string;
  description?: string;
  session_scoped?: boolean;
  configured?: boolean;
}

interface ToolOverrideEntry {
  toolName: string;
  displayName: string;
  level: SensitivityLevel;
}

const TOOL_CAPABILITIES: ToolCapability[] = [
  'files', 'web', 'knowledge', 'learning', 'automation', 'data', 'communication', 'other',
];

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

const EMPTY_SHELL_RULE_DRAFT = {
  action: 'ask' as ShellCommandAction,
  matchType: 'exact' as ShellCommandMatchType,
  pattern: '',
  note: '',
};

const SHELL_EFFECT_RESTRICTIVENESS: Record<ShellCommandAction, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function shellRuleRemovalRelaxesPolicy(
  rule: ShellCommandRule,
  defaultEffect: ShellCommandAction,
  nextRules: ShellCommandRule[]
): boolean {
  if (!rule.enabled || rule.action === 'allow') return false;
  const nextEffect = previewShellCommandPolicy(rule.pattern, defaultEffect, nextRules).effect;
  return SHELL_EFFECT_RESTRICTIVENESS[nextEffect] < SHELL_EFFECT_RESTRICTIVENESS[rule.action];
}

/** Fine-grained policy for the protected local terminal tool. */
function ShellCommandRulesSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [defaultEffect, setDefaultEffect] = useState<ShellCommandAction>('ask');
  const [rules, setRules] = useState<ShellCommandRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState<ShellCommandAction | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<ShellCommandMatchType | 'all'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState(EMPTY_SHELL_RULE_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pendingRisk, setPendingRisk] = useState<string | null>(null);
  const [pendingDefaultAllow, setPendingDefaultAllow] = useState(false);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [previewCommand, setPreviewCommand] = useState('');

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await invoke<string>('get_setting', {
        key: SHELL_COMMAND_POLICY_SETTING_KEYS.policy,
      }).catch(() => '');
      const policy = parseShellCommandPolicy(raw);
      setDefaultEffect(policy.defaultEffect);
      setRules(policy.rules);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  const persistPolicy = useCallback(async (
    nextDefault: ShellCommandAction,
    nextRules: ShellCommandRule[]
  ) => {
    setSaving(true);
    try {
      await invoke('save_setting', {
        key: SHELL_COMMAND_POLICY_SETTING_KEYS.policy,
        value: serializeShellCommandPolicy(nextDefault, nextRules),
      });
      setDefaultEffect(nextDefault);
      setRules(nextRules);
      showGlobalNotification('success', t('settings:tool_permissions.shell_rules.saved'));
      return true;
    } catch (error) {
      console.error('[ToolPermissions] Save shell command policy failed:', error);
      showGlobalNotification('error', t('settings:tool_permissions.shell_rules.save_failed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleDefaultEffect = useCallback(async (effect: ShellCommandAction) => {
    if (effect === 'allow' && !pendingDefaultAllow) {
      setPendingDefaultAllow(true);
      return;
    }
    if (await persistPolicy(effect, rules)) setPendingDefaultAllow(false);
  }, [pendingDefaultAllow, persistPolicy, rules]);

  const beginAdd = useCallback(() => {
    setEditingId(null);
    setDraft(EMPTY_SHELL_RULE_DRAFT);
    setDraftError(null);
    setPendingRisk(null);
    setShowEditor(true);
  }, []);

  const beginEdit = useCallback((rule: ShellCommandRule) => {
    setEditingId(rule.id);
    setDraft({
      action: rule.action,
      matchType: rule.matchType,
      pattern: rule.pattern,
      note: rule.note ?? '',
    });
    setDraftError(null);
    setPendingRisk(null);
    setShowEditor(true);
  }, []);

  const saveDraft = useCallback(async () => {
    const validationError = validateShellCommandPattern(draft.pattern, draft.matchType);
    if (validationError) {
      setDraftError(validationError);
      return;
    }
    const duplicate = rules.some(rule => rule.id !== editingId
      && rule.matchType === draft.matchType
      && rule.pattern.toLocaleLowerCase() === draft.pattern.trim().toLocaleLowerCase());
    if (duplicate) {
      setDraftError('duplicate');
      return;
    }
    const candidate: ShellCommandRule = {
      id: editingId ?? `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: draft.action,
      matchType: draft.matchType,
      pattern: draft.pattern.trim(),
      enabled: editingId ? rules.find(rule => rule.id === editingId)?.enabled !== false : true,
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    };
    const risk = assessShellCommandRuleRisk(candidate);
    const riskFingerprint = `${candidate.action}:${candidate.matchType}:${candidate.pattern}`;
    if (risk && pendingRisk !== riskFingerprint) {
      setPendingRisk(riskFingerprint);
      return;
    }
    const next = editingId
      ? rules.map(rule => rule.id === editingId ? candidate : rule)
      : [...rules, candidate];
    if (await persistPolicy(defaultEffect, next)) {
      setShowEditor(false);
      setEditingId(null);
      setPendingRisk(null);
    }
  }, [defaultEffect, draft, editingId, pendingRisk, persistPolicy, rules]);

  const filteredRules = useMemo(() => filterShellCommandRules(rules, {
    query,
    action: actionFilter,
    matchType: typeFilter,
  }), [actionFilter, query, rules, typeFilter]);
  const preview = useMemo(() => previewCommand.trim()
    ? previewShellCommandPolicy(previewCommand, defaultEffect, rules)
    : null, [defaultEffect, previewCommand, rules]);
  const allVisibleSelected = filteredRules.length > 0
    && filteredRules.every(rule => selectedRuleIds.has(rule.id));

  useEffect(() => {
    const validIds = new Set(rules.map(rule => rule.id));
    setSelectedRuleIds(previous => new Set(
      Array.from(previous).filter(id => validIds.has(id))
    ));
  }, [rules]);

  useEffect(() => {
    setSelectedRuleIds(new Set());
  }, [actionFilter, query, typeFilter]);

  const selectVisibleRules = useCallback((selected: boolean) => {
    setSelectedRuleIds(previous => {
      const next = new Set(previous);
      for (const rule of filteredRules) {
        if (selected) next.add(rule.id);
        else next.delete(rule.id);
      }
      return next;
    });
  }, [filteredRules]);

  const updateSelectedRules = useCallback(async (operation: 'enable' | 'disable' | 'delete') => {
    if (selectedRuleIds.size === 0) return;
    const next = operation === 'delete'
      ? rules.filter(rule => !selectedRuleIds.has(rule.id))
      : rules.map(rule => selectedRuleIds.has(rule.id)
        ? { ...rule, enabled: operation === 'enable' }
        : rule);
    const relaxedCount = operation === 'enable' ? 0 : rules.filter(rule => (
      selectedRuleIds.has(rule.id) && shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)
    )).length;
    // eslint-disable-next-line no-alert -- policy relaxation and destructive removal require explicit confirmation
    if (relaxedCount > 0 && !window.confirm(t('settings:tool_permissions.shell_rules.relax_confirm', { count: relaxedCount }))) return;
    // eslint-disable-next-line no-alert -- destructive bulk removal requires explicit confirmation
    if (operation === 'delete' && relaxedCount === 0 && !window.confirm(t('settings:tool_permissions.shell_rules.bulk_delete_confirm', { count: selectedRuleIds.size }))) return;
    if (await persistPolicy(defaultEffect, next)) setSelectedRuleIds(new Set());
  }, [defaultEffect, persistPolicy, rules, selectedRuleIds, t]);

  const setRuleEnabled = useCallback(async (rule: ShellCommandRule, enabled: boolean) => {
    const next = rules.map(item => item.id === rule.id ? { ...item, enabled } : item);
    if (!enabled && shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)) {
      // eslint-disable-next-line no-alert -- disabling a restrictive rule may widen terminal access
      if (!window.confirm(t('settings:tool_permissions.shell_rules.relax_confirm', { count: 1 }))) return;
    }
    await persistPolicy(defaultEffect, next);
  }, [defaultEffect, persistPolicy, rules, t]);

  const deleteRule = useCallback(async (rule: ShellCommandRule) => {
    const next = rules.filter(item => item.id !== rule.id);
    const key = shellRuleRemovalRelaxesPolicy(rule, defaultEffect, next)
      ? 'settings:tool_permissions.shell_rules.relax_confirm'
      : 'settings:tool_permissions.shell_rules.delete_confirm';
    // eslint-disable-next-line no-alert -- deleting a command rule requires explicit confirmation
    if (!window.confirm(t(key, { count: 1, pattern: rule.pattern }))) return;
    await persistPolicy(defaultEffect, next);
  }, [defaultEffect, persistPolicy, rules, t]);

  const actionClass: Record<ShellCommandAction, string> = {
    allow: 'border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400',
    ask: 'border-yellow-500/25 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
    deny: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400',
  };

  return (
    <div data-testid="shell-command-rules" className="border-t border-border/30 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CodeBlock className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('settings:tool_permissions.shell_rules.title')}
            </h4>
            <span className="text-xs text-muted-foreground">({rules.length})</span>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground leading-relaxed">
            {t('settings:tool_permissions.shell_rules.desc')}
          </p>
        </div>
        <NotionButton variant="ghost" size="sm" onClick={beginAdd} disabled={loading || saving} className="text-xs">
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('settings:tool_permissions.shell_rules.add')}
        </NotionButton>
      </div>

      <div className="rounded-lg border border-border/40 bg-muted/10 p-3 mb-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">{t('settings:tool_permissions.shell_rules.default_title')}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t('settings:tool_permissions.shell_rules.default_desc')}</div>
          </div>
          <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5 self-start sm:self-auto" role="group" aria-label={t('settings:tool_permissions.shell_rules.default_title')}>
            {(['allow', 'ask', 'deny'] as ShellCommandAction[]).map(effect => (
              <NotionButton
                key={effect}
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => void handleDefaultEffect(effect)}
                aria-pressed={defaultEffect === effect}
                className={cn('!h-7 !px-2 text-xs', defaultEffect === effect && actionClass[effect])}
              >
                {t(`settings:tool_permissions.shell_rules.action_${effect}`)}
              </NotionButton>
            ))}
          </div>
        </div>
        {pendingDefaultAllow && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Warning className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1">{t('settings:tool_permissions.shell_rules.default_allow_warning')}</span>
            <NotionButton variant="ghost" size="sm" onClick={() => void handleDefaultEffect('allow')} className="!h-6 text-xs">
              {t('settings:tool_permissions.shell_rules.confirm_allow')}
            </NotionButton>
          </div>
        )}
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-md border border-border/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <Lock className="mt-px h-3.5 w-3.5 flex-shrink-0" />
        <span>{t('settings:tool_permissions.shell_rules.safety_boundary')}</span>
      </div>

      <div className="mb-3 rounded-lg border border-border/40 bg-muted/10 p-3">
        <div className="mb-2 text-xs font-medium text-foreground">{t('settings:tool_permissions.shell_rules.preview_title')}</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={previewCommand}
            onChange={event => setPreviewCommand(event.target.value)}
            placeholder={t('settings:tool_permissions.shell_rules.preview_placeholder')}
            aria-label={t('settings:tool_permissions.shell_rules.preview_title')}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          {preview && (
            <div className="flex min-h-8 items-center gap-2 text-xs sm:max-w-[45%]">
              <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px]', actionClass[preview.effect])}>
                {t(`settings:tool_permissions.shell_rules.action_${preview.effect}`)}
              </span>
              <span className="truncate text-muted-foreground" title={preview.matchedRule?.pattern}>
                {preview.matchedRule
                  ? t('settings:tool_permissions.shell_rules.preview_matched', { pattern: preview.matchedRule.pattern })
                  : t('settings:tool_permissions.shell_rules.preview_default')}
              </span>
            </div>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t('settings:tool_permissions.shell_rules.preview_hint')}</p>
      </div>

      {showEditor && (
        <div className="mb-3 rounded-lg border border-primary/20 bg-primary/[0.025] p-3">
          <div className="mb-2 text-xs font-medium text-foreground">
            {t(editingId ? 'settings:tool_permissions.shell_rules.edit_title' : 'settings:tool_permissions.shell_rules.add_title')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[8rem_10rem_minmax(12rem,1fr)] gap-2">
            <Select value={draft.action} onValueChange={value => { setDraft(prev => ({ ...prev, action: value as ShellCommandAction })); setPendingRisk(null); }}>
              <SelectTrigger className="h-8 text-xs" aria-label={t('settings:tool_permissions.shell_rules.effect_label')}><SelectValue /></SelectTrigger>
              <SelectContent>{(['allow', 'ask', 'deny'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.action_${value}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={draft.matchType} onValueChange={value => { setDraft(prev => ({ ...prev, matchType: value as ShellCommandMatchType })); setDraftError(null); setPendingRisk(null); }}>
              <SelectTrigger className="h-8 text-xs" aria-label={t('settings:tool_permissions.shell_rules.match_label')}><SelectValue /></SelectTrigger>
              <SelectContent>{(['exact', 'prefix', 'executable'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.match_${value}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Input
              value={draft.pattern}
              onChange={event => { setDraft(prev => ({ ...prev, pattern: event.target.value })); setDraftError(null); setPendingRisk(null); }}
              placeholder={t(`settings:tool_permissions.shell_rules.placeholder_${draft.matchType}`)}
              aria-label={t('settings:tool_permissions.shell_rules.pattern_label')}
              className="h-8 text-xs font-mono"
              autoFocus
            />
          </div>
          <Input value={draft.note} onChange={event => setDraft(prev => ({ ...prev, note: event.target.value }))} placeholder={t('settings:tool_permissions.shell_rules.note_placeholder')} aria-label={t('settings:tool_permissions.shell_rules.note_label')} className="mt-2 h-8 text-xs" />
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t(`settings:tool_permissions.shell_rules.help_${draft.matchType}`)}</p>
          {draftError && <p className="mt-2 text-xs text-destructive">{t(`settings:tool_permissions.shell_rules.error_${draftError}`)}</p>}
          {pendingRisk && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              <Warning className="mt-px h-3.5 w-3.5 flex-shrink-0" />
              <span>{t('settings:tool_permissions.shell_rules.broad_allow_warning')}</span>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <NotionButton variant="ghost" size="sm" onClick={() => { setShowEditor(false); setPendingRisk(null); }} className="text-xs">{t('common:cancel')}</NotionButton>
            <NotionButton variant="default" size="sm" onClick={() => void saveDraft()} disabled={saving} className="text-xs">
              {t(pendingRisk ? 'settings:tool_permissions.shell_rules.confirm_allow' : 'common:save')}
            </NotionButton>
          </div>
        </div>
      )}

      {loading ? <div className="h-24 rounded-lg bg-muted/20 animate-pulse" /> : rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 py-6 text-center">
          <CodeBlock className="mx-auto mb-2 h-5 w-5 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{t('settings:tool_permissions.shell_rules.empty')}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">{t('settings:tool_permissions.shell_rules.empty_hint')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(10rem,1fr)_9rem_10rem] gap-2 mb-2">
            <div className="relative"><MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings:tool_permissions.shell_rules.search')} aria-label={t('settings:tool_permissions.shell_rules.search')} className="h-8 pl-8 text-xs" /></div>
            <Select value={actionFilter} onValueChange={value => setActionFilter(value as ShellCommandAction | 'all')}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('settings:tool_permissions.shell_rules.all_effects')}</SelectItem>{(['allow', 'ask', 'deny'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.action_${value}`)}</SelectItem>)}</SelectContent></Select>
            <Select value={typeFilter} onValueChange={value => setTypeFilter(value as ShellCommandMatchType | 'all')}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('settings:tool_permissions.shell_rules.all_matches')}</SelectItem>{(['exact', 'prefix', 'executable'] as const).map(value => <SelectItem key={value} value={value}>{t(`settings:tool_permissions.shell_rules.match_${value}`)}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2">
            <Checkbox
                      checked={allVisibleSelected ? true : selectedRuleIds.size > 0 ? 'indeterminate' : false}
              onCheckedChange={checked => selectVisibleRules(checked === true)}
              aria-label={t('settings:tool_permissions.shell_rules.select_visible')}
            />
            <span className="text-[11px] text-muted-foreground">
              {selectedRuleIds.size > 0
                ? t('settings:tool_permissions.shell_rules.selected_count', { count: selectedRuleIds.size })
                : t('settings:tool_permissions.shell_rules.select_visible')}
            </span>
            {selectedRuleIds.size > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <NotionButton variant="ghost" size="sm" disabled={saving} onClick={() => void updateSelectedRules('enable')} className="!h-7 text-xs">{t('settings:tool_permissions.shell_rules.bulk_enable')}</NotionButton>
                <NotionButton variant="ghost" size="sm" disabled={saving} onClick={() => void updateSelectedRules('disable')} className="!h-7 text-xs">{t('settings:tool_permissions.shell_rules.bulk_disable')}</NotionButton>
                <NotionButton variant="ghost" size="sm" disabled={saving} onClick={() => void updateSelectedRules('delete')} className="!h-7 text-xs text-destructive">{t('settings:tool_permissions.shell_rules.bulk_delete')}</NotionButton>
              </div>
            )}
          </div>
          {filteredRules.length === 0 ? <div className="rounded-md border border-dashed border-border/50 py-5 text-center text-xs text-muted-foreground">{t('settings:tool_permissions.shell_rules.no_matches')}</div> : (
            <div className="overflow-hidden rounded-lg border border-border/40 divide-y divide-border/30">
              {filteredRules.map(rule => {
                const risk = assessShellCommandRuleRisk(rule);
                return <div key={rule.id} className={cn('flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5', !rule.enabled && 'opacity-60')}>
                  <Checkbox
                    checked={selectedRuleIds.has(rule.id)}
                    onCheckedChange={checked => setSelectedRuleIds(previous => {
                      const next = new Set(previous);
                      if (checked === true) next.add(rule.id); else next.delete(rule.id);
                      return next;
                    })}
                    aria-label={t('settings:tool_permissions.shell_rules.select_rule', { pattern: rule.pattern })}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="break-all text-xs font-medium text-foreground">{rule.pattern}</code>
                      <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', actionClass[rule.action])}>{t(`settings:tool_permissions.shell_rules.action_${rule.action}`)}</span>
                      <span className="rounded border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">{t(`settings:tool_permissions.shell_rules.match_${rule.matchType}`)}</span>
                      {risk && <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"><Warning className="h-3 w-3" />{t('settings:tool_permissions.shell_rules.broad_badge')}</span>}
                    </div>
                    {rule.note && <p className="mt-1 truncate text-[11px] text-muted-foreground" title={rule.note}>{rule.note}</p>}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Switch checked={rule.enabled} disabled={saving} onCheckedChange={enabled => void setRuleEnabled(rule, enabled)} aria-label={t('settings:tool_permissions.shell_rules.toggle_rule', { pattern: rule.pattern })} />
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => beginEdit(rule)} className="!h-7 !w-7" title={t('common:actions.edit')} aria-label={t('common:actions.edit')}><PencilSimple className="h-3.5 w-3.5" /></NotionButton>
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => void deleteRule(rule)} className="!h-7 !w-7 text-muted-foreground hover:text-destructive" title={t('common:delete')} aria-label={t('common:delete')}><Trash className="h-3.5 w-3.5" /></NotionButton>
                  </div>
                </div>;
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 工具权限管理区域 - 非折叠，直接展示 */
function ToolPermissionsSection({ toolsByServer }: {
  toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [globalBypass, setGlobalBypass] = useState(false);
  const [toolOverrides, setToolOverrides] = useState<ToolOverrideEntry[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<Map<string, SensitivityLevel>>(new Map());
  const [domainOverrides, setDomainOverrides] = useState<Map<string, SensitivityLevel>>(new Map());
  const [historyCount, setHistoryCount] = useState(0);
  const [runtimeRoots, setRuntimeRoots] = useState<RuntimeRootEntry[]>([]);
  const [newRuntimeRootPath, setNewRuntimeRootPath] = useState('');
  const [workspaceAccess, setWorkspaceAccess] = useState<'read_only' | 'read_write'>('read_only');
  const [isSavingRuntimeRoot, setIsSavingRuntimeRoot] = useState(false);
  const [toolSearch, setToolSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState<ToolLevelFilter>('all');
  const [overrideFilter, setOverrideFilter] = useState<ToolOverrideFilter>('all');
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [groupMode, setGroupMode] = useState<'domain' | 'source'>('domain');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  /** 待确认的高风险授权（两步确认：第一次点添加只显示警示，再点才真正授权） */
  const [pendingRootRisk, setPendingRootRisk] = useState<Exclude<AuthorizedRootRisk, 'safe'> | null>(null);
  const runtimeRootInputRef = useRef<HTMLInputElement>(null);

  /** 每个来源/工具对都是独立权限主体，同名工具不会跨服务串权。 */
  const allTools = useMemo(
    () => buildManagedPermissionTools(toolsByServer),
    [toolsByServer]
  );

  useEffect(() => {
    const validIds = new Set(allTools.map(tool => tool.id));
    setSelectedTools(prev => new Set(Array.from(prev).filter(id => validIds.has(id))));
  }, [allTools]);

  const overrideMap = useMemo(
    () => new Map(toolOverrides.map(override => [override.toolName, override.level])),
    [toolOverrides]
  );
  const toolById = useMemo(
    () => new Map(allTools.map(tool => [tool.id, tool])),
    [allTools]
  );

  const resolveConfiguredPolicy = useCallback((tool: ManagedPermissionTool) => {
    const direct = resolveToolOverrideEntry(tool, overrideMap);
    if (direct) return { level: direct.level, origin: direct.scoped ? 'tool' : 'legacy' } as const;
    const sourceLevel = sourceOverrides.get(tool.source);
    if (sourceLevel) return { level: sourceLevel, origin: 'source' } as const;
    const domainLevel = domainOverrides.get(tool.domain);
    if (domainLevel) return { level: domainLevel, origin: 'domain' } as const;
    if (globalBypass) return { level: 'low' as const, origin: 'global' } as const;
    return { level: null, origin: 'default' } as const;
  }, [domainOverrides, globalBypass, overrideMap, sourceOverrides]);

  const effectiveLevelMap = useMemo(() => {
    const levels = new Map<string, SensitivityLevel>();
    for (const tool of allTools) {
      const level = resolveConfiguredPolicy(tool).level;
      if (level) levels.set(tool.id, level);
    }
    return levels;
  }, [allTools, resolveConfiguredPolicy]);

  const availableSources = useMemo(() => (
    Array.from(new Set(allTools.map(tool => tool.source))).sort((a, b) => a.localeCompare(b))
  ), [allTools]);

  const filteredTools = useMemo(() => filterManagedPermissionTools(allTools, effectiveLevelMap, {
    query: toolSearch,
    source: sourceFilter,
    level: levelFilter,
    override: overrideFilter,
  }, overrideMap), [allTools, effectiveLevelMap, levelFilter, overrideFilter, overrideMap, sourceFilter, toolSearch]);

  useEffect(() => {
    setSelectedTools(new Set());
  }, [levelFilter, overrideFilter, sourceFilter, toolSearch]);

  const capabilityGroups = useMemo(() => TOOL_CAPABILITIES
    .map(capability => ({
      capability,
      tools: filteredTools.filter(tool => tool.capability === capability),
    }))
    .filter(group => group.tools.length > 0), [filteredTools]);

  /** 从后端加载所有权限配置 */
  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await invoke<[string, string, string][]>('get_settings_by_prefix', {
        prefix: 'tool_approval.',
      });
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_list_runtime_roots').catch((err) => {
        console.error('[ToolPermissions] Failed to load runtime roots:', err);
        return [] as RuntimeRootEntry[];
      });

      let bypass = false;
      const overrides: ToolOverrideEntry[] = [];
      const sources = new Map<string, SensitivityLevel>();
      const domains = new Map<string, SensitivityLevel>();
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
        } else if (key.startsWith('tool_approval.source.')) {
          const source = key.slice('tool_approval.source.'.length);
          if (source && ['low', 'medium', 'high'].includes(value)) {
            sources.set(source, value as SensitivityLevel);
          }
        } else if (key.startsWith('tool_approval.domain.')) {
          const domain = key.slice('tool_approval.domain.'.length);
          if (domain && ['low', 'medium', 'high'].includes(value)) {
            domains.set(domain, value as SensitivityLevel);
          }
        } else if (key.startsWith('tool_approval.scope.')) {
          histCount++;
        }
      }

      setGlobalBypass(bypass);
      setToolOverrides(overrides);
      setSourceOverrides(sources);
      setDomainOverrides(domains);
      setHistoryCount(histCount);
      setRuntimeRoots(roots);
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
  const handleToggleGlobalBypass = useCallback(async (checked: boolean) => {
    const newVal = checked;
    // eslint-disable-next-line no-alert -- enabling a broad policy requires impact confirmation
    if (newVal && !window.confirm(t('settings:tool_permissions.bypass_enable_confirm', { count: allTools.length }))) return;
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
  }, [allTools.length, t]);

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

  /** 批量更新沿用现有单工具设置键，支持能力域和多选操作。 */
  const handleBulkOverride = useCallback(async (
    toolIds: string[],
    level: SensitivityLevel | null
  ) => {
    const ids = Array.from(new Set(toolIds));
    if (ids.length === 0 || isBulkUpdating) return;
    if (level === 'low' && ids.length > 1) {
      // eslint-disable-next-line no-alert -- lowering multiple tools reduces routine approvals
      if (!window.confirm(t('settings:tool_permissions.bulk_low_confirm', { count: ids.length }))) return;
    }
    const settingKeys = level
      ? ids.map(id => `tool_approval.override.${id}`)
      : selectedOverrideKeysForReset(allTools, new Set(ids), overrideMap);
    if (settingKeys.length === 0) return;
    setIsBulkUpdating(true);
    try {
      const results = await Promise.allSettled(settingKeys.map(key => {
        return level
          ? invoke('save_setting', { key, value: level })
          : invoke('delete_setting', { key });
      }));
      const succeededKeys = settingKeys.filter((_, index) => results[index].status === 'fulfilled');
      const failedKeys = new Set(settingKeys.filter((_, index) => results[index].status === 'rejected'));
      const succeededIds = succeededKeys.map(key => key.slice('tool_approval.override.'.length));
      const succeededSet = new Set(succeededIds);
      setToolOverrides(prev => {
        const unchanged = prev.filter(override => !succeededSet.has(override.toolName));
        if (!level) return unchanged;
        return [
          ...unchanged,
          ...succeededIds.map(toolName => ({
            toolName,
            displayName: stripMcpPrefix(toolName),
            level,
          })),
        ];
      });
      setSelectedTools(prev => {
        const next = new Set(prev);
        for (const id of ids) {
          const expectedKey = level
            ? `tool_approval.override.${id}`
            : (() => {
                const tool = toolById.get(id);
                const entry = tool ? resolveToolOverrideEntry(tool, overrideMap) : null;
                return entry ? `tool_approval.override.${entry.id}` : null;
              })();
          if (expectedKey && !failedKeys.has(expectedKey)) next.delete(id);
        }
        return next;
      });
      if (succeededKeys.length !== settingKeys.length) {
        showGlobalNotification('error', t('settings:tool_permissions.bulk_partial_failed', {
          success: succeededKeys.length,
          total: settingKeys.length,
        }));
      } else {
        showGlobalNotification('success', t('settings:tool_permissions.bulk_updated', {
          count: level ? ids.length : succeededKeys.length,
        }));
      }
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allTools, isBulkUpdating, overrideMap, t, toolById]);

  const handleSetGroupOverride = useCallback(async (
    kind: 'source' | 'domain',
    group: string,
    level: SensitivityLevel | null
  ) => {
    if (isBulkUpdating) return;
    const affectedCount = allTools.filter(tool => (
      kind === 'source' ? tool.source === group : tool.domain === group
    )).length;
    if (level === 'low') {
      // eslint-disable-next-line no-alert -- lowering an entire group requires impact confirmation
      if (!window.confirm(t('settings:tool_permissions.group_low_confirm', { count: affectedCount }))) return;
    }
    const key = `tool_approval.${kind}.${group}`;
    setIsBulkUpdating(true);
    try {
      if (level) await invoke('save_setting', { key, value: level });
      else await invoke('delete_setting', { key });
      const setMap = kind === 'source' ? setSourceOverrides : setDomainOverrides;
      setMap(prev => {
        const next = new Map(prev);
        if (level) next.set(group, level);
        else next.delete(group);
        return next;
      });
      showGlobalNotification('success', t('settings:tool_permissions.group_updated'));
    } catch (err) {
      console.error('[ToolPermissions] Set group override failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allTools, isBulkUpdating, t]);

  const toggleToolSelection = useCallback((toolName: string, selected: boolean) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      if (selected) next.add(toolName);
      else next.delete(toolName);
      return next;
    });
  }, []);

  const selectVisibleTools = useCallback((selected: boolean) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      for (const tool of filteredTools) {
        if (selected) next.add(tool.id);
        else next.delete(tool.id);
      }
      return next;
    });
  }, [filteredTools]);

  /** 清除所有历史审批记录（DB + 内存） */
  const handleClearHistory = useCallback(async () => {
    // eslint-disable-next-line no-alert -- 破坏性操作需要阻塞式确认，待统一 confirm 组件落地后替换
    if (!window.confirm(t('settings:tool_permissions.clear_history_confirm'))) return;
    try {
      // 🔧 R2-H2 修复：调用统一命令，同时清内存 + DB。
      // 旧实现 `delete_settings_by_prefix` 只清 DB，ApprovalManager 内存 HashMap
      // 还留着，未重启进程期间前面的批准继续自动通过，违背"清除"承诺。
      const result = await invoke<number>('chat_v2_clear_approval_history');
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

  const handleAuthorizeRuntimeRoot = useCallback(async () => {
    const path = newRuntimeRootPath.trim();
    if (!path || isSavingRuntimeRoot) return;
    // 高风险目录两步确认：第一次提交只展示内联警示（不阻止授权），再次提交才真正执行
    const risk = assessAuthorizedRootRisk(path);
    if (risk !== 'safe' && pendingRootRisk === null) {
      setPendingRootRisk(risk);
      return;
    }
    setIsSavingRuntimeRoot(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_authorize_runtime_root', { path });
      setRuntimeRoots(roots);
      setNewRuntimeRootPath('');
      setPendingRootRisk(null);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_added'));
    } catch (err) {
      console.error('[ToolPermissions] Authorize runtime root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_add_failed'));
    } finally {
      setIsSavingRuntimeRoot(false);
    }
  }, [isSavingRuntimeRoot, newRuntimeRootPath, pendingRootRisk, t]);

  const handleSetWorkspaceRoot = useCallback(async () => {
    const path = newRuntimeRootPath.trim();
    if (!path || isSavingRuntimeRoot) return;
    setIsSavingRuntimeRoot(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_set_workspace_root', {
        path,
        access: workspaceAccess,
      });
      setRuntimeRoots(roots);
      setNewRuntimeRootPath('');
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_workspace_set'));
    } catch (err) {
      console.error('[ToolPermissions] Set workspace root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_workspace_set_failed'));
    } finally {
      setIsSavingRuntimeRoot(false);
    }
  }, [isSavingRuntimeRoot, newRuntimeRootPath, t, workspaceAccess]);

  const handleResetWorkspaceRoot = useCallback(async () => {
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_reset_workspace_root');
      setRuntimeRoots(roots);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_workspace_reset_done'));
    } catch (err) {
      console.error('[ToolPermissions] Reset workspace root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_workspace_reset_failed'));
    }
  }, [t]);

  const handleRevokeRuntimeRoot = useCallback(async (rootId: string) => {
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_revoke_runtime_root', { rootId });
      setRuntimeRoots(roots);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_removed'));
    } catch (err) {
      console.error('[ToolPermissions] Revoke runtime root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_remove_failed'));
    }
  }, [t]);

  /** 「立即设置」引导：滚动并聚焦到已有的路径输入框（旁边就是浏览按钮） */
  const handleFocusRuntimeRootInput = useCallback(() => {
    const input = runtimeRootInputRef.current;
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }, []);

  /** 打开系统目录选择器，把选中的目录填入路径输入框 */
  const handleBrowseRuntimeRoot = useCallback(async () => {
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: t('settings:tool_permissions.runtime_root_browse_title'),
      });
      if (typeof selected === 'string' && selected.trim()) {
        setNewRuntimeRootPath(selected);
        setPendingRootRisk(null);
      }
    } catch (err) {
      console.error('[ToolPermissions] Browse runtime root failed:', err);
    }
  }, [t]);

  /** 高风险警示的「重新选择」：清空输入并重开目录选择器 */
  const handleReselectRuntimeRoot = useCallback(() => {
    setPendingRootRisk(null);
    setNewRuntimeRootPath('');
    void handleBrowseRuntimeRoot();
  }, [handleBrowseRuntimeRoot]);

  /** 按钮组：等级选择器 */
  const LevelSelector = useCallback(({ toolName, currentLevel, resetOverrideId }: {
    toolName: string;
    currentLevel: SensitivityLevel | null;
    resetOverrideId?: string;
  }) => {
    const levels: SensitivityLevel[] = ['low', 'medium', 'high'];
    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.level_filter')}>
        {levels.map(level => {
          const isActive = currentLevel === level;
          const config = SENSITIVITY_CONFIG[level];
          return (
            <NotionButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={isActive}
              onClick={() => {
                if (isActive) {
                  handleRemoveOverride(resetOverrideId ?? toolName);
                } else {
                  handleSetOverride(toolName, level);
                }
              }}
              className={cn(
                '!h-auto !px-2 !py-0.5 text-xs font-medium',
                isActive
                  ? config.badge
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
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
  }, [handleSetOverride, handleRemoveOverride, isBulkUpdating, t]);

  const BulkLevelSelector = useCallback(({ toolNames }: { toolNames: string[] }) => {
    const configuredLevels = toolNames.map(id => {
      const tool = toolById.get(id);
      return tool ? resolveToolOverride(tool, overrideMap) : null;
    });
    const firstLevel = configuredLevels[0] ?? null;
    const sharedLevel = configuredLevels.every(level => level === firstLevel) ? firstLevel : null;
    const allInherited = configuredLevels.every(level => level === null);
    const levels: Array<SensitivityLevel | 'default'> = ['default', 'low', 'medium', 'high'];

    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.bulk_level_label')}>
        {levels.map(level => {
          const active = level === 'default' ? allInherited : sharedLevel === level;
          return (
            <NotionButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={active}
              onClick={() => void handleBulkOverride(toolNames, level === 'default' ? null : level)}
              className={cn(
                '!h-6 !px-1.5 text-[11px] font-medium',
                active && level === 'default' && 'bg-background text-foreground shadow-sm',
                active && level !== 'default' && SENSITIVITY_CONFIG[level].badge,
                !active && 'text-muted-foreground hover:text-foreground'
              )}
              title={level === 'default'
                ? t('settings:tool_permissions.reset_group_to_default')
                : t(`settings:tool_permissions.set_group_to_${level}`)}
            >
              {level === 'default'
                ? t('settings:tool_permissions.level_default')
                : t(`settings:tool_permissions.level_${level}`)}
            </NotionButton>
          );
        })}
      </div>
    );
  }, [handleBulkOverride, isBulkUpdating, overrideMap, t, toolById]);

  const GroupLevelSelector = useCallback(({ kind, group, currentLevel }: {
    kind: 'source' | 'domain';
    group: string;
    currentLevel: SensitivityLevel | null;
  }) => {
    const levels: Array<SensitivityLevel | 'default'> = ['default', 'low', 'medium', 'high'];
    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.group_level_label', { group })}>
        {levels.map(level => {
          const active = level === 'default' ? currentLevel === null : currentLevel === level;
          return (
            <NotionButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={active}
              onClick={() => void handleSetGroupOverride(kind, group, level === 'default' ? null : level)}
              className={cn(
                '!h-6 !px-1.5 text-[11px] font-medium',
                active && level === 'default' && 'bg-background text-foreground shadow-sm',
                active && level !== 'default' && SENSITIVITY_CONFIG[level].badge,
                !active && 'text-muted-foreground hover:text-foreground'
              )}
            >
              {level === 'default'
                ? t('settings:tool_permissions.level_default')
                : t(`settings:tool_permissions.level_${level}`)}
            </NotionButton>
          );
        })}
      </div>
    );
  }, [handleSetGroupOverride, isBulkUpdating, t]);

  const selectedVisibleCount = filteredTools.filter(tool => selectedTools.has(tool.id)).length;
  const allVisibleSelected = filteredTools.length > 0 && selectedVisibleCount === filteredTools.length;
  const configuredToolCount = allTools.filter(tool => resolveConfiguredPolicy(tool).level !== null).length;
  const policyGroups = useMemo(() => {
    const groups = new Map<string, ManagedPermissionTool[]>();
    for (const tool of allTools) {
      const key = groupMode === 'source' ? tool.source : tool.domain;
      const groupTools = groups.get(key) ?? [];
      groupTools.push(tool);
      groups.set(key, groupTools);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [allTools, groupMode]);

  return (
    <div className="mt-8 min-w-0 max-w-full pt-6 border-t border-border/40">
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
          <div
            className={cn(
              'p-4 rounded-lg border transition-colors duration-200',
              globalBypass
                ? 'border-primary/30 bg-primary/5'
                : 'border-border/40 bg-muted/20 hover:border-border/60'
            )}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1 mr-4">
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
              <Switch
                checked={globalBypass}
                onCheckedChange={handleToggleGlobalBypass}
                aria-label={t('settings:tool_permissions.global_bypass_title')}
                title={t('settings:tool_permissions.global_bypass_title')}
                className="data-[state=unchecked]:bg-[color:var(--surface-panel-strong)] data-[state=unchecked]:ring-1 data-[state=unchecked]:ring-[color:var(--button-utility-border)] data-[state=checked]:shadow-[0_0_0_1px_var(--button-primary-border)]"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <Lock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('settings:tool_permissions.runtime_roots_title')}
                </h4>
                <span className="text-xs text-muted-foreground">
                  ({runtimeRoots.length})
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-3">
              {t('settings:tool_permissions.runtime_roots_desc')}
            </p>

            <div className="mb-3 flex min-w-0 flex-col lg:flex-row gap-2">
              <Input
                ref={runtimeRootInputRef}
                value={newRuntimeRootPath}
                onChange={(event) => {
                  setNewRuntimeRootPath(event.target.value);
                  setPendingRootRisk(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAuthorizeRuntimeRoot();
                  }
                }}
                placeholder={t('settings:tool_permissions.runtime_root_path_placeholder')}
                className="h-8 min-w-0 text-xs font-mono lg:basis-0 lg:flex-1"
              />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                  value={workspaceAccess}
                  onValueChange={(value) => setWorkspaceAccess(value as 'read_only' | 'read_write')}
                >
                  <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label={t('settings:tool_permissions.runtime_root_workspace_access')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_only">{t('settings:tool_permissions.runtime_root_read_only')}</SelectItem>
                    <SelectItem value="read_write">{t('settings:tool_permissions.runtime_root_read_write')}</SelectItem>
                  </SelectContent>
                </Select>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleBrowseRuntimeRoot}
                  disabled={isSavingRuntimeRoot}
                  className="text-xs flex-shrink-0"
                >
                  <FolderOpen className="h-3 w-3 mr-1" />
                  {t('settings:tool_permissions.runtime_root_browse')}
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleSetWorkspaceRoot}
                  disabled={!newRuntimeRootPath.trim() || isSavingRuntimeRoot}
                  className="text-xs flex-shrink-0"
                >
                  <Check className="h-3 w-3 mr-1" />
                  {t('settings:tool_permissions.runtime_root_set_workspace')}
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleAuthorizeRuntimeRoot}
                  disabled={!newRuntimeRootPath.trim() || isSavingRuntimeRoot}
                  className={cn(
                    'text-xs flex-shrink-0',
                    pendingRootRisk && 'text-amber-700 dark:text-amber-300'
                  )}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {t(pendingRootRisk
                    ? 'settings:tool_permissions.runtime_root_confirm_add'
                    : 'settings:tool_permissions.runtime_root_add')}
                </NotionButton>
              </div>
            </div>

            {workspaceAccess === 'read_write' && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                <Warning className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{t('settings:tool_permissions.runtime_root_workspace_write_warning')}</span>
              </div>
            )}

            {pendingRootRisk && (
              <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                <div className="flex items-start gap-2">
                  <Warning className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span>
                      {pendingRootRisk === 'critical'
                        ? t('settings:tool_permissions.runtime_root_risk_critical', { path: newRuntimeRootPath.trim() })
                        : t('settings:tool_permissions.runtime_root_risk_broad', {
                            folder: newRuntimeRootPath.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()
                              ?? newRuntimeRootPath.trim(),
                          })}
                    </span>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={handleReselectRuntimeRoot}
                      className="!h-auto !px-1 !py-0 ml-1 align-baseline text-xs font-medium text-primary hover:underline"
                    >
                      {t('settings:tool_permissions.runtime_root_reselect')}
                    </NotionButton>
                  </div>
                </div>
              </div>
            )}

            {runtimeRoots.length === 0 ? (
              <div className="text-center py-5 rounded-lg border border-dashed border-border/60 bg-muted/5">
                <Lock className="h-5 w-5 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t('settings:tool_permissions.runtime_roots_empty')}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/80 leading-relaxed px-4">
                  {t('settings:tool_permissions.runtime_roots_authorized_empty_hint')}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border/30 bg-muted/5 overflow-hidden">
                <div className="divide-y divide-border/30">
                  {runtimeRoots.map((root) => {
                    const isReadWrite = root.access === 'read_write';
                    const canRevoke = root.kind === 'authorized';
                    const canResetWorkspace = root.kind === 'workspace' && root.configured;
                    const displayKind = t(
                      `settings:tool_permissions.runtime_root_kind.${root.kind}`,
                      root.kind.replace(/_/g, ' '),
                    );
                    return (
                      <div key={root.id} className="px-3 py-2.5 flex items-start gap-3">
                        <div className="mt-0.5 h-7 w-7 rounded-md bg-muted/40 border border-border/30 flex items-center justify-center flex-shrink-0">
                          {root.kind === 'artifact' || root.kind === 'temp' ? (
                            <Package className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground truncate">
                              {root.label || root.id}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/40 capitalize">
                              {displayKind}
                            </span>
                            <span
                              className="inline-block max-w-[12rem] truncate text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground border border-border/30 font-mono normal-case"
                              title={root.id}
                            >
                              {root.id}
                            </span>
                            <span
                              className={cn(
                                'text-[10px] px-1.5 py-0.5 rounded border',
                                isReadWrite
                                  ? 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-900/50'
                                  : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-900/50'
                              )}
                            >
                              {t(isReadWrite
                                ? 'settings:tool_permissions.runtime_root_read_write'
                                : 'settings:tool_permissions.runtime_root_read_only')}
                            </span>
                            {root.session_scoped && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                                {t('settings:tool_permissions.runtime_root_session_scoped')}
                              </span>
                            )}
                            {root.kind === 'workspace' && root.configured && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                                {t('settings:tool_permissions.runtime_root_configured')}
                              </span>
                            )}
                            {root.kind === 'workspace' && !root.configured && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-900/50">
                                <Warning className="h-3 w-3" />
                                {t('settings:tool_permissions.runtime_root_not_configured')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={root.path}>
                            {root.path}
                          </div>
                          {root.description && (
                            <div className="mt-1 text-[11px] text-muted-foreground/80 leading-relaxed">
                              {root.description}
                            </div>
                          )}
                          {root.kind === 'workspace' && !root.configured && (
                            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-relaxed text-yellow-700 dark:text-yellow-400">
                              <span>{t('settings:tool_permissions.runtime_root_not_configured_hint')}</span>
                              <NotionButton
                                variant="ghost"
                                size="sm"
                                onClick={handleFocusRuntimeRootInput}
                                className="!h-auto !px-1 !py-0 text-[11px] font-medium text-primary hover:underline"
                              >
                                {t('settings:tool_permissions.runtime_root_configure_now')}
                              </NotionButton>
                            </div>
                          )}
                        </div>
                        {canRevoke && (
                          <NotionButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            onClick={() => handleRevokeRuntimeRoot(root.id)}
                            className="!h-7 !w-7 text-muted-foreground hover:text-destructive flex-shrink-0"
                            title={t('settings:tool_permissions.runtime_root_remove')}
                            aria-label={t('settings:tool_permissions.runtime_root_remove')}
                          >
                            <Trash className="h-3.5 w-3.5" />
                          </NotionButton>
                        )}
                        {canResetWorkspace && (
                          <NotionButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            onClick={handleResetWorkspaceRoot}
                            className="!h-7 !w-7 text-muted-foreground flex-shrink-0"
                            title={t('settings:tool_permissions.runtime_root_workspace_reset')}
                            aria-label={t('settings:tool_permissions.runtime_root_workspace_reset')}
                          >
                            <ArrowClockwise className="h-3.5 w-3.5" />
                          </NotionButton>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {runtimeRoots.length > 0 && !runtimeRoots.some((root) => root.kind === 'authorized') && (
              <p className="mt-2 text-[11px] text-muted-foreground/80 leading-relaxed">
                {t('settings:tool_permissions.runtime_roots_authorized_empty_hint')}
              </p>
            )}
          </div>

          <ShellCommandRulesSection />

          {/* 2. 工具策略：默认展示能力域，单工具覆盖收进高级管理。 */}
          <div>
            <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Stack className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t('settings:tool_permissions.policy_overview_title')}
                  </h4>
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  {t('settings:tool_permissions.policy_overview_desc')}
                </p>
              </div>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={fetchConfig}
                disabled={isLoading || isBulkUpdating}
                className="text-xs flex-shrink-0"
              >
                <ArrowClockwise className={cn('h-3 w-3 mr-1', (isLoading || isBulkUpdating) && 'animate-spin')} />
                {t('settings:tool_permissions.refresh')}
              </NotionButton>
            </div>

            {allTools.length === 0 ? (
              <div className="text-center py-6 rounded-lg border border-dashed border-border/60 bg-muted/5">
                <Shield className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t('settings:tool_permissions.no_tools')}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 border-y border-border/30 mb-3">
                  <div className="py-2.5 pr-3">
                    <div className="text-base font-semibold tabular-nums">{allTools.length}</div>
                    <div className="text-[11px] text-muted-foreground">{t('settings:tool_permissions.summary_tools')}</div>
                  </div>
                  <div className="py-2.5 px-3 border-x border-border/30">
                    <div className="text-base font-semibold tabular-nums">{availableSources.length}</div>
                    <div className="text-[11px] text-muted-foreground">{t('settings:tool_permissions.summary_sources')}</div>
                  </div>
                  <div className="py-2.5 pl-3">
                    <div className="text-base font-semibold tabular-nums text-primary">{configuredToolCount}</div>
                    <div className="text-[11px] text-muted-foreground">{t('settings:tool_permissions.summary_overrides')}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-[11px] text-muted-foreground">{t('settings:tool_permissions.group_by')}</span>
                  <div className="flex items-center bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.group_by')}>
                    {(['domain', 'source'] as const).map(mode => (
                      <NotionButton
                        key={mode}
                        variant="ghost"
                        size="sm"
                        onClick={() => setGroupMode(mode)}
                        aria-pressed={groupMode === mode}
                        className={cn(
                          '!h-6 !px-2 text-[11px]',
                          groupMode === mode && 'bg-background text-foreground shadow-sm'
                        )}
                      >
                        {t(`settings:tool_permissions.group_by_${mode}`)}
                      </NotionButton>
                    ))}
                  </div>
                </div>

                <div className="rounded-md border border-border/40 divide-y divide-border/30 overflow-hidden">
                  {policyGroups.map(([group, tools]) => {
                    const overriddenCount = tools.filter(tool => resolveToolOverrideEntry(tool, overrideMap) !== null).length;
                    const currentLevel = groupMode === 'source'
                      ? sourceOverrides.get(group) ?? null
                      : domainOverrides.get(group) ?? null;
                    return (
                      <div key={group} className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors">
                        <div className="flex items-center min-w-0 flex-1 gap-2">
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground truncate" title={group}>
                              {groupMode === 'source' ? formatToolSource(group) : group}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {t('settings:tool_permissions.group_summary', {
                                count: tools.length,
                                overridden: overriddenCount,
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="self-end sm:self-auto flex-shrink-0">
                          <GroupLevelSelector kind={groupMode} group={group} currentLevel={currentLevel} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/80 leading-relaxed">
                  <Lock className="h-3.5 w-3.5 mt-px flex-shrink-0" />
                  <span>{t('settings:tool_permissions.dynamic_risk_hint')}</span>
                </div>

                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAdvancedTools(value => !value)}
                  className="mt-2 !px-1 text-xs"
                  aria-expanded={showAdvancedTools}
                >
                  <CaretRight className={cn('h-3.5 w-3.5 mr-1 transition-transform', showAdvancedTools && 'rotate-90')} />
                  {t('settings:tool_permissions.advanced_title')}
                  <span className="ml-1 text-muted-foreground">({toolOverrides.length})</span>
                </NotionButton>

                {showAdvancedTools && (
                  <div className="mt-3 border-t border-border/30 pt-3">
                    <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                      <Funnel className="h-3.5 w-3.5" />
                      <span>{t('settings:tool_permissions.filters_title')}</span>
                      <span className="ml-auto tabular-nums">
                        {t('settings:tool_permissions.filtered_count', { count: filteredTools.length })}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1fr)_10rem_9rem_9rem] gap-2 mb-3">
                      <div className="relative">
                        <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                        <Input
                          value={toolSearch}
                          onChange={event => setToolSearch(event.target.value)}
                          placeholder={t('settings:tool_permissions.search_placeholder')}
                          aria-label={t('settings:tool_permissions.search_placeholder')}
                          className="h-8 pl-8 text-xs"
                        />
                      </div>
                      <Select value={sourceFilter} onValueChange={setSourceFilter}>
                        <SelectTrigger className="h-8 text-xs" aria-label={t('settings:tool_permissions.source_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.source_all')}</SelectItem>
                          {availableSources.map(source => (
                            <SelectItem key={source} value={source}>{formatToolSource(source)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={levelFilter} onValueChange={value => setLevelFilter(value as ToolLevelFilter)}>
                        <SelectTrigger className="h-8 text-xs" aria-label={t('settings:tool_permissions.level_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.level_all')}</SelectItem>
                          <SelectItem value="default">{t('settings:tool_permissions.level_default')}</SelectItem>
                          <SelectItem value="low">{t('settings:tool_permissions.level_low')}</SelectItem>
                          <SelectItem value="medium">{t('settings:tool_permissions.level_medium')}</SelectItem>
                          <SelectItem value="high">{t('settings:tool_permissions.level_high')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={overrideFilter} onValueChange={value => setOverrideFilter(value as ToolOverrideFilter)}>
                        <SelectTrigger className="h-8 text-xs" aria-label={t('settings:tool_permissions.override_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.override_all')}</SelectItem>
                          <SelectItem value="overridden">{t('settings:tool_permissions.override_only')}</SelectItem>
                          <SelectItem value="inherited">{t('settings:tool_permissions.inherited_only')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {filteredTools.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-muted/20 border border-border/30 rounded-t-md">
                        <Checkbox
                          checked={allVisibleSelected ? true : selectedVisibleCount > 0 ? 'indeterminate' : false}
                          onCheckedChange={checked => selectVisibleTools(checked === true)}
                          aria-label={t('settings:tool_permissions.select_visible')}
                        />
                        <span className="text-xs text-muted-foreground">
                          {selectedTools.size > 0
                            ? t('settings:tool_permissions.selected_count', { count: selectedTools.size })
                            : t('settings:tool_permissions.select_visible')}
                        </span>
                        {selectedTools.size > 0 && (
                          <>
                            <div className="ml-auto">
                              <BulkLevelSelector toolNames={Array.from(selectedTools)} />
                            </div>
                            <NotionButton
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedTools(new Set())}
                              className="!h-6 text-[11px]"
                            >
                              {t('settings:tool_permissions.clear_selection')}
                            </NotionButton>
                          </>
                        )}
                      </div>
                    )}

                    {filteredTools.length === 0 ? (
                      <div className="py-8 text-center border border-dashed border-border/50 rounded-md text-xs text-muted-foreground">
                        {t('settings:tool_permissions.no_matching_tools')}
                      </div>
                    ) : (
                      <CustomScrollArea
                        fullHeight={false}
                        className="border-x border-b border-border/30 rounded-b-md"
                        viewportProps={{ style: { maxHeight: 480 } }}
                      >
                        <div className="divide-y divide-border/20">
                          {capabilityGroups.flatMap(group => group.tools).map(tool => {
                            const overrideEntry = resolveToolOverrideEntry(tool, overrideMap);
                            const policy = resolveConfiguredPolicy(tool);
                            const statusKey = policy.origin === 'tool' || policy.origin === 'legacy'
                              ? 'status_overridden'
                              : `status_${policy.origin}`;
                            return (
                              <div
                                key={tool.id}
                                className={cn(
                                  'flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 transition-colors',
                                  overrideEntry ? 'bg-primary/[0.035]' : 'hover:bg-muted/20'
                                )}
                              >
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <Checkbox
                                    checked={selectedTools.has(tool.id)}
                                    onCheckedChange={checked => toggleToolSelection(tool.id, checked === true)}
                                    aria-label={t('settings:tool_permissions.select_tool', { name: tool.display })}
                                    className="mt-0.5"
                                  />
                                  <span className={cn(
                                    'mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0',
                                    policy.level ? SENSITIVITY_CONFIG[policy.level].dot : 'bg-muted-foreground/30'
                                  )} />
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <span className="text-sm text-foreground font-mono break-all" title={tool.name}>
                                        {tool.display}
                                      </span>
                                      <span className={cn(
                                        'text-[10px] px-1.5 py-0.5 rounded border',
                                        overrideEntry
                                          ? 'border-primary/20 bg-primary/5 text-primary'
                                          : 'border-border/40 text-muted-foreground'
                                      )}>
                                        {t(`settings:tool_permissions.${statusKey}`)}
                                      </span>
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-muted-foreground truncate" title={tool.description || tool.name}>
                                      {t(`settings:tool_permissions.capability_${tool.capability}`)}
                                      <span className="mx-1">·</span>
                                      {formatToolSource(tool.source)}
                                      {tool.description && <><span className="mx-1">·</span>{tool.description}</>}
                                    </div>
                                  </div>
                                </div>
                                <div className="self-end sm:self-auto flex-shrink-0">
                                  <LevelSelector
                                    toolName={tool.id}
                                    currentLevel={overrideEntry?.level ?? null}
                                    resetOverrideId={overrideEntry?.id}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CustomScrollArea>
                    )}
                  </div>
                )}
              </>
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
                <Trash className="h-3 w-3 mr-1" />
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
  testStep,
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

  // stdio 测试步骤 → 可读标签映射
  const testStepLabel = useMemo(() => {
    if (!testStep) return null;
    const map: Record<string, string> = {
      spawn_process: t('settings:mcp_test_steps.spawn_process'),
      connecting: t('settings:mcp_test_steps.connecting'),
      initializing: t('settings:mcp_test_steps.initializing'),
      listing_tools: t('settings:mcp_test_steps.listing_tools'),
      listing_prompts: t('settings:mcp_test_steps.listing_prompts'),
      listing_resources: t('settings:mcp_test_steps.listing_resources'),
      disconnecting: t('settings:mcp_test_steps.disconnecting'),
      done: t('settings:mcp_test_steps.done'),
    };
    return map[testStep] || testStep;
  }, [testStep, t]);

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
      <SettingSection title={t('settings:tabs.mcp_tools')} hideHeader className="min-w-0 max-w-full" contentClassName="min-w-0 max-w-full">
        <div className="space-y-4">
          <div className="grid min-w-0 gap-3 grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
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
    <SettingSection title={t('settings:tabs.mcp_tools')} description={t('settings:mcp_descriptions.section_description')} hideHeader className="min-w-0 max-w-full" contentClassName="min-w-0 max-w-full">
      <div className="min-w-0 max-w-full space-y-6">
        {/* 概览统计 - 紧凑的网格布局 */}
        <div className="grid min-w-0 gap-4 grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
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
              <WifiSlash className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{lastError}</span>
            </div>
          </div>
        )}

        {/* 操作栏 */}
        <div className="flex min-w-0 flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:justify-between">
          <h3 className="text-base font-medium text-foreground flex-shrink-0">{t('settings:mcp_server_list.server_list')}</h3>
          <div className="flex min-w-0 w-full flex-wrap items-center gap-1.5 sm:gap-2 lg:w-auto lg:justify-end">
            <ActionMenu
              onReconnect={onReconnect}
              onRefresh={onRefreshRegistry}
              onHealthCheck={onHealthCheck}
              onClearCache={onClearCache}
              onOpenPolicy={onOpenPolicy}
            />
            <PresetServerSelector
              existingServerIds={servers.map(s => s.id)}
              onAddPreset={(preset, options) => {
                const config = presetToMcpConfig(preset, options);
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
                    testStepLabel={testingServerId === server.id ? testStepLabel : null}
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
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Prompts */}
              <div className="space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:mcp_server_list.latest_prompts')}</div>
                <div className="space-y-2">
                  {prompts.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70 italic">{t('settings:mcp_server_list.none')}</span>
                  ) : (
                    prompts.items.slice(0, 5).map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md">
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
                      <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-md">
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
