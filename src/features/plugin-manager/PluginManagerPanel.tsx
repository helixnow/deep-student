// RUST-FIX(RF-W35-plugin-manager-view): Rust 版只有设置里的「插件」页签（渠道插件登录/绑定），没有官方+社区插件管理视图。
// RUST-FIX(RF-P2-manager-redesign): 单状态摘要、详情与显式信任确认。
// RUST-FIX(RF-P6-manager-cards): 我的插件（卡片）→ 做一个新的（对话开场白）→ 内置能力（安静分组）→ 渠道插件；详情进侧边抽屉。
import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import { WorkshopComposer } from '@/features/plugin-workshop';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen, CaretRight, PencilSimple, ChatCircle, DownloadSimple, MagnifyingGlass, Package, PuzzlePiece, ShieldChevron, Sparkle,
  WarningCircle, Wrench,
} from '@phosphor-icons/react';

import { DsAlertDialog, DsDialog, DsDialogBody, DsDialogHeader, DsDialogTitle } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { GroupTitle, SettingSection } from '@/components/settings';
import { Input } from '@/components/ui/shad/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import type { UnifiedModelInfo } from '@/features/settings/components/plugins/PluginsTab';
import type { PluginInfo } from '@/features/settings/api/pluginsApi';

import { ChannelPluginDialog, ChannelPluginSection, findChannelPlugin, useChannelPlugins } from './ChannelPluginSection';
import { ConfigForm } from './ConfigForm';
import { permissionLines } from './permissions';
import { pluginConfigForm } from './config-schema';
import { ConsentDialog } from './ConsentDialog';
import { InstallFeedback } from './InstallFeedback';
import { PluginCard } from './PluginCard';
import { PluginDetail } from './PluginDetail';
import { PluginRow } from './PluginRow';
import { forgetPluginContributions, usePluginContributions } from './contributions';
import { PACKAGE_BUSY_KEY, errorMessage, usePluginManagerState, type PluginManagerController } from './controller';
import { errorBudgetOf, type PluginErrorBudgetView } from './reasons';
import type { ManagedPlugin } from './types';
import { pluginUiStatus, type PluginUiHostStatus } from './ui-status';
import { usePluginUiHostStatus } from './use-ui-status';
import { usePluginErrorBudget } from './use-error-budget';
import {
  PLUGIN_FILTERS, categoryIconName, officialPluginGroups, pluginDescription, pluginIsEssential, pluginName, pluginNeedsAttention,
  type PluginFilter,
} from './presentation';
import { usePluginManagerWorkshop, type PluginManagerWork, type PluginManagerWorkshop } from './workshop';

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

/** 空/加载文案：与设置页其它分区一致的安静小字。 */
const LIST_EMPTY_CLASS = 'px-1 py-2.5 text-sm text-muted-foreground';
/** 粗指针（触屏）保底 44px 命中高度，与设置页按钮写法一致。 */
const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';
const GROUP_ICONS = { ChatCircle, BookOpen, MagnifyingGlass, Wrench, Package, PuzzlePiece } as const;
/** 对话开场白：点一下，带着这句话进插件工坊（只填进输入框，由用户自己发送）。 */
const STARTERS = ['app', 'selection', 'tool'] as const;
const NO_WORKS: ReadonlyMap<string, PluginManagerWork> = new Map();

/** schema 里至少有一项能在这里编辑（或需要原样保留的项）时才算有设置。 */
function hasEditableConfig(schema: Parameters<typeof pluginConfigForm>[0]): boolean {
  const form = pluginConfigForm(schema);
  return form.fields.length > 0 || form.unsupported.length > 0;
}

/** 分组标题旁的数量：跟着标题读，不单独占一行。 */
function SectionCount({ count, testId }: { count: number; testId: string }) {
  return <span data-testid={testId} className="ml-2 text-xs font-normal tabular-nums text-muted-foreground/70">{count}</span>;
}

