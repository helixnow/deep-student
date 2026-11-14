/**
 * FE-B9 evidence: the notes workspace explorer tree's right-click menu (`NotesWorkspaceApp.getTreeMenuItems`
 * rendered by `TreeContextMenu`), inside the app's UI kernel. `notes-tree-menu.<target>.json`: for each tree target
 * (VFS folder, nested VFS folder, path-only folder, note, favorite note, mindmap) the rows in order (label,
 * danger, disabled, separators), the same rows from the keyboard (Shift+F10), and for every row on a fresh
 * mount what clicking it does: backend calls (shape only), window events, open tabs per pane, an opened
 * dialog, and an inline rename editor.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootAppUi, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

const { calls, record } = vi.hoisted(() => {
  const calls: string[] = [];
  const shape = (value: unknown): unknown => {
    if (typeof value === 'function') return 'ƒ';
    if (Array.isArray(value)) return value.map(shape);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]));
    return value;
  };
  const record = (name: string, args: unknown[]) => { calls.push(`${name}${JSON.stringify(args.map(shape))}`); };
  return { calls, record };
});

const { fixture } = vi.hoisted(() => {
  const node = (id: string, name: string, type: 'note' | 'mindmap', path: string, extra: Record<string, unknown> = {}) => ({
    id, sourceId: id, path, name, type, createdAt: 1, updatedAt: 1, ...extra,
  });
  const folder = (id: string, title: string, parentId: string | null, sortOrder: number) => ({
    id, parentId, title, isExpanded: false, sortOrder, createdAt: 1, updatedAt: 1,
  });
  const folders = [folder('fld_course', '课程', null, 0), folder('fld_chapter', '第一章', 'fld_course', 0)];
  const nodes = [
    node('note_class', '课堂笔记', 'note', '/fld_course/note_class'),
    node('note_fav', '收藏笔记', 'note', '/note_fav', { isFavorite: true }),
    node('note_loose', '散页', 'note', '/归档/note_loose'),
    node('mm_map', '章节导图', 'mindmap', '/fld_course/fld_chapter/mm_map'),
  ];
  const tree = [{
    folder: folders[0],
    items: [{ id: 'fi_1', folderId: 'fld_course', itemType: 'note', itemId: 'note_class', sortOrder: 0 }],
    children: [{
      folder: folders[1],
      items: [{ id: 'fi_2', folderId: 'fld_chapter', itemType: 'mindmap', itemId: 'mm_map', sortOrder: 0 }],
      children: [],
    }],
  }];
  const created = { note: node('note_new', '未命名笔记', 'note', '/note_new'), mindmap: node('mm_new', '未命名导图', 'mindmap', '/mm_new') };
  return { fixture: { folders, nodes, tree, created } };
});

vi.mock('@/dstu', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const fn = <A extends unknown[], R>(name: string, impl: (...args: A) => R) => (...args: A) => { record(name, args); return impl(...args); };
  return {
    dstu: {
      list: fn('dstu.list', async (_path: string, options?: { isFavorite?: boolean; typeFilter?: string }) => ok(
        options?.isFavorite ? fixture.nodes.filter((n) => n.isFavorite) : fixture.nodes.filter((n) => !options?.typeFilter || n.type === options.typeFilter),
      )),
      watch: () => () => undefined,
      rename: fn('dstu.rename', async () => ok(fixture.nodes[0])),
      delete: fn('dstu.delete', async () => ok(undefined)),
      search: fn('dstu.search', async () => ok([])),
      getContent: fn('dstu.getContent', async () => ok('')),
      setFavorite: fn('dstu.setFavorite', async () => ok(undefined)),
      get: fn('dstu.get', async (path: string) => ok(fixture.nodes.find((n) => path.endsWith(n.id)) ?? fixture.created.note)),
    },
    createEmpty: fn('createEmpty', async (options: { type: 'note' | 'mindmap' }) => ok(fixture.created[options.type])),
    folderApi: {
      listFolders: fn('folderApi.listFolders', async () => ok(fixture.folders)),
      getFolderTree: fn('folderApi.getFolderTree', async () => ok(fixture.tree)),
      createFolder: fn('folderApi.createFolder', async () => ok({ id: 'fld_new' })),
      renameFolder: fn('folderApi.renameFolder', async () => ok(undefined)),
      deleteFolder: fn('folderApi.deleteFolder', async () => ok(undefined)),
      moveItem: fn('folderApi.moveItem', async () => ok(undefined)),
      moveFolder: fn('folderApi.moveFolder', async () => ok(undefined)),
    },
    trashApi: {
      listTrash: fn('trashApi.listTrash', async () => ok([])),
      restoreItem: fn('trashApi.restoreItem', async () => ok(undefined)),
      permanentlyDelete: fn('trashApi.permanentlyDelete', async () => ok(undefined)),
      emptyTrash: fn('trashApi.emptyTrash', async () => ok(0)),
    },
    updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString(),
  };
});
vi.mock('@/features/workbench/apps/notes/wikilinkRenameSync', () => ({
  syncWikiLinksAfterNoteRename: async () => ({ updatedSources: 0, rewrittenLinks: 0, skippedDirtySources: 0, failedSources: 0, scanFailed: false }),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => record('notify', args),
}));
vi.mock('@/utils/notesApi', () => ({ NotesAPI: { listTags: async () => [] } }));
vi.mock('@/features/notes/noteRelations', () => ({
  NOTE_RELATIONS_CHANGED: 'notes:relations-changed',
  isNoteRelationUsable: () => true,
  noteRelationsService: { list: async () => [], put: async () => undefined, delete: async () => undefined, referenceStatus: async () => null },
}));
vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: (props: { resourceId?: string }) => <div data-testid={`note-editor-${String(props.resourceId)}`} />,
}));
vi.mock('@/features/mindmap/MindMapContentView', () => ({
  MindMapContentView: (props: { resourceId?: string }) => <div data-testid={`mindmap-editor-${String(props.resourceId)}`} />,
}));

const TARGETS: Record<string, { name: string; expand?: string[] }> = {
  'vfs-folder': { name: '课程' },
  'nested-vfs-folder': { name: '第一章', expand: ['课程'] },
  'path-folder': { name: '归档' },
  note: { name: '课堂笔记', expand: ['课程'] },
  'favorite-note': { name: '收藏笔记' },
  mindmap: { name: '章节导图', expand: ['课程', '第一章'] },
};

type Row = { label: string; danger: boolean; disabled: boolean } | '—';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const menu = () => document.querySelector('.nwt-context-menu[role=menu]');
const readRows = (): Row[] => Array.from(menu()?.querySelectorAll('[role=menuitem], [role=separator]') ?? []).map((row) => {
  if (row.getAttribute('role') === 'separator') return '—';
  const button = row as HTMLButtonElement;
  return { label: text(button), danger: button.classList.contains('is-danger'), disabled: button.disabled };
});
const treeItem = (name: string) => Array.from(document.querySelectorAll('[role=treeitem]'))
  .find((row) => (row.getAttribute('aria-label') ?? text(row.querySelector('.nwt-row-label') ?? row)).includes(name)) as HTMLElement | undefined;
const tabsByPane = () => ({
  tabs: Array.from(document.querySelectorAll('[role=tablist]'))
    .map((list) => Array.from(list.querySelectorAll('[role=tab]')).map((tab) => `${text(tab)}${tab.getAttribute('aria-selected') === 'true' ? ' *' : ''}`))
    .filter((tabs) => tabs.length),
  panes: Array.from(document.querySelectorAll('[data-notes-pane]')).map((pane) => `${pane.getAttribute('data-notes-pane')}: ${
    Array.from(pane.querySelectorAll('[data-testid*="-editor-"]')).map((editor) => editor.getAttribute('data-testid')).join(',')}`),
});
/** Inline panels and dialogs the row opens, with the follow-up a user would take (confirm / name + Enter). */
const openedSurface = () => {
  const dialog = document.querySelector('[role=dialog], [role=alertdialog]');
  if (dialog) {
    return { kind: 'dialog', title: text(dialog.querySelector('h1, h2, h3, [id$=title]')), buttons: Array.from(dialog.querySelectorAll('button')).map(text).filter(Boolean) };
  }
  const create = document.querySelector('[data-notes-inline-create]');
  if (create) {
    const input = create.querySelector('input')!;
    return { kind: 'inline-create', label: input.getAttribute('aria-label'), value: input.value, buttons: Array.from(create.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? text(b)) };
  }
  const confirm = document.querySelector('[data-notes-inline-confirm]');
  if (confirm) {
    return { kind: 'inline-confirm', label: confirm.getAttribute('aria-label'), text: text(confirm.querySelector('p')), buttons: Array.from(confirm.querySelectorAll('button')).map((b) => `${text(b)}${b.classList.contains('is-danger') ? ' (danger)' : ''}`) };
  }
  return null;
};
async function followUp(): Promise<unknown> {
  const create = document.querySelector<HTMLInputElement>('[data-notes-inline-create] input');
  const confirm = document.querySelector<HTMLButtonElement>('[data-notes-inline-confirm] button.is-danger');
  if (!create && !confirm) return undefined;
  calls.length = 0;
  if (create) {
    fireEvent.change(create, { target: { value: '新文件夹' } });
    fireEvent.keyDown(create, { key: 'Enter' });
  } else {
    fireEvent.click(confirm!);
  }
  await settle(600);
  return { action: create ? 'name 新文件夹 + Enter' : 'click danger button', calls: [...new Set(calls.filter((call) => !REFRESH.test(call)))], refreshed: calls.some((call) => call.startsWith('folderApi.getFolderTree')), closed: !openedSurface() };
}
const REFRESH = /^(dstu\.list|folderApi\.(listFolders|getFolderTree))\[/;

let app: AppUi;
let events: string[] = [];
const realDispatch = window.dispatchEvent.bind(window);

async function settle(ms = 400) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mountApp() {
  const [{ NotesWorkspaceApp }, { resetWorkspaceRegistryForTests }, { __resetContentDirtyRegistry }] = await Promise.all([
    import('@/features/workbench/apps/notes/NotesWorkspaceApp'),
    import('@/features/workbench/apps/notes/workspaceRegistry'),
    import('@/features/workbench/apps/content/contentDirtyRegistry'),
  ]);
  resetWorkspaceRegistryForTests();
  __resetContentDirtyRegistry();
  localStorage.clear();
  const slot = document.createElement('div');
  slot.dataset.wbTitlebarSlot = '';
  slot.dataset.windowId = 'notes-window';
  document.body.appendChild(slot);
  const view = render(app.wrap(
    <NotesWorkspaceApp windowId="notes-window" instanceKey={null} launchPayload={undefined} isActive isVisible onTitleChange={() => {}} requestClose={() => {}} />,
  ));
  await waitFor(() => { if (!treeItem('课程')) throw new Error('tree not loaded'); }, { timeout: 5000 });
  await settle(200);
  return view;
}

async function reveal(target: { name: string; expand?: string[] }): Promise<HTMLElement> {
  for (const folder of target.expand ?? []) {
    const row = treeItem(folder)!;
    if (row.getAttribute('aria-expanded') !== 'true') {
      fireEvent.keyDown(row, { key: 'ArrowRight' });
      await settle(100);
      if (row.getAttribute('aria-expanded') !== 'true') { fireEvent.click(row); await settle(100); }
    }
  }
  const row = treeItem(target.name);
  if (!row) throw new Error(`tree item ${target.name} not found`);
  return row;
}

async function openMenuOn(target: { name: string; expand?: string[] }) {
  const row = await reveal(target);
  fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });
  await settle(50);
  return row;
}

