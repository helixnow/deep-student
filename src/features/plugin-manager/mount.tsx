/**
 * W35 与设置外壳（W36/W17）之间的唯一挂载点。
 *
 * W35 不修改 Settings/App/main/ui-kernel，也不改官方插件聚合入口（`src/ui-plugins/official/plugins.ts`）：
 * 新增官方插件会改变 slot-snapshot golden 的插件清单，必须由 W16 按 owner-moves 流程接收。
 * 拿到 W01 的真实命令、W17 的宿主状态接口后，W36/W17 只需在此调用一次：
 *
 * ```ts
 * ctx.ui.settings.register(createPluginManagerSection({
 *   controller, errorBudget: kernel.errors, uiStatus: ctx.ui.hostStatus,
 * }));
 * ```
 *
 * 新官方插件目录同样只需要 `defineUiPlugin({ meta, apply })` 里注册这个 section——组件、状态与
 * 适配器都在 `src/features/plugin-manager` 内，插件侧不复制任何 UI 逻辑。
 */
import React from 'react';
import { Package, Plug } from '@phosphor-icons/react';

import type { SettingsSectionRegistration, SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';
import { useOptionalUiKernel } from '@/ui-kernel/react';

import type { PluginManagerController } from './controller';
import type { PluginErrorBudgetView } from './reasons';
import type { PluginUiHostStatus } from './ui-status';
import type { PluginManagerWorkshop } from './workshop';

/** 与设置其它分区一致：未打开分区时不把管理页（及其表单/弹窗）拉进启动包。 */
const LazyPluginManagerPanel = React.lazy(() =>
  import('./PluginsSection').then((module) => ({ default: module.PluginsSection })),
);

export const PLUGIN_MANAGER_SECTION_ID = 'plugin-manager';
/** 用户定稿：「插件管理」+ Package / teal；现有微信渠道「插件」的名称与图标不改。 */
export const PLUGIN_MANAGER_NAVIGATION = {
  titleKey: 'plugin_manager:title',
  icon: Package,
  mobileAccent: 'var(--settings-nav-accent-teal)',
} as const;

export interface PluginManagerSectionOptions {
  workshop?: PluginManagerWorkshop;
  controller: PluginManagerController;
  /** 内核 `UiErrorBudget` 实例；用于展示 3 次熔断后的自动卸载原因。 */
  errorBudget?: PluginErrorBudgetView | null;
  /** W17 已发布的 `ctx.ui.hostStatus`：UI 侧降级、同意与安全模式（`safeMode`）。 */
  uiStatus?: PluginUiHostStatus | null;
  /** 设置分区排序（默认 45，位于现有「插件」渠道页签之后）。 */
  order?: number;
  /** 侧栏排序（默认 125）。 */
  navigationOrder?: number;
}

/** 生成可直接交给 `ctx.ui.settings.register` 的插件管理分区。 */
export function createPluginManagerSection({
  controller,
  errorBudget,
  uiStatus,
  workshop,
  order = 45,
  navigationOrder = 125,
}: PluginManagerSectionOptions): SettingsSectionRegistration {
  return {
    id: PLUGIN_MANAGER_SECTION_ID,
    group: 'integrations',
    order,
    titleKey: PLUGIN_MANAGER_NAVIGATION.titleKey,
    placement: 'main',
    // 刻意在桌面和移动端均展示；不同于仅桌面的微信渠道页。
    // 配置/同意沿用 DsDialog 的移动 bottom sheet 与统一返回键。
    visible: () => true,
    component: function PluginManagerSettingsSection(renderProps?: Partial<SettingsSectionRenderProps>) {
      const kernel = useOptionalUiKernel();
      // 渠道插件（微信 iLink Bot）的回复模型选择复用设置页的统一模型清单；
      // 直接渲染（测试/独立挂载）时没有 shell 工厂，退化为空清单。
      const models = renderProps?.getProps?.plugins?.().models ?? [];
      return <LazyPluginManagerPanel controller={controller} errorBudget={errorBudget ?? kernel?.errors} uiStatus={uiStatus} workshop={workshop} models={models} />;
    },
    navigation: {
      order: navigationOrder,
      legacyGroup: 2,
      icon: PLUGIN_MANAGER_NAVIGATION.icon,
      mobileDescriptionKey: 'plugin_manager:subtitle',
      mobileAccent: PLUGIN_MANAGER_NAVIGATION.mobileAccent,
      category: { id: 'integrations', titleKey: 'settings:categories.integrations', icon: Plug, order: 40 },
      categoryOrder: 40,
    },
    searchDetails: [
      {
        order: 10,
        labelKey: 'plugin_manager:title',
        keywords: ['plugin', 'plugins', '插件', 'community', '社区', 'consent', '同意', 'config', '配置'],
      },
    ],
  };
}
