import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { AppSelect } from '@/components/ui/app-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/shad/Tabs';
import { ApiKeyField } from '../ApiKeyField';
import { UnifiedCodeEditor } from '@/components/shared/UnifiedCodeEditor';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import {
  DEFAULT_STDIO_ARGS_PLACEHOLDER,
  resolveSettingsStdioFraming,
} from '../constants';
import { Plus, X } from '@phosphor-icons/react';
import { saveSetting } from '@/utils/settingsApi';
import type { UseMcpEditorSectionDeps, McpToolConfig } from '../hookDepsTypes';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { invoke } from './runtime';
import type { McpToolModalState } from './types';

/** 移动端嵌入式 MCP 工具编辑器的渲染所需的 useMcpEditorSection 作用域值 */
export interface McpToolEditorEmbeddedContext {
  config: UseMcpEditorSectionDeps['config'];
  setConfig: UseMcpEditorSectionDeps['setConfig'];
  isSmallScreen: boolean;
  t: UseMcpEditorSectionDeps['t'];
  closeRightPanel: () => void;
  mcpToolSubmitRef: MutableRefObject<(() => Promise<void>) | null>;
  mcpToolModal: McpToolModalState;
  setMcpToolModal: Dispatch<SetStateAction<McpToolModalState>>;
  showMcpApiKey: boolean;
  setShowMcpApiKey: Dispatch<SetStateAction<boolean>>;
  refreshSnapshots: (options?: { reload?: boolean }) => Promise<void>;
}

