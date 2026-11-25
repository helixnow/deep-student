import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, ShieldChevron, WarningCircle } from '@phosphor-icons/react';

import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';

import { errorMessage, type PluginManagerController } from './controller';
import { createHostPluginManagerAdapter } from './host-adapter';
import { pluginName } from './presentation';
import { describePluginFault, type PluginErrorBudgetView } from './reasons';
import { succeeded } from './result';
import { exitSafeModeAndRestart } from './safeMode';
import type { ManagedPlugin, PluginManagerAdapter } from './types';
import { pluginUiStatus, type PluginUiHostStatus } from './ui-status';
import { usePluginErrorBudget } from './use-error-budget';
import { usePluginUiHostStatus } from './use-ui-status';

const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

export interface SafeModeExitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-loaded plugin list (e.g. from PluginManagerPanel). When omitted, loads via adapter on open. */
  plugins?: readonly ManagedPlugin[];
  /** Optional controller used to persist disable actions before normal restart. */
  controller?: PluginManagerController;
  /** Optional W17 host status handle for live degraded signals. */
  uiStatus?: PluginUiHostStatus | null;
  /** Optional UI error budget handle for auto-uninstalled / crashed plugins. */
  errorBudget?: PluginErrorBudgetView | null;
  /** Optional adapter override when mounted standalone (outside PluginManagerPanel). */
  adapter?: PluginManagerAdapter;
  /** Optional exit handler override (defaults to `exitSafeModeAndRestart`). */
  onExit?: () => Promise<void> | void;
}

interface CommunityPluginEntry {
  readonly plugin: ManagedPlugin;
  readonly name: string;
  readonly fault: ReturnType<typeof describePluginFault>;
  readonly statusKind: 'faulted' | 'will-enable' | 'quarantined';
}

