// RUST-FIX(RF-P6-manager-cards): 「我的插件」用卡片呈现——身份、它增加了什么、状态、就近的开关与一个顺手的主操作。
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise, ArrowSquareOut, ChatCircleText, DotsThree, Export, Info, NotePencil, Play, Power, ShieldCheck, Sparkle, Trash, WarningCircle,
} from '@phosphor-icons/react';

import { AppMenu, AppMenuContent, AppMenuItem, AppMenuSeparator, AppMenuTrigger } from '@/components/ui/app-menu/AppMenu';
import { DsButton } from '@/components/ui/DsButton';
import { Switch } from '@/components/ui/shad/Switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { cn } from '@/lib/utils';

import { describePluginFault, type PluginAutoUninstallReason } from './reasons';
import type { ManagedPlugin, PluginPlatform } from './types';
import type { PluginUiStatusSnapshot } from './ui-status';
import {
  pluginAdditions, pluginDescription, pluginMonogram, pluginName, pluginStatusKey, pluginStatusTone, pluginTint, unsupportedPlatformKey,
  type PluginAdditionKind,
} from './presentation';

/** 与设置页一致的触屏命中高度。 */
const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

const DOT_TONE = {
  ok: 'bg-success',
  off: 'bg-muted-foreground/40',
  warn: 'bg-warning',
  bad: 'bg-destructive',
} as const;

/** 状态：一个安静的圆点 + 文字；颜色只是辅助，文字始终在。 */
export function PluginStatus({ statusKey, className }: { statusKey: string; className?: string }) {
  const { t } = useTranslation('plugin_manager');
  const tone = pluginStatusTone(statusKey);
  return (
    <span data-testid="plugin-summary-state" data-tone={tone}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground', className)}>
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
      <span className="min-w-0 truncate">{t(statusKey)}</span>
    </span>
  );
}

