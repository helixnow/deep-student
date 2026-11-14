/**
 * The notes workspace explorer tree's right-click menu (FE-B9): `resource.contextMenu` rows for the `notes-tree`
 * scope. They load with NotesWorkspaceApp and announce themselves to `resourceMenuContributions`, so `dstu.ui.menu`
 * owns them; without a UI kernel the workspace uses this table directly.
 *
 * Labels resolve in the workbench namespace (as before the migration); `resolveNotesTreeMenu` turns the rows into
 * what `TreeContextMenu` renders.
 */
import type { NotesTreeMenuContext, ScopedResourceMenuContribution, SlotEntry } from '@/ui-sdk';
import { resourceMenuContributions, type ResourceMenuValue } from './resourceMenu';

export type { NotesTreeMenuContext };

type NotesTreeRow = ScopedResourceMenuContribution<'notes-tree'>;
/** Any slot row, read without its scopes (the kernel already hides rows of other surfaces). */
type MenuRow = Omit<ScopedResourceMenuContribution, 'scopes'>;

function row(key: string, order: number, definition: Omit<NotesTreeRow, 'id' | 'order' | 'scopes'>): NotesTreeRow {
  return { ...definition, id: `notes-tree:${key}`, order, scopes: ['notes-tree'] };
}

const always = () => true;
const isResource = (c: NotesTreeMenuContext) => c.item.kind !== 'folder';
const deletable = (c: NotesTreeMenuContext) => c.canDelete;

export const notesTreeMenuRows: readonly NotesTreeRow[] = [
  row('open', 10, { labelKey: 'notesWorkspace.context.open', visible: isResource, run: (c) => c.actions.open(c.item) }),
  row('open-split', 20, { labelKey: 'notesWorkspace.context.openSplit', visible: isResource, run: (c) => c.actions.openInSplit(c.item) }),
  row('favorite', 30, {
    labelKey: (c) => (c.actions.isFavorite(c.item) ? 'notesWorkspace.context.unfavorite' : 'notesWorkspace.context.favorite'),
    visible: isResource,
    run: (c) => c.actions.setFavorite(c.item, !c.actions.isFavorite(c.item)),
  }),
  row('rename', 40, { labelKey: 'notesWorkspace.context.rename', visible: (c) => c.item.canRename !== false, run: (c) => c.beginRename() }),
  row('separator-new', 50, { separator: true, visible: always }),
  row('new-note', 60, { labelKey: 'notesWorkspace.context.newNote', visible: always, run: (c) => c.actions.createResource('note', c.createFolderId) }),
  row('new-folder', 70, { labelKey: 'notesWorkspace.context.newFolder', visible: always, run: (c) => c.actions.createFolder(c.createFolderId) }),
  row('new-mindmap', 80, { labelKey: 'notesWorkspace.context.newMindmap', visible: always, run: (c) => c.actions.createResource('mindmap', c.createFolderId) }),
  // 与资源管理器「+」菜单对齐：右键同样能新建学习笔记（落到右键所在文件夹）
  row('new-learning-note', 90, {
    labelKey: 'notes:learning.create.title',
    labelParams: () => ({ defaultValue: '新建学习笔记' }),
    visible: always,
    run: (c) => c.actions.createLearningNote(c.createFolderId),
  }),
  row('separator-delete', 100, { separator: true, visible: deletable }),
  row('delete', 110, { labelKey: 'notesWorkspace.context.delete', danger: true, visible: deletable, run: (c) => c.actions.requestDelete(c.item) }),
];

export const officialNotesTreeMenuEntries: readonly SlotEntry<ResourceMenuValue>[] = notesTreeMenuRows.map((value) => ({
  id: value.id,
  order: value.order,
  owner: 'dstu.ui.menu',
  origin: 'builtin',
  value,
}));

for (const entry of officialNotesTreeMenuEntries) resourceMenuContributions.announce(entry);

/** One row of the tree's context menu (the shape `TreeContextMenu` renders); `id` is unique across contributions. */
export interface NotesTreeMenuItemView {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export type NotesTreeMenuTranslate = (key: string, options: Record<string, unknown>) => string;
export type ResourceMenuError = (entry: SlotEntry<ResourceMenuValue>, phase: 'render' | 'report', error: unknown) => void;

/**
 * The rows of `entries` that show for `context`, in slot order. A shown separator row puts a separator before the next
 * row shown. A community row that throws while evaluated is left out; a community `run` that throws is only reported.
 */
export function resolveNotesTreeMenu(
  entries: readonly SlotEntry<ResourceMenuValue>[],
  context: NotesTreeMenuContext,
  t: NotesTreeMenuTranslate,
  onError: ResourceMenuError,
): NotesTreeMenuItemView[] {
  const items: NotesTreeMenuItemView[] = [];
  let separatorBefore = false;
  for (const entry of entries) {
    const value: MenuRow = entry.value;
    const builtin = entry.origin === 'builtin';
    let shown: Omit<NotesTreeMenuItemView, 'id' | 'onSelect' | 'separatorBefore'> | 'separator' | null;
    try {
      if (!value.visible(context)) shown = null;
      else if (value.separator) shown = 'separator';
      else {
        const labelKey = typeof value.labelKey === 'function' ? value.labelKey(context) : value.labelKey ?? '';
        shown = { label: t(labelKey, value.labelParams?.(context) ?? {}), danger: value.danger, disabled: value.disabled?.(context) };
      }
    } catch (error) {
      if (builtin) throw error;
      onError(entry, 'render', error);
      continue;
    }
    if (shown === 'separator') separatorBefore = true;
    if (!shown || shown === 'separator') continue;
    const run = () => value.run?.(context);
    items.push({
      ...shown,
      id: `${entry.owner}:${entry.id}`,
      ...(separatorBefore ? { separatorBefore } : {}),
      onSelect: builtin ? run : () => {
        try {
          run();
        } catch (error) {
          onError(entry, 'report', error);
        }
      },
    });
    separatorBefore = false;
  }
  return items;
}
