/**
 * W35 channel plugins inside 插件管理.
 *
 * The legacy WeChat channel page (`settings/tabs/plugins`) used to be its own sidebar entry and only
 * hosted the iLink Bot. The manager now surfaces the same host channel inventory in-place, so the
 * user binds/toggles/configures the bot without leaving 插件管理. Host access stays behind
 * `pluginsApi`; this file owns no command strings and never fabricates state.
 */
import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Plug, QrCode, WarningCircle } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogBody } from '@/components/ui/DsDialog';
import { Badge } from '@/components/ui/shad/Badge';
import { Switch } from '@/components/ui/shad/Switch';
import { SettingsGroup } from '@/components/settings';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/lib/utils';
import type { UnifiedModelInfo } from '@/features/settings/components/plugins/PluginsTab';
import {
  pluginsApi,
  PLUGIN_EVENTS,
  type PluginInfo,
  type PluginState,
} from '@/features/settings/api/pluginsApi';

/**
 * The legacy channel page owns the QR/config markup. Load it only when the dialog opens so the
 * manager chunk does not drag its model selector and i18n plumbing into every settings render.
 */
const IlinkBotConfigPanel = lazy(() =>
  import('@/features/settings/components/plugins/PluginsTab').then((module) => ({ default: module.IlinkBotConfigPanel })));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
}

/** Channel plugins currently exposed by the host; both historical spellings are accepted. */
const CHANNEL_PLUGIN_IDS = new Set(['ilinkbot', 'dstu.ilink', 'ilink_bot']);

export function isChannelPluginId(id: string): boolean {
  return CHANNEL_PLUGIN_IDS.has(id);
}

/** Match a manager plugin id to the host channel entry, tolerating the legacy `dstu.ilink` spelling. */
export function findChannelPlugin(channel: ChannelPlugins, id: string): PluginInfo | undefined {
  return channel.plugins.find((entry) => entry.id === id)
    ?? (isChannelPluginId(id) ? channel.plugins.find((entry) => isChannelPluginId(entry.id)) : undefined);
}

function stateVariant(state: PluginState): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (state === 'running') return 'default';
  if (state === 'error') return 'destructive';
  if (state === 'waiting_login' || state === 'starting' || state === 'stopping') return 'secondary';
  return 'outline';
}

/** Host channel inventory shared by the inline section and the official-list entry point. */
export interface ChannelPlugins {
  plugins: PluginInfo[];
  loading: boolean;
  busyId?: string;
  refresh: () => Promise<void>;
  setEnabled: (plugin: PluginInfo, enabled: boolean) => Promise<void>;
  beginLogin: (plugin: PluginInfo) => Promise<void>;
}

/**
 * `enabled` is false on mobile, where channel configuration stays desktop-only (same rule as the
 * legacy page). A failing `plugin_list` degrades to an empty list: the manager itself must stay usable.
 */
export function useChannelPlugins(enabled: boolean): ChannelPlugins {
  const { t } = useTranslation('plugin_manager');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [busyId, setBusyId] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const list = await pluginsApi.list();
      setPlugins(Array.isArray(list) ? list : []);
    } catch {
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen(PLUGIN_EVENTS.stateChanged, () => { void refresh(); })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, refresh]);

  const setEnabled = useCallback(async (plugin: PluginInfo, next: boolean) => {
    setBusyId(plugin.id);
    try {
      await pluginsApi.setEnabled(plugin.id, next);
      await refresh();
      showGlobalNotification('success', t(next ? 'notice.enabled' : 'notice.disabled', { id: plugin.label }));
    } catch (error) {
      showGlobalNotification('error', `${t('channel.error')}: ${errorText(error)}`);
    } finally {
      setBusyId(undefined);
    }
  }, [refresh, t]);

  const beginLogin = useCallback(async (plugin: PluginInfo) => {
    setBusyId(plugin.id);
    try {
      await pluginsApi.beginLogin(plugin.id);
      await refresh();
    } catch (error) {
      showGlobalNotification('error', `${t('channel.error')}: ${errorText(error)}`);
    } finally {
      setBusyId(undefined);
    }
  }, [refresh, t]);

  return { plugins, loading, busyId, refresh, setEnabled, beginLogin };
}