/** 插件的图标块：没有自带图标时用名字的首字 + 由 id 决定的固定色，不再是同一枚拼图。 */
export function PluginTile({ plugin, name, size = 'md' }: { plugin: ManagedPlugin; name: string; size?: 'md' | 'lg' }) {
  const tint = `var(--settings-nav-accent-${pluginTint(plugin.id)})`;
  return (
    <span aria-hidden="true" data-testid="plugin-tile" data-tint={pluginTint(plugin.id)}
      className={cn('flex shrink-0 select-none items-center justify-center rounded-xl font-semibold leading-none',
        size === 'lg' ? 'size-12 text-xl' : 'size-10 text-base')}
      style={{ color: tint, backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)` }}>
      {pluginMonogram(plugin, name)}
    </span>
  );
}

/** 「它增加了什么」：由贡献点推导的小标签。 */
export function PluginAdditionChips({ kinds, className, surface = 'muted', label = true }: {
  kinds: readonly PluginAdditionKind[]; className?: string;
  /** What the chips sit on: a muted card needs a lighter chip, the sheet's plain background a muted one. */
  surface?: 'muted' | 'background';
  /** The tiny 「它增加了」 label; off where a section heading already says it. */
  label?: boolean;
}) {
  const { t } = useTranslation('plugin_manager');
  if (!kinds.length) return null;
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      {/* A tiny label says what the chips are; each chip says where the addition shows up on hover/focus. */}
      {label ? <span aria-hidden="true" data-testid="plugin-adds-label" className="text-2xs leading-5 text-muted-foreground/80">{t('card.addsLabel')}</span> : null}
      <ul data-testid="plugin-adds" aria-label={t('card.addsLabel')} className="flex min-w-0 flex-wrap gap-1.5">
        {kinds.map((kind) => (
          <li key={kind} data-kind={kind} title={t(`addsHint.${kind}`)}
            className={cn('rounded-md px-1.5 py-0.5 text-xs leading-5 text-foreground/75',
              surface === 'muted' ? 'bg-background/80 dark:bg-background/50' : 'bg-muted')}>
            {t(`adds.${kind}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 信任档位：只在详情的「技术信息」里出现（卡片上不放档位，用来源说明它从哪来）。 */
export function PluginTrustChip({ trust }: { trust: 'full' | 'restricted' }) {
  const { t } = useTranslation('plugin_manager');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="plugin-trust-badge" data-trust={trust}
          className={cn('inline-flex shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 py-0.5 text-xs leading-5 outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring',
            trust === 'full' ? 'bg-warning/10 text-warning' : 'bg-muted-foreground/10 text-muted-foreground')}>
          <ShieldCheck className="size-3" aria-hidden="true" />
          {t(`manager.${trust}`)}
        </span>
      </TooltipTrigger>
      <TooltipContent maxWidth={280} className="!whitespace-normal !leading-relaxed">
        {t(trust === 'full' ? 'manager.fullRisk' : 'manager.restrictedNote')}
      </TooltipContent>
    </Tooltip>
  );
}

export interface PluginCardProps {
  plugin: ManagedPlugin;
  platform: PluginPlatform;
  busy: boolean;
  /** 开关正在向 Host 提交的目标值；有值时开关先显示它，其余状态仍按 Host 报告的 `plugin`。 */
  pendingEnabled?: boolean;
  autoUninstalled: PluginAutoUninstallReason | null;
  uiStatus?: PluginUiStatusSnapshot;
  safeMode?: boolean;
  /** UI 内核里归属这个插件的贡献点（运行中才有；停用后用记住的那份）。 */
  livePoints?: readonly string[];
  /** 这个插件登记了可以直接打开的视图。 */
  canOpen?: boolean;
  /** 工坊托管作品：可以回到它的对话里修改。 */
  canModify?: boolean;
  canExport?: boolean;
  /** 工坊留有上一版时的版本号。 */
  previousVersion?: string;
  onToggle: (enabled: boolean) => void;
  onSelect: () => void;
  onOpen?: () => void;
  onModify?: () => void;
  onExport?: () => void;
  onRestorePrevious?: () => void;
  onUninstall: () => void;
  onReviewConsent?: () => void;
  /** 选区按钮插件的主操作：去笔记里试试。 */
  onTryNotes?: () => void;
  /** AI 助手新本事的主操作：把这句话放进输入框。 */
  onTrySay?: (phrase: string) => void;
}

/** 卡片上的来源：你让 AI 做的 / 来自文件 · 作者 X / 来源未知。 */
export function pluginProvenance(plugin: ManagedPlugin, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (plugin.source === 'workshop') return t('manager.sources.workshop');
  if (plugin.author?.trim()) return t('card.provenanceFile', { author: plugin.author.trim() });
  return t('card.provenanceUnknown');
}

type CardPrimary = { key: string; label: string; a11y: string; icon: typeof Play; run: () => void; disabled: boolean };

export function PluginCard({
  plugin, platform, busy, pendingEnabled, autoUninstalled, uiStatus, safeMode = false, livePoints,
  canOpen = false, canModify = false, canExport = false, previousVersion,
  onToggle, onSelect, onOpen, onModify, onExport, onRestorePrevious, onUninstall, onReviewConsent, onTryNotes, onTrySay,
}: PluginCardProps) {
  const { t } = useTranslation('plugin_manager');
  const name = pluginName(plugin, t).trim() || plugin.id;
  const description = pluginDescription(plugin, t);
  const platforms = plugin.platforms ?? [];
  const supported = platforms.length === 0 || platforms.includes(platform);
  const blockedBySafeMode = safeMode && plugin.origin === 'community';
  const consentRequired = uiStatus?.consentRequired === true || plugin.consent === 'required';
  const fault = describePluginFault(t, {
    degradedReason: plugin.degraded?.reason,
    uiDegraded: uiStatus?.degraded,
    runtime: plugin.runtime,
    runtimeDetail: plugin.runtimeDetail,
    autoUninstalled,
  });
  const statusKey = !supported
    ? unsupportedPlatformKey({ platforms }, platform)
    : autoUninstalled || fault
      ? 'manager.problemStatus'
      : pluginStatusKey(plugin, uiStatus, safeMode);
  // 还没被允许的插件实际上不在运行：开关如实显示为关，由「允许并启用」打开。
  const switchChecked = pendingEnabled ?? (plugin.enabled && !consentRequired);
  // 安全模式下禁止启用社区插件，但允许停用已启用的社区插件以隔离排查故障。
  const switchDisabled = busy || !supported || (blockedBySafeMode && !switchChecked);
  const additions = pluginAdditions(plugin, livePoints);
  const running = plugin.enabled && plugin.runtime === 'running';
  const headingId = `plugin-card-${plugin.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const showDirectRecoveryActions = blockedBySafeMode || (fault !== null && plugin.origin === 'community');

  // 一个顺手的主操作：要允许就「允许并启用」；按它增加了什么去用它（打开应用 / 去笔记里试试 / 试一句）；
  // 已启用但没跑起来就「启动」（安全模式或存在故障时不展示「启动」，改为直接给停用/卸载排查动作）。没有明显的就不放。
  const phrase = plugin.agentTools?.[0]?.title;
  const primary: CardPrimary | null = showDirectRecoveryActions
    ? null
    : consentRequired && onReviewConsent
      ? { key: 'consent', label: t('card.allowAndEnable'), a11y: t('row.reviewConsentA11y', { id: name }), icon: ShieldCheck, run: onReviewConsent, disabled: busy }
      : running && canOpen && onOpen
        ? { key: 'open', label: t('card.openNamed', { name }), a11y: t('card.openA11y', { id: name }), icon: ArrowSquareOut, run: onOpen, disabled: false }
        : running && additions.includes('selectionButton') && onTryNotes
          ? { key: 'try-notes', label: t('card.tryNotes'), a11y: t('card.tryNotes'), icon: NotePencil, run: onTryNotes, disabled: false }
          : running && phrase && onTrySay
            ? { key: 'try-say', label: t('card.trySay', { phrase }), a11y: t('card.trySay', { phrase }), icon: ChatCircleText, run: () => onTrySay(phrase), disabled: false }
            : plugin.enabled && plugin.runtime !== 'running' && !consentRequired
              ? { key: 'start', label: t('manager.start'), a11y: t('card.startA11y', { id: name }), icon: Play, run: () => onToggle(true), disabled: switchDisabled }
              : null;

  return (
    <div role="listitem" aria-labelledby={headingId}
      data-testid="plugin-card" data-plugin-id={plugin.id} data-origin={plugin.origin} data-source={plugin.source}
      data-enabled={String(plugin.enabled)} data-runtime={plugin.runtime} data-fault={fault ? 'true' : undefined}
      data-auto-uninstalled={autoUninstalled ? 'true' : undefined}
      className={cn('group flex min-w-0 flex-col gap-2.5 rounded-2xl bg-muted p-4 transition-colors motion-reduce:transition-none',
        'hover:bg-[color:var(--sidebar-quiet-hover,hsl(var(--muted)))] focus-within:ring-1 focus-within:ring-border',
        fault && 'border border-destructive/30',
        !supported && 'opacity-70')}>
      <div className="flex min-w-0 items-start gap-3">
        <PluginTile plugin={plugin} name={name} />
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="min-w-0 text-sm font-medium leading-5 text-foreground">
            {/* `cn()` is plain concatenation: the primitive's fixed height, padding, nowrap and hover fill are
                overridden with `!` so the name reads as a title that wraps, not as a toolbar button. */}
            <DsButton variant="ghost" onClick={onSelect} aria-label={t('manager.details', { id: name })} data-testid="plugin-card-name"
              className={cn('!h-auto max-w-full !justify-start !whitespace-normal !rounded !bg-transparent !p-0 text-left !text-sm !font-medium !text-foreground [overflow-wrap:anywhere] hover:underline', COARSE_TOUCH)}>
              {name}
            </DsButton>
          </h4>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PluginStatus statusKey={statusKey} />
          </div>
        </div>
        {/* 开关的占位固定：等待 Host 时只是禁用，不换成别的东西，卡片不跳动。 */}
        <Switch checked={switchChecked} disabled={switchDisabled} aria-label={t(switchChecked ? 'row.disable' : 'row.enable', { id: name })} className="mt-0.5 shrink-0" onCheckedChange={onToggle} />
      </div>

      <p data-testid="plugin-card-description"
        className="line-clamp-2 min-w-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {description || t(fault ? 'card.brokenDescription' : 'card.noDescription')}
      </p>

      {fault ? (
        <div
          data-testid="plugin-card-diagnostic"
          data-fault="true"
          data-code={fault.code ?? undefined}
          className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs leading-relaxed text-destructive"
        >
          <WarningCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {fault.label}
            {fault.detail ? t('error.detailSuffix', { detail: fault.detail }) : ''}
          </span>
        </div>
      ) : blockedBySafeMode ? (
        <p
          data-testid="plugin-card-diagnostic"
          data-fault="false"
          className="rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {t(plugin.enabled ? 'safeMode.cardPausedHint' : 'safeMode.cardQuarantinedHint')}
        </p>
      ) : null}

      {/* 标签与底栏一起贴底：同一行的卡片等高，说明长短不同也不会让标签和按钮上下错位。 */}
      <div className="mt-auto flex min-w-0 flex-col gap-2.5 pt-0.5">
      <PluginAdditionChips kinds={additions} />

      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
        {showDirectRecoveryActions ? (
          <div
            data-testid={blockedBySafeMode ? 'plugin-card-safe-mode-actions' : 'plugin-card-fault-actions'}
            className="flex shrink-0 items-center gap-1.5"
          >
            {plugin.enabled ? (
              <DsButton
                variant="outline"
                size="sm"
                data-testid="plugin-card-disable"
                aria-label={t('row.disable', { id: name })}
                className={cn('!h-8 shrink-0 gap-1 !rounded-lg !px-2.5', COARSE_TOUCH)}
                disabled={busy}
                onClick={() => onToggle(false)}
              >
                <Power className="size-3.5" aria-hidden="true" />
                {t('card.disable')}
              </DsButton>
            ) : null}
            <DsButton
              variant="outline"
              size="sm"
              data-testid="plugin-card-uninstall"
              aria-label={t('row.uninstallA11y', { id: name })}
              className={cn('!h-8 shrink-0 gap-1 !rounded-lg !px-2.5 !text-destructive', COARSE_TOUCH)}
              disabled={busy}
              onClick={onUninstall}
            >
              <Trash className="size-3.5" aria-hidden="true" />
              {t('row.uninstall')}
            </DsButton>
          </div>
        ) : primary ? (
          <DsButton variant="outline" size="sm" data-testid={`plugin-card-${primary.key}`} aria-label={primary.a11y}
            // 卡片网格里不放实色按钮（D1：一个视图一个实色主按钮；详情页才用实色）。
            className={cn('!h-8 shrink-0 gap-1.5 !rounded-lg !px-2.5', COARSE_TOUCH)}
            disabled={primary.disabled} onClick={primary.run}>
            <primary.icon className="size-4" aria-hidden="true" />{primary.label}
          </DsButton>
        ) : null}
        {canExport && onExport ? (
          <DsButton variant="ghost" size="sm" data-testid="plugin-card-export"
            aria-label={t('card.exportA11y', { id: name })}
            className={cn('!h-8 shrink-0 gap-1 !rounded-lg !px-2 text-xs text-muted-foreground hover:text-foreground', COARSE_TOUCH)}
            disabled={busy} onClick={onExport}>
            <Export className="size-3.5" aria-hidden="true" />{t('card.exportShort')}
          </DsButton>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70" data-testid="plugin-card-origin">
          {pluginProvenance(plugin, t)}{plugin.version && plugin.version !== '—' ? ` · v${plugin.version}` : ''}
        </span>
        <AppMenu>
          <AppMenuTrigger asChild>
            <DsButton variant="ghost" size="sm" iconOnly data-testid="plugin-card-more" data-more-trigger=""
              aria-label={t('card.more', { id: name })} className={cn('shrink-0 text-muted-foreground', COARSE_TOUCH)}>
              <DotsThree className="size-5" weight="bold" aria-hidden="true" />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={208}>
            {canModify && onModify ? <AppMenuItem icon={<Sparkle size={16} />} onClick={onModify}>{t('manager.modify')}</AppMenuItem> : null}
            <AppMenuItem icon={<Info size={16} />} onClick={onSelect}>{t('card.details')}</AppMenuItem>
            {plugin.enabled && !consentRequired ? <AppMenuItem icon={<Power size={16} />} disabled={busy || !supported} onClick={() => onToggle(false)}>{t('card.disable')}</AppMenuItem> : null}
            {canExport && onExport ? <AppMenuItem icon={<Export size={16} />} disabled={busy} onClick={onExport}>{t('card.export')}</AppMenuItem> : null}
            {previousVersion && onRestorePrevious ? (
              <AppMenuItem icon={<ArrowCounterClockwise size={16} />} disabled={busy || blockedBySafeMode} onClick={onRestorePrevious}>
                {t('card.restorePrevious', { version: previousVersion })}
              </AppMenuItem>
            ) : null}
            <AppMenuSeparator />
            <AppMenuItem destructive icon={<Trash size={16} />} disabled={busy} onClick={onUninstall}>{t('row.uninstall')}</AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      </div>
      </div>
    </div>
  );
}
