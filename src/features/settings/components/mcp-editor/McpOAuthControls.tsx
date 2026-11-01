import { useState, useEffect, useCallback } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { invoke } from './runtime';

/** MCP OAuth 登录 / 重新授权 / 注销 */
export function McpOAuthControls({
  serverId,
  resourceUrl,
  hasApiKey,
  t,
  onAuthorized,
  onRevoked,
}: {
  serverId: string;
  resourceUrl: string;
  hasApiKey: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onAuthorized?: () => void;
  onRevoked?: () => void;
}) {
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!invoke || !serverId || !resourceUrl.trim()) return;
    try {
      const status = await invoke<{ authorized: boolean }>('get_mcp_oauth_status', {
        serverId,
        resourceUrl: resourceUrl.trim(),
      });
      setAuthorized(Boolean(status?.authorized));
    } catch {
      setAuthorized(false);
    }
  }, [serverId, resourceUrl]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const startOauth = useCallback(async () => {
    if (!invoke) {
      showGlobalNotification('error', t('settings:mcp.oauth.desktop_only'));
      return;
    }
    if (!resourceUrl.trim()) {
      showGlobalNotification('error', t('settings:mcp.oauth.missing_url'));
      return;
    }
    if (hasApiKey) {
      showGlobalNotification('info', t('settings:mcp.oauth.clear_api_key_first'));
      return;
    }
    setBusy(true);
    try {
      await invoke('start_mcp_oauth', {
        serverId,
        resourceUrl: resourceUrl.trim(),
        clientId: null,
        clientSecret: null,
        scopes: [],
      });
      showGlobalNotification('success', t('settings:mcp.oauth.login_success'));
      onAuthorized?.();
      await refreshStatus();
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e) || t('settings:mcp.oauth.login_failed'));
    } finally {
      setBusy(false);
    }
  }, [serverId, resourceUrl, hasApiKey, refreshStatus, t, onAuthorized]);

  const revokeOauth = useCallback(async () => {
    if (!invoke || !serverId) return;
    setBusy(true);
    try {
      await invoke('revoke_mcp_oauth', { serverId });
      showGlobalNotification('success', t('settings:mcp.oauth.logout_success'));
      setAuthorized(false);
      onRevoked?.();
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e) || t('settings:mcp.oauth.logout_failed'));
    } finally {
      setBusy(false);
    }
  }, [serverId, t, onRevoked]);

  const cancelOauth = useCallback(async () => {
    if (!invoke || !serverId) return;
    try {
      await invoke('cancel_mcp_oauth', { serverId });
      showGlobalNotification('info', t('settings:mcp.oauth.cancelled'));
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, [serverId, t]);

  return (
    <div className="mcp-oauth-controls rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">{t('settings:mcp.oauth.title')}</div>
          <div className="text-xs text-muted-foreground">
            {authorized
              ? t('settings:mcp.oauth.status_authorized')
              : t('settings:mcp.oauth.status_none')}
          </div>
        </div>
        <span className={cn(
          'w-2 h-2 rounded-full flex-shrink-0',
          authorized ? 'bg-green-500' : 'bg-muted-foreground/40',
        )} />
      </div>
      <div className="flex flex-wrap gap-2 max-md:justify-end">
        <DsButton
          size="sm"
          variant="primary"
          className="[@media(pointer:coarse)]:!min-h-11"
          disabled={busy || hasApiKey || !resourceUrl.trim()}
          onClick={() => void startOauth()}
        >
          {authorized ? t('settings:mcp.oauth.reauth') : t('settings:mcp.oauth.login')}
        </DsButton>
        {busy && (
          <DsButton size="sm" variant="ghost" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => void cancelOauth()}>
            {t('settings:mcp.oauth.cancel')}
          </DsButton>
        )}
        {authorized && (
          <DsButton size="sm" variant="outline" className="!text-destructive [@media(pointer:coarse)]:!min-h-11" disabled={busy} onClick={() => void revokeOauth()}>
            {t('settings:mcp.oauth.logout')}
          </DsButton>
        )}
      </div>
    </div>
  );
}
