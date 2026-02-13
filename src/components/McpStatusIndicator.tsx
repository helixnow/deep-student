import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, CheckCircle, XCircle, RefreshCcw, Wrench } from 'lucide-react';
import { TauriAPI } from '../utils/tauriApi';
import { McpService } from '../mcp/mcpService';
import { debugLog } from '../debug-panel/debugMasterSwitch';

interface McpStatus {
  available: boolean;
  enabled: boolean;
  connected?: boolean;
  enabled_reason?: string | null;
  server_info?: { name?: string; version?: string; protocol_version?: string } | null;
  tools_count?: number;
  last_error?: string | null;
}

const McpStatusIndicator: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { t } = useTranslation('common');
  const [status, setStatus] = React.useState<McpStatus | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      // 优先使用前端 McpService 状态
      const st = await McpService.status().catch(() => null);
      if (st) {
        setStatus({
          available: st.available,
          enabled: true,
          connected: st.connected,
          tools_count: st.toolsCount,
          last_error: st.lastError || null,
          server_info: null,
          enabled_reason: null,
        } as any);
      } else {
        const s = await TauriAPI.getMcpStatus();
        setStatus(s);
      }
    } catch (e: unknown) {
      setStatus({ available: false, enabled: false, last_error: (e as any)?.message || String(e) } as any);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const off = McpService.onStatus((s) => {
      setStatus({
        available: s.available,
        enabled: true,
        connected: s.connected,
        tools_count: s.toolsCount,
        last_error: s.lastError || null,
        server_info: null,
        enabled_reason: null,
      } as any);
    });
    return () => { try { off(); } catch {} };
  }, [load]);

  const isEnabled = !!status?.enabled;
  const isConnected = status?.connected ?? status?.available;
  const statusVariant = !isEnabled ? 'muted' : (isConnected ? 'success' : 'danger');
  const textClass =
    statusVariant === 'success'
      ? 'text-success-foreground'
      : statusVariant === 'danger'
        ? 'text-danger-foreground'
        : 'text-muted-foreground';
  const Icon = !isEnabled ? Wrench : (isConnected ? CheckCircle : XCircle);

  if (compact) {
    return (
      <button
        onClick={load}
        title={t('mcpStatus.refreshStatus')}
        className={`inline-flex items-center gap-1.5 text-xs transition-colors ${textClass} hover:text-foreground`}
      >
        <Plug size={14} className="shrink-0" />
        <Icon size={14} className="shrink-0" />
        <span className="text-left">
          {isEnabled
            ? (isConnected ? t('mcpStatus.connected') : `${t('mcpStatus.disconnected')}${status?.last_error ? '：' + String(status.last_error).slice(0, 60) : ''}`)
            : (status?.available ? (status?.enabled_reason || t('mcpStatus.notEnabledInSession')) : `${t('mcpStatus.disconnected')}${status?.last_error ? '：' + String(status.last_error).slice(0, 60) : ''}`)}
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      <Plug size={16} className={textClass} />
      <span className={`text-sm ${textClass}`}>
        {isEnabled
          ? (isConnected ? t('mcpStatus.connectedOk') : `${t('mcpStatus.initFailed')}${status?.last_error ? '：' + String(status.last_error).slice(0, 120) : ''}`)
          : (status?.available ? (status?.enabled_reason || t('mcpStatus.notEnabledMcpTools')) : `${t('mcpStatus.initFailed')}${status?.last_error ? '：' + String(status.last_error).slice(0, 120) : ''}`)}
      </span>
      <button
        onClick={() => { McpService.connectAll().catch((err) => { debugLog.warn('[MCP] Connect failed:', err); }); load(); }}
        title={t('actions.refresh')}
        className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-muted/80 transition-colors inline-flex items-center gap-1"
      >
        <RefreshCcw size={12} /> {t('actions.refresh')}
      </button>
      {status?.server_info && (
        <span className="text-xs text-muted-foreground">{status.server_info.name} v{status.server_info.version}</span>
      )}
      {typeof status?.tools_count === 'number' && (
        <span className="text-xs text-muted-foreground">{t('mcpStatus.toolsCount')}: {status.tools_count}</span>
      )}
      {status?.last_error && (
        <span className="text-xs text-amber-600">{String(status.last_error).slice(0, 120)}</span>
      )}
    </div>
  );
};

export default McpStatusIndicator;
