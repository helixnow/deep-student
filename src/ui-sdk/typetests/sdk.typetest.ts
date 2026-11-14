/**
 * SDK 的编译期断言（`npm run typecheck` 与 `__tests__/sdk.types.test.ts` 检查；不被应用导入）。
 * 社区插件经 SDK 模块做声明合并（打包后的模块名为 `@deepstudent/ui`，仓库内为本目录的 index）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import {
  contribution, contributeAll, createPluginStore, definePlugin, defineSlot, defineUiPlugin, SlotOutlet, usePluginStore, type AppMenuDesktop,
  type AppMenuDockWindow, type AppMenuRow, type AppMenuWorkbench, type PluginStore, type SettingsSection,
} from '../index';

declare module '../index' {
  interface SlotMap {
    'sdk-typetest.cards': { heading: string; component: ComponentType };
  }
}

declare const ctx: Context;
declare function expectType<T>(value: T): void;

export const cards = [
  contribution('sdk-typetest.cards', { id: 'ok', value: { heading: 'h', component: () => null } }),
  // @ts-expect-error [static-shape]
  contribution('sdk-typetest.cards', { id: 'bad', value: { heading: 1, component: () => null } }),
  // @ts-expect-error [static-builtin-nav]
  contribution('nav', { id: 'n', value: { id: 'n', labelKey: 'l' } }),
  contribution('sdk-typetest.undeclared', { id: 'u', value: 42 }),
];

export const plugin = definePlugin({
  meta: { id: 'acme.sdk-typetest', platforms: ['desktop'], host: 'dstu.review', requiresHost: ['dstu.mastery'] },
  apply(c) {
    c.ui.declareSlot(defineSlot('sdk-typetest.cards', 'list'));
    contributeAll(c, cards);
  },
});

// @ts-expect-error [meta-platform]
definePlugin({ meta: { id: 'x', platforms: ['tablet'] }, apply() {} });
// @ts-expect-error [meta-api-version]
definePlugin({ meta: { id: 'x', apiVersion: 1 }, apply() {} });
// Meta fields belong in meta; the kernel reads only plugin.meta.
// @ts-expect-error [meta-field-outside-meta]
defineUiPlugin({ meta: { id: 'x' }, devOnly: true, apply() {} });

export function storeAssertions(): void {
  const store = createPluginStore(ctx, { done: 0, label: 'x' });
  expectType<PluginStore<{ done: number; label: string }>>(store);
  // @ts-expect-error [store-shape]
  store.setState({ done: 'many' });
}

export function Outlet(): ComponentType | null {
  // @ts-expect-error [outlet-render]
  void SlotOutlet({ name: 'sdk-typetest.cards', render: (entry) => entry.value.missing });
  void SlotOutlet({ name: 'sdk-typetest.cards', render: (entry) => entry.value.heading });
  const done: number = usePluginStore(createPluginStore(ctx, { done: 1 }), (s) => s.done);
  void done;
  return null;
}

export function settingsAssertions(): SettingsSection | undefined {
  // An inline section may carry navigation (the settings sidebar entry); order may be left out.
  ctx.ui.settings.register({
    id: 'acme.sdk-typetest/goal', group: 'acme.sdk-typetest', titleKey: 'acme.sdk-typetest:title', component: () => null,
    navigation: { order: 900, legacyGroup: 4, icon: () => null, mobileDescriptionKey: 'acme.sdk-typetest:description', mobileAccent: 'var(--settings-nav-accent-teal)' },
  });
  // @ts-expect-error [settings-navigation]
  ctx.ui.settings.register({ id: 'x', group: 'x', titleKey: 'x', component: () => null, navigation: { order: 1 } });
  return ctx.ui.slots.get<SettingsSection>('settings.sections', 'acme.sdk-typetest/goal')?.value;
}

// Rows for the Dock and desktop menus are written against the context types the SDK exports.
const dockWindowRow = (window: AppMenuDockWindow, workbench: AppMenuWorkbench): AppMenuRow => ({ id: window.id, label: window.label, run: () => workbench.focusWindow(window.id) });
const wallpaperRows = (desktop: AppMenuDesktop): AppMenuRow[] =>
  desktop.wallpaperPresets.map((preset) => ({ id: preset.id, label: preset.nameKey, radio: true, checked: desktop.wallpaper.value === preset.id, run: () => desktop.setWallpaperPreset(preset.id) }));
export const menus = [
  contribution('app.menu', { id: 'acme.sdk-typetest/dock', value: { menu: 'workbench.dock', items: (dock) => dock.windows.map((w) => dockWindowRow(w, dock.workbench)) } }),
  contribution('app.menu', { id: 'acme.sdk-typetest/desktop', value: { menu: 'workbench.desktop', items: (desktop) => [{ id: 'wallpaper', label: 'Wallpaper', submenu: wallpaperRows(desktop) }] } }),
  // @ts-expect-error [menu-context]
  contribution('app.menu', { id: 'acme.sdk-typetest/wrong', value: { menu: 'workbench.dock', items: (dock) => wallpaperRows(dock) } }),
];
