// RUST-FIX(RF-P2-manager-redesign): compact named rows and one authoritative summary state.
// RUST-FIX(RF-P6-manager-cards): 「内置能力」的安静行——一句话说明；被其他功能依赖的基础服务显示为锁定而不是开关。
import { useTranslation } from 'react-i18next';
import { BookOpen, ChatCircle, Lock, MagnifyingGlass, Package, PuzzlePiece, Wrench } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { settingsQuietInteractiveRowClassName } from '@/components/settings';
import { Switch } from '@/components/ui/shad/Switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { cn } from '@/lib/utils';

import { PluginStatus } from './PluginCard';
import type { PluginAutoUninstallReason } from './reasons';
import type { ManagedPlugin, PluginPlatform } from './types';
import type { PluginUiStatusSnapshot } from './ui-status';
import { pluginName, pluginDescription, pluginStatusKey, unsupportedPlatformKey } from './presentation';

export interface PluginRowProps {
  onSelect?: () => void;
  plugin: ManagedPlugin;
  platform: PluginPlatform;
  busy: boolean;
  /** 开关正在向 Host 提交的目标值；有值时开关先显示它，其余状态仍按 Host 报告的 `plugin`。 */
  pendingEnabled?: boolean;
  /** 达到预算被内核自动卸载时的记录。 */
  autoUninstalled: PluginAutoUninstallReason | null;
  /** W17 hostStatus 的 UI 侧状态（降级/同意）；提供时优先于 Host 快照里的原始原因。 */
  uiStatus?: PluginUiStatusSnapshot;
  /** 安全模式会话：社区插件不可启用。 */
  safeMode?: boolean;
  /**
   * 有值表示这是别的功能正在依赖的基础服务：不渲染开关，显示锁定标记并用这句话说明原因。
   * 由调用方根据 Host 的依赖数据生成（见 `pluginIsEssential`）。
   */
  lockedReason?: string;
  onToggle: (enabled: boolean) => void;
}

/** 与设置页一致的触屏命中高度。 */
const COARSE_TOUCH = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

export const PLUGIN_ICONS = { ChatCircle, BookOpen, MagnifyingGlass, Wrench, Package, PuzzlePiece } as const;

/** 锁定标记：基础服务不提供开关；悬停/聚焦说明是谁在用它，读屏直接读出原因。 */
export function PluginLockedMark({ reason, className }: { reason: string; className?: string }) {
  const { t } = useTranslation('plugin_manager');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="plugin-locked"
          className={cn('inline-flex shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}>
          <Lock className="size-3.5" aria-hidden="true" />
          {t('essential.label')}
          <span className="sr-only">{reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent maxWidth={280} side="left" className="!whitespace-normal !leading-relaxed">{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 一条内置能力：名称、一句话说明（与分组标题对齐，不再每行重复同一枚分组图标），右侧是开关或锁定标记。点名称进详情。
 *
 * 版式照设置页列表行（`settingsQuietInteractiveRowClassName` 的悬停/圆角），不另做卡片；
 * 状态只在“不是正常运行”时出现，正常的行保持安静。
 */
export function PluginRow({
  onSelect, plugin, platform, busy, pendingEnabled, autoUninstalled, uiStatus, safeMode = false, lockedReason, onToggle,
}: PluginRowProps) {
  const { t } = useTranslation('plugin_manager');
  const declared = plugin.platforms;
  const supported = declared.length === 0 || declared.includes(platform);
  const originKey = plugin.origin === 'builtin' ? 'origin.builtin' : 'origin.community';
  const blockedBySafeMode = safeMode && plugin.origin === 'community';
  const name = pluginName(plugin, t);
  const description = pluginDescription(plugin, t);
  const switchChecked = pendingEnabled ?? plugin.enabled;
  const statusKey = !supported ? unsupportedPlatformKey(plugin, platform) : autoUninstalled ? 'manager.problemStatus' : pluginStatusKey(plugin, uiStatus, safeMode);

  return (
    <div role="listitem" data-testid="plugin-row" data-plugin-id={plugin.id} data-origin={plugin.origin}
      data-enabled={String(plugin.enabled)} data-runtime={plugin.runtime} data-locked={lockedReason ? 'true' : undefined}
      className={cn('flex min-w-0 items-center gap-3 py-2 pl-12 pr-1 sm:pl-10', settingsQuietInteractiveRowClassName, !supported && 'opacity-70')}>
      {/* `cn()` is plain concatenation (no tailwind-merge), so the primitive's `whitespace-nowrap`,
          fixed `h-*`, `shrink-0`, `items-center` and `justify-center` would win by stylesheet order.
          Every override that must beat them is `!`-prefixed; inner text containers keep `min-w-0`
          plus explicit wrapping so long plugin descriptions never run under the right-hand switch. */}
      <DsButton variant="ghost" onClick={onSelect} aria-label={t('manager.details', { id: name })}
        className={cn('!h-auto !shrink !items-start !justify-start !whitespace-normal !rounded-lg !bg-transparent !p-0 min-w-0 flex-1 gap-3 text-left', COARSE_TOUCH)}>
        <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]" data-testid="plugin-row-text">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-normal text-foreground/90">{name}</span>
            {statusKey !== 'runtime.running' ? <PluginStatus statusKey={statusKey} /> : null}
          </span>
          <span className="mt-0.5 block min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-xs font-normal leading-relaxed text-muted-foreground/70" data-testid="plugin-row-description">
            {description || plugin.author || t(originKey)}
          </span>
        </span>
      </DsButton>
      {lockedReason
        ? <PluginLockedMark reason={lockedReason} />
        : <Switch checked={switchChecked} disabled={busy || !supported || blockedBySafeMode} aria-label={t('row.enable', { id: name })} className="shrink-0" onCheckedChange={onToggle} />}
    </div>
  );
}
