import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateWorkbenchApp,
  consumeWorkbenchHandoff,
  flushWorkbenchSnapshot,
  getWorkspaceActiveResourceType,
  hasDirtyWorkbenchWindows,
  isWorkbenchHostEnabled,
  launchWorkbenchApp,
  openWorkbenchAppsPanel,
  toggleWorkbenchAppsPanel,
  useFocusedWorkbenchAppTypeId,
} from '@/shared/workbenchHost';
import { installWorkbenchHost, uninstallWorkbenchHost } from '../host-runtime';
import { closeAppsPanel, isAppsPanelOpen } from '@/features/workbench/components/appsPanelStore';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

function makeWindow(id: string, typeId: string): WorkbenchWindow {
  return {
    id,
    typeId,
    instanceKey: null,
    title: typeId,
    frame: { x: 0, y: 0, w: 640, h: 480 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    createdAt: 1,
    lastFocusedAt: 1,
  };
}

function FocusProbe({ enabled }: { enabled: boolean }) {
  const typeId = useFocusedWorkbenchAppTypeId(enabled);
  return <output data-testid="focus">{String(typeId)}</output>;
}

describe('workbench host bridge', () => {
  beforeEach(() => {
    uninstallWorkbenchHost();
    resetWindowStoreForTests();
    closeAppsPanel();
  });

  afterEach(() => {
    uninstallWorkbenchHost();
    resetWindowStoreForTests();
    closeAppsPanel();
  });

  it('returns safe defaults before the desktop runtime registers', async () => {
    expect(isWorkbenchHostEnabled()).toBe(false);
    expect(getWorkspaceActiveResourceType()).toBeNull();
    expect(consumeWorkbenchHandoff()).toBeNull();
    expect(hasDirtyWorkbenchWindows()).toBe(false);
    expect(await activateWorkbenchApp({ typeId: 'todo', instanceKey: '', action: 'x' })).toBe(false);
    await expect(flushWorkbenchSnapshot()).resolves.toBeUndefined();
    launchWorkbenchApp({ typeId: 'todo', reason: 'api' });
    openWorkbenchAppsPanel();
    toggleWorkbenchAppsPanel();
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('tracks the focused workbench app type through the registered runtime', () => {
    useWindowStore.setState({
      windows: { notes: makeWindow('notes', 'notes') },
      focusStack: ['notes'],
    });
    render(<FocusProbe enabled />);
    expect(screen.getByTestId('focus')).toHaveTextContent('null');

    act(() => installWorkbenchHost());
    expect(screen.getByTestId('focus')).toHaveTextContent('notes');

    act(() => {
      useWindowStore.setState({
        windows: { files: makeWindow('files', 'files') },
        focusStack: ['files'],
      });
    });
    expect(screen.getByTestId('focus')).toHaveTextContent('files');

    // 经典壳（enabled=false）不读取工作台状态，即使运行时已注册。
    cleanup();
    render(<FocusProbe enabled={false} />);
    expect(screen.getByTestId('focus')).toHaveTextContent('null');
  });

  it('forwards apps-panel actions and reports enablement', () => {
    installWorkbenchHost();
    expect(isWorkbenchHostEnabled()).toBe(false);
    workbenchBus.setEnabled(true);
    expect(isWorkbenchHostEnabled()).toBe(true);
    workbenchBus.setEnabled(false);
    openWorkbenchAppsPanel();
    expect(isAppsPanelOpen()).toBe(true);
    toggleWorkbenchAppsPanel();
    expect(isAppsPanelOpen()).toBe(false);
    toggleWorkbenchAppsPanel();
    expect(isAppsPanelOpen()).toBe(true);
  });

  it('falls back to defaults after uninstall', () => {
    installWorkbenchHost();
    workbenchBus.setEnabled(true);
    expect(isWorkbenchHostEnabled()).toBe(true);
    uninstallWorkbenchHost();
    workbenchBus.setEnabled(false);
    expect(isWorkbenchHostEnabled()).toBe(false);
    expect(getWorkspaceActiveResourceType()).toBeNull();
    expect(hasDirtyWorkbenchWindows()).toBe(false);
  });
});
