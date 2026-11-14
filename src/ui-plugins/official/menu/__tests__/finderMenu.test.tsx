import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));

import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { ScopedResourceMenuContribution } from '@/ui-kernel/contracts/content';
import { SidebarContextMenu, type SidebarContextMenuProps } from '@/features/learning-hub/sidebar/SidebarContextMenu';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import { officialNotesTreeMenuEntries } from '../notesTreeMenu';

type Target = SidebarContextMenuProps['contextMenuTarget'];
const TARGETS: Record<string, Target> = {
  empty: { type: 'empty' },
  folder: { type: 'folder', folder: { folder: { id: 'fld_a', parentId: null, title: '线代', isExpanded: false, sortOrder: 0, createdAt: 0, updatedAt: 0 }, children: [], items: [] } } as unknown as Target,
  resource: { type: 'resource', resource: { id: 'note_a', title: '特征值', type: 'note', path: '/线代/特征值', isFavorite: false } } as unknown as Target,
};

let kernel: UiKernel | undefined;
afterEach(async () => {
  cleanup();
  await kernel?.dispose();
  kernel = undefined;
});

function props(target: Target): SidebarContextMenuProps {
  const handler = () => vi.fn(async () => undefined);
  return new Proxy({
    mode: 'list', contextMenuOpen: true, setContextMenuOpen: vi.fn(), contextMenuPosition: { x: 40, y: 60 }, contextMenuTarget: target,
    effectivePath: { folderId: 'fld_parent', dstuPath: '/线代' }, isTrashView: false, canCreateInCurrentView: true, canDeleteInCurrentView: true,
    canMoveInCurrentView: true, canAddToChatInCurrentView: true, canPasteHere: true, clipboardCount: 2, selectedIds: new Set<string>(),
  } as Record<string | symbol, unknown>, { get: (values, key) => (key in values ? values[key] : handler()) }) as unknown as SidebarContextMenuProps;
}

const rows = () => Array.from(document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] [role=separator]'))
  .map((row) => (row.getAttribute('role') === 'separator' ? '—' : row.textContent?.replace(/\s+/g, ' ').trim()));

function finderRows(k: UiKernel) {
  return Object.fromEntries(Object.entries(TARGETS).map(([name, target]) => {
    const view = render(<UiKernelProvider kernel={k}><SidebarContextMenu {...props(target)} /></UiKernelProvider>);
    const shown = rows();
    view.unmount();
    return [name, shown];
  }));
}

describe('Finder context menu next to the notes tree rows (FE-B9)', () => {
  it('never shows the notes tree rows; a community row scoped to resources shows on resources only and runs', async () => {
    kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);
    const k = kernel;
    expect(k.slots.list('resource.contextMenu').filter((entry) => entry.owner === 'dstu.ui.menu').map((entry) => entry.id))
      .toEqual(officialNotesTreeMenuEntries.map((entry) => entry.id));
    const withNotesTree = finderRows(k);
    expect(withNotesTree.resource!.length).toBeGreaterThan(0);

    const run = vi.fn();
    const pin: ScopedResourceMenuContribution<'resource'> = {
      id: 'pin', order: 1, scopes: ['resource'], labelKey: 'example.pin', labelParams: () => ({ defaultValue: '钉到侧栏' }),
      visible: (c) => c.resourceItem?.type === 'note', run: (c) => { c.closeMenu(); run(c.resourceItem?.id); },
    };
    await act(async () => {
      await k.install(defineUiPlugin({ meta: { id: 'example.pin' }, apply(ctx) {
        ctx.ui.contribute('resource.contextMenu', { id: 'pin', order: 1, value: pin });
      } }));
    });
    const withPin = finderRows(k);
    expect(withPin.empty).toEqual(withNotesTree.empty);
    expect(withPin.folder).toEqual(withNotesTree.folder);
    expect(withPin.resource).toEqual(['钉到侧栏', ...withNotesTree.resource!]);
    const target = props(TARGETS.resource!);
    render(<UiKernelProvider kernel={k}><SidebarContextMenu {...target} /></UiKernelProvider>);
    fireEvent.click(screen.getByRole('menuitem', { name: '钉到侧栏' }));
    expect(run).toHaveBeenCalledWith('note_a');
    expect(target.setContextMenuOpen).toHaveBeenCalledWith(false);
    cleanup();

    await act(async () => { await k.unload('example.pin'); await k.unload('dstu.ui.menu'); });
    expect(k.slots.list('resource.contextMenu').some((entry) => entry.owner === 'dstu.ui.menu')).toBe(false);
    expect(finderRows(k)).toEqual(withNotesTree);
  });
});
