import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ArrowLeft, QrCode, Plug, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Badge } from '@/components/ui/shad/Badge';
import { Switch } from '@/components/ui/shad/Switch';
import { UnifiedModelSelector } from '@/components/shared/UnifiedModelSelector';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { SettingSection, settingsQuietInteractiveRowClassName } from '../SettingsCommon';
import { SettingRow, SettingsGroup, SwitchRow } from '../settingsTabPrimitives';
import {
  pluginsApi,
  PLUGIN_EVENTS,
  type IlinkBotConfig,
  type PluginInfo,
  type PluginState,
  type PluginStatusSnapshot,
} from '../../api/pluginsApi';

type UnifiedModelInfo = {
  id: string;
  name: string;
  vendorName?: string;
  providerType?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
};

interface IlinkBotConfigPanelProps {
  plugin: PluginInfo;
  models: UnifiedModelInfo[];
  onBack: () => void;
  onPluginChange: () => void;
}

function stateBadgeVariant(state: PluginState): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'running':
      return 'default';
    case 'error':
      return 'destructive';
    case 'waiting_login':
    case 'starting':
    case 'stopping':
      return 'secondary';
    default:
      return 'outline';
  }
}

export const IlinkBotConfigPanel: React.FC<IlinkBotConfigPanelProps> = ({
  plugin,
  models,
  onBack,
  onPluginChange,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [config, setConfig] = useState<IlinkBotConfig | null>(null);
  const [status, setStatus] = useState<PluginStatusSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [unbindOpen, setUnbindOpen] = useState(false);
  const [activityLog, setActivityLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([
        pluginsApi.getConfig(plugin.id),
        pluginsApi.getStatus(plugin.id),
      ]);
      setConfig(cfg);
      setStatus(st);
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e));
    }
  }, [plugin.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      const u1 = await listen<{ pluginId: string; state: PluginState; error?: string }>(
        PLUGIN_EVENTS.stateChanged,
        (ev) => {
          if (ev.payload.pluginId !== plugin.id) return;
          void refresh();
          onPluginChange();
        },
      );
      const u2 = await listen<{
        pluginId: string;
        pngBase64: string;
        status: string;
      }>(PLUGIN_EVENTS.qrcode, (ev) => {
        if (ev.payload.pluginId !== plugin.id) return;
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                qrcodePngBase64: ev.payload.pngBase64,
                qrcodeStatus: ev.payload.status,
                state: 'waiting_login',
              }
            : prev,
        );
      });
      const u3 = await listen<{ pluginId: string; kind: string; summary: string }>(
        PLUGIN_EVENTS.activity,
        (ev) => {
          if (ev.payload.pluginId !== plugin.id) return;
          setActivityLog((prev) => [ev.payload.summary, ...prev].slice(0, 12));
          void refresh();
        },
      );
      if (cancelled) {
        u1();
        u2();
        u3();
        return;
      }
      unlisteners = [u1, u2, u3];
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [plugin.id, refresh, onPluginChange]);

  const currentState = status?.state ?? plugin.state;

  const stateLabel = useMemo(
    () => t(`settings:plugins.states.${currentState}`, currentState),
    [currentState, t],
  );

  const saveConfig = async (patch: Partial<IlinkBotConfig> & Record<string, unknown>) => {
    setBusy(true);
    try {
      await pluginsApi.setConfig(plugin.id, patch);
      await refresh();
      onPluginChange();
      showGlobalNotification('success', t('settings:plugins.saved'));
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const bound = status?.bound ?? config?.bound ?? plugin.bound;
  const enabled = status?.enabled ?? config?.enabled ?? plugin.enabled;
  const qrPng = status?.qrcodePngBase64;
  const waitingLogin = currentState === 'waiting_login' || Boolean(qrPng && !bound);

  const toggleEnabled = async (next: boolean) => {
    setBusy(true);
    try {
      await pluginsApi.setEnabled(plugin.id, next);
      await refresh();
      onPluginChange();
      showGlobalNotification(
        'success',
        next ? t('settings:plugins.resume') : t('settings:plugins.pause'),
      );
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div className="py-10 text-sm text-muted-foreground">{t('common:loading')}</div>
    );
  }

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <SettingSection title={plugin.label} hideHeader>
        {/* 子页头部：插件名 + 返回列表 */}
        <div className="flex flex-wrap items-start justify-between gap-2 px-1">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">{plugin.label}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
              {plugin.blurb}
            </p>
          </div>
          <DsButton variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t('settings:plugins.back_to_list')}
          </DsButton>
        </div>

        {/* 连接 */}
        <SettingsGroup
          title={t('settings:plugins.connection_title')}
          actions={<Badge variant={stateBadgeVariant(currentState)}>{stateLabel}</Badge>}
        >
          {!bound && !waitingLogin && (
            <div className="space-y-3 px-1 py-2.5">
              <p className="text-xs leading-relaxed text-muted-foreground/70">
                {t('settings:plugins.binding_hint')}
              </p>
              <DsButton
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await pluginsApi.beginLogin(plugin.id);
                    await refresh();
                    onPluginChange();
                  } catch (e) {
                    showGlobalNotification('error', getErrorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <QrCode className="w-4 h-4 mr-1" />
                {t('settings:plugins.scan_qr')}
              </DsButton>
            </div>
          )}

          {waitingLogin && (
            <div className="flex flex-col items-center gap-3 px-1 py-4">
              {qrPng ? (
                <img
                  src={`data:image/png;base64,${qrPng}`}
                  alt="WeChat QR"
                  className="w-52 h-52 rounded-md bg-white p-2 border border-border/40"
                />
              ) : (
                <div className="w-52 h-52 rounded-md border border-dashed border-border/60 flex items-center justify-center text-xs text-muted-foreground/70">
                  {t('settings:plugins.qr_loading')}
                </div>
              )}
              <p className="text-sm text-center text-foreground/90">
                {t(`settings:plugins.qr_status.${status?.qrcodeStatus || 'wait'}`, {
                  defaultValue: t('settings:plugins.qr_status.wait'),
                })}
              </p>
              <DsButton
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await pluginsApi.cancelLogin(plugin.id);
                    await refresh();
                    onPluginChange();
                  } catch (e) {
                    showGlobalNotification('error', getErrorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('settings:plugins.cancel_scan')}
              </DsButton>
            </div>
          )}

          {bound && !waitingLogin && (
            <>
              <SettingRow title={t('settings:plugins.user_id')}>
                <code className="text-xs text-muted-foreground break-all md:pt-2 inline-block">
                  {status?.userId || config.userId || '—'}
                </code>
              </SettingRow>
              <SettingRow title={t('settings:plugins.account_id')}>
                <code className="text-xs text-muted-foreground break-all md:pt-2 inline-block">
                  {status?.accountId || config.accountId || '—'}
                </code>
              </SettingRow>
              <SwitchRow
                title={t('settings:plugins.enable_switch')}
                description={t('settings:plugins.bound_running_hint')}
                checked={enabled}
                disabled={busy}
                onCheckedChange={toggleEnabled}
              />
              <div className="px-1 py-2.5">
                <DsButton
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setUnbindOpen(true)}
                >
                  {t('settings:plugins.rebind')}
                </DsButton>
              </div>
            </>
          )}
        </SettingsGroup>

        {/* 回复设置 */}
        <SettingsGroup title={t('settings:plugins.reply_title')}>
          <SettingRow
            title={t('settings:plugins.model')}
            description={t('settings:plugins.model_desc')}
          >
            <div className="w-full md:w-[280px]">
              <UnifiedModelSelector
                models={models}
                value={config.modelConfigId || ''}
                onChange={(id) => {
                  setConfig((c) => (c ? { ...c, modelConfigId: id } : c));
                  void saveConfig({ modelConfigId: id });
                }}
                placeholder={t('settings:plugins.model_fallback')}
                allowEmpty
                emptyLabel={t('settings:plugins.model_fallback')}
              />
            </div>
          </SettingRow>

          <SettingRow
            title={t('settings:plugins.rate_limit')}
            description={t('settings:plugins.rate_limit_desc')}
          >
            <Input
              type="number"
              min={1}
              max={120}
              className="h-11 !w-28 bg-transparent text-xs md:h-8 md:!w-24"
              value={config.rateLimitPerMin}
              onChange={(e) =>
                setConfig((c) =>
                  c ? { ...c, rateLimitPerMin: Number(e.target.value) || 10 } : c,
                )
              }
              onBlur={() => void saveConfig({ rateLimitPerMin: config.rateLimitPerMin })}
            />
          </SettingRow>

          <div className="px-1 py-2.5 space-y-2">
            <h3 className="text-sm text-foreground/90 leading-tight">
              {t('settings:plugins.system_prompt')}
            </h3>
            <Textarea
              value={config.systemPrompt}
              onChange={(e) =>
                setConfig((c) => (c ? { ...c, systemPrompt: e.target.value } : c))
              }
              onBlur={() => void saveConfig({ systemPrompt: config.systemPrompt })}
              rows={3}
              placeholder={t('settings:plugins.system_prompt_placeholder')}
            />
          </div>
        </SettingsGroup>

        {/* 错误与最近活动 */}
        {(status?.lastError || plugin.error) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <WarningCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="break-all">{status?.lastError || plugin.error}</span>
          </div>
        )}

        {(activityLog.length > 0 || status?.lastActivity) && (
          <SettingsGroup title={t('settings:plugins.activity')}>
            <ul className="px-1 py-1 text-xs leading-relaxed text-muted-foreground/70 space-y-1 max-h-40 overflow-auto">
              {(activityLog.length > 0 ? activityLog : [status?.lastActivity ?? '']).map(
                (line, i) => (
                  <li key={`${i}-${line}`} className="truncate">
                    {line}
                  </li>
                ),
              )}
            </ul>
          </SettingsGroup>
        )}
      </SettingSection>

      <DsAlertDialog
        open={unbindOpen}
        onOpenChange={setUnbindOpen}
        title={t('settings:plugins.rebind_confirm_title')}
        description={t('settings:plugins.rebind_confirm_desc')}
        confirmText={t('settings:plugins.rebind')}
        cancelText={t('common:cancel')}
        onConfirm={async () => {
          setBusy(true);
          try {
            await pluginsApi.unbind(plugin.id);
            await refresh();
            onPluginChange();
            showGlobalNotification('success', t('settings:plugins.ready_to_rebind'));
          } catch (e) {
            showGlobalNotification('error', getErrorMessage(e));
          } finally {
            setBusy(false);
            setUnbindOpen(false);
          }
        }}
      />
    </div>
  );
};

