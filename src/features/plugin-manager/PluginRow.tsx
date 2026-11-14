// RUST-FIX(RF-P2-manager-redesign): compact named rows and one authoritative summary state.
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, GearSix, PuzzlePiece, ShieldCheck, Trash, ChatCircle, BookOpen, MagnifyingGlass, Wrench, Package } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { settingsQuietInteractiveRowClassName } from '@/components/settings';
import { Badge } from '@/components/ui/shad/Badge';
import { Switch } from '@/components/ui/shad/Switch';
import { cn } from '@/lib/utils';

import { DegradedReason } from './DegradedReason';
import type { PluginAutoUninstallReason } from './reasons';
import type { ManagedPlugin, PluginPlatform } from './types';
import type { PluginUiStatusSnapshot } from './ui-status';
import { pluginName, pluginDescription, pluginStatusKey } from './presentation';

export interface PluginRowProps {
  compact?: boolean;
  onSelect?: () => void;
  plugin: ManagedPlugin;
  platform: PluginPlatform;
  busy: boolean;
  /** 当前累计错误 / 预算（没有错误预算时为 null）。 */
  errorBudget: { errors: number; budget: number } | null;
  /** 达到预算被内核自动卸载时的记录。 */
  autoUninstalled: PluginAutoUninstallReason | null;
  /** W17 hostStatus 的 UI 侧状态（降级/同意）；提供时优先于 Host 快照里的原始原因。 */
  uiStatus?: PluginUiStatusSnapshot;
  /** 安全模式会话：社区插件不可启用。 */
  safeMode?: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onUninstall: () => void;
  /** 用户要处理“需要同意”：请求 Host 重新评估，Host 会以 CONSENT_REQUIRED 返回精确主体。 */
  onReviewConsent?: () => void;
}

/** 与设置页一致的触屏命中高度。 */
const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

/**
 * 一条已安装插件：ID、版本、平台、启用/运行状态、降级与自动卸载原因、启停/配置/卸载。
 *
 * 版式照设置页列表行（PluginsTab / MCP 服务器行）：
 * 左侧图标块 + 名称/描述/状态，右侧操作列（桌面分隔线、移动端整行另起），
 * 行本身用 `settingsQuietInteractiveRowClassName` 的悬停/圆角，不另做卡片。
 */
