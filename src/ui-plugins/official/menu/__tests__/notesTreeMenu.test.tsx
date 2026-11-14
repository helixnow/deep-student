import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/utils/settingsApi', () => ({ getSetting: vi.fn(async () => null), saveSetting: vi.fn(async () => undefined) }));
vi.mock('@/features/workbench/apps/notes/wikilinkRenameSync', () => ({ syncWikiLinksAfterNoteRename: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/notesApi', () => ({ NotesAPI: { listTags: async () => [] } }));
vi.mock('@/features/notes/noteRelations', () => ({
  NOTE_RELATIONS_CHANGED: 'notes:relations-changed',
  isNoteRelationUsable: () => true,
  noteRelationsService: { list: async () => [], put: vi.fn(), delete: vi.fn(), referenceStatus: vi.fn() },
}));
vi.mock('@/dstu', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const nodes = [
    { id: 'note_1', sourceId: 'note_1', path: '/course/note_1', name: '课堂笔记', type: 'note', createdAt: 1, updatedAt: 1 },
    { id: 'mindmap_1', sourceId: 'mindmap_1', path: '/course/mindmap_1', name: '章节导图', type: 'mindmap', createdAt: 2, updatedAt: 2 },
  ];
  return {
    dstu: {
      list: vi.fn(async (_path: string, options?: { isFavorite?: boolean }) => ok(options?.isFavorite ? [] : nodes)),
      watch: vi.fn(() => () => undefined),
      rename: vi.fn(async () => ok(nodes[0])),
      delete: vi.fn(async () => ok(undefined)),
      search: vi.fn(async () => ok([])),
      getContent: vi.fn(async () => ok('')),
      setFavorite: vi.fn(async () => ok(undefined)),
    },
    createEmpty: vi.fn(),
    folderApi: {
      listFolders: vi.fn(async () => ok([])),
      getFolderTree: vi.fn(async () => ok([])),
      createFolder: vi.fn(async () => ok({ id: 'fld_new' })),
      renameFolder: vi.fn(async () => ok(undefined)),
      deleteFolder: vi.fn(async () => ok(undefined)),
      moveItem: vi.fn(async () => ok(undefined)),
      moveFolder: vi.fn(async () => ok(undefined)),
    },
    trashApi: {
      listTrash: vi.fn(async () => ok([])),
      restoreItem: vi.fn(async () => ok(undefined)),
      permanentlyDelete: vi.fn(async () => ok(undefined)),
      emptyTrash: vi.fn(async () => ok(0)),
    },
    updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString(),
  };
});
vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: (props: { resourceId?: string }) => <div data-testid={`note-editor-${String(props.resourceId)}`} />,
}));
vi.mock('@/features/mindmap/MindMapContentView', () => ({
  MindMapContentView: (props: { resourceId?: string }) => <div data-testid={`mindmap-editor-${String(props.resourceId)}`} />,
}));

