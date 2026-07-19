import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
import { resolveTreeKeyboardNav } from '../keyboard';
import { flattenVisibleTree } from '../flatten';
import {
  NOTES_WORKSPACE_TREE_ROOT_ID,
  type NotesWorkspaceTreeItem,
} from '../types';

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

describe('resolveTreeKeyboardNav', () => {
  const rows = flattenVisibleTree(sampleItems, new Set(['fld_a']));

  it('moves focus with ArrowUp / ArrowDown across visible rows', () => {
    expect(resolveTreeKeyboardNav({
      key: 'ArrowDown',
      currentId: 'fld_a',
      rows,
      expandedIds: new Set(['fld_a']),
    })).toEqual({ type: 'focus', id: 'note_1' });

    expect(resolveTreeKeyboardNav({
      key: 'ArrowUp',
      currentId: 'note_1',
      rows,
      expandedIds: new Set(['fld_a']),
    })).toEqual({ type: 'focus', id: 'fld_a' });
  });

  it('expands / collapses folders and enters / exits hierarchy', () => {
    expect(resolveTreeKeyboardNav({
      key: 'ArrowRight',
      currentId: 'fld_a',
      rows: flattenVisibleTree(sampleItems, new Set()),
      expandedIds: new Set(),
    })).toEqual({ type: 'toggle', id: 'fld_a' });

    expect(resolveTreeKeyboardNav({
      key: 'ArrowLeft',
      currentId: 'fld_a',
      rows,
      expandedIds: new Set(['fld_a']),
    })).toEqual({ type: 'toggle', id: 'fld_a' });

    expect(resolveTreeKeyboardNav({
      key: 'ArrowLeft',
      currentId: 'note_1',
      rows,
      expandedIds: new Set(['fld_a']),
      includeRoot: true,
    })).toEqual({ type: 'focus', id: 'fld_a' });
  });

  it('opens leaves with Enter and starts rename with F2', () => {
    expect(resolveTreeKeyboardNav({
      key: 'Enter',
      currentId: 'note_1',
      rows,
      expandedIds: new Set(['fld_a']),
    })).toEqual({ type: 'open', id: 'note_1' });

    expect(resolveTreeKeyboardNav({
      key: 'F2',
      currentId: 'note_1',
      rows,
      expandedIds: new Set(['fld_a']),
    })).toEqual({ type: 'rename', id: 'note_1' });
  });

  it('treats root as a navigable row when includeRoot is set', () => {
    expect(resolveTreeKeyboardNav({
      key: 'ArrowDown',
      currentId: NOTES_WORKSPACE_TREE_ROOT_ID,
      rows,
      expandedIds: new Set(['fld_a']),
      includeRoot: true,
    })).toEqual({ type: 'focus', id: 'fld_a' });
  });
});

function KeyboardHarness() {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['fld_a']));
  const [selectedId, setSelectedId] = useState<string | null>('note_1');
  const onOpen = vi.fn();

  return (
    <NotesWorkspaceTree
      items={sampleItems}
      expandedIds={expandedIds}
      selectedId={selectedId}
      onToggleExpand={(id) => {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }}
      onSelect={setSelectedId}
      onOpen={onOpen}
      onMove={vi.fn()}
      onRename={vi.fn()}
    />
  );
}

describe('NotesWorkspaceTree keyboard integration', () => {
  it('ArrowDown moves aria-selected focus to the next visible row', () => {
    render(<KeyboardHarness />);
    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(screen.getByRole('treeitem', { name: '笔记：Beta' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter opens the focused leaf', () => {
    const onOpen = vi.fn();
    render(
      <NotesWorkspaceTree
        items={sampleItems}
        expandedIds={new Set(['fld_a'])}
        selectedId="note_1"
        onToggleExpand={vi.fn()}
        onSelect={vi.fn()}
        onOpen={onOpen}
        onMove={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('note_1');
  });

  it('Delete requests host-owned deletion for the focused item', () => {
    const onDelete = vi.fn();
    render(
      <NotesWorkspaceTree
        items={sampleItems}
        expandedIds={new Set(['fld_a'])}
        selectedId="note_1"
        onToggleExpand={vi.fn()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onMove={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />,
    );
    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'note_1', kind: 'note' }));
  });
});