export function renderMcpToolEditorEmbedded({
  config, setConfig, isSmallScreen, t, closeRightPanel, mcpToolSubmitRef, mcpToolModal, setMcpToolModal,
  showMcpApiKey, setShowMcpApiKey, refreshSnapshots,
}: McpToolEditorEmbeddedContext) {
  if (!mcpToolModal.open) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">{t('settings:sections.select_tool_to_edit')}</p>
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
    }
    setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
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
              name: serverName,
              transportType: (serverConfig.type || serverConfig.transportType || (serverConfig.command ? 'stdio' : 'sse')) as McpToolConfig['transportType'],
              command: serverConfig.command as string | undefined,
              args: serverConfig.args as string[] | undefined,
              env: serverConfig.env as Record<string, string> | undefined,
              url: serverConfig.url as string | undefined,
              endpoint: serverConfig.url as string | undefined,
              fetch: serverConfig.type === 'sse' || serverConfig.type === 'streamable_http' ? { type: serverConfig.type as 'sse' | 'streamable_http', url: serverConfig.url as string } : undefined,
              apiKey: serverConfig.apiKey as string | undefined,
            };
            if (serverConfig?.namespace) toolToSave['namespace'] = serverConfig.namespace;
            if (serverConfig?.cwd) toolToSave['cwd'] = serverConfig.cwd;
            if (serverConfig?.framing != null) {
              toolToSave['framing'] = resolveSettingsStdioFraming(String(serverConfig.framing));
            } else if (transport === 'stdio' || toolToSave.transportType === 'stdio') {
              toolToSave['framing'] = 'jsonl';
            }
          } else {
            toolToSave = {
              id: draft.id || `mcp_${Date.now()}`,
              name: (jsonConfig.name as string) || draft.name || t('common:unnamed_mcp_tool'),
              ...jsonConfig,
            } as McpToolConfig;
            if (toolToSave.transportType === 'stdio' || toolToSave.command) {
              toolToSave['framing'] = resolveSettingsStdioFraming(
                typeof toolToSave['framing'] === 'string' ? String(toolToSave['framing']) : null,
              );
            }
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
          args: transport === 'stdio' ? normalizedArgs : undefined,
          env: draft.env,
          url: transport === 'websocket' ? draft.url : undefined,
          endpoint: (transport === 'sse' || transport === 'streamable_http') ? (draft.endpoint || draft.fetch?.url) : undefined,
          fetch: (transport === 'sse' || transport === 'streamable_http') ? { type: transport, url: draft.endpoint || draft.fetch?.url || '' } : undefined,
          apiKey: draft.apiKey,
          oauth: draft.apiKey ? undefined : draft.oauth,
          namespace: draft.namespace,
          cwd: draft.cwd,
          framing: transport === 'stdio' ? resolveSettingsStdioFraming(draft.framing) : draft.framing,
        };
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

  // 移动端保存出口上收统一顶栏（P1-7 同模型编辑器）：顶栏 Check 经此 ref 触发提交，
  // 每次渲染同步最新闭包，不引入额外状态
  mcpToolSubmitRef.current = handleSubmit;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background [&_input]:min-h-11"
      style={{
        paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
      }}
    >
      <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="flex-1 flex flex-col min-h-0 px-4 pt-4">
        <TabsList className="grid h-auto min-h-11 w-full flex-shrink-0 grid-cols-2 rounded-lg bg-muted p-1">
          <TabsTrigger value="form" className="min-h-11 data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode')}</TabsTrigger>
          <TabsTrigger value="json" className="min-h-11 data-[state=active]:bg-background data-[state=active]:shadow-sm">JSON</TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-hidden min-h-0 mt-3">
          <TabsContent value="form" className="h-full min-h-0 data-[state=inactive]:hidden">
            <CustomScrollArea className="h-full min-h-0" viewportClassName="pr-2">
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
                    className="min-h-11"
                  />
                </div>

                {transport === 'websocket' && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings:mcp.websocket_url')}</label>
                    <Input {...TECHNICAL_INPUT_PROPS} value={draft.url || ''} onChange={e => updateDraft({ url: e.target.value })} placeholder="ws://localhost:8000" />
                  </div>
                )}

                {(transport === 'sse' || transport === 'streamable_http') && (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{transport === 'streamable_http' ? t('settings:mcp_descriptions.http_endpoint_label', 'HTTP Endpoint *') : t('settings:mcp_descriptions.sse_endpoint_label', 'SSE Endpoint *')}</label>
                      <Input
                        {...TECHNICAL_INPUT_PROPS}
                        value={draft.endpoint || draft.fetch?.url || ''}
                        onChange={e => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                        placeholder={transport === 'streamable_http' ? 'https://api.example.com/mcp/http' : 'https://api.example.com/mcp/sse'}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{t('settings:mcp.api_key')}</label>
                      <ApiKeyField
                        value={draft.apiKey || ''}
                        onChange={e => updateDraft({ apiKey: e.target.value })}
                        placeholder={t('settings:placeholders.api_key')}
                        inputClassName="min-h-11 font-mono"
                        revealed={showMcpApiKey}
                        canReveal={(draft.apiKey || '').trim().length > 0}
                        onToggle={() => setShowMcpApiKey(v => !v)}
                        showLabel={t('common:securePassword.showPassword')}
                        hideLabel={t('common:securePassword.hidePassword')}
                      />
                    </div>
                  </>
                )}

                {transport === 'stdio' && (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{t('settings:mcp_descriptions.command_label')}</label>
                      <Input
                        {...TECHNICAL_INPUT_PROPS}
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
                    <div key={idx} className="flex min-w-0 flex-col gap-2 sm:flex-row">
                      <Input
                        value={key}
                        onChange={e => {
                          const newEnv = { ...draft.env };
                          delete newEnv[key];
                          newEnv[e.target.value] = value;
                          updateDraft({ env: newEnv });
                        }}
                        placeholder={t('settings:placeholders.env_key')}
                        className="min-w-0 flex-1"
                      />
                      <Input
                        value={value}
                        onChange={e => updateDraft({ env: { ...draft.env, [key]: e.target.value } })}
                        placeholder={t('settings:placeholders.env_value')}
                        className="min-w-0 flex-1"
                      />
                      <DsButton
                        variant="ghost"
                        iconOnly size="sm"
                        className="self-end max-sm:!h-11 max-sm:!w-11 sm:self-auto [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={() => {
                          const newEnv = { ...draft.env };
                          delete newEnv[key];
                          updateDraft({ env: newEnv });
                        }}
                      >
                        <X className="h-4 w-4" />
                      </DsButton>
                    </div>
                  ))}
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={() => updateDraft({ env: { ...draft.env, '': '' } })}
                    className="min-h-11 sm:min-h-0 [@media(pointer:coarse)]:!min-h-11"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t('settings:mcp_descriptions.add_env')}
                  </DsButton>
                </div>
              </div>
            </CustomScrollArea>
          </TabsContent>

          <TabsContent value="json" className="h-full min-h-0 data-[state=inactive]:hidden">
            <div className="flex h-full min-h-0 flex-col">
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

      {/* 移动端：保存唯一出口在统一顶栏 Check（P1-7，同模型编辑器），底栏不再重复；桌面右侧面板保留 */}
      {!isSmallScreen && (
      <div className="flex flex-shrink-0 gap-2 border-t border-border px-4 py-3">
        <DsButton variant="ghost" onClick={handleClose} className="min-h-11 flex-1">{t('common:actions.cancel')}</DsButton>
        <DsButton variant="primary" onClick={handleSubmit} className="min-h-11 flex-1">{isEditing ? t('common:actions.save') : t('common:actions.create')}</DsButton>
      </div>
      )}
    </div>
  );
}