export function SafeModeExitDialog({
  open,
  onOpenChange,
  plugins: injectedPlugins,
  controller,
  uiStatus,
  errorBudget,
  adapter: injectedAdapter,
  onExit,
}: SafeModeExitDialogProps) {
  const { t } = useTranslation('plugin_manager');
  const titleId = useId();
  const hostStatus = usePluginUiHostStatus(uiStatus);
  const autoUninstalled = usePluginErrorBudget(errorBudget);
  const standaloneAdapterRef = useRef<PluginManagerAdapter | null>(null);
  const getStandaloneAdapter = useCallback(() => {
    if (injectedAdapter) return injectedAdapter;
    if (!standaloneAdapterRef.current) {
      standaloneAdapterRef.current = createHostPluginManagerAdapter('desktop');
    }
    return standaloneAdapterRef.current;
  }, [injectedAdapter]);

  const [loadedPlugins, setLoadedPlugins] = useState<readonly ManagedPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedToDisable, setSelectedToDisable] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const initializedSelectionRef = useRef(false);

  const sourcePlugins = injectedPlugins ?? loadedPlugins;
  const inventoryReady = injectedPlugins !== undefined || loadedOnce;
  const showLoading = loading || (open && !inventoryReady && !loadError);

  useEffect(() => {
    if (!open) {
      initializedSelectionRef.current = false;
      setLoadedOnce(false);
      setLoadedPlugins([]);
      setActionError(null);
      setLoadError(null);
      setSubmitting(false);
      return;
    }
    if (injectedPlugins !== undefined) return;
    let active = true;
    setLoading(true);
    setLoadedOnce(false);
    setLoadError(null);
    getStandaloneAdapter()
      .list()
      .then((snapshot) => {
        if (!active) return;
        setLoadedPlugins(snapshot.plugins);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setLoadedOnce(true);
        }
      });
    return () => {
      active = false;
    };
  }, [open, injectedPlugins, getStandaloneAdapter]);

  const communityEntries = useMemo<CommunityPluginEntry[]>(() => {
    const entries = sourcePlugins
      .filter((plugin) => plugin.origin === 'community')
      .map((plugin): CommunityPluginEntry => {
        const uiSnap = pluginUiStatus(hostStatus, plugin.id);
        const auto = autoUninstalled.find((item) => item.pluginId === plugin.id) ?? null;
        const fault = describePluginFault(t, {
          degradedReason: plugin.degraded?.reason,
          uiDegraded: uiSnap?.degraded,
          runtime: plugin.runtime,
          runtimeDetail: plugin.runtimeDetail,
          autoUninstalled: auto,
        });
        const statusKind: CommunityPluginEntry['statusKind'] = fault
          ? 'faulted'
          : plugin.enabled
            ? 'will-enable'
            : 'quarantined';
        return {
          plugin,
          name: pluginName(plugin, t),
          fault,
          statusKind,
        };
      });

    const rank = { faulted: 0, 'will-enable': 1, quarantined: 2 } as const;
    return entries.sort((a, b) => rank[a.statusKind] - rank[b.statusKind] || a.name.localeCompare(b.name));
  }, [sourcePlugins, hostStatus, autoUninstalled, t]);

  const enabledEntries = useMemo(
    () => communityEntries.filter((entry) => entry.plugin.enabled),
    [communityEntries],
  );
  const faultedEntries = useMemo(
    () => communityEntries.filter((entry) => entry.statusKind === 'faulted'),
    [communityEntries],
  );

  // Pre-select any enabled faulted plugins so normal startup won't immediately re-trigger a crash.
  useEffect(() => {
    if (!open || !inventoryReady || initializedSelectionRef.current) return;
    initializedSelectionRef.current = true;
    const defaultIds = communityEntries
      .filter((entry) => entry.plugin.enabled && entry.statusKind === 'faulted')
      .map((entry) => entry.plugin.id);
    setSelectedToDisable(new Set(defaultIds));
  }, [open, inventoryReady, communityEntries]);

  const allEnabledSelected =
    enabledEntries.length > 0 && enabledEntries.every((entry) => selectedToDisable.has(entry.plugin.id));

  const togglePluginSelection = (pluginId: string) => {
    setSelectedToDisable((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });
  };

  const toggleDisableAll = () => {
    if (allEnabledSelected) {
      setSelectedToDisable(new Set());
    } else {
      setSelectedToDisable(new Set(enabledEntries.map((entry) => entry.plugin.id)));
    }
  };

  const applyDisablesAndExit = async (idsToDisable: readonly string[]) => {
    if (submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      for (const id of idsToDisable) {
        const entry = communityEntries.find((item) => item.plugin.id === id);
        const label = entry?.name ?? id;
        if (controller) {
          await controller.setEnabled(id, false);
          const snap = controller.getSnapshot();
          if (snap.error) {
            setActionError(
              t('safeMode.exitDialog.disableFailed', {
                name: label,
                detail: snap.error.detail ?? snap.error.code,
              }),
            );
            return;
          }
        } else {
          const result = await getStandaloneAdapter().setEnabled(id, false);
          if (!succeeded(result)) {
            const detail = 'detail' in result && result.detail ? result.detail : result.code;
            setActionError(t('safeMode.exitDialog.disableFailed', { name: label, detail }));
            return;
          }
        }
      }
      onOpenChange(false);
      await (onExit ? onExit() : exitSafeModeAndRestart());
    } catch (error) {
      const firstId = idsToDisable[0] ?? '';
      const firstName = communityEntries.find((item) => item.plugin.id === firstId)?.name ?? firstId;
      setActionError(
        t('safeMode.exitDialog.disableFailed', {
          name: firstName,
          detail: errorMessage(error),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const selectedEnabledIds = enabledEntries
    .map((entry) => entry.plugin.id)
    .filter((id) => selectedToDisable.has(id));

  return (
    <DsDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onOpenChange(false);
      }}
      aria-labelledby={titleId}
      maxWidth="max-w-xl"
      showClose={!submitting}
      closeOnOverlay={!submitting}
    >
      <div data-testid="safe-mode-exit-dialog" className="flex min-h-0 flex-col">
        <DsDialogHeader>
          <DsDialogTitle id={titleId} className="flex items-center gap-2">
            <ShieldChevron className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{t('safeMode.exitDialog.title')}</span>
          </DsDialogTitle>
          <DsDialogDescription>{t('safeMode.exitDialog.description')}</DsDialogDescription>
        </DsDialogHeader>

        <DsDialogBody className="space-y-3 py-4">
          {showLoading ? (
            <p role="status" data-testid="safe-mode-exit-loading" className="text-xs text-muted-foreground">
              {t('safeMode.exitDialog.loading')}
            </p>
          ) : null}

          {loadError ? (
            <div
              role="alert"
              data-testid="safe-mode-exit-load-error"
              className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground"
            >
              {t('safeMode.exitDialog.loadError', { detail: loadError })}
            </div>
          ) : null}

          {actionError ? (
            <div
              role="alert"
              data-testid="safe-mode-exit-error"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
            >
              <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{actionError}</span>
            </div>
          ) : null}

          {!showLoading && communityEntries.length === 0 && !loadError ? (
            <div
              data-testid="safe-mode-exit-empty"
              className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-xs text-foreground"
            >
              <CheckCircle className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              <span>{t('safeMode.exitDialog.empty')}</span>
            </div>
          ) : null}

          {!showLoading && communityEntries.length > 0 ? (
            <>
              {faultedEntries.length > 0 ? (
                <div
                  role="alert"
                  data-testid="safe-mode-exit-fault-warning"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
                >
                  <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 leading-relaxed">
                    {t('safeMode.exitDialog.faultWarning', { count: faultedEntries.length })}
                  </span>
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground" data-testid="safe-mode-exit-summary">
                  {enabledEntries.length > 0
                    ? t('safeMode.exitDialog.activeNotice', {
                        enabledCount: enabledEntries.length,
                        totalCount: communityEntries.length,
                      })
                    : t('safeMode.exitDialog.allDisabledNotice', { totalCount: communityEntries.length })}
                </p>
              )}

              {enabledEntries.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/60 px-3 py-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    data-testid="safe-mode-exit-disable-all"
                    checked={allEnabledSelected}
                    disabled={submitting}
                    onChange={toggleDisableAll}
                    className="size-3.5 accent-primary"
                  />
                  <span>{t('safeMode.exitDialog.disableAllLabel', { count: enabledEntries.length })}</span>
                </label>
              ) : null}

              <ul
                data-testid="safe-mode-exit-plugin-list"
                className="max-h-60 space-y-2 overflow-y-auto pr-0.5"
              >
                {communityEntries.map(({ plugin, name, fault, statusKind }) => {
                  const isFaulted = statusKind === 'faulted';
                  const checked = plugin.enabled && selectedToDisable.has(plugin.id);
                  return (
                    <li
                      key={plugin.id}
                      data-testid="safe-mode-exit-plugin-item"
                      data-plugin-id={plugin.id}
                      data-faulted={isFaulted ? 'true' : 'false'}
                      data-enabled={plugin.enabled ? 'true' : 'false'}
                      className={cn(
                        'rounded-lg border p-2.5 text-xs',
                        isFaulted
                          ? 'border-destructive/40 bg-destructive/5'
                          : 'border-border/60 bg-muted/40',
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          data-testid={`safe-mode-exit-disable-${plugin.id}`}
                          aria-label={t('safeMode.exitDialog.pluginCheckboxLabel', { name })}
                          checked={checked}
                          disabled={!plugin.enabled || submitting}
                          onChange={() => togglePluginSelection(plugin.id)}
                          className="mt-0.5 size-3.5 shrink-0 accent-primary"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                              {name}
                              {plugin.version && plugin.version !== '—' ? (
                                <span className="ml-1.5 font-normal text-muted-foreground">v{plugin.version}</span>
                              ) : null}
                            </span>
                            <span
                              data-testid="safe-mode-exit-plugin-status"
                              className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                                isFaulted
                                  ? 'bg-destructive/15 text-destructive'
                                  : plugin.enabled
                                    ? 'bg-warning/15 text-warning'
                                    : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {isFaulted
                                ? t('safeMode.exitDialog.statusFaulted')
                                : plugin.enabled
                                  ? t('safeMode.exitDialog.statusWillEnable')
                                  : t('safeMode.exitDialog.statusQuarantined')}
                            </span>
                          </div>
                          {fault ? (
                            <p
                              data-testid="safe-mode-exit-plugin-fault"
                              className="break-words leading-relaxed text-destructive"
                            >
                              {fault.label}
                              {fault.detail ? `：${fault.detail}` : ''}
                            </p>
                          ) : null}
                          {checked ? (
                            <p className="text-xs text-muted-foreground">
                              {t('safeMode.exitDialog.disableHintSelected')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </DsDialogBody>

        <DsDialogFooter className="flex-wrap gap-2">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            data-testid="safe-mode-exit-cancel"
            className={COARSE_TOUCH}
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('safeMode.exitDialog.cancel')}
          </DsButton>
          {enabledEntries.length > 0 && !allEnabledSelected ? (
            <DsButton
              type="button"
              variant="outline"
              size="sm"
              data-testid="safe-mode-exit-keep-disabled"
              className={COARSE_TOUCH}
              disabled={submitting || showLoading}
              onClick={() => {
                void applyDisablesAndExit(enabledEntries.map((entry) => entry.plugin.id));
              }}
            >
              {t('safeMode.exitDialog.keepAllDisabledButton')}
            </DsButton>
          ) : null}
          <DsButton
            type="button"
            variant="primary"
            size="sm"
            data-testid="safe-mode-exit-confirm"
            className={COARSE_TOUCH}
            disabled={submitting || showLoading}
            onClick={() => {
              void applyDisablesAndExit(selectedEnabledIds);
            }}
          >
            {submitting
              ? t('safeMode.exitDialog.working')
              : selectedEnabledIds.length > 0
                ? t('safeMode.exitDialog.confirmDisableAndExit', { count: selectedEnabledIds.length })
                : t('safeMode.exitDialog.confirmExit')}
          </DsButton>
        </DsDialogFooter>
      </div>
    </DsDialog>
  );
}
