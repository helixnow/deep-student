import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from '@/ui-plugins/official/settings';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';
import '../production';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});
vi.mock('../host-adapter', () => ({
  createHostPluginManagerAdapter: () => new FakePluginManagerAdapter([
    managedPlugin({ id: 'community.example', origin: 'community', consent: 'required' }),
  ]),
}));

describe('production settings registration', () => {
  it('registers under the settings owner, consumes real hostStatus, and revokes with that owner', async () => {
    const kernel = new UiKernel();
    kernel.hostStatus.update({ plugins: [], degraded: [], safeMode: true });
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const entry = kernel.slots.list('settings.sections').find((entry) => entry.key === 'plugin-manager')!;
    expect(entry.owner).toBe('dstu.ui.settings');
    expect(entry.value.navigation).toMatchObject({ mobileAccent: 'var(--settings-nav-accent-teal)' });
    const Component = entry.value.component;
    const view = render(<UiKernelProvider kernel={kernel}><Suspense fallback={null}>
      <Component getProps={{} as never} />
    </Suspense></UiKernelProvider>);
    // Wait for the real lazy section, not merely its Suspense fallback.
    expect(await screen.findByTestId('plugin-safe-mode', {}, { timeout: 10_000 })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '查看 community.example 的详情' }));
    expect(await screen.findByRole('button', { name: '处理 community.example 的权限同意' })).toBeDisabled();
    view.unmount();
    await kernel.unload('dstu.ui.settings');
    expect(kernel.slots.list('settings.sections').some((entry) => entry.key === 'plugin-manager')).toBe(false);
    await kernel.dispose();
  }, 15_000);
});