export function PluginRow({
  compact = false,
  onSelect,
  plugin,
  platform,
  busy,
  errorBudget,
  autoUninstalled,
  uiStatus,
  safeMode = false,
  onToggle,
  onConfigure,
  onUninstall,
  onReviewConsent,
}: PluginRowProps) {
  const { t } = useTranslation('plugin_manager');
  const declared = plugin.platforms;
  const supported = declared.length === 0 || declared.includes(platform);
  const headingId = `plugin-${plugin.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-name`;
  const originKey = plugin.origin === 'builtin' ? 'origin.builtin' : 'origin.community';
  const degraded = uiStatus?.degraded;
  const consentRequired = uiStatus?.consentRequired === true || plugin.consent === 'required';
  const blockedBySafeMode = safeMode && plugin.origin === 'community';
  const name = pluginName(plugin, t);
  const description = pluginDescription(plugin, t);
  const icons = { ChatCircle, BookOpen, MagnifyingGlass, Wrench, Package, PuzzlePiece };
  const Icon = icons[plugin.icon as keyof typeof icons] ?? PuzzlePiece;
  const statusKey = !supported ? 'row.unsupportedPlatform' : autoUninstalled ? 'manager.problemStatus' : pluginStatusKey(plugin, uiStatus, safeMode);
  const summary = <Badge variant={statusKey === 'manager.problemStatus' ? 'destructive' : statusKey === 'row.consentRequired' ? 'secondary' : 'outline'} data-testid="plugin-summary-state">
    {t(statusKey)}
  </Badge>;

  if (compact) return (
    <div role="listitem" data-testid="plugin-row" data-plugin-id={plugin.id} data-origin={plugin.origin}
      data-enabled={String(plugin.enabled)} data-runtime={plugin.runtime}
      className={cn('flex min-w-0 items-center gap-3 px-1 py-2.5', settingsQuietInteractiveRowClassName)}>
      {/* `cn()` is plain concatenation (no tailwind-merge), so the primitive's `whitespace-nowrap`,
          fixed `h-*`, `shrink-0`, `items-center` and `justify-center` would win by stylesheet order.
          Every override that must beat them is `!`-prefixed; inner text containers keep `min-w-0`
          plus explicit wrapping so long plugin descriptions never run under the right-hand switch. */}
      <DsButton variant="ghost" onClick={onSelect} aria-label={t('manager.details', { id: name })}
        className={cn('!h-auto !shrink !items-start !justify-start !whitespace-normal !rounded-lg !bg-transparent !p-0 min-w-0 flex-1 gap-3 text-left', COARSE_TOUCH)}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/80"><Icon className="size-4 text-muted-foreground" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]" data-testid="plugin-row-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-sm text-foreground/90">{name}</span>{summary}
            {plugin.trust ? <Badge variant="outline" className={plugin.trust === 'full' ? 'border-warning/30 bg-warning/10 text-warning' : undefined} data-testid="plugin-trust-badge">{t(`manager.${plugin.trust}`)}</Badge> : null}
          </span>
          <span className="mt-1 block min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-xs text-muted-foreground/70" data-testid="plugin-row-description">{plugin.author || t(originKey)}{description ? ` · ${description}` : ''}</span>
        </span>
      </DsButton>
      <Switch checked={plugin.enabled} disabled={busy || !supported || blockedBySafeMode} aria-label={t('row.enable', { id: name })} className="shrink-0" onCheckedChange={onToggle} />
    </div>
  );

  return (
    <div
      role="listitem"
      aria-labelledby={headingId}
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
      data-origin={plugin.origin}
      data-enabled={plugin.enabled ? 'true' : 'false'}
      data-runtime={plugin.runtime}
      data-auto-uninstalled={autoUninstalled ? 'true' : undefined}
      className={cn(
        'group flex min-w-0 flex-col gap-2 overflow-hidden px-1 py-2.5 md:flex-row md:items-start',
        settingsQuietInteractiveRowClassName,
        !supported && 'opacity-70',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 pt-0.5 md:pt-1.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/80">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 id={headingId} className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-sm leading-tight text-foreground/90">
              {name}
            </h4>
            <span className="text-xs text-muted-foreground">{plugin.author || t(originKey)}</span>
            <span className="text-xs text-muted-foreground" data-testid="plugin-version">
              {plugin.version}
            </span>
            {declared.map((kind) => (
              <span key={kind} className="text-xs text-muted-foreground" data-platform={kind}>
                {t(`platform.${kind}`)}
              </span>
            ))}
            {!supported ? (
              <span data-testid="plugin-platform-unsupported">
                {t('row.unsupportedPlatform')}
              </span>
            ) : null}
            {consentRequired ? (
              <span className="sr-only" data-testid="plugin-consent-required">
                {t('row.consentRequired')}
              </span>
            ) : null}
          </div>

          {description ? (
            <p className="mt-0.5 min-w-0 whitespace-normal break-words text-xs leading-relaxed text-muted-foreground/70 [overflow-wrap:anywhere] md:line-clamp-2" data-testid="plugin-row-description">
              {description}
            </p>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
            {summary}
          </div>
          {!blockedBySafeMode && !degraded && !plugin.degraded && plugin.runtimeDetail ? (
            <p
              className="mt-1 min-w-0 whitespace-normal break-words text-xs leading-relaxed text-muted-foreground/70 [overflow-wrap:anywhere]"
              data-testid="plugin-runtime-detail"
            >
              {plugin.runtimeDetail}
            </p>
          ) : null}

          {!blockedBySafeMode && (degraded || plugin.degraded) ? (
            <DegradedReason reason={plugin.degraded?.reason} info={degraded} className="mt-1.5" />
          ) : null}

          {blockedBySafeMode ? (
            <p data-testid="plugin-safe-mode-hint" className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
              {t('safeMode.rowHint')}
            </p>
          ) : null}

          {autoUninstalled ? (
            <p
              role="status"
              data-testid="plugin-auto-uninstalled"
              className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive"
            >
              <ArrowCounterClockwise className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('errorBudget.row', { errors: autoUninstalled.errors, budget: autoUninstalled.budget })}
            </p>
          ) : errorBudget && errorBudget.errors > 0 ? (
            <p data-testid="plugin-error-budget" className="mt-1 text-xs text-muted-foreground/70">
              {t('errorBudget.count', { errors: errorBudget.errors, budget: errorBudget.budget })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-11 w-full min-w-0 flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/30 pt-2 md:w-auto md:max-w-[50%] md:border-l md:border-t-0 md:pl-4 md:pt-0">
        {plugin.enabled && plugin.runtime !== 'running' && !consentRequired ? <DsButton variant="outline" size="sm" className={COARSE_TOUCH}
          disabled={busy || !supported || blockedBySafeMode} onClick={() => onToggle(true)}>{t('manager.start')}</DsButton> : null}
        {consentRequired && onReviewConsent ? (
          <DsButton
            variant="outline"
            size="sm"
            className={cn('gap-1.5', COARSE_TOUCH)}
            onClick={onReviewConsent}
            disabled={busy || blockedBySafeMode}
            aria-label={t('row.reviewConsentA11y', { id: plugin.id })}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t('row.reviewConsent')}
          </DsButton>
        ) : null}
        {plugin.configurable !== false ? (
          <DsButton
            variant="outline"
            size="sm"
            className={cn('gap-1.5', COARSE_TOUCH)}
            onClick={onConfigure}
            disabled={busy}
            aria-label={t('row.configA11y', { id: plugin.id })}
          >
            <GearSix className="size-4" aria-hidden="true" />
            {t('row.configure')}
          </DsButton>
        ) : null}
        {plugin.origin === 'community' ? (
          <DsButton
            variant="outline"
            size="sm"
            className={cn('gap-1.5 !text-destructive', COARSE_TOUCH)}
            onClick={onUninstall}
            disabled={busy}
            aria-label={t('row.uninstallA11y', { id: plugin.id })}
          >
            <Trash className="size-4" aria-hidden="true" />
            {t('row.uninstall')}
          </DsButton>
        ) : null}
        <Switch
          checked={plugin.enabled}
          disabled={busy || !supported || blockedBySafeMode}
          aria-label={t('row.enable', { id: plugin.id })}
          onCheckedChange={onToggle}
        />
      </div>
    </div>
  );
}
