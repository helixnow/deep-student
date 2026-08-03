import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
import { resolveRangeSelection } from '../keyboard';
import { excludeNestedIds, flattenVisibleTree } from '../flatten';
import type { NotesWorkspaceTreeItem } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) => {
      const catalog: Record<string, string> = {
        'workbench:notesWorkspace.tree.aria': '文件树',
        'workbench:notesWorkspace.tree.root': '资料库根目录',
        'workbench:notesWorkspace.tree.folder': '文件夹：{{name}}',
        'workbench:notesWorkspace.tree.note': '笔记：{{name}}',
        'workbench:notesWorkspace.tree.mindmap': '导图：{{name}}',
        'workbench:notesWorkspace.tree.renameInput': '重命名',
      };
      const value = options?.defaultValue ?? catalog[key] ?? key;
      return typeof options?.name === 'string'
        ? value.replace(/\{\{name\}\}/g, options.name)
        : value;
    },
  }),
}));

const sampleItems: NotesWorkspaceTreeItem[] = [
  {
    id: 'fld_a',
    name: 'Archive',
    kind: 'folder',
    path: '/fld_a',
    children: [
      { id: 'note_1', name: 'Alpha', kind: 'note' },
      { id: 'note_2', name: 'Beta', kind: 'note' },
    ],
  },
  { id: 'note_root', name: 'Root note', kind: 'note' },
];

function MultiSelectHarness({
  onDelete,
  onDeleteMany,
  onSelectionChange,
  onOpen = vi.fn(),
}: {
  onDelete?: (item: NotesWorkspaceTreeItem) => void;
  onDeleteMany?: (items: NotesWorkspaceTreeItem[]) => void;
  onSelectionChange?: (ids: string[]) => void;
  onOpen?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>('note_1');
  const [expandedIds] = useState(() => new Set(['fld_a']));

  return (
    <NotesWorkspaceTree
      items={sampleItems}
      expandedIds={expandedIds}
      selectedId={selectedId}
      onToggleExpand={vi.fn()}
      onSelect={setSelectedId}
      onSelectionChange={onSelectionChange}
      onOpen={onOpen}
      onMove={vi.fn()}
      onRename={vi.fn()}
      onDelete={onDelete}
      onDeleteMany={onDeleteMany}
    />
  );
}

const row = (name: string) => screen.getByRole('treeitem', { name });

describe('NotesWorkspaceTree multi-select', () => {
  it('marks the tree as aria-multiselectable', () => {
    render(<MultiSelectHarness />);
    expect(screen.getByRole('tree')).toHaveAttribute('aria-multiselectable', 'true');
  });

  it('Cmd/Ctrl+Click toggles rows into the selection without opening them', () => {
    const onOpen = vi.fn();
    const onSelectionChange = vi.fn();
    render(<MultiSelectHarness onOpen={onOpen} onSelectionChange={onSelectionChange} />);

    fireEvent.click(row('笔记：Beta'), { metaKey: true });

    expect(row('笔记：Alpha')).toHaveAttribute('aria-selected', 'true');
    expect(row('笔记：Beta')).toHaveAttribute('aria-selected', 'true');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenLastCalledWith(['note_1', 'note_2']);

    fireEvent.click(row('笔记：Beta'), { ctrlKey: true });
    expect(row('笔记：Beta')).toHaveAttribute('aria-selected', 'false');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['note_1']);
  });

  it('Shift+Click selects the visible range from the anchor', () => {
    const onSelectionChange = vi.fn();
    render(<MultiSelectHarness onSelectionChange={onSelectionChange} />);

    fireEvent.click(row('笔记：Root note'), { shiftKey: true });

    expect(row('笔记：Alpha')).toHaveAttribute('aria-selected', 'true');
    expect(row('笔记：Beta')).toHaveAttribute('aria-selected', 'true');
    expect(row('笔记：Root note')).toHaveAttribute('aria-selected', 'true');
    expect(row('文件夹：Archive')).toHaveAttribute('aria-selected', 'false');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['note_1', 'note_2', 'note_root']);
  });

  it('plain click collapses a multi-selection back to a single row', () => {
    const onSelectionChange = vi.fn();
    render(<MultiSelectHarness onSelectionChange={onSelectionChange} />);

    fireEvent.click(row('笔记：Beta'), { metaKey: true });
    fireEvent.click(row('笔记：Root note'));

    expect(row('笔记：Alpha')).toHaveAttribute('aria-selected', 'false');
    expect(row('笔记：Beta')).toHaveAttribute('aria-selected', 'false');
    expect(row('笔记：Root note')).toHaveAttribute('aria-selected', 'true');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['note_root']);
  });

  it('Shift+ArrowDown extends the selection with the keyboard', () => {
    render(<MultiSelectHarness />);

    const alpha = row('笔记：Alpha');
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown', shiftKey: true });

    expect(row('笔记：Alpha')).toHaveAttribute('aria-selected', 'true');
    expect(row('笔记：Beta')).toHaveAttribute('aria-selected', 'true');
  });

  it('Delete loops onDelete over every selected item', () => {
    const onDelete = vi.fn();
    render(<MultiSelectHarness onDelete={onDelete} />);

    fireEvent.click(row('笔记：Beta'), { metaKey: true });
    const beta = row('笔记：Beta');
    beta.focus();
    fireEvent.keyDown(beta, { key: 'Delete' });

    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(onDelete).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'note_1' }));
    expect(onDelete).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'note_2' }));
  });

  it('Delete prefers onDeleteMany for batch deletion when provided', () => {
    const onDelete = vi.fn();
    const onDeleteMany = vi.fn();
    render(<MultiSelectHarness onDelete={onDelete} onDeleteMany={onDeleteMany} />);

    fireEvent.click(row('笔记：Beta'), { metaKey: true });
    const beta = row('笔记：Beta');
    beta.focus();
    fireEvent.keyDown(beta, { key: 'Delete' });

    expect(onDelete).not.toHaveBeenCalled();
    expect(onDeleteMany).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'note_1' }),
      expect.objectContaining({ id: 'note_2' }),
    ]);
  });

  it('Delete on an unselected focused row only deletes that row', () => {
    const onDelete = vi.fn();
    render(<MultiSelectHarness onDelete={onDelete} />);

    const rootNote = row('笔记：Root note');
    rootNote.focus();
    fireEvent.keyDown(rootNote, { key: 'Delete' });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'note_root' }));
  });
});

