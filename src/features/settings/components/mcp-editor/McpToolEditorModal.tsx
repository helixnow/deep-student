import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogFooter } from '@/components/ui/DsDialog';
import UnifiedModal from '@/components/UnifiedModal';
import { Input } from '@/components/ui/shad/Input';
import { AppSelect } from '@/components/ui/app-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';
import { ApiKeyField } from '../ApiKeyField';
import { UnifiedCodeEditor } from '@/components/shared/UnifiedCodeEditor';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { isTauriStdioSupported } from '@/mcp/tauriStdioTransport';
import { testMcpSseFrontend, testMcpHttpFrontend, testMcpWebsocketFrontend } from '@/mcp/mcpFrontendTester';
import {
  DEFAULT_STDIO_ARGS_PLACEHOLDER,
  resolveSettingsStdioFraming,
} from '../constants';
import { Trash } from '@phosphor-icons/react';
import { saveSetting } from '@/utils/settingsApi';
import { TauriAPI } from '@/utils/tauriApi';
import { isAndroid } from '@/utils/platform';
import type { UseMcpEditorSectionDeps, McpToolConfig } from '../hookDepsTypes';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { McpOAuthControls } from './McpOAuthControls';
import { invoke } from './runtime';
import { normalizeFrontendResult } from './utils';
import type { McpTestResult, McpToolModalState } from './types';

/** 桌面端 MCP 工具编辑模态的渲染所需的 useMcpEditorSection 作用域值 */
export interface McpToolEditorModalContext {
  config: UseMcpEditorSectionDeps['config'];
  setConfig: UseMcpEditorSectionDeps['setConfig'];
  isSmallScreen: boolean;
  t: UseMcpEditorSectionDeps['t'];
  mcpToolModal: McpToolModalState;
  setMcpToolModal: Dispatch<SetStateAction<McpToolModalState>>;
  showMcpApiKey: boolean;
  setShowMcpApiKey: Dispatch<SetStateAction<boolean>>;
  describeToolCount: (res: McpTestResult | null) => string;
  handleMcpTestResult: (res: McpTestResult | null, failureLabel: string) => boolean;
  handleMcpTestError: (error: unknown, failureLabel: string) => void;
  renderInfoPopover: (label: string, description: string) => ReactElement;
  refreshSnapshots: (options?: { reload?: boolean }) => Promise<void>;
}

