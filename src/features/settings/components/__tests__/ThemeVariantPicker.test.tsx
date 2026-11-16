/**
 * theme.variants（contracts/surfaces.ts）：外观设置里的插件主题选择（ThemeVariantPicker）+ 设置插件的应用控制器。
 *
 * - 由 dstu.ui.settings 声明；无变体时选择器不渲染；
 * - 选中后按当前明暗模式把 light / dark 变量写到 <html>，切换模式随之切换；
 * - 选回默认、插件卸载时移除变量并恢复原有内联值；选择按 `<插件 id>/<贡献 id>` 记住，插件回来时重新生效。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeVariantPicker } from '../ThemeVariantPicker';
import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { setSelectedThemeVariant, THEME_VARIANT_STORAGE_KEY } from '@/features/settings/themeVariants';

const root = document.documentElement;
let kernel: UiKernel | undefined;

beforeEach(() => {
  setSelectedThemeVariant(null);
  root.classList.remove('dark');
  root.removeAttribute('style');
});
afterEach(async () => {
  cleanup();
  await kernel?.dispose();
  kernel = undefined;
  setSelectedThemeVariant(null);
  root.classList.remove('dark');
  root.removeAttribute('style');
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await installOfficialUiPlugins(kernel);
  return kernel;
}

const sepia: UiPlugin = defineUiPlugin({ meta: { id: 'community.theme' }, apply(ctx) {
  ctx.ui.contribute('theme.variants', { id: 'sepia', value: {
    label: '护眼棕', description: '暖色纸张',
    light: { '--background': '40 40% 94%', '--foreground': '30 20% 20%', color: 'red' },
    dark: { '--background': '30 15% 12%' },
  } });
} });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const variable = (name: string) => root.style.getPropertyValue(name);

describe('theme.variants', () => {
  it('is declared by dstu.ui.settings; the picker stays hidden without variants', async () => {
    const k = await boot();
    expect(k.slots.definition('theme.variants')?.cardinality).toBe('list');
    render(<UiKernelProvider kernel={k}><ThemeVariantPicker /></UiKernelProvider>);
    expect(screen.queryByTestId('theme-variant-picker')).toBeNull();
  });

  it('applies the picked variant for the current mode, follows mode switches, and reverts on default', async () => {
    const k = await boot();
    root.style.setProperty('--background', 'custom-palette');
    await k.install(sepia);
    render(<UiKernelProvider kernel={k}><ThemeVariantPicker /></UiKernelProvider>);
    const option = screen.getByRole('radio', { name: '护眼棕' });
    expect(screen.getByRole('radio', { name: '默认' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem(THEME_VARIANT_STORAGE_KEY)).toBe('community.theme/sepia');
    expect(variable('--background')).toBe('40 40% 94%');
    expect(variable('--foreground')).toBe('30 20% 20%');
    expect(root.style.color).toBe(''); // only custom properties are applied

    root.classList.add('dark');
    await act(flush);
    expect(variable('--background')).toBe('30 15% 12%');
    expect(variable('--foreground')).toBe('');

    fireEvent.click(screen.getByRole('radio', { name: '默认' }));
    expect(variable('--background')).toBe('custom-palette');
    expect(localStorage.getItem(THEME_VARIANT_STORAGE_KEY)).toBeNull();
  });

  it('removes the variables when the plugin unloads and re-applies them when it returns', async () => {
    const k = await boot();
    await k.install(sepia);
    setSelectedThemeVariant('community.theme/sepia');
    expect(variable('--background')).toBe('40 40% 94%');

    await act(async () => { await k.unload('community.theme'); });
    expect(variable('--background')).toBe('');

    await act(async () => { await k.install(sepia); });
    expect(variable('--background')).toBe('40 40% 94%');
  });

  it('removes the variables when the settings plugin (the controller) goes away', async () => {
    const k = await boot();
    await k.install(sepia);
    setSelectedThemeVariant('community.theme/sepia');
    expect(variable('--background')).toBe('40 40% 94%');
    await k.dispose();
    kernel = undefined;
    expect(variable('--background')).toBe('');
  });
});
