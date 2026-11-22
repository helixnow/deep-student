import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

vi.mock('@/features/workbench/apps/registerAll', () => ({ DEFAULT_DOCK_PINNED: ['chat'] }));
vi.mock('@/features/workbench/core/scheduler', () => ({ startScheduler: () => () => {} }));
vi.mock('@/features/workbench/core/snapshot', () => ({
  flushSnapshot: async () => {},
  registerDockPinnedProvider: () => {},
  saveSnapshot: () => {},
}));
vi.mock('@/features/workbench/core/spaceSnapshots', () => ({
  bootInitialSpaceWorkbench: async () => ({ snapshot: null }),
  getSpaceSwitchGeneration: () => 0,
  handleStudySpaceChanged: async () => {},
  installSpaceSnapshotMirror: () => () => {},
}));
vi.mock('@/features/workbench/core/projection', () => ({ resyncProjections: () => {} }));
vi.mock('@/features/workbench/apps/system/projections', () => ({ registerSystemProjections: () => () => {} }));
vi.mock('@/features/workbench/components/WallpaperLayer', () => ({
  WallpaperLayer: () => null,
  DEFAULT_WALLPAPER: { type: 'solid', color: '#000' },
}));
vi.mock('@/features/workbench/components/DesktopContextMenu', () => ({
  DesktopContextMenu: () => null,
  useDesktopGestures: () => ({ onDesktopContextMenu: vi.fn(), onDesktopKeyDown: vi.fn(), onDesktopDoubleClick: vi.fn() }),
}));
vi.mock('@/features/workbench/components/WallpaperManagerDialog', () => ({
  WallpaperManagerDialog: () => null,
  OPEN_WALLPAPER_MANAGER_EVENT: 'open-wallpaper-manager',
}));
vi.mock('@/features/workbench/hooks/useWallpaperCoveragePause', () => ({ useWallpaperCoveragePause: () => false }));
vi.mock('@/features/workbench/components/EmptyDesktop', () => ({ EmptyDesktop: () => null }));
vi.mock('@/features/workbench/components/DesktopAgendaWidget', () => ({ DesktopAgendaWidget: () => <div data-testid="builtin-agenda" /> }));
vi.mock('@/features/workbench/components/DesktopAiBriefingWidget', () => ({ DesktopAiBriefingWidget: () => <div data-testid="builtin-briefing" /> }));
vi.mock('@/features/workbench/components/ImmersiveHint', () => ({ ImmersiveHint: () => null }));
vi.mock('@/features/workbench/components/DesktopShortcuts', () => ({ DesktopShortcutsLayer: () => null }));
vi.mock('@/features/workbench/components/WindowShell', () => ({ WindowShell: () => null }));
vi.mock('@/features/workbench/components/SnapPreview', () => ({ SnapPreview: () => null }));
vi.mock('@/features/workbench/components/Dock', () => {
  let pinned = ['chat'];
  return {
    Dock: () => null,
    getDockPinned: () => pinned,
    setDockPinned: (next: string[]) => { pinned = next; },
    subscribeDockPinned: () => () => {},
  };
});
vi.mock('@/features/workbench/components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/features/workbench/components/AppsPanel', () => ({ AppsPanel: () => null }));
vi.mock('@/features/workbench/components/ExposeOverlay', () => ({ ExposeOverlay: () => null }));
vi.mock('@/features/workbench/components/WindowSwitcher', () => ({ WindowSwitcher: () => null }));
vi.mock('@/features/workbench/components/ShortcutCheatsheet', () => ({ ShortcutCheatsheet: () => null }));
vi.mock('@/features/workbench/components/WorkbenchDevPanel', () => ({ WorkbenchDevPanel: () => null }));
vi.mock('@/features/workbench/components/WorkbenchEventBridge', () => ({ WorkbenchEventBridge: () => null }));
vi.mock('@/features/workbench/hooks/useWorkbenchShortcuts', () => ({ useWorkbenchShortcuts: () => {} }));
vi.mock('@/features/workbench/hooks/useCompositorNudge', () => ({ useCompositorNudge: () => {} }));
vi.mock('@/features/workbench/hooks/useDesktopDrop', () => ({
  useDesktopDrop: () => ({ isDragging: false, dragOver: false, rootDropProps: {} }),
}));
vi.mock('@/features/workbench/components/window-shell/useTilingDivider', () => ({
  useTilingDivider: () => ({ dividerProps: null }),
}));
vi.mock('@/features/workbench/apps/content/ContentCloseConfirmation', () => ({ ContentCloseConfirmationHost: () => null }));
vi.mock('@/features/workbench/apps/preview/quickLook', () => ({ QuickLookHost: () => null }));

