// RUST-FIX(RF-P6-manager-cards): 详情抽屉的正文——它增加了什么、健康、信任与权限（人话）、设置、版本与改动、技术信息。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, ArrowSquareOut, Export, Play, ShieldCheck, Sparkle, Trash } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { Switch } from '@/components/ui/shad/Switch';
import { cn } from '@/lib/utils';

import { DegradedReason } from './DegradedReason';
import { PluginAdditionChips, PluginStatus, PluginTile, pluginProvenance } from './PluginCard';
import { PluginLockedMark } from './PluginRow';
import type { PluginAutoUninstallReason } from './reasons';
import type { ManagedPlugin, PluginPlatform } from './types';
import type { PluginUiStatusSnapshot } from './ui-status';
import type { PluginManagerWork } from './workshop';
import { permissionLines } from './permissions';
import { pluginAdditions, pluginDescription, pluginName, pluginStatusKey, unsupportedPlatformKey } from './presentation';

const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">{title}</h3>
      <div className="min-w-0 space-y-2 text-sm">{children}</div>
    </section>
  );
}


export interface PluginDetailProps {
  plugin: ManagedPlugin;
  platform: PluginPlatform;
  busy: boolean;
  pendingEnabled?: boolean;
  errorBudget: { errors: number; budget: number } | null;
  autoUninstalled: PluginAutoUninstallReason | null;
  uiStatus?: PluginUiStatusSnapshot;
  safeMode?: boolean;
  livePoints?: readonly string[];
  lockedReason?: string;
  /** 依赖它的插件名称（Host 的 `requiredBy`，已本地化）。 */
  requiredByNames?: readonly string[];
  work?: PluginManagerWork;
  canOpen?: boolean;
  canModify?: boolean;
  canExport?: boolean;
  canChangeTrust?: boolean;
  /** 配置区（由面板提供：加载/错误/表单）。 */
  /** 配置区（加载中/出错/表单）；插件没有可编辑的设置时为 null，整个分区不出现。 */
  settings: ReactNode | null;
  onToggle: (enabled: boolean) => void;
  onOpen?: () => void;
  onModify?: () => void;
  onExport?: () => void;
  onRestorePrevious?: () => void;
  onUninstall: () => void;
  onReviewConsent?: () => void;
  onChangeTrust?: () => void;
}

