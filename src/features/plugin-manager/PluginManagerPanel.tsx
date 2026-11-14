// RUST-FIX(RF-W35-plugin-manager-view): Rust 版只有设置里的「插件」页签（渠道插件登录/绑定），没有官方+社区插件管理视图。
// RUST-FIX(RF-P2-manager-redesign): 三视图、单状态摘要、详情与显式信任确认。
import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadSimple, ShieldChevron, WarningCircle, Sparkle } from '@phosphor-icons/react';

import { DsAlertDialog, DsDialog, DsDialogBody, DsDialogHeader, DsDialogTitle } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { SettingSection, SettingsGroup } from '@/components/settings';
import { Input } from '@/components/ui/shad/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { UnifiedModelInfo } from '@/features/settings/components/plugins/PluginsTab';
import type { PluginInfo } from '@/features/settings/api/pluginsApi';

import { ChannelPluginDialog, ChannelPluginSection, findChannelPlugin, useChannelPlugins } from './ChannelPluginSection';
import { ConfigForm } from './ConfigForm';
import { ConsentDialog } from './ConsentDialog';
import { InstallFeedback } from './InstallFeedback';
import { PluginRow } from './PluginRow';
import { PACKAGE_BUSY_KEY, usePluginManagerState, type PluginManagerController } from './controller';
import { errorBudgetOf, type PluginErrorBudgetView } from './reasons';
import type { ManagedPlugin } from './types';
import { pluginUiStatus, type PluginUiHostStatus } from './ui-status';
import { usePluginUiHostStatus } from './use-ui-status';
import { usePluginErrorBudget } from './use-error-budget';
import { pluginName, pluginDescription, pluginCategory, pluginNeedsAttention } from './presentation';
import { usePluginManagerWorkshop, type PluginManagerWorkshop } from './workshop';

export interface PluginManagerPanelProps {
  workshop?: PluginManagerWorkshop;
  controller: PluginManagerController;
  /** 内核 `UiErrorBudget`（结构类型）；缺省时不展示错误预算与自动卸载原因。 */
  errorBudget?: PluginErrorBudgetView | null;
  /** W17 `ctx.ui.hostStatus`（结构类型）；用于 UI 侧降级、同意与安全模式。 */
  uiStatus?: PluginUiHostStatus | null;
  /** 统一模型清单：渠道插件（微信 iLink Bot）的回复模型选择使用它。 */
  models?: readonly UnifiedModelInfo[];
  className?: string;
}

/** 设置分区里的一条列表：行本身用设置页的 quiet 行样式，空/加载文案与 PluginsTab 一致。 */
const LIST_EMPTY_CLASS = 'px-1 py-2.5 text-sm text-muted-foreground';
/** 粗指针（触屏）保底 44px 命中高度，与设置页按钮写法一致。 */
const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

/**
 * 插件管理视图（W35）。
 *
 * 只经 {@link PluginManagerController} 读数据/发动作：列表、启停、卸载、同意、配置与离线安装。
 * 官方与社区插件分开分组；`enabled`（已启用）与 `runtime`（运行中）分别展示，
 * 降级原因用 Host 的结构化错误码，自动卸载原因来自内核错误预算。
 *
 * 版式与设置页其它分区一致：`SettingSection` + `SettingsGroup` + quiet 行，
 * 不放自定义卡片、不硬编码颜色/尺寸；图标、字号层级与空/错误/加载状态照 PluginsTab。
 */