export interface ChannelPluginSectionProps {
  channel: ChannelPlugins;
  /** Open the full iLink configuration panel (QR login, model, rate limit, prompt). */
  onConfigure: (plugin: PluginInfo) => void;
  /** Start QR login, then open the panel that renders the code. */
  onBind: (plugin: PluginInfo) => void;
  className?: string;
}

/** Inline 渠道插件 group: status, QR bind, enable toggle and the configure entry point. */
export function ChannelPluginSection({ channel, onConfigure, onBind, className }: ChannelPluginSectionProps) {
  const { t } = useTranslation('plugin_manager');
  const { plugins, loading, busyId } = channel;

  return (
    <SettingsGroup title={t('channel.title')} description={t('channel.description')} className={className}>
      {loading ? (
        <p className="px-1 py-2.5 text-sm text-muted-foreground">{t('channel.loading')}</p>
      ) : plugins.length === 0 ? (
        <p className="px-1 py-2.5 text-sm text-muted-foreground">{t('channel.empty')}</p>
      ) : plugins.map((plugin) => {
        const busy = busyId === plugin.id;
        const unbound = !plugin.bound;
        return (
          <div
            key={plugin.id}
            role="listitem"
            data-testid="channel-plugin-row"
            data-plugin-id={plugin.id}
            data-bound={String(plugin.bound)}
            className="flex min-w-0 flex-col gap-2 px-1 py-2.5 md:flex-row md:items-start"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/80">
                <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 whitespace-normal break-words text-sm text-foreground/90 [overflow-wrap:anywhere]">
                    {plugin.label}
                  </span>
                  <Badge variant={stateVariant(plugin.state)} className="shrink-0">
                    {t(`channel.${plugin.bound ? 'bound' : 'unbound'}`)}
                  </Badge>
                  {plugin.error ? (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <WarningCircle className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{plugin.error}</span>
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 min-w-0 whitespace-normal break-words text-xs leading-relaxed text-muted-foreground/70 [overflow-wrap:anywhere]">
                  {plugin.blurb || t(unbound ? 'channel.bindHint' : 'channel.boundHint')}
                </p>
              </div>
            </div>
            <div className="flex min-h-11 flex-wrap items-center justify-end gap-2 md:w-auto md:flex-shrink-0">
              {unbound ? (
                <DsButton
                  variant="outline"
                  size="sm"
                  className="gap-1.5 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]"
                  disabled={busy}
                  onClick={() => onBind(plugin)}
                  data-testid="channel-bind"
                >
                  <QrCode className="size-4" aria-hidden="true" />
                  {t('channel.bind')}
                </DsButton>
              ) : null}
              <DsButton
                variant="outline"
                size="sm"
                className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]"
                disabled={busy}
                onClick={() => onConfigure(plugin)}
                aria-label={t('channel.configureA11y', { id: plugin.label })}
                data-testid="channel-configure"
              >
                {t('channel.configure')}
              </DsButton>
              <Switch
                checked={plugin.enabled && plugin.bound}
                disabled={busy || !plugin.bound}
                aria-label={t('channel.enableA11y', { id: plugin.label })}
                onCheckedChange={(next) => { void channel.setEnabled(plugin, next); }}
              />
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}

export interface ChannelPluginDialogProps {
  plugin: PluginInfo | null;
  models: readonly UnifiedModelInfo[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

/** Full iLink panel (QR login, enable, reply model, rate limit, system prompt) in a dialog. */
export function ChannelPluginDialog({ plugin, models, onOpenChange, onChanged }: ChannelPluginDialogProps) {
  const { t } = useTranslation('plugin_manager');
  return (
    <DsDialog
      open={plugin !== null}
      onOpenChange={onOpenChange}
      aria-label={plugin?.label ?? t('channel.title')}
      maxWidth="max-w-2xl"
      className={cn('md:ml-auto md:h-full md:!max-h-full')}
    >
      <DsDialogBody className="py-0">
        {plugin ? (
          <Suspense fallback={<p className="px-5 py-6 text-sm text-muted-foreground">{t('channel.loading')}</p>}>
            <IlinkBotConfigPanel
              plugin={plugin}
              models={[...models]}
              onBack={() => onOpenChange(false)}
              onPluginChange={onChanged}
            />
          </Suspense>
        ) : null}
      </DsDialogBody>
    </DsDialog>
  );
}