export function PluginDetail({
  plugin, platform, busy, pendingEnabled, errorBudget, autoUninstalled, uiStatus, safeMode = false, livePoints,
  lockedReason, requiredByNames = [], work, canOpen = false, canModify = false, canExport = false, canChangeTrust = false, settings,
  onToggle, onOpen, onModify, onExport, onRestorePrevious, onUninstall, onReviewConsent, onChangeTrust,
}: PluginDetailProps) {
  const { t } = useTranslation('plugin_manager');
  const name = pluginName(plugin, t);
  const description = pluginDescription(plugin, t);
  const declared = plugin.platforms;
  const supported = declared.length === 0 || declared.includes(platform);
  const degraded = uiStatus?.degraded;
  const consentRequired = uiStatus?.consentRequired === true || plugin.consent === 'required';
  const blockedBySafeMode = safeMode && plugin.origin === 'community';
  const statusKey = !supported ? unsupportedPlatformKey(plugin, platform) : autoUninstalled ? 'manager.problemStatus' : pluginStatusKey(plugin, uiStatus, safeMode);
  const switchDisabled = busy || !supported || blockedBySafeMode;
  const additions = pluginAdditions(plugin, livePoints);
  const community = plugin.origin === 'community';
  const running = plugin.enabled && plugin.runtime === 'running';
  // 账本对不上的原因用人话说：权限 / 内容 / 版本哪一样变了；从没同意过就是普通的「需要你的同意」。
  const changedReason = plugin.consentReason && plugin.consentReason !== 'missing' ? plugin.consentReason : undefined;
  const consentKey = !community ? null
    : consentRequired ? (changedReason ? `detail.consentChanged.${changedReason}` : 'detail.consentRequired')
      : plugin.consent === 'granted' ? 'detail.consentGranted' : 'detail.consentUnknown';
  const permissions = permissionLines(plugin.permissions ?? [], plugin.agentTools, t);

  return (
    <div data-testid="plugin-detail" data-plugin-id={plugin.id} data-origin={plugin.origin}
      data-enabled={plugin.enabled ? 'true' : 'false'} data-runtime={plugin.runtime}
      data-auto-uninstalled={autoUninstalled ? 'true' : undefined} className="min-w-0 space-y-6">
      <header className="min-w-0 space-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <PluginTile plugin={plugin} name={name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <PluginStatus statusKey={statusKey} />
              {consentRequired ? <span className="sr-only" data-testid="plugin-consent-required">{t('row.consentRequired')}</span> : null}
            </div>
            <p className="mt-1 min-w-0 text-xs text-muted-foreground">
              {community ? pluginProvenance(plugin, t) : t('origin.builtin')}
            </p>
          </div>
          {lockedReason
            ? <PluginLockedMark reason={lockedReason} />
            : <Switch checked={pendingEnabled ?? (plugin.enabled && !consentRequired)} disabled={switchDisabled} aria-label={t('row.enable', { id: name })} className="mt-1 shrink-0" onCheckedChange={onToggle} />}
        </div>
        {description ? <p className="min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere]" data-testid="plugin-detail-description">{description}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {running && canOpen && onOpen ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} onClick={onOpen}>
              <ArrowSquareOut className="size-4" aria-hidden="true" />{t('card.open')}
            </DsButton>
          ) : null}
          {plugin.enabled && plugin.runtime !== 'running' && !consentRequired ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} disabled={switchDisabled} onClick={() => onToggle(true)}>
              <Play className="size-4" aria-hidden="true" />{t('manager.start')}
            </DsButton>
          ) : null}
          {consentRequired && onReviewConsent ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} onClick={onReviewConsent}
              disabled={busy || blockedBySafeMode} aria-label={t('row.reviewConsentA11y', { id: name })}>
              <ShieldCheck className="size-4" aria-hidden="true" />{t('card.allowAndEnable')}
            </DsButton>
          ) : null}
          {canModify && onModify ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} onClick={onModify}>
              <Sparkle className="size-4" aria-hidden="true" />{t('manager.modify')}
            </DsButton>
          ) : null}
          {canExport && onExport ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} disabled={busy} onClick={onExport}>
              <Export className="size-4" aria-hidden="true" />{t('card.export')}
            </DsButton>
          ) : null}
          {community ? (
            <DsButton variant="outline" size="sm" className={cn('gap-1.5 !text-destructive', COARSE_TOUCH)} onClick={onUninstall}
              disabled={busy} aria-label={t('row.uninstallA11y', { id: name })}>
              <Trash className="size-4" aria-hidden="true" />{t('row.uninstall')}
            </DsButton>
          ) : null}
        </div>
      </header>

      {additions.length || plugin.agentTools?.length ? (
        <Section title={t('detail.adds')} testId="plugin-detail-adds">
          <PluginAdditionChips kinds={additions} surface="background" label={false} />
          {plugin.agentTools?.length ? (
            <p className="text-xs leading-relaxed text-muted-foreground" data-testid="plugin-detail-tools">
              {t('detail.agentTools', { tools: plugin.agentTools.map((tool) => tool.title).join(t('detail.separator')) })}
            </p>
          ) : null}
        </Section>
      ) : community ? (
        <Section title={t('detail.adds')} testId="plugin-detail-adds">
          <p className="text-xs leading-relaxed text-muted-foreground">{t('detail.addsUnknown')}</p>
        </Section>
      ) : null}

      <Section title={t('detail.health')} testId="plugin-detail-health">
        {!supported ? <p data-testid="plugin-platform-unsupported" className="text-xs text-warning">{t(unsupportedPlatformKey(plugin, platform))}</p> : null}
        {!blockedBySafeMode && !degraded && !plugin.degraded && plugin.runtimeDetail ? (
          <p className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]" data-testid="plugin-runtime-detail">{plugin.runtimeDetail}</p>
        ) : null}
        {!blockedBySafeMode && (degraded || plugin.degraded) ? <DegradedReason reason={plugin.degraded?.reason} info={degraded} /> : null}
        {blockedBySafeMode ? <p data-testid="plugin-safe-mode-hint" className="text-xs leading-relaxed text-muted-foreground">{t('safeMode.rowHint')}</p> : null}
        {autoUninstalled ? (
          <p role="status" data-testid="plugin-auto-uninstalled" className="flex items-start gap-1.5 text-xs text-destructive">
            <ArrowCounterClockwise className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t('errorBudget.row', { errors: autoUninstalled.errors, budget: autoUninstalled.budget })}
          </p>
        ) : errorBudget && errorBudget.errors > 0 ? (
          // 健康时不提「累计 N 次会被自动卸载」：只有真的出过错才说。
          <p data-testid="plugin-error-budget" className="text-xs text-muted-foreground">
            {t('errorBudget.count', { errors: errorBudget.errors, budget: errorBudget.budget })}
          </p>
        ) : null}
        {consentKey ? <p className="text-xs text-muted-foreground" data-testid="plugin-detail-consent" data-consent={plugin.consent ?? 'unknown'} data-consent-reason={changedReason}>{t(consentKey)}</p> : null}
        {supported && !plugin.degraded && !degraded && !autoUninstalled && !blockedBySafeMode && !consentRequired && running && !(errorBudget && errorBudget.errors > 0)
          ? <p className="text-xs text-muted-foreground">{t('detail.healthy')}</p> : null}
        {lockedReason ? <p className="text-xs leading-relaxed text-muted-foreground" data-testid="plugin-detail-locked">{lockedReason}</p> : null}
      </Section>

      {/* 「它能做什么」：人话的权限行，加一句它和应用一起运行。信任档位这种术语放进「技术信息」。 */}
      <Section title={t('manager.trust')} testId="plugin-detail-trust">
        {!community ? <p className="text-sm text-foreground/80">{t('manager.builtinTrust')}</p> : null}
        {permissions.length ? (
          <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground/50" data-testid="plugin-detail-permissions" aria-label={t('consent.permissions')}>
            {permissions.map((line, index) => (
              <li className="min-w-0 text-sm text-foreground/85 [overflow-wrap:anywhere]" key={`${line.raw}:${index}`} data-permission={line.raw}>{line.text}</li>
            ))}
          </ul>
        ) : community ? <p className="text-sm text-foreground/80">{t('detail.noPermissionsPlain')}</p> : null}
        {community ? <p className="text-xs leading-relaxed text-muted-foreground" data-testid="plugin-detail-same-process">{t('detail.sameProcess')}</p> : null}
      </Section>

      {settings ? <Section title={t('manager.settings')} testId="plugin-detail-settings">{settings}</Section> : null}

      <Section title={t('manager.version')} testId="plugin-detail-version">
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span data-testid="plugin-version">{plugin.version}</span>
        </p>
        {work?.changes.length ? (
          <div data-testid="plugin-detail-changes">
            <p className="text-xs text-muted-foreground">{t('detail.changes')}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-foreground/80">
              {work.changes.map((change) => <li key={change} className="[overflow-wrap:anywhere]">{change}</li>)}
            </ul>
          </div>
        ) : null}
        {work?.previousVersion && onRestorePrevious ? (
          <DsButton variant="outline" size="sm" className={cn('gap-1.5', COARSE_TOUCH)} disabled={busy || blockedBySafeMode} onClick={onRestorePrevious}>
            <ArrowCounterClockwise className="size-4" aria-hidden="true" />{t('card.restorePrevious', { version: work.previousVersion })}
          </DsButton>
        ) : <p className="text-xs leading-relaxed text-muted-foreground">{t(community ? 'manager.rollbackPending' : 'detail.builtinVersion')}</p>}
      </Section>

      <details className="text-xs text-muted-foreground" data-testid="plugin-detail-technical">
        <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]">{t('manager.technical')}</summary>
        <dl className="mt-2 space-y-1.5">
          <div><dt className="inline">{t('detail.idLabel')}</dt><dd className="inline select-all break-all font-mono text-foreground/80" data-testid="plugin-detail-id">{plugin.id}</dd></div>
          {plugin.homepage ? <div><dt className="inline">{t('detail.homepageLabel')}</dt><dd className="inline select-all break-all">{plugin.homepage}</dd></div> : null}
          {plugin.permissions?.length ? <div><dt className="inline">{t('permission.rawLabel')}</dt><dd className="inline select-all break-all font-mono" data-testid="plugin-detail-raw-permissions">{plugin.permissions.join(', ')}</dd></div> : null}
          {community && plugin.trust ? <div data-testid="plugin-detail-trust-level"><dt className="inline">{t('manager.trustLevel', { level: '' })}</dt><dd className="inline">{t(`manager.${plugin.trust}`)}</dd></div> : null}
          {requiredByNames.length ? <div><dt className="inline">{t('detail.requiredByLabel')}</dt><dd className="inline" data-testid="plugin-detail-required-by">{requiredByNames.join(t('detail.separator'))}</dd></div> : null}
        </dl>
        {community && plugin.trust ? (
          <div className="mt-3 space-y-1.5" data-testid="plugin-detail-change-trust">
            <p className="leading-relaxed">{t(plugin.trust === 'full' ? 'manager.fullRisk' : 'manager.restrictedNote')}</p>
            <DsButton variant="outline" size="sm" className={COARSE_TOUCH} disabled={!canChangeTrust}
              aria-describedby={safeMode ? 'plugin-trust-disabled-reason' : undefined} onClick={onChangeTrust}>{t('manager.changeTrust')}</DsButton>
            {safeMode ? <p id="plugin-trust-disabled-reason">{t('manager.trustDisabled')}</p> : null}
          </div>
        ) : null}
      </details>
    </div>
  );
}
