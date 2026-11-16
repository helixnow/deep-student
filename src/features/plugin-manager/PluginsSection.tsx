import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { PluginManagerPanel, type PluginManagerPanelProps } from './PluginManagerPanel';
import { usePluginManagerState } from './controller';
import { usePluginErrorBudget } from './use-error-budget';
import { usePluginUiHostStatus } from './use-ui-status';
import { usePluginManagerWorkshop } from './workshop';
import { pluginName } from './presentation';

export interface PluginsSectionProps extends PluginManagerPanelProps {
  /** Restore is supplied by the version owner; no invented Host command or optimistic success. */
  onRollback?: (pluginId: string) => Promise<void>;
}

/** Settings mount point with live Host/UI-budget isolation notices above the manager. */
export function PluginsSection({ onRollback, ...props }: PluginsSectionProps) {
  const { t } = useTranslation('plugin_manager');
  const state = usePluginManagerState(props.controller);
  const disabled = usePluginErrorBudget(props.errorBudget);
  const status = usePluginUiHostStatus(props.uiStatus);
  const registeredWorkshop = usePluginManagerWorkshop();
  const workshop = props.workshop ?? registeredWorkshop;
  const rollback = onRollback ?? workshop?.onRollback;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [goBack, setGoBack] = useState<ReadonlySet<string>>(new Set());
  const running = useRef(false);
  const isolated = state.plugins.filter(plugin => plugin.origin === 'community' && (
    disabled.some(entry => entry.pluginId === plugin.id)
    || plugin.degraded && plugin.consent !== 'required' && !plugin.degraded.reason.startsWith('CONSENT_REQUIRED:')
    || status?.state(plugin.id) === 'degraded' && !status.consentRequired(plugin.id)
  ));
  // 「回到上一版」只在工坊真的留着上一版时出现，不给一个点了才报错的按钮。
  const isolatedSignature = isolated.map(plugin => plugin.id).join('|');
  useEffect(() => {
    if (!isolatedSignature || !workshop?.works) { setGoBack(new Set()); return undefined; }
    let live = true;
    workshop.works().then(list => { if (live) setGoBack(new Set(list.filter(work => work.previousVersion).map(work => work.pluginId))); })
      .catch(() => { if (live) setGoBack(new Set()); });
    return () => { live = false; };
  }, [isolatedSignature, workshop]);
  const recover = async (id: string, repair: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(id);
    setError(undefined);
    try {
      if (repair) {
        await props.controller.setEnabled(id, false);
        const current = props.controller.getSnapshot();
        if (current.error) throw new Error(current.error.detail ?? current.error.code);
        if (current.plugins.find(plugin => plugin.id === id)?.enabled !== false) throw new Error(t('isolation.disableUnconfirmed'));
        workshop?.onModify(id);
      } else {
        await rollback?.(id);
        await props.controller.refresh();
      }
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      setError(workshop?.describeError?.(raw) ?? raw);
    } finally {
      running.current = false;
      setBusy(undefined);
    }
  };
  return <div className="space-y-3">
    {isolated.map(plugin => {
      const crashed = disabled.some(entry => entry.pluginId === plugin.id);
      const raw = plugin.degraded?.reason ?? status?.reason(plugin.id) ?? (crashed ? t('isolation.budgetExhausted') : undefined);
      // An explicit version owner (onRollback) knows its versions; otherwise ask the workshop whether one is retained.
      const canGoBack = Boolean(rollback) && (onRollback !== undefined || goBack.has(plugin.id));
      const canRepair = Boolean(workshop) && plugin.source === 'workshop';
      return <div key={plugin.id} role="alert" data-testid="plugin-isolation" data-plugin-id={plugin.id} className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
        <p className="font-medium">{t(crashed ? 'isolation.crashed' : 'isolation.failedStart', { name: pluginName(plugin, t) })}</p>
        {canGoBack || canRepair ? <div className="flex flex-wrap gap-2">
          {canGoBack ? <DsButton size="sm" variant="outline" disabled={!!busy} onClick={() => { void recover(plugin.id, false); }}>{t('isolation.rollback')}</DsButton> : null}
          {canRepair ? <DsButton size="sm" variant="outline" disabled={!!busy} onClick={() => { void recover(plugin.id, true); }}>{t('isolation.repair')}</DsButton> : null}
        </div> : null}
        {raw ? <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manager.technical')}</summary>
          <p className="mt-1 break-words font-mono">{raw}</p>
        </details> : null}
      </div>;
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <PluginManagerPanel {...props} />
  </div>;
}
