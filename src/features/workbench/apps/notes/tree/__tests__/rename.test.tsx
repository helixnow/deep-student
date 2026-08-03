import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
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

const items: NotesWorkspaceTreeItem[] = [
  {
    id: 'fld_a',
    name: 'Archive',
    kind: 'folder',
    children: [{ id: 'note_1', name: 'Alpha', kind: 'note' }],
  },
];

function RenameHarness({
  onRename = vi.fn(),
}: {
  onRename?: (id: string, name: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>('note_1');
  const [expandedIds] = useState(() => new Set(['fld_a']));

  return (
    <NotesWorkspaceTree
      items={items}
      expandedIds={expandedIds}
      selectedId={selectedId}
      onToggleExpand={vi.fn()}
      onSelect={setSelectedId}
      onOpen={vi.fn()}
      onMove={vi.fn()}
      onRename={onRename}
      getMenuItems={(item, helpers) => [
        {
          id: 'rename',
          label: '重命名',
          onSelect: () => {
            void item;
            helpers.beginRename();
          },
        },
      ]}
    />
  );
}

describe('NotesWorkspaceTree rename', () => {
  it('enters rename on double-click, commits with Enter', () => {
    const onRename = vi.fn();
    render(<RenameHarness onRename={onRename} />);

    const row = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    fireEvent.doubleClick(row);

    const input = screen.getByRole('textbox', { name: '重命名' });
    expect(input).toHaveValue('Alpha');

    fireEvent.change(input, { target: { value: 'Alpha v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('note_1', 'Alpha v2');
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
  });

  it('cancels rename on Escape without calling onRename', () => {
    const onRename = vi.fn();
    render(<RenameHarness onRename={onRename} />);

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '笔记：Alpha' }));
    const input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: '笔记：Alpha' })).toBeInTheDocument();
  });

  it('commits rename on blur when the value changed', () => {
    const onRename = vi.fn();
    render(<RenameHarness onRename={onRename} />);

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '笔记：Alpha' }));
    const input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.change(input, { target: { value: 'Blurred' } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith('note_1', 'Blurred');
  });

  it('starts rename via F2 keyboard shortcut', () => {
    const onRename = vi.fn();
    render(
      <NotesWorkspaceTree
        items={items}
        expandedIds={new Set(['fld_a'])}
        selectedId="note_1"
        onToggleExpand={vi.fn()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onMove={vi.fn()}
        onRename={onRename}
      />,
    );

    const row = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    row.focus();
    fireEvent.keyDown(row, { key: 'F2' });

    const input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.change(input, { target: { value: 'From F2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('note_1', 'From F2');
  });

  it('starts rename from context-menu helpers.beginRename', () => {
    const onRename = vi.fn();
    render(<RenameHarness onRename={onRename} />);

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '笔记：Alpha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));

    const input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.change(input, { target: { value: 'From menu' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('note_1', 'From menu');
  });
});