export function PluginManagerPanel({ controller, errorBudget, uiStatus, models, className, workshop: injectedWorkshop }: PluginManagerPanelProps) {
  const { t } = useTranslation('plugin_manager');
  const registeredWorkshop = usePluginManagerWorkshop();
  const workshop = injectedWorkshop ?? registeredWorkshop;
  const state = usePluginManagerState(controller);
  const autoUninstalled = usePluginErrorBudget(errorBudget);
  // W17 的清单/降级/同意/安全模式都可能晚于首帧到达，订阅后按当前值渲染。
  const hostStatus = usePluginUiHostStatus(uiStatus);
  const safeMode = state.safeMode || hostStatus?.safeMode === true;
  const [uninstallTarget, setUninstallTarget] = useState<ManagedPlugin | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [view, setView] = useState('installed');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trustTarget, setTrustTarget] = useState<{ plugin: ManagedPlugin; trust: 'full' | 'restricted'; enable?: boolean } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const configTitleId = useId();

  // 微信 iLink Bot 等渠道插件只在桌面端可配置（与旧「插件」页签的可见性规则一致）。
  const channelEnabled = (state.platform ?? 'desktop') !== 'mobile';
  const channel = useChannelPlugins(channelEnabled);
  const [channelTarget, setChannelTarget] = useState<PluginInfo | null>(null);
  const openChannel = useCallback((plugin: PluginInfo) => {
    controller.closeConfig();
    setSelectedId(null);
    setChannelTarget(plugin);
  }, [controller]);
  const closeChannel = useCallback(() => setChannelTarget(null), []);
  const channelChanged = useCallback(() => {
    void channel.refresh();
    void controller.refresh();
  }, [channel.refresh, controller]);

  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const notice = state.notice;
    if (!notice || notice.kind === 'package') return;
    const target = state.plugins.find((entry) => entry.id === notice.pluginId);
    const label = target ? pluginName(target, t) : notice.pluginId;
    const message = notice.kind === 'config-saved'
      ? t('notice.configSaved', { id: label, revision: notice.revision })
      : notice.kind === 'consent-granted'
        ? t('notice.consentGranted', { id: label })
        : t(notice.enabled ? 'notice.enabled' : 'notice.disabled', { id: label });
    showGlobalNotification('success', message);
    controller.dismissNotice();
  }, [controller, state.notice, state.plugins, t]);

  const filtered = state.plugins.filter((plugin) => {
    const matchesQuery = [pluginName(plugin, t), plugin.id, plugin.author, pluginDescription(plugin, t)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const problem = pluginNeedsAttention(plugin, pluginUiStatus(hostStatus, plugin.id)) || autoUninstalled.some((entry) => entry.pluginId === plugin.id);
    return matchesQuery && (filter === 'all' || filter === 'enabled' && plugin.enabled || filter === 'problem' && problem || filter === 'official' && plugin.origin === 'builtin');
  });
  const official = filtered.filter((plugin) => plugin.origin === 'builtin');
  const community = filtered.filter((plugin) => plugin.origin === 'community');
  const categories = [...new Set(official.map(pluginCategory))];
  const selected = state.plugins.find((plugin) => plugin.id === selectedId);
  const selectPlugin = (plugin: ManagedPlugin) => {
    // 官方列表里的 iLink（dstu.ilink / ilinkbot）没有通用 Config schema：直接进渠道配置面板。
    const channelPlugin = findChannelPlugin(channel, plugin.id);
    if (channelPlugin) {
      openChannel(channelPlugin);
      return;
    }
    setSelectedId(plugin.id);
    if (plugin.configurable !== false) void controller.openConfig(plugin.id);
    else controller.closeConfig();
  };
  const togglePlugin = (plugin: ManagedPlugin, enabled: boolean) => {
    if (enabled && plugin.origin === 'community' && plugin.trust === 'full') setTrustTarget({ plugin, trust: 'full', enable: true });
    else void controller.setEnabled(plugin.id, enabled);
  };

  const packageBusy = state.busy.includes(PACKAGE_BUSY_KEY);
  const config = state.config;
  const listLoading = state.status === 'loading' || state.status === 'idle';
  const noPlugins = !listLoading && state.plugins.length === 0;
  useRefreshOnReturn(() => controller.refresh(), !listLoading);

  const pageActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <DsButton variant="outline" size="sm" className={COARSE_TOUCH} onClick={workshop?.onCreate} disabled={!workshop} title={!workshop ? t('manager.workshopPending') : undefined}>
        <Sparkle className="size-4" aria-hidden="true" />{t('manager.create')}
      </DsButton>
      {view !== 'discover' ? <DsButton
        variant="outline"
        size="sm"
        className={COARSE_TOUCH}
        onClick={() => void controller.installPackage()}
        disabled={packageBusy}
      >
        <DownloadSimple className="size-4" aria-hidden="true" />
        {packageBusy ? t('install.running') : t('actions.install')}
      </DsButton> : null}
    </div>
  );

  const renderRows = (plugins: readonly ManagedPlugin[], label: string) => (
    <div role="list" aria-label={label} className="space-y-px">
      {plugins.map((plugin) => (
        <PluginRow
          compact
          onSelect={() => selectPlugin(plugin)}
          key={plugin.id}
          plugin={plugin}
          platform={state.platform ?? 'desktop'}
          busy={state.busy.includes(`plugin:${plugin.id}`) || state.consentBusy}
          errorBudget={errorBudgetOf(errorBudget, plugin.id, plugin.origin)}
          autoUninstalled={autoUninstalled.find((entry) => entry.pluginId === plugin.id) ?? null}
          uiStatus={pluginUiStatus(hostStatus, plugin.id)}
          safeMode={safeMode}
          onToggle={(enabled) => togglePlugin(plugin, enabled)}
          onConfigure={() => void controller.openConfig(plugin.id)}
          onUninstall={() => setUninstallTarget(plugin)}
          onReviewConsent={() => togglePlugin(plugin, true)}
        />
      ))}
    </div>
  );

  return (
    <div className={cn('space-y-1 pb-10 text-left ui-fade-in-slow', className)} data-testid="plugin-manager">
      <SettingSection title={t('title')} description={t('subtitle')} hideHeader>
        {safeMode ? (
          <div
            role="status"
            data-testid="plugin-safe-mode"
            className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
          >
            <ShieldChevron className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <div className="font-medium">{t('safeMode.title')}</div>
              <p className="text-xs leading-relaxed text-muted-foreground/80">{t('safeMode.description')}</p>
            </div>
          </div>
        ) : null}

        {state.error ? (
          <div
            role="alert"
            data-testid="plugin-manager-error"
            className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                <WarningCircle className="size-4 shrink-0" aria-hidden="true" />
                {state.error.code === 'LIST_FAILED'
                  ? t('error.list')
                  : state.error.code === 'RELOAD_FAILED'
                    ? t('error.reload')
                    : t('error.title')}
              </div>
              <p className="break-words text-xs leading-relaxed text-muted-foreground">
                {t('error.code', { code: state.error.code })}
                {state.error.detail ? `：${state.error.detail}` : ''}
              </p>
            </div>
            <DsButton variant="ghost" size="sm" className={COARSE_TOUCH} onClick={() => controller.clearError()}>
              {t('actions.dismiss')}
            </DsButton>
          </div>
        ) : null}

        {state.notice?.kind === 'package' ? (
          <InstallFeedback result={state.notice.result} onDismiss={() => controller.dismissNotice()} />
        ) : null}

        <SettingsGroup
          title={t('manager.browse')}
          description={t('subtitle')}
          actions={pageActions}
        >
          <SegmentedControl ariaLabel={t('title')} value={view} onValueChange={setView} size="compact" className="flex-wrap" options={['installed', 'discover', 'creations'].map(value => ({ value, label: t(`manager.${value}`) }))} />
        </SettingsGroup>

        {view === 'installed' ? <>
        <SettingsGroup title={t('manager.installed')}>
          <Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('manager.search')} placeholder={t('manager.search')} />
          <SegmentedControl ariaLabel={t('manager.installed')} value={filter} onValueChange={setFilter} size="compact" className="mt-3 flex-wrap" options={['all', 'enabled', 'problem', 'update', 'official'].map(value => ({ value, label: t(`manager.${value}`) }))} />
          {listLoading ? (
            <p role="status" className={LIST_EMPTY_CLASS}>
              {t('list.loading')}
            </p>
          ) : noPlugins ? (
            <p role="status" data-testid="plugin-manager-empty" className={LIST_EMPTY_CLASS}>
              {t('list.empty')}
            </p>
          ) : !filtered.length ? <p className={LIST_EMPTY_CLASS}>{t(filter === 'update' ? 'manager.updatesUnavailable' : 'manager.noMatches')}</p> : null}
        </SettingsGroup>
        {channelEnabled ? (
          <ChannelPluginSection
            channel={channel}
            onConfigure={openChannel}
            onBind={(plugin) => {
              setChannelTarget(plugin);
              void channel.beginLogin(plugin);
            }}
          />
        ) : null}
        {!listLoading && !noPlugins ? <>
          <SettingsGroup
            title={t('list.community')}
            actions={
              <span data-testid="plugin-count-community" className="text-xs tabular-nums text-muted-foreground/70">
                {community.length}
              </span>
            }
          >
            {community.length ? (
              renderRows(community, t('list.community'))
            ) : (
              <p className={LIST_EMPTY_CLASS}>{t('list.communityEmpty')}</p>
            )}
          </SettingsGroup>
          <SettingsGroup title={t('list.official')} actions={<span data-testid="plugin-count-builtin" className="text-xs text-muted-foreground">{official.length}</span>}>
            {categories.map(category => <details key={category} className="py-2">
              <summary className="cursor-pointer text-sm text-foreground/90 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]">{t(category, { defaultValue: category })} · {official.filter(plugin => pluginCategory(plugin) === category).length}</summary>
              {renderRows(official.filter(plugin => pluginCategory(plugin) === category), t(category, { defaultValue: category }))}
            </details>)}
          </SettingsGroup>
        </> : null}
        </> : view === 'discover' ? <>
          <SettingsGroup title={t('manager.offline')} description={t('manager.offlineDescription')}>
            <DsButton variant="outline" size="sm" disabled={packageBusy} onClick={() => void controller.installPackage()}><DownloadSimple className="size-4" />{t('actions.install')}</DsButton>
          </SettingsGroup>
          <SettingsGroup title={t('manager.index')}><p className={LIST_EMPTY_CLASS}>{t('manager.indexDescription')}</p></SettingsGroup>
        </> : workshop?.creations ?? <SettingsGroup title={t('manager.creations')}><p className={LIST_EMPTY_CLASS}>{t('manager.workshopPending')}</p></SettingsGroup>}
      </SettingSection>

      <ChannelPluginDialog
        plugin={channelTarget}
        models={models ?? []}
        onOpenChange={(open) => { if (!open) closeChannel(); }}
        onChanged={channelChanged}
      />

      <ConsentDialog
        subject={state.consent}
        busy={state.consentBusy}
        onConfirm={() => void controller.grantConsent()}
        onCancel={() => controller.dismissConsent()}
      />

      <DsAlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open && !uninstalling) setUninstallTarget(null);
        }}
        title={t('uninstall.title', { id: uninstallTarget ? pluginName(uninstallTarget, t) : '' })}
        description={`${uninstallTarget?.id ?? ''} · ${uninstallTarget?.version ?? ''} — ${t('uninstall.description')}`}
        loading={uninstalling}
        disabled={uninstalling}
        confirmText={t('uninstall.confirm')}
        cancelText={t('uninstall.cancel')}
        onConfirm={async () => {
          if (uninstalling) return;
          const target = uninstallTarget;
          if (!target) return;
          setUninstalling(true);
          try {
            await controller.uninstall(target.id);
            const error = controller.getSnapshot().error;
            showGlobalNotification(error ? 'error' : 'success', error ? error.detail ?? error.code : t('notice.uninstalled', { id: pluginName(target, t) }));
          } finally {
            setUninstalling(false);
            setUninstallTarget(null);
          }
        }}
        onCancel={() => { if (!uninstalling) setUninstallTarget(null); }}
      />

      <DsAlertDialog open={trustTarget !== null} onOpenChange={(open) => { if (!open && !trustBusy) setTrustTarget(null); }}
        title={t(trustTarget?.enable ? 'manager.fullEnable' : 'manager.changeTrust')}
        description={`${trustTarget?.plugin.id ?? ''} · ${trustTarget?.plugin.version ?? ''} · ${trustTarget?.plugin.permissions?.join(', ') ?? ''} — ${t(`manager.${trustTarget?.trust ?? 'restricted'}`)}: ${t(trustTarget?.trust === 'full' ? 'manager.fullRisk' : 'manager.restrictedNote')}`}
        loading={trustBusy} disabled={trustBusy} confirmText={t('manager.confirmTrust')} cancelText={t('uninstall.cancel')}
        onCancel={() => { if (!trustBusy) setTrustTarget(null); }}
        onConfirm={async () => {
          if (!trustTarget || trustBusy) return;
          setTrustBusy(true);
          try {
            if (trustTarget.enable) await controller.setEnabled(trustTarget.plugin.id, true);
            else if (trustTarget.plugin.permissions) await controller.setTrust({ id: trustTarget.plugin.id, version: trustTarget.plugin.version, permissions: trustTarget.plugin.permissions }, trustTarget.trust);
          } finally { setTrustBusy(false); setTrustTarget(null); }
        }} />

      <DsDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !(config?.status === 'ready' && config.saving)) { controller.closeConfig(); setSelectedId(null); }
        }}
        aria-labelledby={configTitleId}
        maxWidth="max-w-2xl"
        className="md:ml-auto md:h-full md:!max-h-full"
        showClose={config?.status !== 'ready' || !config.saving}
        closeOnOverlay={config?.status !== 'ready' || !config.saving}
      >
        {selected ? (
          <>
            <DsDialogHeader>
              <DsDialogTitle id={configTitleId}>{pluginName(selected, t)}</DsDialogTitle>
            </DsDialogHeader>
            <DsDialogBody className="space-y-5 py-4">
              <SettingsGroup title={t('manager.status')}>
                <PluginRow plugin={selected} platform={state.platform ?? 'desktop'} busy={state.busy.includes(`plugin:${selected.id}`) || state.consentBusy}
                  errorBudget={errorBudgetOf(errorBudget, selected.id, selected.origin)} autoUninstalled={autoUninstalled.find(entry => entry.pluginId === selected.id) ?? null}
                  uiStatus={pluginUiStatus(hostStatus, selected.id)} safeMode={safeMode}
                  onToggle={enabled => togglePlugin(selected, enabled)} onConfigure={() => void controller.openConfig(selected.id)}
                  onUninstall={() => setUninstallTarget(selected)} onReviewConsent={() => togglePlugin(selected, true)} />
                {selected.origin === 'community' ? <DsButton variant="outline" size="sm" disabled={!workshop} onClick={() => workshop?.onModify(selected.id)}><Sparkle className="size-4" />{t('manager.modify')}</DsButton> : null}
              </SettingsGroup>
              <SettingsGroup title={t('manager.trust')}>
                <p className={LIST_EMPTY_CLASS}>{selected.origin === 'builtin' ? t('manager.builtinTrust') : selected.trust ? t(`manager.${selected.trust}`) : t('manager.trustUnknown')}</p>
                {selected.source ? <p className="pb-2 text-xs text-muted-foreground">{t('manager.source')} · {t(`manager.sources.${selected.source}`)}</p> : null}
                {selected.origin === 'community' && selected.trust ? <>
                  <p className="text-xs text-muted-foreground">{t(selected.trust === 'full' ? 'manager.fullRisk' : 'manager.restrictedNote')}</p>
                  <DsButton variant="outline" size="sm" className="my-2 !border-primary/30 !bg-primary/10 !text-primary hover:!bg-primary/20" disabled={safeMode || !selected.permissions || state.busy.includes(`plugin:${selected.id}`)}
                    aria-describedby={safeMode ? 'plugin-trust-disabled-reason' : undefined}
                    onClick={() => setTrustTarget({ plugin: selected, trust: selected.trust === 'full' ? 'restricted' : 'full' })}>{t('manager.changeTrust')}</DsButton>
                  {safeMode ? <p id="plugin-trust-disabled-reason" className="mt-1 text-xs text-muted-foreground">{t('manager.trustDisabled')}</p> : null}
                </> : null}
                {selected.permissions?.length ? <ul className="space-y-2 py-2 text-sm">{selected.permissions.map(permission => <li className="break-words" key={permission}>
                  {permission.startsWith('service:') ? t('manager.servicePermission', { name: pluginName(selected, t) }) : t('manager.declaredPermission')}
                  <span className="mt-0.5 block break-all text-xs text-muted-foreground/70">{permission}</span>
                </li>)}</ul> : null}
              </SettingsGroup>
              <SettingsGroup title={t('manager.settings')}>
              {!config ? <p className={LIST_EMPTY_CLASS}>{t('manager.noSettings')}</p> : config.status === 'loading' ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('config.loading')}
                </p>
              ) : config.status === 'error' ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm text-destructive">
                    {config.message}
                  </p>
                  <DsButton variant="outline" size="sm" className={COARSE_TOUCH} onClick={() => void controller.reloadConfig()}>
                    {t('config.retry')}
                  </DsButton>
                </div>
              ) : (
                <ConfigForm
                  pluginId={config.pluginId}
                  schema={config.config.schema}
                  values={config.config.values}
                  revision={config.config.revision}
                  saving={config.saving}
                  conflict={config.conflict}
                  message={config.message}
                  issues={config.issues}
                  onSave={(values, revision) => {
                    void controller.saveConfig(values, revision);
                  }}
                  onCancel={() => { controller.closeConfig(); setSelectedId(null); }}
                  onReload={() => void controller.reloadConfig()}
                />
              )}
              </SettingsGroup>
              <SettingsGroup title={t('manager.version')}>
                <p className="text-sm">{selected.version}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('manager.rollbackPending')}</p>
                <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('manager.technical')}</summary><p className="mt-2 break-all">{selected.id}</p></details>
              </SettingsGroup>
            </DsDialogBody>
          </>
        ) : null}
      </DsDialog>
    </div>
  );
}
