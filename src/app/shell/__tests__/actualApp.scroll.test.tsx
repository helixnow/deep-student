import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import shellPlugin from '@/ui-plugins/official/shell';
import { clearAllViewStates, restoreViewState } from '@/utils/viewStateManager';
import { actualAppHarness } from './actualAppHarness';

vi.mock('@/styles/motion-springs', () => ({ prefersReducedMotion: () => true }));
afterEach(() => { cleanup(); clearAllViewStates(); vi.useRealTimers(); });

it('actual App saves settings scroll, cleans up on leave and restores after returning', async () => {
  vi.useFakeTimers();
  const kernel = new UiKernel();
  await kernel.install(shellPlugin, { origin: 'builtin' });
  const app = actualAppHarness();
  expect(app.startup).toEqual(['host', 'prewarm']);
  render(<UiKernelProvider kernel={kernel}><app.App /></UiKernelProvider>);
  await act(async () => app.navigate('settings'));
  const layer = document.querySelector<HTMLElement>('[data-view-layer-shell="settings"]')!;
  // jsdom has no layout or Tailwind; provide the same computed visibility/content geometry.
  layer.style.zIndex = '10'; layer.style.opacity = '1';
  Object.defineProperties(layer, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  // Listener installation happens at commit; initial computed class style is supplied below.
  await act(async () => app.navigate('chat-v2'));
  await act(async () => app.navigate('settings'));
  layer.scrollTop = 345;
  fireEvent.scroll(layer);
  await act(async () => vi.advanceTimersByTime(350));
  expect(restoreViewState('settings')?.scrollTop).toBe(345);
  await act(async () => app.navigate('chat-v2'));
  layer.scrollTop = 999;
  fireEvent.scroll(layer);
  await act(async () => vi.advanceTimersByTime(350));
  expect(restoreViewState('settings')?.scrollTop).toBe(345);
  layer.scrollTop = 0;
  await act(async () => app.navigate('settings'));
  await act(async () => vi.advanceTimersByTime(99));
  expect(layer.scrollTop).toBe(0);
  await act(async () => vi.advanceTimersByTime(51));
  expect(layer.scrollTop).toBe(345);
  cleanup();
  await kernel.dispose();
});