function pluginDisplayState(p: PluginInfo): { key: string; variant: ReturnType<typeof stateBadgeVariant> } {
  if (p.state === 'error') return { key: 'states.error', variant: 'destructive' };
  if (!p.bound) return { key: 'unbound', variant: 'outline' };
  return { key: `states.${p.state}`, variant: stateBadgeVariant(p.state) };
}

interface PluginsTabProps {
  models: UnifiedModelInfo[];
}

export const PluginsTab: React.FC<PluginsTabProps> = ({ models }) => {
  const { t } = useTranslation(['settings', 'common']);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const list = await pluginsApi.list();
      setPlugins(list);
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen(PLUGIN_EVENTS.stateChanged, () => {
      void refreshList();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshList]);

  const toggleEnabled = async (p: PluginInfo, next: boolean) => {
    setTogglingId(p.id);
    try {
      await pluginsApi.setEnabled(p.id, next);
      await refreshList();
      showGlobalNotification(
        'success',
        next ? t('settings:plugins.resume') : t('settings:plugins.pause'),
      );
    } catch (e) {
      showGlobalNotification('error', getErrorMessage(e));
    } finally {
      setTogglingId(null);
    }
  };

  const selected = plugins.find((p) => p.id === selectedId) || null;

  if (selected) {
    return (
      <IlinkBotConfigPanel
        plugin={selected}
        models={models}
        onBack={() => setSelectedId(null)}
        onPluginChange={() => void refreshList()}
      />
    );
  }

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <SettingSection
        title={t('settings:plugins.title')}
        description={t('settings:plugins.description')}
        hideHeader
      >
        <SettingsGroup
          title={t('settings:plugins.title')}
          description={t('settings:plugins.description')}
        >
          {loading ? (
            <p className="px-1 py-2.5 text-sm text-muted-foreground">
              {t('common:loading')}
            </p>
          ) : plugins.length === 0 ? (
            <p className="px-1 py-2.5 text-sm text-muted-foreground">
              {t('settings:plugins.empty')}
            </p>
          ) : (
            plugins.map((p) => {
              const display = pluginDisplayState(p);
              return (
                <div
                  key={p.id}
                  className={cn(
                    'group flex items-center gap-3 px-1 py-2.5',
                    settingsQuietInteractiveRowClassName,
                  )}
                >
                  <DsButton
                    variant="ghost"
                    className="flex h-auto min-w-0 flex-1 items-center justify-start gap-3 border-0 p-0 text-left whitespace-normal !bg-transparent hover:!bg-transparent"
                    onClick={() => setSelectedId(p.id)}
                  >
                    <div className="rounded-md bg-muted p-2 shrink-0">
                      <Plug className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-foreground/90 leading-tight">
                          {p.label}
                        </span>
                        <Badge variant={display.variant}>
                          {t(`settings:plugins.${display.key}`, display.key)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground/70 md:line-clamp-2">
                        {p.bound ? p.blurb : t('settings:plugins.bind_first_hint')}
                      </p>
                    </div>
                  </DsButton>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={p.enabled && p.bound}
                      disabled={!p.bound || togglingId === p.id}
                      onCheckedChange={(next) => void toggleEnabled(p, next)}
                      aria-label={t('settings:plugins.enable_switch')}
                    />
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedId(p.id)}
                    >
                      {t('settings:plugins.configure')}
                    </DsButton>
                  </div>
                </div>
              );
            })
          )}
        </SettingsGroup>
      </SettingSection>
    </div>
  );
};