/**
 * 插件管理视图（W35）。
 *
 * 只经 {@link PluginManagerController} 读数据/发动作：列表、启停、卸载、同意、配置与离线安装。
 * `enabled`（已启用）与 `runtime`（运行中）分别来自 Host，页面用一个摘要状态呈现但从不把两者混为一谈；
 * 降级原因用 Host 的结构化错误码，自动卸载原因来自内核错误预算。
 *
 * 版面：先是用户自己的插件（工坊作品与导入的包，卡片），再是「做一个新的」，然后才是随应用提供的内置能力
 * （安静的分组行；别的功能正在依赖的基础服务显示为锁定，依据是 Host 的依赖数据），最后是渠道插件。
 * 视觉沿用设置页的原语与 token（`bg-muted` 圆角面、quiet 行、设置色板），不引入新的视觉语言。
 */
export function PluginManagerPanel({ controller, errorBudget, uiStatus, models, className, workshop: injectedWorkshop }: PluginManagerPanelProps) {
  const { t } = useTranslation('plugin_manager');
  const registeredWorkshop = usePluginManagerWorkshop();
  const workshop = injectedWorkshop ?? registeredWorkshop;
  const state = usePluginManagerState(controller);
  const autoUninstalled = usePluginErrorBudget(errorBudget);
  // W17 的清单/降级/同意/安全模式都可能晚于首帧到达，订阅后按当前值渲染。
  const hostStatus = usePluginUiHostStatus(uiStatus);
  const contributions = usePluginContributions();
  const safeModeUrl = typeof window !== 'undefined' && (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const v = p.get('safeMode') ?? p.get('safe_mode');
      return v === '1' || v === 'true';
    } catch { return false; }
  })();
  const safeMode = state.safeMode || hostStatus?.safeMode === true || safeModeUrl;
  const [uninstallTarget, setUninstallTarget] = useState<ManagedPlugin | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [filter, setFilter] = useState<PluginFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trustTarget, setTrustTarget] = useState<{ plugin: ManagedPlugin; trust: 'full' | 'restricted'; enable?: boolean } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ plugin: ManagedPlugin; version: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [creationsOpen, setCreationsOpen] = useState(false);
  const userToggledCreationsRef = useRef(false);
  const [works, setWorks] = useState(NO_WORKS);
  const [pendingCount, setPendingCount] = useState(0);
  const configTitleId = useId();
  const creationsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

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
      ? t('notice.configSaved', { id: label })
      : notice.kind === 'consent-granted'
        ? t('notice.consentGranted', { id: label })
        : t(notice.enabled ? 'notice.enabled' : 'notice.disabled', { id: label });
    showGlobalNotification('success', message);
    controller.dismissNotice();
  }, [controller, state.notice, state.plugins, t]);

  // 工坊托管作品的版本事实（上一版、本版改动）：只在「我的插件」这批东西变化时重读。
  const mineSignature = state.plugins.filter((plugin) => plugin.origin === 'community')
    .map((plugin) => `${plugin.id}@${plugin.version}:${plugin.enabled ? 1 : 0}`).join('|');
  useEffect(() => {
    if (!workshop?.works) { setWorks(NO_WORKS); return undefined; }
    let live = true;
    workshop.works()
      .then((list) => { if (live) setWorks(new Map(list.map((work) => [work.pluginId, work]))); })
      .catch(() => { if (live) setWorks(NO_WORKS); });
    return () => { live = false; };
  }, [workshop, mineSignature]);

  // 有作品正在制作中或等用户确认时，「工坊创作记录」自动展开；完成后且用户未手动切过时自动收起。
  useEffect(() => {
    if (!workshop?.pending) { setPendingCount(0); return undefined; }
    let live = true;
    const read = () => Promise.all([
      workshop.pending!(),
      workshop.hasActive ? workshop.hasActive() : Promise.resolve(false),
    ])
      .then(([list, active]) => {
        if (!live) return;
        setPendingCount(list.length);
        if (!userToggledCreationsRef.current) setCreationsOpen(list.length > 0 || active);
      })
      .catch(() => { if (live) setPendingCount(0); });
    void read();
    const timer = setInterval(() => { void read(); }, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [workshop, mineSignature]);

  const needle = query.trim().toLocaleLowerCase();
  const problemOf = (plugin: ManagedPlugin) =>
    pluginNeedsAttention(plugin, pluginUiStatus(hostStatus, plugin.id)) || autoUninstalled.some((entry) => entry.pluginId === plugin.id);
  const filtered = state.plugins.filter((plugin) => {
    const matchesQuery = !needle || [pluginName(plugin, t), plugin.id, plugin.author, pluginDescription(plugin, t)].join(' ').toLocaleLowerCase().includes(needle);
    return matchesQuery && (filter === 'all'
      || filter === 'mine' && plugin.origin === 'community'
      || filter === 'builtin' && plugin.origin === 'builtin'
      || filter === 'disabled' && !plugin.enabled
      || filter === 'problem' && problemOf(plugin));
  });
  const official = filtered.filter((plugin) => plugin.origin === 'builtin');
  const community = filtered.filter((plugin) => plugin.origin === 'community');
  const officialGroups = officialPluginGroups(official);
  const selected = state.plugins.find((plugin) => plugin.id === selectedId);
  const names = useMemo(() => new Map(state.plugins.map((plugin) => [plugin.id, pluginName(plugin, t)])), [state.plugins, t]);
  // 详情开着时插件才跑起来（例如刚点了「启动插件」），Host 这时才报告它可配置：就地读出设置，不必关掉重开。
  const selectedConfigurable = selected !== undefined && selected.configurable !== false;
  const configurableSeen = useRef<string | null>(null);
  useEffect(() => {
    const key = selectedId ? `${selectedId}:${selectedConfigurable}` : null;
    const previous = configurableSeen.current;
    configurableSeen.current = key;
    if (selectedId && selectedConfigurable && previous === `${selectedId}:false` && !state.config) void controller.openConfig(selectedId);
  }, [controller, selectedConfigurable, selectedId, state.config]);
  /** 基础服务的锁定原因：谁在用它（Host 的依赖数据）。不是基础服务时为 undefined，照常给开关。 */
  const lockedReasonOf = (plugin: ManagedPlugin): string | undefined => {
    if (!pluginIsEssential(plugin)) return undefined;
    const users = (plugin.requiredBy ?? []).map((id) => names.get(id) ?? id);
    return t(users.length > 2 ? 'essential.reasonMany' : 'essential.reason', { names: users.slice(0, 2).join(t('detail.separator')), count: users.length });
  };

  const selectPlugin = (plugin: ManagedPlugin) => {
    // 官方列表里的 iLink（dstu.ilink / ilinkbot）没有通用 Config schema：直接进渠道配置面板。
    const channelPlugin = findChannelPlugin(channel, plugin.id);
    if (channelPlugin) {
      openChannel(channelPlugin);
      return;
    }
    let opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 从「更多」菜单打开时，菜单项马上就会卸载：先把焦点放回这张卡片的菜单按钮，
    // 抽屉记录的返回目标与这里的都是它，关闭后焦点回到用户离开的地方。
    if (opener?.closest('[role="menu"]')) {
      const trigger = pluginElement(plugin.id)?.querySelector<HTMLElement>('[data-more-trigger]');
      if (trigger) { trigger.focus({ preventScroll: true }); opener = trigger; }
    }
    openerRef.current = opener;
    setSelectedId(plugin.id);
    if (plugin.configurable !== false) void controller.openConfig(plugin.id);
    else controller.closeConfig();
  };
  /** 关闭详情并把焦点还给打开它的元素；从菜单项打开时菜单已卸载，退回到这个插件的卡片/行。 */
  const closeDetail = () => {
    const id = selectedId;
    const opener = openerRef.current;
    openerRef.current = null;
    controller.closeConfig();
    setSelectedId(null);
    requestAnimationFrame(() => {
      const fallback = id ? pluginElement(id)?.querySelector<HTMLElement>('button') : undefined;
      (opener?.isConnected ? opener : fallback)?.focus({ preventScroll: true });
    });
  };
  function pluginElement(id: string): HTMLElement | undefined {
    return [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-plugin-id]') ?? [])]
      .find((element) => element.getAttribute('data-plugin-id') === id);
  }
  const togglePlugin = (plugin: ManagedPlugin, enabled: boolean) => {
    // 完全信任的风险只确认一次：Host 账本里已有与当前安装内容一致的同意（ID、版本、权限、内容摘要都没变，
    // 例如工坊确认卡上点过头的那一版）时，停用后再启用直接生效。账本对不上（换了版本/权限/内容）、
    // 或 Host 没报告同意状态时，仍先过这道确认；Host 自己还会以 CONSENT_REQUIRED 拒绝未同意的启用。
    const consented = plugin.consent === 'granted';
    if (enabled && plugin.origin === 'community' && plugin.trust === 'full' && !consented) setTrustTarget({ plugin, trust: 'full', enable: true });
    else void controller.setEnabled(plugin.id, enabled);
  };
  /** 工坊的错误一律转成人话（describeError），不把 `WORKSHOP_STATE: …` 原文给用户。 */
  const workshopErrorText = (error: unknown) => {
    const raw = errorMessage(error);
    return workshop?.describeError?.(raw) ?? raw;
  };
  const exportPlugin = async (plugin: ManagedPlugin) => {
    if (!workshop?.onExport) return;
    try {
      const path = await workshop.onExport(plugin.id);
      if (path === null) return; // 用户在保存对话框里取消了
      const reveal = workshop.onReveal;
      const message = path ? t('notice.exported', { id: pluginName(plugin, t), path }) : t('notice.exportedNoPath', { id: pluginName(plugin, t) });
      if (path && reveal) showGlobalNotification('success', message, undefined, { action: { label: t('notice.reveal'), onClick: () => reveal(path) } });
      else showGlobalNotification('success', message);
    } catch (error) {
      showGlobalNotification('error', workshopErrorText(error));
    }
  };
  const openPlugin = (plugin: ManagedPlugin) => {
    const view = contributions.view(plugin.id);
    if (view) contributions.open(view);
  };

  const packageBusy = state.busy.includes(PACKAGE_BUSY_KEY);
  const config = state.config;
  const listLoading = state.status === 'loading' || state.status === 'idle';
  const noPlugins = !listLoading && state.plugins.length === 0;
  useRefreshOnReturn(() => controller.refresh(), !listLoading);

  const narrowing = needle !== '' || filter === 'disabled' || filter === 'problem';
  const showMine = filter !== 'builtin' && (!narrowing || community.length > 0);
  const showStarters = !narrowing && filter !== 'builtin';
  const showOfficial = filter !== 'mine' && !noPlugins && (!narrowing || official.length > 0);
  // 清单读完再出现：首帧只有一条「正在读取」，渠道那一行不先占位再跳动。
  const showChannel = channelEnabled && filter === 'all' && !needle && !listLoading;
  const nothingMatches = !listLoading && !noPlugins && filtered.length === 0 && (narrowing || filter === 'builtin');

  /** 一个插件在卡片/详情里共用的派生事实与动作。 */
  const facts = (plugin: ManagedPlugin) => {
    const work = works.get(plugin.id);
    const managed = plugin.source === 'workshop' || work !== undefined;
    const view = contributions.view(plugin.id);
    return {
      work,
      busy: state.busy.includes(`plugin:${plugin.id}`) || state.consentBusy,
      pendingEnabled: state.pendingEnabled[plugin.id],
      autoUninstalled: autoUninstalled.find((entry) => entry.pluginId === plugin.id) ?? null,
      uiStatus: pluginUiStatus(hostStatus, plugin.id),
      livePoints: contributions.points(plugin.id),
      canOpen: view !== undefined,
      canModify: managed && workshop !== undefined,
      canExport: managed && workshop?.onExport !== undefined,
      onToggle: (enabled: boolean) => togglePlugin(plugin, enabled),
      onOpen: () => openPlugin(plugin),
      onModify: () => workshop?.onModify(plugin.id),
      onExport: () => { void exportPlugin(plugin); },
      onRestorePrevious: work?.previousVersion && workshop?.onRestorePrevious
        ? () => setRestoreTarget({ plugin, version: work.previousVersion! }) : undefined,
      onUninstall: () => setUninstallTarget(plugin),
      onReviewConsent: () => togglePlugin(plugin, true),
      onTryNotes: () => dispatchAppEvent(APP_EVENTS.OPEN_NOTES),
      onTrySay: (phrase: string) => dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: phrase, autoSend: false }),
      /** 工坊作品从工坊卸载：对话里的卡片、创作记录和这里的列表说的是同一件事。 */
      managed: managed && workshop?.onUninstall !== undefined,
    };
  };

  const importButton = (
    <DsButton variant="outline" size="sm" data-testid="plugin-import" className={cn('gap-1.5', COARSE_TOUCH)}
      onClick={() => void controller.installPackage()} disabled={packageBusy}>
      <DownloadSimple className="size-4" aria-hidden="true" />
      {packageBusy ? t('install.running') : t('actions.install')}
    </DsButton>
  );

  return (
    <div ref={rootRef} className={cn('space-y-1 pb-10 text-left ui-fade-in-slow', className)} data-testid="plugin-manager">
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
                {state.error.detail ? t('error.detailSuffix', { detail: state.error.detail }) : ''}
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

        <WorkshopComposer workshop={workshop} disabled={safeMode} />

        {/* 一条轻的工具栏：搜索 + 范围。没有底板，不抢「我的插件」的位置。 */}
        <div role="search" data-testid="plugin-toolbar" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative min-w-[12rem] flex-1">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('manager.search')}
              placeholder={t('manager.search')} className="!pl-9" />
          </div>
          <SegmentedControl<PluginFilter> ariaLabel={t('manager.filterLabel')} value={filter} onValueChange={setFilter} size="compact" className="max-w-full flex-wrap"
            options={PLUGIN_FILTERS.map((value) => ({ value, label: t(`manager.filters.${value}`) }))} />
        </div>

        {listLoading ? <p role="status" className={LIST_EMPTY_CLASS}>{t('list.loading')}</p> : null}
        {nothingMatches ? <p role="status" data-testid="plugin-no-matches" className={LIST_EMPTY_CLASS}>{t('manager.noMatches')}</p> : null}

        {!listLoading && showMine ? (
          <section data-testid="plugin-section-mine" className="min-w-0">
            <GroupTitle description={t('mine.description')}
              title={<>{t('mine.title')}<SectionCount testId="plugin-count-community" count={community.length} /></>} />
            {community.length ? (
              <div role="list" aria-label={t('mine.title')} data-testid="plugin-mine-grid"
                className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3">
                {community.map((plugin) => {
                  const fact = facts(plugin);
                  return (
                    <PluginCard key={plugin.id} plugin={plugin} platform={state.platform ?? 'desktop'} safeMode={safeMode}
                      busy={fact.busy} pendingEnabled={fact.pendingEnabled} autoUninstalled={fact.autoUninstalled} uiStatus={fact.uiStatus}
                      livePoints={fact.livePoints} canOpen={fact.canOpen} canModify={fact.canModify} canExport={fact.canExport}
                      previousVersion={fact.work?.previousVersion}
                      onToggle={fact.onToggle} onSelect={() => selectPlugin(plugin)} onOpen={fact.onOpen} onModify={fact.onModify}
                      onExport={fact.onExport} onRestorePrevious={fact.onRestorePrevious} onUninstall={fact.onUninstall}
                      onReviewConsent={fact.onReviewConsent} onTryNotes={fact.onTryNotes} onTrySay={fact.onTrySay} />
                  );
                })}
              </div>
            ) : (
              <div data-testid="plugin-mine-empty" className="flex min-w-0 flex-col items-center gap-2 rounded-2xl bg-muted px-4 py-8 text-center">
                <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkle className="size-5" /></span>
                <p className="text-sm font-medium text-foreground">{t('mine.emptyTitle')}</p>
                <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{t('mine.emptyDescription')}</p>
              </div>
            )}
            {workshop?.creations ? (
              <div className="mt-3 min-w-0">
                <DsButton variant="ghost" size="sm" aria-expanded={creationsOpen} aria-controls={creationsId} data-testid="plugin-creations-toggle"
                  className={cn('gap-1.5 text-muted-foreground', COARSE_TOUCH)}
                  onClick={() => { userToggledCreationsRef.current = true; setCreationsOpen((open) => !open); }}>
                  <CaretRight className={cn('size-3.5 transition-transform motion-reduce:transition-none', creationsOpen && 'rotate-90')} aria-hidden="true" />
                  {pendingCount ? t('mine.creationsPending', { count: pendingCount }) : t('mine.creations')}
                </DsButton>
                {/* 展开才挂载：工坊列表在挂载期间会轮询 Host。 */}
                <div id={creationsId} hidden={!creationsOpen} data-testid="plugin-creations">{creationsOpen ? workshop.creations : null}</div>
              </div>
            ) : null}
          </section>
        ) : null}

        {!listLoading && showStarters ? (
          <section data-testid="plugin-starters" className="min-w-0">
            <GroupTitle title={t('starters.title')} description={t('starters.description')} actions={importButton} />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {STARTERS.map((starter) => (
                <DsButton key={starter} variant="outline" size="sm" data-testid="plugin-starter" data-starter={starter}
                  disabled={!workshop} onClick={() => workshop?.onCreate(t(`starters.${starter}`))}
                  className={cn('!h-auto min-h-9 max-w-full gap-1.5 !whitespace-normal !rounded-full bg-muted !px-3.5 !py-1.5 text-left', COARSE_TOUCH)}>
                  <Sparkle className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{t(`starters.${starter}`)}</span>
                </DsButton>
              ))}
              <DsButton variant="ghost" size="sm" data-testid="plugin-create" disabled={!workshop}
                // 与开场白同一种胶囊：一样可点，图标换成笔，表示「自己写」。
                className={cn('!h-auto min-h-9 max-w-full gap-1.5 !rounded-full bg-muted !px-3.5 !py-1.5 text-muted-foreground', COARSE_TOUCH)} onClick={() => workshop?.onCreate()}>
                <PencilSimple className="size-3.5 shrink-0" aria-hidden="true" />
                {t('manager.create')}
              </DsButton>
            </div>
            {!workshop ? <p className="mt-2 px-1 text-xs text-muted-foreground" data-testid="plugin-workshop-pending">{t('manager.workshopPending')}</p> : null}
          </section>
        ) : null}

        {noPlugins ? <p role="status" data-testid="plugin-manager-empty" className={LIST_EMPTY_CLASS}>{t('list.empty')}</p> : null}

        {!listLoading && showOfficial ? (
          <section data-testid="plugin-section-builtin" className="min-w-0">
            <GroupTitle description={t('builtin.description')}
              title={<>{t('builtin.title')}<SectionCount testId="plugin-count-builtin" count={official.length} /></>} />
            <div className="rounded-2xl bg-muted px-2 py-1 sm:px-3">
              {officialGroups.map((group) => {
                const title = t(group.category, { defaultValue: group.category });
                const open = narrowing || openGroups.has(group.category);
                const Icon = GROUP_ICONS[categoryIconName(group.category) as keyof typeof GROUP_ICONS] ?? PuzzlePiece;
                const off = group.plugins.filter((plugin) => !plugin.enabled).length;
                return (
                  <details key={group.category} open={open} data-testid="plugin-group" data-category={group.category}
                    className="border-b border-border/40 py-1 last:border-b-0">
                    <summary
                      // 受控展开：由状态决定 open，搜索/筛选时强制展开。键盘 Enter/Space 在 summary 上同样触发 click。
                      onClick={(event) => {
                        event.preventDefault();
                        if (narrowing) return;
                        setOpenGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group.category)) next.delete(group.category); else next.add(group.category);
                          return next;
                        });
                      }}
                      className={cn('flex min-w-0 cursor-pointer list-none items-center gap-3 rounded-lg px-1 py-2 outline-none [&::-webkit-details-marker]:hidden',
                        'hover:bg-[color:var(--sidebar-quiet-hover)] focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]')}>
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/60"><Icon className="size-4 text-muted-foreground" aria-hidden="true" /></span>
                      <span className="min-w-0 flex-1 text-sm text-foreground/90">
                        <span data-testid="plugin-group-title">{title}</span>
                        <span className="text-muted-foreground/70"> · <span data-testid="plugin-group-count" className="tabular-nums">{group.plugins.length}</span></span>
                      </span>
                      {off ? <span className="shrink-0 text-xs text-muted-foreground/70">{t('builtin.groupOff', { count: off })}</span> : null}
                      <CaretRight className={cn('size-3.5 shrink-0 text-muted-foreground/70 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden="true" />
                    </summary>
                    <div role="list" aria-label={title} className="space-y-px pb-1 pl-0 sm:pl-2">
                      {group.plugins.map((plugin) => {
                        const fact = facts(plugin);
                        return (
                          <PluginRow key={plugin.id} plugin={plugin} platform={state.platform ?? 'desktop'} safeMode={safeMode}
                            busy={fact.busy} pendingEnabled={fact.pendingEnabled} autoUninstalled={fact.autoUninstalled} uiStatus={fact.uiStatus}
                            lockedReason={lockedReasonOf(plugin)} onSelect={() => selectPlugin(plugin)} onToggle={fact.onToggle} />
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        ) : null}

        {showChannel ? (
          <ChannelPluginSection
            channel={channel}
            onConfigure={openChannel}
            onBind={(plugin) => {
              setChannelTarget(plugin);
              void channel.beginLogin(plugin);
            }}
          />
        ) : null}
      </SettingSection>

      <ChannelPluginDialog
        plugin={channelTarget}
        models={models ?? []}
        onOpenChange={(open) => { if (!open) closeChannel(); }}
        onChanged={channelChanged}
      />

      <ConsentDialog
        subject={state.consent}
        agentTools={state.plugins.find((plugin) => plugin.id === state.consent?.id)?.agentTools}
        name={(() => { const target = state.plugins.find((plugin) => plugin.id === state.consent?.id); return target ? pluginName(target, t) : undefined; })()}
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
        description={uninstallTarget && facts(uninstallTarget).managed ? t('uninstall.descriptionWorkshop') : t('uninstall.description')}
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
            let workshopError: string | null = null;
            if (facts(target).managed && workshop?.onUninstall) {
              try { await workshop.onUninstall(target.id); } catch (cause) { workshopError = workshopErrorText(cause); }
              await controller.refresh();
            } else await controller.uninstall(target.id);
            const snapshotError = controller.getSnapshot().error;
            const error = workshopError ? { code: 'UNINSTALL_FAILED', detail: workshopError } : snapshotError;
            if (!error) {
              forgetPluginContributions(target.id);
              if (selectedId === target.id) { controller.closeConfig(); setSelectedId(null); }
            }
            showGlobalNotification(error ? 'error' : 'success', error ? error.detail ?? error.code : t('notice.uninstalled', { id: pluginName(target, t) }));
          } finally {
            setUninstalling(false);
            setUninstallTarget(null);
          }
        }}
        onCancel={() => { if (!uninstalling) setUninstallTarget(null); }}
      />

      <DsAlertDialog open={trustTarget !== null} onOpenChange={(open) => { if (!open && !trustBusy) setTrustTarget(null); }}
        // 启用一个还没被允许的插件：同一套人话（它需要什么 + 它和应用一起运行、随时可以关掉）。
        // 更改档位（技术信息里）才提档位这个术语。
        title={trustTarget?.enable ? t('consent.title', { name: pluginName(trustTarget.plugin, t) }) : t('manager.changeTrust')}
        description={trustTarget?.enable
          ? `${trustTarget.plugin.permissions?.length ? `${t('consent.permissions')}：${permissionLines(trustTarget.plugin.permissions, trustTarget.plugin.agentTools, t).map((line) => line.text).join(t('detail.separator'))}。` : ''}${t('detail.sameProcess')}`
          : `${trustTarget?.plugin.id ?? ''} · ${trustTarget?.plugin.version ?? ''} — ${t(`manager.${trustTarget?.trust ?? 'restricted'}`)}：${t(trustTarget?.trust === 'full' ? 'manager.fullRisk' : 'manager.restrictedNote')}`}
        loading={trustBusy} disabled={trustBusy} confirmText={trustTarget?.enable ? t('card.allowAndEnable') : t('manager.confirmTrust')} cancelText={t('uninstall.cancel')}
        onCancel={() => { if (!trustBusy) setTrustTarget(null); }}
        onConfirm={async () => {
          if (!trustTarget || trustBusy) return;
          setTrustBusy(true);
          try {
            if (trustTarget.enable) await controller.setEnabled(trustTarget.plugin.id, true);
            else if (trustTarget.plugin.permissions) await controller.setTrust({ id: trustTarget.plugin.id, version: trustTarget.plugin.version, permissions: trustTarget.plugin.permissions }, trustTarget.trust);
          } finally { setTrustBusy(false); setTrustTarget(null); }
        }} />

      <DsAlertDialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open && !restoring) setRestoreTarget(null); }}
        title={t('restore.title', { id: restoreTarget ? pluginName(restoreTarget.plugin, t) : '', version: restoreTarget?.version ?? '' })}
        description={t('restore.description')}
        loading={restoring} disabled={restoring} confirmVariant="primary" confirmText={t('restore.confirm')} cancelText={t('uninstall.cancel')}
        onCancel={() => { if (!restoring) setRestoreTarget(null); }}
        onConfirm={async () => {
          const target = restoreTarget;
          if (!target || restoring || !workshop?.onRestorePrevious) return;
          setRestoring(true);
          try {
            await workshop.onRestorePrevious(target.plugin.id);
            await controller.refresh();
            showGlobalNotification('success', t('notice.restored', { id: pluginName(target.plugin, t), version: target.version }));
          } catch (error) {
            showGlobalNotification('error', workshopErrorText(error));
          } finally { setRestoring(false); setRestoreTarget(null); }
        }} />

      {/* 详情：桌面贴右侧的抽屉，移动端是 DsDialog 的 bottom sheet（统一返回键）。 */}
      <DsDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !(config?.status === 'ready' && config.saving)) closeDetail();
        }}
        aria-labelledby={configTitleId}
        maxWidth="max-w-xl"
        className="md:ml-auto md:h-full md:!max-h-full"
        showClose={config?.status !== 'ready' || !config.saving}
        closeOnOverlay={config?.status !== 'ready' || !config.saving}
      >
        {selected ? (() => {
          const fact = facts(selected);
          const lockedReason = lockedReasonOf(selected);
          return (
            <>
              <DsDialogHeader>
                <DsDialogTitle id={configTitleId}>{pluginName(selected, t)}</DsDialogTitle>
              </DsDialogHeader>
              <DsDialogBody className="py-4">
                <PluginDetail plugin={selected} platform={state.platform ?? 'desktop'} safeMode={safeMode}
                  busy={fact.busy} pendingEnabled={fact.pendingEnabled} uiStatus={fact.uiStatus}
                  errorBudget={errorBudgetOf(errorBudget, selected.id, selected.origin)} autoUninstalled={fact.autoUninstalled}
                  livePoints={fact.livePoints} lockedReason={lockedReason} work={fact.work}
                  requiredByNames={(selected.requiredBy ?? []).map((id) => names.get(id) ?? id)}
                  canOpen={fact.canOpen} canModify={fact.canModify} canExport={fact.canExport}
                  canChangeTrust={!safeMode && !!selected.permissions && !state.busy.includes(`plugin:${selected.id}`)}
                  onToggle={fact.onToggle} onOpen={fact.onOpen} onModify={fact.onModify} onExport={fact.onExport}
                  onRestorePrevious={fact.onRestorePrevious} onUninstall={fact.onUninstall} onReviewConsent={fact.onReviewConsent}
                  onChangeTrust={() => setTrustTarget({ plugin: selected, trust: selected.trust === 'full' ? 'restricted' : 'full' })}
                  // 没有可编辑的设置（Host 说不可配置，或 schema 里一项都没有）时不出现这个分区，更不出现修订号与保存。
                  settings={!config || (config.status === 'ready' && !hasEditableConfig(config.config.schema)) ? null : config.status === 'loading' ? (
                    <p role="status" className="text-sm text-muted-foreground">{t('config.loading')}</p>
                  ) : config.status === 'error' ? (
                    <div className="space-y-3">
                      <p role="alert" className="text-sm text-destructive">{config.message}</p>
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
                      onCancel={closeDetail}
                      onReload={() => void controller.reloadConfig()}
                    />
                  )} />
              </DsDialogBody>
            </>
          );
        })() : null}
      </DsDialog>
    </div>
  );
}