describe('resolveRangeSelection', () => {
  const rows = flattenVisibleTree(sampleItems, new Set(['fld_a']));

  it('returns the inclusive range between anchor and target in row order', () => {
    expect(resolveRangeSelection(rows, 'note_1', 'note_root'))
      .toEqual(['note_1', 'note_2', 'note_root']);
    expect(resolveRangeSelection(rows, 'note_root', 'note_1'))
      .toEqual(['note_1', 'note_2', 'note_root']);
  });

  it('falls back to the target when the anchor is not visible', () => {
    expect(resolveRangeSelection(rows, 'missing', 'note_2')).toEqual(['note_2']);
    expect(resolveRangeSelection(rows, null, 'note_2')).toEqual(['note_2']);
  });

  it('returns empty when the target is not visible', () => {
    expect(resolveRangeSelection(rows, 'note_1', 'missing')).toEqual([]);
  });
});

describe('excludeNestedIds', () => {
  it('drops ids nested under a selected folder and keeps DFS order', () => {
    expect(excludeNestedIds(sampleItems, new Set(['note_2', 'fld_a', 'note_root'])))
      .toEqual(['fld_a', 'note_root']);
  });

  it('keeps sibling selections untouched', () => {
    expect(excludeNestedIds(sampleItems, ['note_root', 'note_1']))
      .toEqual(['note_1', 'note_root']);
  });
});
