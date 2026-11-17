/**
 * 插件视图应用（学习桌面）— 把社区插件的 `views` 槽位条目镜像成工作台应用
 *
 * 社区插件（含插件工坊作品）只调用 `ctx.ui.views.register`，在经典壳里它是一个顶层视图；
 * 学习桌面没有「视图」，只有窗口应用。本模块订阅 UI 内核的 `views` 槽位，为每条非官方
 * 视图登记一个 `plugin-view.<viewKey>` 工作台应用，于是：
 * - 「全部应用」（AppsPanel）自动列出它（标题取插件命名空间里的 titleKey）；
 * - `kernel.navigation.navigate(viewKey)` → NAVIGATE_TO_VIEW{view} 由 WorkbenchEventBridge
 *   经 {@link resolvePluginViewAppTypeId} 打开对应窗口（插件管理卡片 / 工坊卡片的「打开」）；
 * - 插件卸载 / 停用（视图撤销）时应用随之注销。
 *
 * 官方视图（origin === 'builtin'）各有专属工作台应用，不在此镜像。
 */
import React from 'react';
import { PuzzlePiece } from '@phosphor-icons/react';
import type { UiKernel } from '@/ui-kernel/kernel';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { ShellViewContribution } from '@/ui-kernel/contracts/shell';
import { pluginNamespace } from '@/ui-kernel/meta';
import { whenAppUiKernel } from '@/ui-kernel/app-kernel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition, AppWindowProps } from '../../core/types';
import { createPluginViewAgentManifest } from './agentManifest';

/** 插件视图应用 typeId 前缀（不用 ':'，agent targetRef 以 ':' 分段）。 */
export const PLUGIN_VIEW_APP_PREFIX = 'plugin-view.';

/** `views` 槽位 key → 工作台应用 typeId。 */
export function pluginViewAppTypeId(viewKey: string): string {
  return `${PLUGIN_VIEW_APP_PREFIX}${viewKey}`;
}

export function isPluginViewAppTypeId(typeId: string): boolean {
  return typeId.startsWith(PLUGIN_VIEW_APP_PREFIX);
}

/**
 * NAVIGATE_TO_VIEW 的 view 若是已镜像的插件视图，返回要启动的 typeId；否则 null（交给经典壳或其它处理）。
 */
export function resolvePluginViewAppTypeId(view: unknown): string | null {
  if (typeof view !== 'string' || !view) return null;
  const typeId = pluginViewAppTypeId(view);
  return appRegistry.get(typeId) ? typeId : null;
}

type ViewEntry = SlotEntry<ShellViewContribution & { icon?: unknown }>;

/** 视图标题的 i18n key：带命名空间的原样使用，否则落在插件 id 派生的命名空间里。 */
export function pluginViewNameKey(entry: Pick<ViewEntry, 'owner' | 'value'>): string {
  const titleKey = typeof entry.value?.titleKey === 'string' && entry.value.titleKey ? entry.value.titleKey : 'title';
  return titleKey.includes(':') ? titleKey : `${pluginNamespace(entry.owner)}:${titleKey}`;
}

function isComponentLike(value: unknown): value is React.ComponentType<any> {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

function pluginViewIcon(entry: ViewEntry): React.ReactNode {
  const fallback = <PuzzlePiece size={30} weight="duotone" data-testid="wb-plugin-view-icon" />;
  const custom = entry.value.icon;
  if (!isComponentLike(custom)) return fallback;
  return (
    <span data-testid="wb-plugin-view-icon" className="inline-flex h-8 w-8 items-center justify-center">
      <ErrorBoundary name={`plugin-view-icon:${entry.owner}/${entry.key ?? entry.value.id}`} fallback={() => fallback}>
        {React.createElement(custom, { size: 28, className: 'h-7 w-7' })}
      </ErrorBoundary>
    </span>
  );
}

function createPluginViewAppDefinition(entry: ViewEntry, kernel: UiKernel): AppDefinition {
  const viewKey = entry.key ?? entry.value.id;
  const render = React.lazy(async () => {
    const { PluginViewAppWindow } = await import('./PluginViewAppWindow');
    const Window: React.FC<AppWindowProps> = (props) => (
      <PluginViewAppWindow {...props} viewKey={viewKey} kernel={kernel} />
    );
    Window.displayName = `PluginViewApp(${viewKey})`;
    return { default: Window };
  });
  return {
    typeId: pluginViewAppTypeId(viewKey),
    nameKey: pluginViewNameKey(entry),
    icon: pluginViewIcon(entry),
    instanceMode: 'single',
    memoryWeight: 1,
    defaultFrame: { w: 960, h: 680 },
    minSize: { w: 420, h: 320 },
    render,
    agentManifest: createPluginViewAgentManifest(entry.owner, viewKey, kernel),
  };
}

interface Mirrored {
  entry: ViewEntry;
  def: AppDefinition;
}

/**
 * 把一个内核的社区 `views` 条目持续镜像进 appRegistry；返回停止函数（注销全部镜像应用）。
 * 导出供测试；生产经 {@link registerPluginViewApps} 接主窗口内核。
 */
export function mirrorPluginViewApps(kernel: UiKernel): () => void {
  const mirrored = new Map<string, Mirrored>();

  const sync = () => {
    const entries = (kernel.slots.list('views') as readonly ViewEntry[])
      .filter((entry) => entry.origin !== 'builtin' && (entry.key ?? entry.value?.id));
    const seen = new Set<string>();
    for (const entry of entries) {
      const typeId = pluginViewAppTypeId(entry.key ?? entry.value.id);
      seen.add(typeId);
      const current = mirrored.get(typeId);
      if (current && current.entry.value === entry.value && current.entry.owner === entry.owner) continue;
      if (current) appRegistry.unregister(typeId, current.def);
      const def = createPluginViewAppDefinition(entry, kernel);
      appRegistry.register(def);
      mirrored.set(typeId, { entry, def });
    }
    for (const [typeId, { def }] of mirrored) {
      if (seen.has(typeId)) continue;
      appRegistry.unregister(typeId, def);
      mirrored.delete(typeId);
    }
  };

  sync();
  const unsubscribe = kernel.slots.subscribe('views', sync);
  return () => {
    unsubscribe();
    for (const [typeId, { def }] of mirrored) appRegistry.unregister(typeId, def);
    mirrored.clear();
  };
}

let started = false;

/** 幂等：主窗口内核就绪后开始镜像（随工作台 chunk 装配，见 registerAll.ts）。 */
export function registerPluginViewApps(): void {
  if (started) return;
  started = true;
  whenAppUiKernel((kernel) => {
    mirrorPluginViewApps(kernel);
  });
}