import { defineUiPlugin, UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { NotesTreeMenuActions, NotesTreeMenuItem, ScopedResourceMenuContribution } from '@/ui-kernel/contracts/content';
import { NotesWorkspaceApp } from '@/features/workbench/apps/notes/NotesWorkspaceApp';
import { resetWorkspaceRegistryForTests } from '@/features/workbench/apps/notes/workspaceRegistry';
import { __resetContentDirtyRegistry } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import {
  officialNotesTreeMenuEntries, resolveNotesTreeMenu, type NotesTreeMenuContext,
} from '../notesTreeMenu';
import type { ResourceMenuValue } from '../resourceMenu';

let kernel: UiKernel | undefined;
beforeEach(() => {
  resetWorkspaceRegistryForTests();
  __resetContentDirtyRegistry();
  window.localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await kernel?.dispose();
  kernel = undefined;
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

async function install(k: UiKernel, plugin: UiPlugin<any>) {
  await act(async () => { await k.install(plugin); });
}

const workspace = () => (
  <NotesWorkspaceApp windowId="notes-window" instanceKey={null} launchPayload={undefined} isActive isVisible onTitleChange={() => {}} requestClose={() => {}} />
);

async function mount(k?: UiKernel) {
  render(k ? <UiKernelProvider kernel={k}>{workspace()}</UiKernelProvider> : workspace());
  await screen.findByRole('treeitem', { name: /课堂笔记/ });
}

const menu = () => document.querySelector('.nwt-context-menu[role=menu]');
const rows = () => Array.from(menu()?.querySelectorAll('[role=menuitem], [role=separator]') ?? [])
  .map((row) => (row.getAttribute('role') === 'separator' ? '—' : row.textContent?.trim()));

function openMenuOn(name: RegExp) {
  fireEvent.contextMenu(screen.getByRole('treeitem', { name }), { clientX: 120, clientY: 160 });
  return rows();
}

function closeMenu() {
  fireEvent.keyDown(window, { key: 'Escape' });
}

const describeEntries = (entries: readonly SlotEntry<unknown>[]) => entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));
const notesTreeRows = (k: UiKernel) => k.slots.list<ResourceMenuValue>('resource.contextMenu').filter((entry) => entry.owner === 'dstu.ui.menu');

const NOTE_ROWS = ['打开', '在右侧分屏打开', '收藏', '重命名', '—', '新建笔记', '新建文件夹', '新建导图', '新建学习笔记', '—', '删除'];

describe('resource.contextMenu in the notes workspace tree (FE-B9)', () => {
  it('holds the notes tree rows, owned by dstu.ui.menu, and the tree shows the same menu with or without the kernel', async () => {
    const k = await boot();
    expect(describeEntries(notesTreeRows(k))).toEqual(describeEntries(officialNotesTreeMenuEntries));
    expect(notesTreeRows(k).every((entry) => entry.origin === 'builtin' && 'scopes' in entry.value && entry.value.scopes.join() === 'notes-tree')).toBe(true);

    await mount();
    const note = openMenuOn(/课堂笔记/);
    closeMenu();
    const mindmap = openMenuOn(/章节导图/);
    cleanup();

    await mount(k);
    expect(openMenuOn(/课堂笔记/)).toEqual(note);
    closeMenu();
    expect(openMenuOn(/章节导图/)).toEqual(mindmap);
    expect(note).toEqual(NOTE_ROWS);
  });

  it('places community notes-tree rows and v1 items by order, runs them with the tree item and closes the menu; unload removes them', async () => {
    const k = await boot();
    const copy = vi.fn();
    const exported = vi.fn();
    const copyLink: ScopedResourceMenuContribution<'notes-tree'> = {
      id: 'copy-link', order: 55, scopes: ['notes-tree'], labelKey: 'example.copyLink', labelParams: () => ({ defaultValue: '复制链接' }),
      visible: (c) => c.item.kind === 'note', run: (c) => copy(c.item.id, c.createFolderId),
    };
    await install(k, defineUiPlugin({ meta: { id: 'example.copy-link' }, apply(ctx) {
      ctx.ui.contribute('resource.contextMenu', { id: 'copy-link', order: 55, value: copyLink });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.export' }, apply(ctx) {
      ctx.ui.contextMenu.register({ id: 'export', resourceTypes: ['note'], labelKey: 'export', order: 65, run: exported });
    } }));
    await mount(k);

    // The vitest react-i18next mock only knows the locale files, so the v1 label shows as its plugin-namespaced key.
    expect(openMenuOn(/课堂笔记/)).toEqual([
      '打开', '在右侧分屏打开', '收藏', '重命名', '—', '复制链接', '新建笔记', 'example.export:export', '新建文件夹', '新建导图', '新建学习笔记', '—', '删除',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制链接' }));
    expect(copy).toHaveBeenCalledWith('note_1', null);
    expect(menu()).toBeNull();
    openMenuOn(/课堂笔记/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'example.export:export' }));
    await act(async () => {});
    expect(exported).toHaveBeenCalledWith(expect.objectContaining({ id: 'note_1', name: '课堂笔记', kind: 'note' }));
    expect(menu()).toBeNull();
    expect(openMenuOn(/章节导图/)).not.toContain('复制链接');
    closeMenu();

    await act(async () => {
      await k.unload('example.copy-link');
      await k.unload('example.export');
    });
    expect(openMenuOn(/课堂笔记/)).toEqual(NOTE_ROWS);
  });

  it('leaves out a community row that throws and reports it; a throwing run is reported, the menu still closes', async () => {
    const k = await boot();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-row' }, apply(ctx) {
      ctx.ui.contribute('resource.contextMenu', { id: 'broken', order: 15, value: {
        id: 'broken', order: 15, scopes: ['notes-tree'], visible: () => { throw new Error('visible'); },
      } satisfies ScopedResourceMenuContribution<'notes-tree'> });
    } }));
    await install(k, defineUiPlugin({ meta: { id: 'example.broken-run' }, apply(ctx) {
      ctx.ui.contribute('resource.contextMenu', { id: 'throws', order: 115, value: {
        id: 'throws', order: 115, scopes: ['notes-tree'], labelKey: 'throws', visible: () => true, run: () => { throw new Error('run'); },
      } satisfies ScopedResourceMenuContribution<'notes-tree'> });
    } }));
    await mount(k);

    expect(openMenuOn(/课堂笔记/)).toEqual([...NOTE_ROWS, 'throws']);
    expect(k.errors.list('example.broken-row')[0]).toMatchObject({ slot: 'resource.contextMenu', entryId: 'broken', phase: 'render' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'throws' }));
    expect(k.errors.list('example.broken-run')[0]).toMatchObject({ slot: 'resource.contextMenu', entryId: 'throws', phase: 'report' });
    expect(menu()).toBeNull();
    error.mockRestore();
  });

  it('removes the notes tree rows with dstu.ui.menu', async () => {
    const k = await boot();
    await k.unload('dstu.ui.menu');
    expect(notesTreeRows(k)).toEqual([]);
    expect(k.slots.list('resource.contextMenu').length).toBeGreaterThan(0);
  });
});

