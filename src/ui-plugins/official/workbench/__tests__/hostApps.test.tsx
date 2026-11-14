import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import { blockRegistry } from '@/features/chat/registry/blockRegistry';
import { contributeWorkbenchApp } from '@/features/workbench/core/appContributions';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import type { AppDefinition, AppWindowProps } from '@/features/workbench/core/types';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import workbenchPlugin from '../index';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const ANKI = 'dstu.anki';
const manifest = (installed: string[], degraded: { id: string; reason: string }[] = []) => ({
  plugins: installed.map((id) => ({ id })),
  degraded,
});

const EmptyLibrary: React.FC<AppWindowProps> = () => <p>卡片库还是空的</p>;

function app(typeId: string, hostPlugin?: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:apps.${typeId}`,
    icon: null,
    instanceMode: 'single',
    memoryWeight: 1,
    defaultFrame: { w: 100, h: 100 },
    minSize: { w: 50, h: 50 },
    render: React.lazy(async () => ({ default: EmptyLibrary })),
    ...(hostPlugin ? { hostPlugin } : {}),
  };
}

function openWindow(typeId: string) {
  const def = appRegistry.get(typeId)!;
  const onTitleChange = vi.fn();
  const props = { windowId: `${typeId}-1`, instanceKey: null, isActive: true, onTitleChange } as unknown as AppWindowProps;
  render(<React.Suspense fallback={null}><def.render {...props} /></React.Suspense>);
  return { onTitleChange };
}

const registered = () => appRegistry.list().map((def) => def.typeId).sort();

let kernel: UiKernel;

beforeAll(async () => {
  await import('@/components/system-status/HostUnavailablePanel');
  contributeWorkbenchApp(app('w17-flashcards', ANKI));
  contributeWorkbenchApp(app('w17-todo'));
});

async function start() {
  kernel = new UiKernel({ legacyRegistries: { commandRegistry, blockRegistry, appRegistry } });
  expect(await kernel.install(workbenchPlugin)).toBe(true);
}

afterEach(async () => {
  await kernel.dispose();
  useSystemStatusStore.getState().setComponentHealth([]);
});

describe('dstu.ui.workbench: apps that declare hostPlugin', () => {
  it('withdraws the app while its Host plugin is missing and registers it again when the plugin returns', async () => {
    await start();
    expect(registered()).toEqual(['w17-flashcards', 'w17-todo']);

    act(() => kernel.hostStatus.update(manifest(['dstu.chat'])));
    expect(registered()).toEqual(['w17-todo']);

    act(() => kernel.hostStatus.update(manifest(['dstu.chat', ANKI])));
    expect(registered()).toEqual(['w17-flashcards', 'w17-todo']);
    expect(appRegistry.get('w17-flashcards')!.hostPlugin).toBe(ANKI);
  });

  it('shows the Host unavailable panel while degraded and switches an open window live in both directions', async () => {
    await start();
    act(() => kernel.hostStatus.update(manifest([ANKI], [{ id: ANKI, reason: 'anki database locked' }])));
    expect(registered()).toEqual(['w17-flashcards', 'w17-todo']);

    const { onTitleChange } = openWindow('w17-flashcards');
    expect(await screen.findByText('anki database locked')).toBeInTheDocument();
    expect(screen.queryByText('卡片库还是空的')).not.toBeInTheDocument();
    expect(onTitleChange).toHaveBeenCalledWith('workbench:apps.w17-flashcards');
    expect(useSystemStatusStore.getState().componentHealth).toEqual([
      { component: `host:${ANKI}`, status: 'degraded', reason: 'anki database locked', dependency: null },
    ]);

    act(() => kernel.hostStatus.updateDegraded([]));
    expect(await screen.findByText('卡片库还是空的')).toBeInTheDocument();
    expect(useSystemStatusStore.getState().componentHealth).toEqual([]);

    act(() => kernel.hostStatus.updateDegraded([{ id: ANKI, reason: 'host plugin crashed' }]));
    expect(await screen.findByText('host plugin crashed')).toBeInTheDocument();
  });

  it('renders the app while the Host status is unknown, and leaves apps without hostPlugin untouched', async () => {
    await start();
    openWindow('w17-flashcards');
    expect(await screen.findByText('卡片库还是空的')).toBeInTheDocument();
    expect(appRegistry.get('w17-todo')!.render).toBe(
      (await import('@/features/workbench/core/appContributions')).workbenchAppContributions.values().find((d) => d.typeId === 'w17-todo')!.render,
    );
  });

  it('reports a failed re-registration to the error budget and keeps the other apps', async () => {
    await start();
    act(() => kernel.hostStatus.update(manifest([])));
    await kernel.install(defineUiPlugin({ meta: { id: 'community.cards' }, apply(ctx) {
      ctx.ui.workbench.registerApp({ ...app('w17-flashcards') });
    } }));

    act(() => kernel.hostStatus.update(manifest([ANKI])));
    expect(appRegistry.get('w17-flashcards')!.hostPlugin).toBeUndefined();
    expect(registered()).toEqual(['w17-flashcards', 'w17-todo']);
    expect(kernel.errors.list('dstu.ui.workbench').map((r) => r.message)).toEqual([
      expect.stringContaining('workbench app "w17-flashcards" is already registered'),
    ]);
  });

  it('stops following the Host plugin once the workbench plugin is unloaded', async () => {
    await start();
    await kernel.unload('dstu.ui.workbench');
    expect(registered()).toEqual([]);
    act(() => kernel.hostStatus.update(manifest([ANKI])));
    expect(registered()).toEqual([]);
  });
});
