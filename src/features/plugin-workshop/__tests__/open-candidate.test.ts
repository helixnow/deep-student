import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { getWorkbenchHostBridge, setWorkbenchHostBridge } from '@/shared/workbenchHost';
import { installWorkbenchHost, uninstallWorkbenchHost } from '@/app/workbench/host-runtime';
import { mirrorPluginViewApps } from '@/features/workbench/apps/plugin-views/register';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { openWorkshopCandidateView } from '../open-candidate';

const ID = 'workshop.open-target';
let kernel: UiKernel;
let stopMirror: (() => void) | undefined;
const plugin = (version: string, id = ID, viewId = 'candidate-target') => defineUiPlugin({ meta: { id, version }, apply(ctx) {
  ctx.ui.views.register({ id: viewId, titleKey: 'title', component: () => null });
} });
beforeEach(() => {
  uninstallWorkbenchHost();
  workbenchBus.setEnabled(false);
  resetWindowStoreForTests();
  kernel = new UiKernel();
});
afterEach(async () => {
  stopMirror?.(); stopMirror = undefined;
  await kernel.dispose();
  uninstallWorkbenchHost();
  workbenchBus.setEnabled(false);
  resetWindowStoreForTests();
});

describe('candidate desktop opening', () => {
  it('waits through host startup and registry assembly, then returns an actual target window without navigation events', async () => {
    await kernel.install(plugin('2.0.0'));
    const opening = openWorkshopCandidateView(kernel.slots, ID, '2.0.0', { timeoutMs: 1000 });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    installWorkbenchHost();
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    workbenchBus.setEnabled(true);
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    stopMirror = mirrorPluginViewApps(kernel);
    const id = await opening;
    expect(useWindowStore.getState().windows[id]).toMatchObject({ typeId: 'plugin-view.candidate-target' });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([id]);
  });

  it('does not open the old release while the exact candidate version is still loading', async () => {
    installWorkbenchHost(); workbenchBus.setEnabled(true);
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(plugin('1.0.0'));
    const opening = openWorkshopCandidateView(kernel.slots, ID, '2.0.0', { timeoutMs: 1000 });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    await kernel.install(plugin('2.0.0'));
    const id = await opening;
    expect(kernel.slots.get('views', 'candidate-target')?.version).toBe('2.0.0');
    expect(useWindowStore.getState().windows[id]?.typeId).toBe('plugin-view.candidate-target');
  });

  it('reopens a closed candidate and restores focus on a minimized candidate during repeated verification', async () => {
    installWorkbenchHost(); workbenchBus.setEnabled(true);
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(plugin('2.0.0'));
    const open = () => openWorkshopCandidateView(kernel.slots, ID, '2.0.0', { timeoutMs: 1000 });
    const first = await open();
    useWindowStore.getState().closeWindow(first);
    expect(useWindowStore.getState().windows[first]).toBeUndefined();
    const reopened = await open();
    expect(useWindowStore.getState().windows[reopened]?.typeId).toBe('plugin-view.candidate-target');
    useWindowStore.getState().minimizeWindow(reopened);
    expect(useWindowStore.getState().windows[reopened]?.minimized).toBe(true);
    expect(await open()).toBe(reopened);
    expect(useWindowStore.getState().windows[reopened]?.minimized).toBe(false);
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([reopened]);
  });

  it('never opens another plugin and stops listening when its scope is cancelled', async () => {
    installWorkbenchHost(); workbenchBus.setEnabled(true);
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(plugin('2.0.0', 'workshop.other', 'other-view'));
    const cancellation = new AbortController();
    const opening = openWorkshopCandidateView(kernel.slots, ID, '2.0.0', { timeoutMs: 1000, signal: cancellation.signal });
    cancellation.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await kernel.install(plugin('2.0.0'));
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
  });

  it('does not acknowledge an open when the desktop launch produced no window', async () => {
    installWorkbenchHost(); workbenchBus.setEnabled(true);
    stopMirror = mirrorPluginViewApps(kernel);
    await kernel.install(plugin('2.0.0'));
    const launch = vi.fn(() => null);
    setWorkbenchHostBridge({ ...getWorkbenchHostBridge()!, launch });
    await expect(openWorkshopCandidateView(kernel.slots, ID, '2.0.0', { timeoutMs: 0 })).rejects.toThrow('WORKSHOP_OPEN_TIMEOUT');
    expect(launch).toHaveBeenCalledOnce();
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
  });
});
