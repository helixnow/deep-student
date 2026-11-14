/**
 * FE-B4 evidence: the Workbench app manifest as the production assembly builds it, plus what the launcher (AppsPanel)
 * and the Dock render from it. Captured from the pre-refactor assembly; the golden is never rewritten.
 */
import fs from 'node:fs';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ browserOpen: false }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@/features/browser/gates', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBrowserLaunchability: async () => ({ open: state.browserOpen, featureFlagEnabled: state.browserOpen, closeMessage: null }),
}));

import { appRegistry } from '../../core/appRegistry';
import { workbenchBus } from '../../core/workbenchBus';
import { useWindowStore } from '../../core/windowStore';
import type { AppDefinition } from '../../core/types';

const GOLDEN = 'src/features/workbench/apps/__golden__/apps.json';

/**
 * The production assembly under test: the real UI kernel bootstrap installs the official plugins (including
 * `dstu.ui.workbench`); WorkbenchDesktop (and the classic → Workbench handoff) then load the app chunk via
 * `apps/registerAll`, whose app modules contribute through that plugin.
 * (Golden captured from the previous assembly, where the app modules wrote to `appRegistry` themselves.)
 */
async function bootWorkbenchApps(): Promise<{ pinned: readonly string[]; dispose: () => Promise<void> }> {
  const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
  const kernel = await createAppUiKernel();
  const { DEFAULT_DOCK_PINNED } = await import('../registerAll');
  expect(kernel.registries.workbenchApps.list().map((def) => def.typeId)).toEqual(appRegistry.list().map((def) => def.typeId));
  return { pinned: DEFAULT_DOCK_PINNED, dispose: () => kernel.dispose() };
}

function describeElement(node: unknown): unknown {
  if (!React.isValidElement(node)) return node ?? null;
  const type = node.type as { displayName?: string; name?: string } | string;
  const props = Object.fromEntries(Object.entries(node.props as Record<string, unknown>).filter(([key]) => key !== 'children'));
  return { type: typeof type === 'string' ? type : type.displayName ?? type.name ?? 'anonymous', props };
}

function describeApp(def: AppDefinition, index: number) {
  const lazy = (def.render as { $$typeof?: symbol }).$$typeof === Symbol.for('react.lazy');
  return {
    index,
    typeId: def.typeId,
    nameKey: def.nameKey,
    icon: describeElement(def.icon),
    showInLauncher: def.showInLauncher ?? null,
    instanceMode: def.instanceMode,
    memoryWeight: def.memoryWeight,
    keepAliveWhenOccluded: def.keepAliveWhenOccluded ?? null,
    defaultFrame: def.defaultFrame,
    minSize: def.minSize,
    render: lazy ? 'lazy' : typeof def.render,
    confirmUnsavedOnClose: (def as { confirmUnsavedOnClose?: boolean }).confirmUnsavedOnClose ?? null,
    handlesCloseShortcut: def.handlesCloseShortcut ?? null,
    handlesTabCycleShortcut: def.handlesTabCycleShortcut ?? null,
    hooks: {
      onActivation: typeof def.onActivation === 'function',
      badgeSource: typeof def.badgeSource === 'function',
      canClose: typeof def.canClose === 'function',
      canSuspend: typeof def.canSuspend === 'function',
      prepareSuspend: typeof def.prepareSuspend === 'function',
    },
    agentCapabilities: def.agentManifest?.capabilities.map((capability) => capability.name) ?? null,
    otherKeys: Object.keys(def).sort(),
  };
}

async function renderLauncher(browserOpen: boolean) {
  state.browserOpen = browserOpen;
  const { AppsPanel } = await import('../../components/AppsPanel');
  const { openAppsPanel, closeAppsPanel } = await import('../../components/appsPanelStore');
  act(() => openAppsPanel());
  const view = render(<AppsPanel />);
  const listbox = () => view.container.querySelector('#wb-apps-listbox');
  await waitFor(() => expect(listbox()?.querySelectorAll('[data-wb-apps-kind="app"]').length ?? 0).toBeGreaterThan(0));
  if (browserOpen) await waitFor(() => expect(listbox()?.querySelector('[data-testid$="browser"]')).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const items = [...listbox()!.querySelectorAll('[data-wb-apps-kind="app"]')].map((el) => ({
    testId: el.getAttribute('data-testid'),
    text: el.textContent,
    html: el.outerHTML,
  }));
  view.unmount();
  act(() => closeAppsPanel());
  return items;
}

async function renderDock(pinned: readonly string[]) {
  const { Dock } = await import('../../components/Dock');
  const { setDockPinned } = await import('../../components/DockPinnedStore');
  act(() => setDockPinned([...pinned]));
  const view = render(<Dock />);
  const items = [...view.container.querySelectorAll('[data-testid^="wb-dock-item-"]')].map((el) => ({
    testId: el.getAttribute('data-testid'),
    html: el.outerHTML,
  }));
  view.unmount();
  return items;
}

describe('Workbench app manifest (FE-B4 golden)', () => {
  const result: Record<string, unknown> = {};
  let dispose: () => Promise<void> = async () => {};

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    workbenchBus.setEnabled(true);
    useWindowStore.setState({ windows: {}, focusStack: [], lifecycles: {}, launchPayloads: {}, tilingRatios: {}, desktopSize: { w: 1600, h: 900 } });
    const booted = await bootWorkbenchApps();
    dispose = booted.dispose;
    result.dockDefaultPinned = booted.pinned;
    result.registry = appRegistry.list().map(describeApp);
    result.agentManifests = appRegistry.listAgentManifests().map(({ typeId }) => typeId);
    result.launcher = {
      browserClosed: await renderLauncher(false),
      browserOpen: await renderLauncher(true),
    };
    result.dock = await renderDock(booted.pinned);
  }, 60_000);

  afterAll(async () => { await dispose(); });

  it('matches the pre-refactor registry, launcher and Dock', () => {
    if (process.env.FE_B4_CAPTURE_GOLDEN === '1') {
      fs.mkdirSync('src/features/workbench/apps/__golden__', { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(result.registry).toEqual(golden.registry);
    expect(result).toEqual(golden);
  });

  it('keeps the four default Dock pins and every app lazily rendered', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(golden.dockDefaultPinned).toEqual(['chat', 'files', 'settings', 'todo']);
    expect(golden.registry.every((app: { render: string }) => app.render === 'lazy')).toBe(true);
    expect(golden.registry).toHaveLength(22);
  });
});
