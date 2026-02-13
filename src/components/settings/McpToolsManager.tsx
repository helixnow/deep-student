import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/shad/Card';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Textarea } from '../ui/shad/Textarea';
import { BadgeCheck, AlertCircle, RefreshCw, Plus, Save as SaveIcon, Trash2, ListChecks, Globe } from 'lucide-react';
import { TauriAPI } from '../../utils/tauriApi';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';

type StaticTool = { id: string; name: string; description?: string };

export const McpToolsManager: React.FC = () => {
  const { t } = useTranslation(['common']);
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
  const [status, setStatus] = useState<any>(null);
  const [onlineTools, setOnlineTools] = useState<Array<{ name: string; description?: string }>>([]);
  const [staticTools, setStaticTools] = useState<StaticTool[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const loadAll = async () => {
    if (!isTauri) return;
    setBusy(true);
    try {
      const [mcpStatus, toolsOnline, rawStatic] = await Promise.all([
        TauriAPI.getMcpStatus().catch(() => null),
        TauriAPI.getMcpTools().catch(() => []),
        TauriAPI.getSetting('mcp.tools.list').catch(() => '[]')
      ]);
      setStatus(mcpStatus);
      setOnlineTools(Array.isArray(toolsOnline) ? toolsOnline : []);
      try {
        const arr = JSON.parse(rawStatic || '[]');
        setStaticTools(Array.isArray(arr) ? arr : []);
      } catch {
        setStaticTools([]);
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const saveStaticTools = async () => {
    if (!isTauri) return;
    setSaving(true);
    try {
      const cleaned = staticTools
        .map(t => ({ id: String(t.id || t.name || '').trim(), name: String(t.name || '').trim(), description: t.description || '' }))
        .filter(t => t.id && t.name);
      await TauriAPI.saveSetting('mcp.tools.list', JSON.stringify(cleaned));
      showGlobalNotification('success', t('common:mcp_tools.messages.list_saved'));
    } catch (e: unknown) {
      console.error(e);
      showGlobalNotification('error', t('common:mcp_tools.messages.save_failed'));
    } finally { setSaving(false); }
  };

  const reloadClient = async () => {
    if (!isTauri) return;
    setBusy(true);
    try {
      const res = await TauriAPI.reloadMcpClient();
      if (res?.success) {
        showGlobalNotification('success', res.message || t('common:mcp_tools.messages.client_reloaded'));
      } else {
        showGlobalNotification('error', res?.error || t('common:mcp_tools.messages.reload_failed'));
      }
      await loadAll();
    } finally { setBusy(false); }
  };

  const refreshTools = async () => {
    if (!isTauri) return;
    setBusy(true);
    try {
      const toolsOnline = await TauriAPI.getMcpTools();
      setOnlineTools(Array.isArray(toolsOnline) ? toolsOnline : []);
      showGlobalNotification('success', t('common:mcp_tools.messages.refreshed', { count: Array.isArray(toolsOnline) ? toolsOnline.length : 0 }));
    } catch (e: unknown) {
      showGlobalNotification('error', t('common:mcp_tools.messages.refresh_failed'));
    } finally { setBusy(false); }
  };

  const testAllEngines = async () => {
    if (!isTauri) return;
    setTesting(true);
    try {
      const res = await TauriAPI.testAllSearchEngines();
      showGlobalNotification('success', t('common:mcp_tools.messages.health_complete', { success: res.summary.success, configured: res.summary.configured }));
    } catch (e: unknown) {
      showGlobalNotification('error', t('common:mcp_tools.messages.health_failed'));
    } finally { setTesting(false); }
  };

  const enabledLabel = useMemo(() => {
    if (!status) return t('common:mcp_tools.status.unknown');
    if (!status.available) return t('common:mcp_tools.status.unavailable');
    return status.enabled ? t('common:mcp_tools.status.enabled') : t('common:mcp_tools.status.disabled');
  }, [status, t]);

  const addTool = () => {
    const id = `tool_${Date.now()}`;
    setStaticTools(prev => [...prev, { id, name: '', description: '' }]);
  };

  const removeTool = (id: string) => {
    setStaticTools(prev => prev.filter(t => t.id !== id));
  };

  const updateTool = (id: string, patch: Partial<StaticTool>) => {
    setStaticTools(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)));
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('common:mcp_tools.title')}</CardTitle>
          <CardDescription>{t('common:mcp_tools.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 items-center">
          <div
            className={`inline-flex items-center gap-2 text-sm px-2 py-1 rounded-md ring-1 ring-inset ${
              status?.enabled
                ? 'bg-success/15 text-success-foreground ring-success/30 dark:bg-success/20'
                : status?.available === false
                  ? 'bg-danger/15 text-danger-foreground ring-danger/30 dark:bg-danger/20'
                  : 'bg-muted text-muted-foreground ring-border/60 dark:bg-muted/60'
            }`}
          >
            {status?.enabled ? <BadgeCheck className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            MCP {enabledLabel}
          </div>
          <NotionButton size="sm" onClick={refreshTools} disabled={busy}>
            <RefreshCw className="h-4 w-4 mr-1" /> {t('common:mcp_tools.refresh_list')}
          </NotionButton>
          <NotionButton size="sm" variant="default" onClick={reloadClient} disabled={busy}>
            <RefreshCw className="h-4 w-4 mr-1" /> {t('common:mcp_tools.reload_client')}
          </NotionButton>
          <NotionButton size="sm" variant="ghost" onClick={testAllEngines} disabled={testing} title={t('common:mcp_tools.health_check_title')}>
            <ListChecks className="h-4 w-4 mr-1" /> {t('common:mcp_tools.health_check')}
          </NotionButton>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('common:mcp_tools.list_title')}</CardTitle>
          <CardDescription>{t('common:mcp_tools.list_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {staticTools.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('common:mcp_tools.no_tools')}</div>
          ) : (
            <div className="space-y-3">
              {staticTools.map(tool => (
                <div key={tool.id} className="grid gap-2 md:grid-cols-2 items-start p-3 rounded-lg border border-border dark:border-border/60">
                  <div>
                    <div className="text-xs mb-1 text-muted-foreground">{t('common:mcp_tools.tool_name_label')}</div>
                    <Input value={tool.name} onChange={e=>updateTool(tool.id, { name: e.target.value })} placeholder={t('common:mcp_tools.tool_name_placeholder')} />
                  </div>
                  <div>
                    <div className="text-xs mb-1 text-muted-foreground">{t('common:mcp_tools.description_label')}</div>
                    <Input value={tool.description || ''} onChange={e=>updateTool(tool.id, { description: e.target.value })} placeholder={t('common:mcp_tools.description_placeholder')} />
                  </div>
                  <div className="md:col-span-2 flex items-center justify-between">
                    <div className="text-xs text-muted-foreground">{t('common:mcp_tools.tool_id_label')}: {tool.id}</div>
                    <NotionButton size="sm" variant="danger" onClick={()=>removeTool(tool.id)}>
                      <Trash2 className="h-4 w-4 mr-1" /> {t('common:mcp_tools.delete_tool')}
                    </NotionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <NotionButton size="sm" onClick={addTool}>
            <Plus className="h-4 w-4 mr-1" /> {t('common:mcp_tools.add_tool')}
          </NotionButton>
          <NotionButton size="sm" variant="default" onClick={saveStaticTools} disabled={saving}>
            <SaveIcon className="h-4 w-4 mr-1" /> {t('common:mcp_tools.save_list')}
          </NotionButton>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('common:mcp_tools.guide_title')}</CardTitle>
          <CardDescription>{t('common:mcp_tools.guide_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div>{t('common:mcp_tools.guide_step1')}</div>
          <div>{t('common:mcp_tools.guide_step2')}</div>
          <div>{t('common:mcp_tools.guide_step3')}</div>
          <div>{t('common:mcp_tools.guide_step4')}</div>
          <div>{t('common:mcp_tools.guide_step5')}</div>
        </CardContent>
      </Card>
    </div>
  );
};

export default McpToolsManager;
