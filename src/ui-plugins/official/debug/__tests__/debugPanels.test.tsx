/**
 * `debug.panels` (FE-B7): dstu.ui.debug mirrors the official announcements, exists in development builds only, and
 * community panels are appended to the Analysis Panel and removed again when their plugin unloads.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { debugMasterSwitch } from '@/debug-panel/debugMasterSwitch';
import { debugPanelContributions, type DebugPanel, type DebugPanelPluginProps } from '../api';
import debugPlugin from '../index';

vi.mock('@/dev/devtools', () => ({ toggleDevtools: vi.fn(async () => null) }));
// The official manifest is covered by src/debug-panel/__tests__/debugPanelInventory.test.tsx.
vi.mock('@/debug-panel/panels', () => ({}));

const OfficialA = () => <div>official-a</div>;
const OfficialB = () => <div>official-b</div>;
const official: DebugPanel[] = [
  { id: 'official-a', labelKey: 'a', descriptionKey: 'a_desc', labelDefault: 'Official A', descriptionDefault: 'A', groupId: 'infra-quality', component: OfficialA },
  { id: 'official-b', labelKey: 'b', descriptionKey: 'b_desc', labelDefault: 'Official B', descriptionDefault: 'B', groupId: 'chat-timeline', component: OfficialB },
];

function CommunityPanel({ isActive }: DebugPanelPluginProps) {
  return <div data-testid="community-panel">community {isActive ? 'active' : 'idle'}</div>;
}

const community = defineUiPlugin({
  meta: { id: 'example.trace-panel', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.contribute('debug.panels', {
      id: 'trace-panel',
      order: 1000,
      value: { id: 'trace-panel', labelKey: 'trace', descriptionKey: 'trace_desc', labelDefault: 'Trace', descriptionDefault: 'Community trace panel', groupId: 'infra-quality', component: CommunityPanel },
    });
  },
});

let createAppUiKernel: typeof import('@/ui-kernel/bootstrap').createAppUiKernel;

beforeAll(async () => {
  for (const panel of official) debugPanelContributions.announce(panel);
  ({ createAppUiKernel } = await import('@/ui-kernel/bootstrap'));
}, 60_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function kernelWithDebug() {
  const kernel = new UiKernel();
  await kernel.install(debugPlugin, { origin: 'builtin' });
  return kernel;
}

function portal() {
  return document.getElementById('dstu-debugger-portal')!;
}

describe('dstu.ui.debug', () => {
  it('declares debug.panels and contributes the announced panels in order, revoked on uninstall', async () => {
    expect(debugPlugin.meta.slots).toEqual(['debug.panels']);
    const kernel = await kernelWithDebug();
    expect(kernel.slots.definitions().find((def) => def.name === 'debug.panels')?.cardinality).toBe('list');
    expect(kernel.slots.list('debug.panels').map((entry) => [entry.id, entry.owner, entry.origin])).toEqual([
      ['official-a', 'dstu.ui.debug', 'builtin'],
      ['official-b', 'dstu.ui.debug', 'builtin'],
    ]);
    await kernel.unload('dstu.ui.debug');
    expect(kernel.slots.list('debug.panels')).toEqual([]);
    await kernel.dispose();
  });

  it('is development-only: the app UI assembly leaves it out of production builds', async () => {
    expect(debugPlugin.meta.devOnly).toBe(true);
    const installed = async () => {
      const kernel = await createAppUiKernel();
      const result = { plugin: kernel.plugins().some((plugin) => plugin.id === 'dstu.ui.debug'), slot: kernel.slots.definitions().some((def) => def.name === 'debug.panels') };
      await kernel.dispose();
      return result;
    };
    expect(await installed()).toEqual({ plugin: true, slot: true });
    vi.stubEnv('DEV', false);
    try {
      expect(await installed()).toEqual({ plugin: false, slot: false });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('appends a community panel to the Analysis Panel and removes it when the plugin unloads', async () => {
    const kernel = await kernelWithDebug();
    await kernel.install(community);
    expect(kernel.slots.list('debug.panels').map((entry) => entry.id)).toEqual(['official-a', 'official-b', 'trace-panel']);
    debugMasterSwitch.enable();
    const { default: DebugPanelHost } = await import('@/debug-panel/DebugPanelHost');
    render(
      <UiKernelProvider kernel={kernel}>
        <DebugPanelHost visible onClose={() => undefined} />
      </UiKernelProvider>,
    );
    const titles = () => Array.from(portal().querySelectorAll('h3')).map((h3) => h3.textContent);
    expect(titles()).toEqual(['Official B', 'Official A', 'Trace']);

    const card = Array.from(portal().querySelectorAll('h3')).find((h3) => h3.textContent === 'Trace')!.closest('div[class*="cursor-pointer"]') as HTMLElement;
    fireEvent.click(within(card).getByText('打开'));
    expect(within(portal()).getByTestId('community-panel').textContent).toBe('community active');

    await act(() => kernel.unload('example.trace-panel'));
    expect(within(portal()).queryByTestId('community-panel')).toBeNull();
    fireEvent.click(within(portal()).getByText('调试首页'));
    expect(titles()).toEqual(['Official B', 'Official A']);
    debugMasterSwitch.disable();
    await kernel.dispose();
  });

  it('isolates a failing community panel', async () => {
    const Broken = () => {
      throw new Error('broken panel');
    };
    const kernel = await kernelWithDebug();
    await kernel.install(defineUiPlugin({
      meta: { id: 'example.broken-panel', version: '0.1.0' },
      apply(ctx) {
        ctx.ui.contribute('debug.panels', { id: 'broken', value: { id: 'broken', labelKey: 'broken', descriptionKey: 'broken_desc', groupId: 'infra-quality', component: Broken } });
      },
    }));
    debugMasterSwitch.enable();
    localStorage.setItem('DSTU_DEBUG_PLUGIN', 'broken');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { default: DebugPanelHost } = await import('@/debug-panel/DebugPanelHost');
    render(
      <UiKernelProvider kernel={kernel}>
        <DebugPanelHost visible onClose={() => undefined} />
      </UiKernelProvider>,
    );
    expect(within(portal()).getByText('Analysis Panel')).toBeTruthy();
    expect(kernel.errors.list('example.broken-panel').map((report) => [report.phase, report.slot, report.entryId])).toEqual([['render', 'debug.panels', 'broken']]);
    error.mockRestore();
    debugMasterSwitch.disable();
    await kernel.dispose();
  });
});