describe('FE-B9 evidence: notes explorer tree context menu', () => {
  beforeAll(async () => {
    localStorage.clear();
    app = await bootAppUi();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  });
  beforeEach(() => {
    events = [];
    window.dispatchEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      events.push(`${event.type}${detail && typeof detail === 'object' ? `{${Object.keys(detail).sort().join(',')}}` : ''}`);
      return realDispatch(event);
    };
  });
  afterEach(() => {
    window.dispatchEvent = realDispatch;
    cleanup();
    document.querySelectorAll('[data-wb-titlebar-slot]').forEach((element) => element.remove());
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.dispose();
  });

  it.each(Object.entries(TARGETS))('keeps the rows and what each row does for %s', async (targetName, target) => {
    let view = await mountApp();
    const row = await openMenuOn(target);
    const rows = readRows();
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle(50);
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    await settle(50);
    const keyboardRows = readRows();
    view.unmount();
    cleanup();
    document.querySelectorAll('[data-wb-titlebar-slot]').forEach((element) => element.remove());

    const actions: Record<string, unknown> = {};
    for (const [index, menuRow] of rows.entries()) {
      if (menuRow === '—' || menuRow.disabled) continue;
      view = await mountApp();
      await openMenuOn(target);
      const button = Array.from(menu()?.querySelectorAll('[role=menuitem], [role=separator]') ?? [])[index] as HTMLButtonElement | undefined;
      if (!button || text(button) !== menuRow.label) throw new Error(`${targetName}: row ${menuRow.label} moved`);
      const tabsBefore = JSON.stringify(tabsByPane());
      calls.length = 0;
      events = [];
      fireEvent.click(button);
      const surfaceAtClick = openedSurface();
      await settle(600);
      const surface = openedSurface();
      const renameInput = document.querySelector<HTMLInputElement>('[role=tree] input');
      const tabs = tabsByPane();
      const action: Record<string, unknown> = {
        menuClosed: !menu(),
        calls: [...new Set(calls.filter((call) => !REFRESH.test(call)))],
        refreshed: calls.some((call) => call.startsWith('folderApi.getFolderTree')),
        events: [...new Set(events)],
        ...(JSON.stringify(tabs) !== tabsBefore ? tabs : {}),
        ...(surface ? { opens: surface } : {}),
        ...(surfaceAtClick && !surface ? { openedThenClosed: surfaceAtClick, focusAfterClose: document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName ?? null } : {}),
        ...(renameInput ? { renameEditor: renameInput.value } : {}),
      };
      const next = await followUp();
      if (next) action.followUp = next;
      actions[`${index}:${menuRow.label}`] = action;
      view.unmount();
      cleanup();
      document.querySelectorAll('[data-wb-titlebar-slot]').forEach((element) => element.remove());
    }
    expect(rows.length).toBeGreaterThan(0);
    expectGolden(`notes-tree-menu.${targetName}.json`, { rows, keyboardSameRows: JSON.stringify(keyboardRows) === JSON.stringify(rows), actions });
  }, 60_000);
});
