import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import shellPlugin from '@/ui-plugins/official/shell';
import type { ShellViewModule } from '@/ui-kernel/contracts/shell';
import { actualAppHarness } from './actualAppHarness';

vi.mock('@/styles/motion-springs', () => ({ prefersReducedMotion: () => true }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(load: () => Promise<ShellViewModule>) {
  const kernel = new UiKernel();
  await kernel.install(shellPlugin, { origin: 'builtin' });
  await kernel.install(defineUiPlugin({ meta: { id: 'test.lazy' }, apply(ctx) {
    ctx.ui.views.register({ id: 'test-lazy', titleKey: 'test', load });
  } }));
  const app = actualAppHarness();
  render(<UiKernelProvider kernel={kernel}><app.App /></UiKernelProvider>);
  return { kernel, app };
}

it('keeps pending lazy fallback inside its layer and hides it when another view is active', async () => {
  let resolve!: (value: ShellViewModule) => void;
  const load = vi.fn(() => new Promise<ShellViewModule>(done => { resolve = done; }));
  const { kernel, app } = await mount(load);
  expect(load).not.toHaveBeenCalled();
  await act(async () => app.navigate('test-lazy'));
  const layer = document.querySelector<HTMLElement>('[data-view-layer-shell="test-lazy"]')!;
  expect(layer.querySelector('[data-page="PageLoadingFallback"]')).not.toBeNull();
  await act(async () => app.navigate('chat-v2'));
  expect(layer.style.visibility).toBe('hidden');
  expect(document.querySelectorAll('[data-page="LazyChatV2Page"]')).toHaveLength(1);
  await act(async () => resolve({ default: () => <div>lazy ready</div> }));
  await act(async () => app.navigate('test-lazy'));
  expect(screen.getByText('lazy ready')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  cleanup(); await kernel.dispose();
});

it('clicking the real App view retry button calls load again and recovers', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi.fn<() => Promise<ShellViewModule>>()
    .mockRejectedValueOnce(new Error('first load failed'))
    .mockResolvedValue({ default: () => <div>recovered lazy view</div> });
  const { kernel, app } = await mount(load);
  try {
    await act(async () => app.navigate('test-lazy'));
    expect(load).toHaveBeenCalledTimes(1);
    const layer = document.querySelector('[data-view-layer-shell="test-lazy"]')!;
    expect(layer.querySelector('button')).not.toBeNull();
    await act(async () => fireEvent.click(layer.querySelector('button')!));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('recovered lazy view')).toBeTruthy();
    await act(async () => app.navigate('chat-v2'));
    await act(async () => app.navigate('test-lazy'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('recovered lazy view')).toBeTruthy();
  } finally { cleanup(); await kernel.dispose(); }
});
