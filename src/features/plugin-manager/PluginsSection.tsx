import React, { useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { PluginManagerPanel, type PluginManagerPanelProps } from './PluginManagerPanel';
import { usePluginManagerState } from './controller';
import { usePluginErrorBudget } from './use-error-budget';
import { usePluginUiHostStatus } from './use-ui-status';
import { usePluginManagerWorkshop } from './workshop';

export interface PluginsSectionProps extends PluginManagerPanelProps {
  /** Restore is supplied by the version owner; no invented Host command or optimistic success. */
  onRollback?: (pluginId: string) => Promise<void>;
}

/** Settings mount point with live Host/UI-budget isolation notices above the manager. */
export function PluginsSection({ onRollback, ...props }: PluginsSectionProps) {
  const state = usePluginManagerState(props.controller);
  const disabled = usePluginErrorBudget(props.errorBudget);
  const status = usePluginUiHostStatus(props.uiStatus);
  const registeredWorkshop = usePluginManagerWorkshop();
  const workshop = props.workshop ?? registeredWorkshop;
  const rollback = onRollback ?? workshop?.onRollback;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const isolated = state.plugins.filter(plugin => plugin.origin === 'community' && (
    disabled.some(entry => entry.pluginId === plugin.id)
    || plugin.degraded && plugin.consent !== 'required' && !plugin.degraded.reason.startsWith('CONSENT_REQUIRED:')
    || status?.state(plugin.id) === 'degraded' && !status.consentRequired(plugin.id)
  ));
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
        if (current.plugins.find(plugin => plugin.id === id)?.enabled !== false) throw new Error('未能确认插件已停用，请刷新后重试');
        workshop?.onModify(id);
      } else {
        await rollback?.(id);
        await props.controller.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(undefined);
    }
  };
  return <div className="space-y-3">
    {isolated.map(plugin => <div key={plugin.id} role="alert" className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
      <p className="font-medium">检测到插件异常，系统已自动隔离该插件以保护主程序稳定运行</p>
      <p className="break-words text-muted-foreground">{plugin.displayName ?? plugin.id} · {plugin.degraded?.reason ?? status?.reason(plugin.id) ?? 'UI 错误预算已耗尽'}</p>
      <div className="flex flex-wrap gap-2">
        <DsButton size="sm" variant="outline" disabled={!!busy || !rollback} title={!rollback ? '此插件尚无可用的版本回退入口' : undefined} onClick={() => { void recover(plugin.id, false); }}>一键回退上一可用版本</DsButton>
        <DsButton size="sm" variant="outline" disabled={!!busy || !workshop || plugin.source !== 'workshop'} title={plugin.source !== 'workshop' ? 'AI 修复仅适用于插件工坊托管的作品' : undefined} onClick={() => { void recover(plugin.id, true); }}>停用并让 AI 修复</DsButton>
      </div>
    </div>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <PluginManagerPanel {...props} />
  </div>;
}
