import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { LearningHubContextMenu, type LearningHubContextMenuProps } from '@/features/learning-hub/components/LearningHubContextMenu';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';
import learningHubZh from '@/locales/zh-CN/learningHub.json';

const kernel = new UiKernel();
beforeAll(async () => { await kernel.install(contentPlugin, { origin: 'builtin' }); });
afterAll(async () => { await kernel.dispose(); });

const state = vi.hoisted(() => ({ touch: false, added: false, events: [] as unknown[] }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => state.touch }));
vi.mock('@/features/workbench/core/liquidGlassLens', () => ({ useLiquidGlassLens() {}, WallpaperReplica: () => null }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({ registerBackHandler: () => () => {}, BACK_PRIORITY: { overlay: 1 } }));
vi.mock('@/features/learning-hub/stores/desktopStore', () => ({
  useDesktopStore: (select: (value: unknown) => unknown) => select({
    hasResourceShortcut: () => state.added,
    hasFolderShortcut: () => state.added,
    addResourceShortcut: (...args: unknown[]) => state.events.push(['addResourceShortcut', ...args]),
    addFolderShortcut: (...args: unknown[]) => state.events.push(['addFolderShortcut', ...args]),
  }),
}));
vi.mock('@phosphor-icons/react', () => Object.fromEntries([
  'FolderPlus', 'FileText', 'ArrowClockwise', 'Pencil', 'Trash', 'ArrowSquareOut', 'Chat',
  'FolderOpen', 'Copy', 'Clipboard', 'ArrowCounterClockwise', 'Warning', 'Star', 'StarHalf', 'CheckCircle', 'Cards',
].map((name) => [name, (props: Record<string, unknown>) => <i data-icon={name} data-size={props.size} data-weight={props.weight} className={props.className as string} />])));

const callbackNames = [
  'onCreateFolder', 'onCreateItem', 'onImportMarkdownNote', 'onRefresh', 'onOpenFolder', 'onRenameFolder',
  'onDeleteFolder', 'onOpenResource', 'onRenameResource', 'onDeleteResource', 'onReferenceToChat', 'onMakeCards',
  'onCopy', 'onDuplicate', 'onPaste', 'onMoveTo', 'onToggleFavorite', 'onRestoreItem', 'onPermanentDeleteItem',
  'onEmptyTrash', 'onExportResource', 'onExportFolder',
] as const;

const folder = { type: 'folder', folder: { folder: { id: 'folder-1', title: 'Folder' } } } as LearningHubContextMenuProps['target'];
const resource = { type: 'resource', resource: { id: 'resource-1', title: 'Resource', type: 'note', path: '/resource' } } as LearningHubContextMenuProps['target'];
const folderItem = { type: 'folderItem', item: { itemId: 'item-1', itemType: 'note' } } as LearningHubContextMenuProps['target'];
const targets = [{ type: 'empty' }, folder, resource, folderItem] as LearningHubContextMenuProps['target'][];

afterEach(() => { vi.useRealTimers(); cleanup(); });

it.each([false, true])('matches original menu lists, conditions, icons and timing (provider=%s)', (withProvider) => {
  vi.useFakeTimers();
  const cases: Record<string, unknown>[] = [];
  function capture(name: string, override: Partial<LearningHubContextMenuProps> = {}, missing: readonly string[] = []) {
    state.events = [];
    const callbacks = Object.fromEntries(callbackNames.filter((key) => !missing.includes(key)).map((key) => [key, (...args: unknown[]) => state.events.push([key, ...args])]));
    const props = { open: true, position: { x: 20, y: 30 }, target: resource, dataView: 'folder', currentFolderId: 'parent-1', pasteCount: 2,
      onOpenChange: (value: boolean) => state.events.push(['close', value]), ...callbacks, ...override } as LearningHubContextMenuProps;
    const element = <LearningHubContextMenu {...props} />;
    const view = render(withProvider ? <UiKernelProvider kernel={kernel}>{element}</UiKernelProvider> : element);
    const menu = document.querySelector('[role=menu]')!;
    const rows = Array.from(menu.querySelectorAll('[role=menuitem], [role=separator]')).map((row, index) => {
      if (row.getAttribute('role') === 'separator') return { id: `separator:${index}`, order: (index + 1) * 10 };
      const button = row as HTMLButtonElement;
      const icon = row.querySelector('[data-icon]');
      state.events = [];
      fireEvent.click(button);
      const immediate = structuredClone(state.events);
      act(() => { vi.advanceTimersByTime(49); });
      const before50 = structuredClone(state.events);
      act(() => { vi.advanceTimersByTime(1); });
      const after50 = structuredClone(state.events);
      return { id: button.textContent, order: (index + 1) * 10, labelKey: button.textContent,
        icon: icon?.getAttribute('data-icon') ?? null, iconSize: icon?.getAttribute('data-size') ?? null,
        iconWeight: icon?.getAttribute('data-weight') ?? null, iconClass: icon?.getAttribute('class') ?? null,
        disabled: button.disabled, danger: button.classList.contains('wb-desk-menu-item--danger'), immediate, before50, after50 };
    });
    cases.push({ name, touch: state.touch, added: state.added, rows,
      touchPanel: menu.className.includes('rounded-t-2xl'), bottom: (menu as HTMLElement).style.bottom,
      title: menu.querySelector('.break-all')?.textContent ?? null });
    view.unmount();
    act(() => { vi.runOnlyPendingTimers(); });
  }
  for (const touch of [false, true]) {
    state.touch = touch;
    for (const target of targets) {
      const prefix = `${touch ? 'mobile' : 'desktop'}:${target.type}`;
      capture(prefix, { target });
      capture(`${prefix}:trash`, { target, isTrashView: true });
      capture(`${prefix}:no-callbacks`, { target }, callbackNames);
      for (const capability of ['canCreate', 'canDelete', 'canMove', 'canAddToChat'] as const) capture(`${prefix}:${capability}=false`, { target, [capability]: false });
    }
  }
  state.touch = false;
  for (const callback of callbackNames) capture(`resource:missing:${callback}`, {}, [callback]);
  for (const count of [0, 1, 2]) capture(`empty:paste=${count}`, { target: { type: 'empty' }, pasteCount: count });
  capture('empty:resource-view:null-parent', { target: { type: 'empty' }, dataView: 'resource', currentFolderId: undefined });
  for (const isFavorite of [false, true]) for (const added of [false, true]) {
    state.added = added;
    capture(`resource:favorite=${isFavorite}:added=${added}`, { target: { ...resource, resource: { ...(resource as any).resource, isFavorite } } as any });
    capture(`resource-folder:favorite=${isFavorite}:added=${added}`, { target: { type: 'resource', resource: { ...(resource as any).resource, type: 'folder', isFavorite } } as any });
  }
  state.added = false;
  for (const itemType of ['note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap', 'unknown']) {
    capture(`trash:folderItem:${itemType}`, { isTrashView: true, target: { type: 'folderItem', item: { itemId: 'trash-1', itemType } } as any });
  }
  const url = 'src/ui-plugins/official/content/__golden__/learning-hub-menu.json';
  if (process.env.U4_CAPTURE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(cases, null, 2)}\n`, { flag: 'wx' });
  expect(cases).toEqual(JSON.parse(readFileSync(url, 'utf8')));
}, 15_000);

it('isolates a broken community menu row while retaining the host menu and exit timing', async () => {
  vi.useFakeTimers();
  state.touch = false;
  state.added = false;
  await kernel.install(defineUiPlugin({ meta: { id: 'community.menu' }, apply(ctx) {
    ctx.ui.contribute('resource.contextMenu', { id: 'broken', order: 5, value: {
      id: 'broken', order: 5, visible: () => true,
      labelKey: () => { throw new Error('bad community label'); },
    } });
  } }));
  const onOpenChange = vi.fn();
  const props: LearningHubContextMenuProps = { open: true, onOpenChange, position: { x: 20, y: 30 }, target: { type: 'empty' }, dataView: 'resource', canCreate: false };
  const tree = (open: boolean) => <UiKernelProvider kernel={kernel}><LearningHubContextMenu {...props} open={open} /></UiKernelProvider>;
  const view = render(tree(true));
  expect(document.querySelector('[role=menuitem]')?.textContent).toBe(learningHubZh.common.refresh);
  view.rerender(tree(false));
  expect(document.querySelector('[role=menu]')?.getAttribute('data-phase')).toBe('closing');
  act(() => { vi.advanceTimersByTime(179); });
  expect(document.querySelector('[role=menu]')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(document.querySelector('[role=menu]')).toBeNull();
  view.unmount();
  await kernel.unload('community.menu');
});

it('isolates same-id community menu replacement while retaining an unrelated contribution', async () => {
  state.touch = false;
  state.added = false;
  const isolated = new UiKernel();
  await isolated.install(contentPlugin, { origin: 'builtin' });
  await isolated.install(defineUiPlugin({ meta: { id: 'community.healthy' }, apply(ctx) {
    ctx.ui.contribute('resource.contextMenu', { id: 'healthy', order: 10, value: {
      id: 'healthy', order: 10, visible: () => true, labelKey: 'common.refresh',
    } });
  } }));
  await isolated.install(defineUiPlugin({ meta: { id: contentPlugin.meta.id }, apply(ctx) {
    ctx.ui.contribute('resource.contextMenu', { id: 'broken', order: 5, value: {
      id: 'broken', order: 5, visible: () => true,
      labelKey: () => { throw new Error('same-id community row failed'); },
    } });
  } }));
  expect(isolated.slots.list('resource.contextMenu').find(entry => entry.id === 'broken')?.origin).toBe('community');
  const view = render(<UiKernelProvider kernel={isolated}>
    <LearningHubContextMenu open onOpenChange={() => {}} position={{ x: 20, y: 30 }} target={{ type: 'empty' }} dataView="resource" />
  </UiKernelProvider>);
  expect(document.querySelectorAll('[role=menuitem]')).toHaveLength(1);
  expect(document.querySelector('[role=menuitem]')?.textContent).toBe(learningHubZh.common.refresh);
  view.unmount();
  await isolated.dispose();
});
