/**
 * FE-B7: the Analysis Panel of a production build has no panels (accepted, see the comment above
 * `import('./panels')` in DebugPanelHost). The panel manifest is never imported, `dstu.ui.debug` is skipped by the
 * production UI assembly, and the host opens with its title bar and an empty home screen.
 */
import fs from 'node:fs';
import React from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, type UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { serializeDom } from '@/ui-plugins/testing/dom-snapshot';

const { manifest } = vi.hoisted(() => {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  return { manifest: { imported: false } };
});

vi.mock('../panels', () => {
  manifest.imported = true;
  return {};
});
vi.mock('@/dev/devtools', () => ({ toggleDevtools: vi.fn(async () => null) }));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE) fs.writeFileSync(file, current, { flag: 'wx' });
  return fs.readFileSync(file, 'utf8');
}

let kernel: UiKernel;

beforeAll(async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
  kernel = await createAppUiKernel();
}, 30_000);

afterAll(async () => {
  await kernel.dispose();
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Analysis Panel in a production build (FE-B7)', () => {
  it('has no debug.panels slot: dstu.ui.debug is skipped as development-only', () => {
    expect(kernel.skipped().filter((entry) => entry.id === 'dstu.ui.debug').map((entry) => entry.reason)).toEqual(['build']);
    expect(kernel.plugins().some((plugin) => plugin.id === 'dstu.ui.debug')).toBe(false);
    expect(kernel.slots.definitions().some((def) => def.name === 'debug.panels')).toBe(false);
  });

  it('accepts a community plugin contributing to the skipped debug.panels slot and drops the contribution', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const community = defineUiPlugin({
      meta: { id: 'example.production-debug-panel' },
      apply(ctx) {
        // No throw: the slot belongs to the devOnly owner the kernel skipped, so the contribution is dropped.
        expect(ctx.ui.contribute('debug.panels', { id: 'extras', value: { id: 'extras' } })).toBeTypeOf('function');
      },
    });
    await expect(kernel.install(community)).resolves.toBe(true);
    expect(kernel.slots.definition('debug.panels')).toBeUndefined();
    expect(kernel.slots.list('debug.panels')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    await kernel.unload('example.production-debug-panel');
    warn.mockRestore();
  });

  it('opens with the title bar and an empty home screen, without importing the panel manifest', async () => {
    const { default: DebugPanelHost } = await import('../DebugPanelHost');
    render(
      <UiKernelProvider kernel={kernel}>
        <DebugPanelHost visible onClose={() => undefined} />
      </UiKernelProvider>,
    );
    expect(manifest.imported).toBe(false);
    const portal = document.getElementById('dstu-debugger-portal')!;
    expect(portal.querySelectorAll('h3')).toHaveLength(0);
    const current = `${serializeDom(portal)}\n`;
    expect(current).toBe(golden('home.production.txt', current));
  });

  it('opens the LLM Playground view from the title bar', async () => {
    const { default: DebugPanelHost } = await import('../DebugPanelHost');
    render(
      <UiKernelProvider kernel={kernel}>
        <DebugPanelHost visible onClose={() => undefined} />
      </UiKernelProvider>,
    );
    const received: unknown[] = [];
    const listener = (event: Event) => received.push([event.constructor.name, (event as CustomEvent).detail]);
    window.addEventListener('NAVIGATE_TO_VIEW', listener);
    try {
      fireEvent.click(within(document.getElementById('dstu-debugger-portal')!).getByText('LLM Playground'));
    } finally {
      window.removeEventListener('NAVIGATE_TO_VIEW', listener);
    }
    expect(received).toEqual([['CustomEvent', { view: 'llm-playground' }]]);
  });
});