export function renderMcpToolEditorModal({
  config, setConfig, isSmallScreen, t, mcpToolModal, setMcpToolModal, showMcpApiKey, setShowMcpApiKey,
  describeToolCount, handleMcpTestResult, handleMcpTestError, renderInfoPopover, refreshSnapshots,
}: McpToolEditorModalContext) {
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
    const config: Record<string, Record<string, Record<string, unknown>>> = { mcpServers: {} };
    const server: Record<string, unknown> = {};
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
      server.args = normalizedArgs;
      server.framing = resolveSettingsStdioFraming(draft.framing);
      if (draft.cwd) server.cwd = draft.cwd;
    }
    if (draft.apiKey) server.apiKey = draft.apiKey;
    else if (draft.oauth) server.oauth = draft.oauth;
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
    const merge = (source?: Record<string, unknown>) => {
      if (!source) return;
      Object.entries(source).forEach(([key, value]) => {
        if (value == null) return;
        headers[key] = typeof value === 'string' ? value : String(value);
      });
    };
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
      let toolToSave: McpToolConfig;
      if (mcpToolModal.mode === 'json') {
        try {
          const jsonConfig = JSON.parse(mcpToolModal.jsonInput || '{}') as Record<string, unknown>;
          if (jsonConfig?.mcpServers && typeof jsonConfig.mcpServers === 'object') {
            const entries = Object.entries(jsonConfig.mcpServers as Record<string, Record<string, unknown>>);
            const [serverName, serverConfig] = entries[0] ?? ['', {}];
            toolToSave = {
              id: draft.id || `mcp_${Date.now()}`,
              name: serverName || draft.name || t('common:unnamed_mcp_tool'),
              mcpServers: jsonConfig.mcpServers as Record<string, unknown>,
            };
            if (serverConfig?.type === 'sse' || serverConfig?.type === 'streamable_http') {
              toolToSave.transportType = serverConfig.type as 'sse' | 'streamable_http';
              toolToSave.fetch = { type: serverConfig.type as 'sse' | 'streamable_http', url: serverConfig.url as string };
            } else if (serverConfig?.url && typeof serverConfig.url === 'string' && serverConfig.url.startsWith('ws')) {
              toolToSave.transportType = 'websocket';
              toolToSave.url = serverConfig.url;
            } else if (serverConfig?.command) {
              toolToSave.transportType = 'stdio';
              toolToSave.command = serverConfig.command as string;
              toolToSave.args = (serverConfig.args as string[]) || [];
            }
            if (serverConfig?.env) toolToSave.env = serverConfig.env as Record<string, string>;
            if (serverConfig?.apiKey) toolToSave.apiKey = serverConfig.apiKey as string;
            if (serverConfig?.namespace) toolToSave['namespace'] = serverConfig.namespace;
          } else {
            toolToSave = {
              id: draft.id || `mcp_${Date.now()}`,
              name: (jsonConfig.name as string) || draft.name || t('common:unnamed_mcp_tool'),
              ...jsonConfig,
            } as McpToolConfig;
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

        const normalizedDraft: Record<string, unknown> = { ...draft };
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
          normalizedDraft.framing = resolveSettingsStdioFraming(
            typeof draft.framing === 'string' ? draft.framing : null,
          );
        }
        toolToSave = normalizedDraft as McpToolConfig;
      }

      // 后端 stdio 门禁要求 enabled == true：新增默认启用；编辑保留原值（存量缺省视为启用）
      if (typeof toolToSave.enabled !== 'boolean') {
        const priorEnabled = mcpToolModal.index != null
          ? (config.mcpTools || [])[mcpToolModal.index]?.enabled
          : undefined;
        toolToSave.enabled = priorEnabled ?? true;
      }

      const nextList = [...(config.mcpTools || [])];
      if (mcpToolModal.index == null) {
        nextList.push(toolToSave);
      } else {
        nextList[mcpToolModal.index] = toolToSave;
      }
      try {
        if (invoke) {
          await saveSetting('mcp.tools.list', JSON.stringify(nextList));
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

  const modalContentClassName = 'flex h-[min(85dvh,720px)] max-h-[min(85dvh,720px)] min-h-0 w-[min(96vw,960px)] flex-col overflow-hidden p-0';

  return (
    <UnifiedModal isOpen={true} onClose={handleClose} closeOnOverlayClick={false} contentClassName={modalContentClassName}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DsDialogHeader>
          <DsDialogTitle>{isEditing ? t('settings:mcp_descriptions.edit_tool_title') : t('settings:mcp_descriptions.add_tool_title')}</DsDialogTitle>
          <DsDialogDescription>{t('settings:mcp_descriptions.tool_modal_hint')}</DsDialogDescription>
        </DsDialogHeader>
        <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="mt-1.5 flex flex-1 flex-col justify-start px-3 pb-0 min-h-0">
          <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
          <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
          <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
        </TabsList>
          <div className="mt-1.5 flex-1 overflow-hidden min-h-0">
        <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
          <CustomScrollArea
            className="h-full min-h-0"
            viewportClassName="pr-2"
            trackOffsetTop={8}
            trackOffsetBottom={8}
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
                if (nextTransport === 'sse' || nextTransport === 'streamable_http') {
                  updateDraft({ transportType: nextTransport, fetch: { type: nextTransport, url: draft.fetch?.url || draft.endpoint || '' } });
                } else {
                  updateDraft({ transportType: nextTransport, fetch: undefined });
                }
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
              <Input {...TECHNICAL_INPUT_PROPS} value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
            </div>
          )}

          {(transport === 'sse' || transport === 'streamable_http') && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                <Input
                  {...TECHNICAL_INPUT_PROPS}
                  value={draft.endpoint || draft.fetch?.url || ''}
                  onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                  placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp.api_key')}</label>
                <ApiKeyField
                  value={draft.apiKey || ''}
                  onChange={e => updateDraft({ apiKey: e.target.value })}
                  placeholder={t('settings:placeholders.api_key')}
                  inputClassName="font-mono"
                  revealed={showMcpApiKey}
                  canReveal={(draft.apiKey || '').trim().length > 0}
                  onToggle={() => setShowMcpApiKey(v => !v)}
                  showLabel={t('common:securePassword.showPassword')}
                  hideLabel={t('common:securePassword.hidePassword')}
                />
                <p className="text-xs text-muted-foreground">{t('settings:mcp.oauth.api_key_priority_hint')}</p>
              </div>
            </div>
          )}

          {!isAndroid() && (transport === 'sse' || transport === 'streamable_http') && (
            <McpOAuthControls
              serverId={draft.id}
              resourceUrl={draft.endpoint || draft.fetch?.url || ''}
              hasApiKey={Boolean((draft.apiKey || '').trim())}
              t={t}
              onAuthorized={() => {
                updateDraft({
                  oauth: {
                    client_id: '',
                    auth_url: '',
                    token_url: '',
                    redirect_uri: 'http://127.0.0.1/auth/callback',
                    scopes: [],
                  },
                });
              }}
              onRevoked={() => {
                updateDraft({ oauth: undefined });
              }}
            />
          )}

          {transport === 'stdio' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('settings:mcp_descriptions.command_label')}</label>
                <Input
                  {...TECHNICAL_INPUT_PROPS}
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
                  value={resolveSettingsStdioFraming(draft.framing)}
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
              <DsButton variant="outline" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={addEnvRow}>+ {t('settings:mcp_descriptions.add_env')}</DsButton>
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
                  <DsButton variant="ghost" iconOnly size="sm" className="h-8 w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" onClick={() => removeEnvRow(key)} aria-label={t('common:remove', { defaultValue: 'Remove' })}>
                    <Trash size={16} />
                  </DsButton>
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
              <DsButton variant="outline" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleTestConnection}>{t('settings:mcp_descriptions.run_test')}</DsButton>
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

        <DsDialogFooter>
          <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleClose}>{t('common:actions.cancel')}</DsButton>
          <DsButton size="sm" variant="primary" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleSubmit}>{isEditing ? t('common:actions.save') : t('common:actions.create')}</DsButton>
        </DsDialogFooter>
      </div>
    </UnifiedModal>
  );
}