import { WorkbenchDesktop } from '@/features/workbench/components/WorkbenchDesktop';

describe('desktop.widgets slot in WorkbenchDesktop (BUG-01a)', () => {
  let kernel: UiKernel;

  beforeEach(async () => {
    cleanup();
    window.localStorage.clear();
    window.localStorage.setItem('desktop.workbenchDesktopWidgets', 'true');
    window.localStorage.setItem('desktop.workbenchWidgetAgenda', 'false');
    window.localStorage.setItem('desktop.workbenchWidgetBriefing', 'false');
    kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);
  });

  afterEach(async () => {
    cleanup();
    window.localStorage.clear();
    await kernel.dispose();
  });

  it('renders contributed widgets even when built-in widgets are disabled, enforces maxHeight by size, and hides when desktopWidgets is off', async () => {
    const plugin = defineUiPlugin({
      meta: { id: 'community.desktop-widgets', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('desktop.widgets', {
          id: 'small-w',
          order: 1,
          value: {
            title: 'Small Timer',
            size: 'sm',
            component: ({ size }) => <div data-testid="widget-sm">size:{size}</div>,
          },
        });
        ctx.ui.contribute('desktop.widgets', {
          id: 'default-w',
          order: 2,
          value: {
            title: 'Medium Tracker',
            component: ({ size }) => <div data-testid="widget-md">size:{size}</div>,
          },
        });
        ctx.ui.contribute('desktop.widgets', {
          id: 'large-w',
          order: 3,
          value: {
            title: 'Large Planner',
            size: 'lg',
            component: ({ size }) => <div data-testid="widget-lg">size:{size}</div>,
          },
        });
      },
    });
    await act(async () => { await kernel.install(plugin, { origin: 'community' }); });

    render(
      <UiKernelProvider kernel={kernel}>
        <WorkbenchDesktop />
      </UiKernelProvider>,
    );

    const regions = await screen.findAllByTestId('wb-desktop-plugin-widget');
    expect(regions).toHaveLength(3);
    expect(screen.queryByTestId('builtin-agenda')).toBeNull();
    expect(screen.queryByTestId('builtin-briefing')).toBeNull();

    expect(regions[0]).toHaveAttribute('role', 'region');
    expect(regions[0]).toHaveAttribute('aria-label', 'Small Timer');
    expect(regions[0]).toHaveStyle({ maxHeight: '160px' });
    expect(screen.getByTestId('widget-sm')).toHaveTextContent('size:sm');

    expect(regions[1]).toHaveAttribute('aria-label', 'Medium Tracker');
    expect(regions[1]).toHaveStyle({ maxHeight: '280px' });
    expect(screen.getByTestId('widget-md')).toHaveTextContent('size:md');

    expect(regions[2]).toHaveAttribute('aria-label', 'Large Planner');
    expect(regions[2]).toHaveStyle({ maxHeight: '420px' });
    expect(screen.getByTestId('widget-lg')).toHaveTextContent('size:lg');

    // Toggling desktopWidgets off hides the entire column
    act(() => {
      window.dispatchEvent(new CustomEvent('workbench:settings-changed', {
        detail: { key: 'desktop.workbenchDesktopWidgets', value: false },
      }));
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId('wb-desktop-plugin-widget')).toHaveLength(0);
    });
  });
});
