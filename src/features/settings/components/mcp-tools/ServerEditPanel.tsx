import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash, CaretDown, CaretUp, CodeBlock, FileCode } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { UnifiedCodeEditor } from '@/components/shared/UnifiedCodeEditor';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { ApiKeyField } from '../ApiKeyField';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import type { McpServer } from './types';

// 服务器编辑面板 - 支持表单/JSON双模式
export function ServerEditPanel({
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
        <DsButton variant="ghost" size="sm" onClick={() => handleModeSwitch('form')} className={cn('[@media(pointer:coarse)]:!min-h-11', editMode === 'form' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <FileCode className="w-3.5 h-3.5" />
          {t('settings:mcp_server_edit.form_mode')}
        </DsButton>
        <DsButton variant="ghost" size="sm" onClick={() => handleModeSwitch('json')} className={cn('[@media(pointer:coarse)]:!min-h-11', editMode === 'json' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <CodeBlock className="w-3.5 h-3.5" />
          {t('settings:mcp_server_edit.json_config')}
        </DsButton>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {editMode === 'form' ? (
          <>
            {/* 表单模式内容 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 名称 */}
              <div>
                <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
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
                <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
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
              <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
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
                  <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.command')} *
                  </label>
                  <Input
                    {...TECHNICAL_INPUT_PROPS}
                    value={formData.command}
                    onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                    className="font-mono"
                    placeholder="npx, node, python..."
                    required
                  />
                </div>
                <div>
                  <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    {t('settings:mcp_server_edit.args')}
                  </label>
                  <Input
                    {...TECHNICAL_INPUT_PROPS}
                    value={formData.args}
                    onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                    className="font-mono"
                    placeholder="-y, @anthropic/mcp-server"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('settings:mcp_server_edit.server_url')} *
                </label>
                <Input
                  type="url"
                  {...TECHNICAL_INPUT_PROPS}
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
              <DsButton variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full !justify-between !px-4 !py-3 !rounded-none [@media(pointer:coarse)]:!min-h-11">
                <span>{t('settings:mcp_server_edit.advanced_config')}</span>
                {showAdvanced ? <CaretUp className="w-4 h-4" /> : <CaretDown className="w-4 h-4" />}
              </DsButton>

              {showAdvanced && (
                <div className="px-4 pb-4 space-y-6 border-t border-border/40 pt-4 bg-muted/10">
                  {/* API Key */}
                  <div>
                    <label className="text-2xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
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
                      <label className="text-2xs text-muted-foreground uppercase tracking-wider">
                        {t('settings:mcp_server_edit.env_vars')}
                      </label>
                      <DsButton variant="ghost" size="sm" onClick={addEnvRow} className="text-primary hover:text-primary/80 !h-auto !p-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!px-2">
                        + {t('settings:mcp_server_edit.add')}
                      </DsButton>
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
                            <DsButton variant="ghost" size="icon" iconOnly onClick={() => removeEnvRow(key)} className="!h-6 !w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 hover:text-destructive" aria-label={t('common:remove', { defaultValue: 'Remove' })}>
                              <Trash className="w-3.5 h-3.5" />
                            </DsButton>
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
              <div className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">
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
              <p className="text-2xs text-muted-foreground mt-2">
                {t('settings:mcp_server_edit.json_hint')}
              </p>
            </div>
          </>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/40">
          <DsButton
            type="button"
            variant="outline"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={onClose}
            disabled={isSaving}
          >
            {t('settings:mcp_server_edit.cancel')}
          </DsButton>
          <DsButton
            type="submit"
            variant="primary"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            disabled={isSaving}
          >
            {t('settings:mcp_server_edit.save')}
          </DsButton>
        </div>
      </form>
    </div>
  );
}