describe('resolveNotesTreeMenu', () => {
  const actions = (favorite = false): NotesTreeMenuActions => ({
    open: vi.fn(), openInSplit: vi.fn(), isFavorite: () => favorite, setFavorite: vi.fn(),
    createResource: vi.fn(), createFolder: vi.fn(), createLearningNote: vi.fn(), requestDelete: vi.fn(),
  });
  const context = (item: NotesTreeMenuItem, extra: Partial<NotesTreeMenuContext> = {}): NotesTreeMenuContext => ({
    scope: 'notes-tree', closeMenu: vi.fn(), item, beginRename: vi.fn(), createFolderId: 'fld_1', canDelete: true, actions: actions(), ...extra,
  });
  const t = (key: string, options: Record<string, unknown>) => (typeof options.defaultValue === 'string' ? `${key}|${options.defaultValue}` : key);
  const community = (id: string, order: number, value: Omit<ScopedResourceMenuContribution<'notes-tree'>, 'id' | 'order' | 'scopes'>): SlotEntry<ResourceMenuValue> => ({
    id, order, owner: `example.${id}`, origin: 'community', value: { ...value, id, order, scopes: ['notes-tree'] } as ResourceMenuValue,
  });
  const view = (items: ReturnType<typeof resolveNotesTreeMenu>) => items.map((item) => `${item.separatorBefore ? '— ' : ''}${item.label}${item.danger ? ' !' : ''}`);
  const folder: NotesTreeMenuItem = { id: 'fld_1', name: 'Folder', kind: 'folder' };
  const note: NotesTreeMenuItem = { id: 'n1', name: 'Note', kind: 'note', favorite: true };

  it('puts a separator before the next row shown and drops the delete group when the item cannot be deleted', () => {
    expect(view(resolveNotesTreeMenu(officialNotesTreeMenuEntries, context(folder, { canDelete: false }), t, vi.fn()))).toEqual([
      'notesWorkspace.context.rename', '— notesWorkspace.context.newNote', 'notesWorkspace.context.newFolder',
      'notesWorkspace.context.newMindmap', 'notes:learning.create.title|新建学习笔记',
    ]);
    expect(view(resolveNotesTreeMenu(officialNotesTreeMenuEntries, context({ ...folder, canRename: false }), t, vi.fn()))).toEqual([
      '— notesWorkspace.context.newNote', 'notesWorkspace.context.newFolder', 'notesWorkspace.context.newMindmap',
      'notes:learning.create.title|新建学习笔记', '— notesWorkspace.context.delete !',
    ]);
  });

  it('collapses adjacent separators and keys rows by owner and id', () => {
    const entries = [...officialNotesTreeMenuEntries, community('sep', 45, { separator: true, visible: () => true }), community('open', 46, { labelKey: 'open', visible: () => true })]
      .sort((a, b) => a.order - b.order);
    const items = resolveNotesTreeMenu(entries, { ...context(note), actions: actions(true) }, t, vi.fn());
    expect(view(items)).toEqual([
      'notesWorkspace.context.open', 'notesWorkspace.context.openSplit', 'notesWorkspace.context.unfavorite', 'notesWorkspace.context.rename',
      '— open', '— notesWorkspace.context.newNote', 'notesWorkspace.context.newFolder', 'notesWorkspace.context.newMindmap',
      'notes:learning.create.title|新建学习笔记', '— notesWorkspace.context.delete !',
    ]);
    expect(items.map((item) => item.id)).toContain('example.open:open');
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it('runs official rows against the workspace actions', () => {
    const c = context(note);
    const items = resolveNotesTreeMenu(officialNotesTreeMenuEntries, c, t, vi.fn());
    for (const item of items) item.onSelect();
    expect(c.actions.open).toHaveBeenCalledWith(note);
    expect(c.actions.openInSplit).toHaveBeenCalledWith(note);
    expect(c.actions.setFavorite).toHaveBeenCalledWith(note, true);
    expect(c.beginRename).toHaveBeenCalledTimes(1);
    expect(c.actions.createResource).toHaveBeenNthCalledWith(1, 'note', 'fld_1');
    expect(c.actions.createResource).toHaveBeenNthCalledWith(2, 'mindmap', 'fld_1');
    expect(c.actions.createFolder).toHaveBeenCalledWith('fld_1');
    expect(c.actions.createLearningNote).toHaveBeenCalledWith('fld_1');
    expect(c.actions.requestDelete).toHaveBeenCalledWith(note);
  });

  it('lets an official row that throws fail loudly, and isolates community rows', () => {
    const onError = vi.fn();
    const broken = { ...officialNotesTreeMenuEntries[0]!, value: { ...officialNotesTreeMenuEntries[0]!.value, visible: () => { throw new Error('official'); } } };
    expect(() => resolveNotesTreeMenu([broken], context(note), t, onError)).toThrow('official');
    const label = community('label', 5, { labelKey: () => { throw new Error('label'); }, visible: () => true });
    const run = community('run', 6, { labelKey: 'run', visible: () => true, run: () => { throw new Error('run'); } });
    const items = resolveNotesTreeMenu([label, run], context(note), t, onError);
    expect(view(items)).toEqual(['run']);
    expect(onError).toHaveBeenCalledWith(label, 'render', expect.objectContaining({ message: 'label' }));
    items[0]!.onSelect();
    expect(onError).toHaveBeenCalledWith(run, 'report', expect.objectContaining({ message: 'run' }));
  });
});
