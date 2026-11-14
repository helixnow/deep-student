import { describe, expect, it, vi } from 'vitest';
import type {
  ContentMenuContext, NotesTreeMenuActions, NotesTreeMenuContext, NotesTreeMenuItem, ResourceMenuContribution,
  ScopedResourceMenuContribution,
} from '../contracts/content';
import { defineUiPlugin, UiKernel } from '../kernel';
import { officialMenuEntries } from '../../ui-plugins/official/content/entries';

const actions = (): NotesTreeMenuActions => ({
  open: vi.fn(), openInSplit: vi.fn(), isFavorite: () => false, setFavorite: vi.fn(),
  createResource: vi.fn(), createFolder: vi.fn(), createLearningNote: vi.fn(), requestDelete: vi.fn(),
});

function notesTree(item: NotesTreeMenuItem): NotesTreeMenuContext {
  return { scope: 'notes-tree', closeMenu: vi.fn(), item, beginRename: vi.fn(), createFolderId: null, canDelete: true, actions: actions() };
}

const note: NotesTreeMenuItem = { id: 'n1', name: 'Note', kind: 'note' };
const folder: NotesTreeMenuItem = { id: 'f1', name: 'Folder', kind: 'folder' };

/** A learning hub resource menu context as `LearningHubContextMenu` builds it. */
function learningHub(type = 'note'): ContentMenuContext {
  const resourceItem = { id: 'n1', type, isFavorite: false };
  return {
    scope: 'resource', closeMenu: vi.fn(), resourceItem, resource: resourceItem, folderId: null, isFolder: false, isAddedToDesktop: false,
    trashId: '', trashItemType: '', target: { type: 'resource', resource: resourceItem }, addFolderShortcut: vi.fn(), addResourceShortcut: vi.fn(),
  } as unknown as ContentMenuContext;
}

const rows = (kernel: UiKernel) => kernel.slots.list<ResourceMenuContribution>('resource.contextMenu');
const visibleIds = (kernel: UiKernel, context: unknown) =>
  rows(kernel).filter((entry) => (entry.value.visible as (c: unknown) => boolean)(context)).map((entry) => entry.id);

describe('resource.contextMenu scopes', () => {
  it('shows a scoped row only on its surfaces and never calls its callbacks with another surface context', async () => {
    const kernel = new UiKernel();
    const visible = vi.fn((c: NotesTreeMenuContext) => c.item.kind !== 'folder');
    const openSplit: ScopedResourceMenuContribution<'notes-tree'> = {
      id: 'openSplit', order: 20, scopes: ['notes-tree'], labelKey: 'notesWorkspace.context.openSplit', visible,
      run: (c) => c.actions.openInSplit(c.item),
    };
    await kernel.install(defineUiPlugin({ meta: { id: 'community.split' }, apply(ctx) {
      ctx.ui.contribute('resource.contextMenu', { id: 'openSplit', order: 20, value: openSplit });
    } }));

    expect(visibleIds(kernel, learningHub())).toEqual([]);
    expect(visible).not.toHaveBeenCalled();
    expect(visibleIds(kernel, notesTree(folder))).toEqual([]);
    const context = notesTree(note);
    expect(visibleIds(kernel, context)).toEqual(['openSplit']);
    (rows(kernel)[0]!.value.run as (c: NotesTreeMenuContext) => void)(context);
    expect(context.actions.openInSplit).toHaveBeenCalledWith(note);
    expect(rows(kernel)[0]!.value).toMatchObject({ scopes: ['notes-tree'], labelKey: 'notesWorkspace.context.openSplit', order: 20 });

    await kernel.unload('community.split');
    expect(rows(kernel)).toEqual([]);
    await kernel.dispose();
  });

  it('stores rows without scopes unchanged, and every official learning hub row stays hidden in the notes tree', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.content-test' }, apply(ctx) {
      for (const entry of officialMenuEntries) ctx.ui.contribute('resource.contextMenu', entry);
    } }));
    expect(rows(kernel).map((entry) => entry.value)).toEqual(officialMenuEntries.map((entry) => entry.value));
    expect(rows(kernel).every((entry, index) => entry.value === officialMenuEntries[index]!.value)).toBe(true);
    expect(visibleIds(kernel, notesTree(note))).toEqual([]);
    expect(visibleIds(kernel, notesTree(folder))).toEqual([]);
    expect(visibleIds(kernel, learningHub()).length).toBeGreaterThan(0);
    await kernel.dispose();
  });

  it('treats a row whose scopes are not an array as a learning hub row, and an empty scopes list as hidden everywhere', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'community.odd' }, apply(ctx) {
      ctx.ui.contribute<unknown>('resource.contextMenu', { id: 'none', value: { id: 'none', order: 1, scopes: [], visible: () => true } });
    } }));
    expect(visibleIds(kernel, notesTree(note))).toEqual([]);
    expect(visibleIds(kernel, learningHub())).toEqual([]);
    await kernel.dispose();
  });

  it('shows v1 context menu items in the notes tree by item kind and passes the tree item to run', async () => {
    const kernel = new UiKernel();
    const run = vi.fn();
    const runAll = vi.fn();
    await kernel.install(defineUiPlugin({ meta: { id: 'community.v1' }, apply(ctx) {
      ctx.ui.contextMenu.register({ id: 'notes', resourceTypes: ['note'], labelKey: 'notes', order: 1, run });
      ctx.ui.contextMenu.register({ id: 'all', resourceTypes: ['*'], labelKey: 'all', order: 2, run: runAll });
    } }));

    expect(visibleIds(kernel, notesTree(note))).toEqual(['notes', 'all']);
    expect(visibleIds(kernel, notesTree(folder))).toEqual(['all']);
    expect(visibleIds(kernel, learningHub('note'))).toEqual(['notes', 'all']);

    const context = notesTree(note);
    (rows(kernel)[0]!.value.run as (c: unknown) => void)(context);
    expect(context.closeMenu).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(note);
    expect(visibleIds(kernel, { scope: 'notes-tree', closeMenu: vi.fn() })).toEqual([]);
    await kernel.dispose();
  });
});
