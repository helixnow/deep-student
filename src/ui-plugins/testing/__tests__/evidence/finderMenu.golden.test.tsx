/**
 * FE-B9 evidence: the Finder (访达) right-click menu as `SidebarContextMenu` wires it, inside the app's UI kernel.
 * `finder-menu.json`: for every target × view condition (permissions, trash, clipboard, batch selection, canvas
 * mode, touch), the rows in order (label, icon, disabled, danger) and which sidebar handler each row calls with
 * which arguments. Complements the U4 golden (`menu.golden.test.tsx`), which pins the menu component itself
 * with synthetic callbacks; this one pins the Finder's wiring of conditions to handlers.
 */
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SidebarContextMenuProps } from '@/features/learning-hub/sidebar/SidebarContextMenu';
import { bootAppUi, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

type Target = SidebarContextMenuProps['contextMenuTarget'];

const folder: Target = { type: 'folder', folder: { folder: { id: 'fld_a', parentId: null, title: '线代', isExpanded: false, sortOrder: 0, createdAt: 0, updatedAt: 0 }, children: [], items: [] } } as unknown as Target;
const resource: Target = { type: 'resource', resource: { id: 'note_a', title: '特征值', type: 'note', path: '/线代/特征值', isFavorite: false } } as unknown as Target;
const favorite: Target = { type: 'resource', resource: { id: 'note_b', title: '收藏笔记', type: 'note', path: '/收藏笔记', isFavorite: true } } as unknown as Target;
const exam: Target = { type: 'resource', resource: { id: 'exam_a', title: '期中卷', type: 'exam', path: '/期中卷' } } as unknown as Target;
const folderItem: Target = { type: 'folderItem', item: { id: 'fi_a', folderId: 'fld_a', itemType: 'note', itemId: 'note_c', sortOrder: 0 } } as unknown as Target;
const TARGETS: Record<string, Target> = { empty: { type: 'empty' }, folder, resource, favorite, exam, folderItem };

const HANDLERS = [
  'setContextMenuOpen', 'handleNewFolder', 'handleNewNote', 'handleNewExam', 'handleNewTextbook', 'handleNewTranslation',
  'handleNewEssay', 'handleNewMindMap', 'handleImportMarkdownNote', 'handleRefresh', 'handleOpenFolder', 'handleOpenRenameDialog',
  'handleBatchDelete', 'handleDeleteFolder', 'onOpenApp', 'handleOpenRenameResourceDialog', 'handleDeleteResource',
  'handleToggleFavorite', 'handleCopyFromContextMenu', 'handleDuplicateFromContextMenu', 'handlePaste', 'handleExportResource',
  'handleExportFolder', 'handleRestoreItem', 'handlePermanentDeleteItem', 'handleEmptyTrash', 'handleReferenceToChat',
  'handleMakeCards', 'handleMoveTo',
] as const;

interface Condition {
  mode?: SidebarContextMenuProps['mode'];
  isTrashView?: boolean;
  canCreateInCurrentView?: boolean;
  canDeleteInCurrentView?: boolean;
  canMoveInCurrentView?: boolean;
  canAddToChatInCurrentView?: boolean;
  canPasteHere?: boolean;
  clipboardCount?: number;
  selected?: string[];
  touch?: boolean;
}

const CONDITIONS: Record<string, Condition> = {
  base: {},
  'no-create': { canCreateInCurrentView: false },
  'no-delete': { canDeleteInCurrentView: false },
  'no-move': { canMoveInCurrentView: false },
  'no-chat': { canAddToChatInCurrentView: false },
  'no-paste': { canPasteHere: false, clipboardCount: 0 },
  'read-only': { canCreateInCurrentView: false, canDeleteInCurrentView: false, canMoveInCurrentView: false, canAddToChatInCurrentView: false, canPasteHere: false },
  trash: { isTrashView: true },
  'batch-selected': { selected: ['fld_a', 'note_a', 'note_c'] },
  'canvas-mode': { mode: 'canvas' },
  touch: { touch: true },
};

function shape(value: unknown): unknown {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'ƒ';
  if (value instanceof Set) return [...value];
  if (value && typeof value === 'object') {
    const target = value as { type?: string; folder?: { folder?: { id: string } }; resource?: { id: string }; item?: { itemId: string } };
    if (target.type === 'folder') return `folder:${target.folder?.folder?.id}`;
    if (target.type === 'resource' && target.resource) return `resource:${target.resource.id}`;
    if (target.type === 'folderItem') return `folderItem:${target.item?.itemId}`;
    if (target.type === 'empty') return 'empty';
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
  return value;
}

function installMatchMedia(touch: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: touch && /pointer:\s*coarse|max-width/.test(query), media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }),
  });
}

let app: AppUi;
const realMatchMedia = window.matchMedia;

