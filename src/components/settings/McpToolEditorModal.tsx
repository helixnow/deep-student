/**
 * MCP 工具编辑器模态框组件
 * 从 Settings.tsx 拆分
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '../ui/NotionDialog';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Label } from '../ui/shad/Label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/shad/Tabs';
import { AppSelect } from '../ui/app-menu';
import { Textarea } from '../ui/shad/Textarea';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { AlertCircle, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { McpToolModalState, McpToolDraft } from './hooks/useMcpSettings';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';

const DEFAULT_STDIO_ARGS = ['-y', '@modelcontextprotocol/server-everything'];

export interface McpToolEditorModalProps {
  mcpToolModal: McpToolModalState;
  setMcpToolModal: React.Dispatch<React.SetStateAction<McpToolModalState>>;
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  isSmallScreen: boolean;
}

export const McpToolEditorModal: React.FC<McpToolEditorModalProps> = ({
  mcpToolModal,
  setMcpToolModal,
  config,
  setConfig,
  isSmallScreen,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  
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

  const updateDraft = (patch: Partial<McpToolDraft>) => {
    setMcpToolModal(prev => ({ ...prev, draft: { ...prev.draft, ...patch } }));
  };

  const convertDraftToJson = () => {
    const name = draft.name || t('common:unnamed_mcp_tool');
    const configObj: Record<string, any> = { mcpServers: {} };
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
    configObj.mcpServers[name] = server;
    setMcpToolModal(prev => ({ ...prev, jsonInput: JSON.stringify(configObj, null, 2) }));
  };

  const handleModeChange = (value: string) => {
    if (value === 'json' && mcpToolModal.mode !== 'json') {
      convertDraftToJson();
    }
    setMcpToolModal(prev => ({ ...prev, mode: value as 'json' | 'form' }));
  };

  const handleEnvKeyChange = (key: string, nextKey: string) => {
    const current = draft.env || {};
    const updated = { ...current };
    const val = updated[key];
    delete updated[key];
    updated[nextKey] = val;
    updateDraft({ env: updated });
  };

  const handleEnvValueChange = (key: string, val: string) => {
    const current = draft.env || {};
    updateDraft({ env: { ...current, [key]: val } });
  };

  const handleEnvRemove = (key: string) => {
    const current = draft.env || {};
    const updated = { ...current };
    delete updated[key];
    updateDraft({ env: updated });
  };

  const handleEnvAdd = () => {
    const current = draft.env || {};
    let newKey = 'NEW_VAR';
    let idx = 1;
    while (newKey in current) {
      newKey = `NEW_VAR_${idx++}`;
    }
    updateDraft({ env: { ...current, [newKey]: '' } });
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
              id: serverName,
              name: serverName,
              transportType: serverConfig?.type || (serverConfig?.command ? 'stdio' : 'sse'),
              ...serverConfig,
            };
          } else {
            toolToSave = {
              id: draft.id || draft.name || `mcp-${Date.now()}`,
              ...jsonConfig,
            };
          }
        } catch (err: unknown) {
          setMcpToolModal(prev => ({ ...prev, error: t('settings:mcp_errors.json_format_error') + getErrorMessage(err) }));
          return;
        }
      } else {
        toolToSave = { ...draft };
        if (!toolToSave.id) {
          toolToSave.id = toolToSave.name || `mcp-${Date.now()}`;
        }
      }

      const nextList = [...(config.mcpTools || [])];
      if (mcpToolModal.index == null) {
        nextList.push(toolToSave);
      } else {
        nextList[mcpToolModal.index] = toolToSave;
      }
      setConfig((prev: any) => ({ ...prev, mcpTools: nextList }));
      
      // 保存逻辑由外部处理
      setMcpToolModal(prev => ({ ...prev, open: false, error: null }));
      showGlobalNotification('success', t('common:mcp_tool_saved'));
    } catch (error: unknown) {
      setMcpToolModal(prev => ({ ...prev, error: getErrorMessage(error) }));
    }
  };

  return (
    <NotionDialog open={mcpToolModal.open} onOpenChange={(open) => !open && handleClose()} maxWidth="max-w-2xl">
        <NotionDialogHeader>
          <NotionDialogTitle>{isEditing ? t('settings:mcp_descriptions.edit_tool_title', '编辑 MCP 工具') : t('settings:mcp_descriptions.add_tool_title', '新增 MCP 工具')}</NotionDialogTitle>
          <NotionDialogDescription>{t('settings:mcp_descriptions.tool_modal_hint', '配置 MCP 服务器连接信息，可在输入栏灵活启用。')}</NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>
        <Tabs value={mcpToolModal.mode} onValueChange={handleModeChange} className="mt-1.5 flex flex-1 flex-col justify-start px-3 pb-0 min-h-0">
          <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 flex-shrink-0">
            <TabsTrigger value="form" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.form_mode', '图形表单')}</TabsTrigger>
            <TabsTrigger value="json" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{t('settings:mcp_descriptions.json_mode', 'JSON 配置')}</TabsTrigger>
          </TabsList>
          
          <CustomScrollArea className="flex-1 min-h-0 mt-4">
            <TabsContent value="form" className="space-y-4 pr-4">
              <div className="space-y-2">
                <Label>{t('settings:mcp_descriptions.tool_name', '工具名称')}</Label>
                <Input
                  value={draft.name || ''}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  placeholder={t('settings:mcp_descriptions.tool_name_placeholder', '输入工具名称')}
                />
              </div>
              
              <div className="space-y-2">
                <Label>{t('settings:mcp_descriptions.transport_type', '传输类型')}</Label>
                <AppSelect
                  value={transport}
                  onValueChange={(v) => updateDraft({ transportType: v as any })}
                  options={[
                    { value: 'stdio', label: t('settings:mcp_transport.stdio') },
                    { value: 'sse', label: t('settings:mcp_transport.sse') },
                    { value: 'streamable_http', label: t('settings:mcp_transport.streamable_http') },
                    { value: 'websocket', label: t('settings:mcp_transport.websocket') },
                  ]}
                  variant="outline"
                  size="sm"
                />
              </div>

              {transport === 'stdio' && (
                <>
                  <div className="space-y-2">
                    <Label>{t('settings:mcp_descriptions.command', '命令')}</Label>
                    <Input
                      value={draft.command || ''}
                      onChange={(e) => updateDraft({ command: e.target.value })}
                      placeholder="npx"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings:mcp_descriptions.args', '参数')}</Label>
                    <Input
                      value={argsInput}
                      onChange={(e) => updateDraft({ args: e.target.value })}
                      placeholder="-y, @anthropic-ai/server-everything"
                    />
                  </div>
                </>
              )}

              {(transport === 'sse' || transport === 'streamable_http') && (
                <div className="space-y-2">
                  <Label>URL</Label>
                  <Input
                    value={draft.endpoint || draft.fetch?.url || ''}
                    onChange={(e) => updateDraft({ endpoint: e.target.value, fetch: { type: transport, url: e.target.value } })}
                    placeholder="https://example.com/mcp"
                  />
                </div>
              )}

              {transport === 'websocket' && (
                <div className="space-y-2">
                  <Label>{t('settings:mcp.websocket_url')}</Label>
                  <Input
                    value={draft.url || ''}
                    onChange={(e) => updateDraft({ url: e.target.value })}
                    placeholder="wss://example.com/mcp"
                  />
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('settings:mcp_descriptions.env_vars', '环境变量')}</Label>
                  <NotionButton type="button" variant="ghost" size="sm" onClick={handleEnvAdd}>
                    <Plus className="h-4 w-4 mr-1" />
                    {t('common:add')}
                  </NotionButton>
                </div>
                {envEntries.map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2">
                    <Input
                      value={key}
                      onChange={(e) => handleEnvKeyChange(key, e.target.value)}
                      className="flex-1"
                      placeholder={t('settings:placeholders.env_key')}
                    />
                    <Input
                      value={val}
                      onChange={(e) => handleEnvValueChange(key, e.target.value)}
                      className="flex-1"
                      placeholder="value"
                    />
                    <NotionButton type="button" variant="ghost" iconOnly size="sm" onClick={() => handleEnvRemove(key)}>
                      <Trash2 className="h-4 w-4" />
                    </NotionButton>
                  </div>
                ))}
              </div>
            </TabsContent>
            
            <TabsContent value="json" className="pr-4">
              <Textarea
                value={mcpToolModal.jsonInput}
                onChange={(e) => setMcpToolModal(prev => ({ ...prev, jsonInput: e.target.value }))}
                className="min-h-[300px] font-mono text-sm"
                placeholder='{"mcpServers": {"my-server": {...}}}'
              />
            </TabsContent>
          </CustomScrollArea>
        </Tabs>

        {mcpToolModal.error && (
          <div className="flex items-center gap-2 text-destructive text-sm px-3">
            <AlertCircle className="h-4 w-4" />
            {mcpToolModal.error}
          </div>
        )}

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={handleClose}>
            {t('common:cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" onClick={handleSubmit}>
            {t('common:save')}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
};

export default McpToolEditorModal;