describe('FE-B9 evidence: Finder context menu wiring', () => {
  beforeAll(async () => {
    localStorage.clear();
    app = await bootAppUi();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
  });
  afterAll(async () => { await app.dispose(); });

  it('maps every condition and target to the same rows and handlers', async () => {
    const [{ SidebarContextMenu }, { useDesktopStore }] = await Promise.all([
      import('@/features/learning-hub/sidebar/SidebarContextMenu'),
      import('@/features/learning-hub/stores/desktopStore'),
    ]);
    const initialDesktop = useDesktopStore.getState();
    // Stable projection: ids and timestamps are generated per call.
    const desktopShortcuts = () => JSON.stringify(useDesktopStore.getState().shortcuts.map(({ name, presetKey, type, target, position }) => ({ name, presetKey, type, target, position })));
    const cases: Record<string, unknown> = {};
    for (const [conditionName, condition] of Object.entries(CONDITIONS)) {
      for (const [targetName, target] of Object.entries(TARGETS)) {
        if (condition.touch && !['empty', 'folder', 'resource'].includes(targetName)) continue;
        vi.useFakeTimers();
        installMatchMedia(!!condition.touch);
        const calls: unknown[][] = [];
        const handlers = Object.fromEntries(HANDLERS.map((name) => [name, (...args: unknown[]) => {
          calls.push([name, ...args.map(shape)]);
          return name.startsWith('handleReference') ? Promise.resolve(true) : Promise.resolve();
        }]));
        const props = {
          ...handlers,
          mode: condition.mode ?? 'list',
          contextMenuOpen: true,
          contextMenuPosition: { x: 40, y: 60 },
          contextMenuTarget: target,
          effectivePath: { folderId: 'fld_parent', dstuPath: '/线代' },
          isTrashView: condition.isTrashView ?? false,
          canCreateInCurrentView: condition.canCreateInCurrentView ?? true,
          canDeleteInCurrentView: condition.canDeleteInCurrentView ?? true,
          canMoveInCurrentView: condition.canMoveInCurrentView ?? true,
          canAddToChatInCurrentView: condition.canAddToChatInCurrentView ?? true,
          canPasteHere: condition.canPasteHere ?? true,
          clipboardCount: condition.clipboardCount ?? 2,
          selectedIds: new Set(condition.selected ?? []),
        } as unknown as SidebarContextMenuProps;
        const view = render(app.wrap(<SidebarContextMenu {...props} />));
        const menu = () => document.querySelector('[role=menu]');
        const readRows = () => Array.from(menu()?.querySelectorAll('[role=menuitem], [role=separator]') ?? []).map((row) => {
          if (row.getAttribute('role') === 'separator') return '—';
          const button = row as HTMLButtonElement;
          const icon = row.querySelector('svg');
          return {
            label: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            disabled: button.disabled,
            danger: /danger|destructive/.test(button.className),
            icon: icon ? icon.getAttribute('viewBox') : null,
          };
        });
        const rows = readRows();
        const actions: Record<string, unknown> = {};
        for (const [index, row] of rows.entries()) {
          if (row === '—' || row.disabled) continue;
          // Each click on a fresh render: a row closes the menu.
          view.rerender(app.wrap(<SidebarContextMenu {...props} contextMenuOpen={false} />));
          act(() => { vi.advanceTimersByTime(500); });
          view.rerender(app.wrap(<SidebarContextMenu {...props} />));
          act(() => { vi.advanceTimersByTime(0); });
          const button = Array.from(menu()?.querySelectorAll('[role=menuitem], [role=separator]') ?? [])[index] as HTMLButtonElement | undefined;
          if (!button || button.textContent?.replace(/\s+/g, ' ').trim() !== row.label) throw new Error(`row ${row.label} moved`);
          calls.length = 0;
          const desktopBefore = desktopShortcuts();
          fireEvent.click(button);
          const immediate = calls.map((call) => call[0]);
          act(() => { vi.advanceTimersByTime(500); });
          await act(async () => { await Promise.resolve(); });
          const desktopAfter = desktopShortcuts();
          actions[`${index}:${row.label}`] = {
            immediate, calls: [...calls],
            ...(desktopAfter !== desktopBefore ? { desktopShortcuts: JSON.parse(desktopAfter) as unknown } : {}),
          };
          useDesktopStore.setState(initialDesktop, true);
        }
        cases[`${conditionName}/${targetName}`] = {
          open: !!menu(),
          touchPanel: (menu()?.className ?? '').includes('rounded-t-2xl'),
          title: menu()?.querySelector('.break-all')?.textContent ?? null,
          rows,
          actions,
        };
        view.unmount();
        act(() => { vi.runOnlyPendingTimers(); });
        vi.useRealTimers();
      }
    }
    expect(Object.keys(cases).length).toBeGreaterThan(40);
    expectGolden('finder-menu.json', cases);
  }, 120_000);
});
