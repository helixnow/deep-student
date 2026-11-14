import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
import type { NotesWorkspaceTreeItem } from '../types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
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

/**
 * Mirrors NotesWorkspaceApp: the「新建文件夹」menu action opens an inline input that
 * auto-focuses and treats a blur with an empty value as cancel.
 */
function Harness({ onRename = vi.fn() }: { onRename?: (id: string, name: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>('note_1');
  const [creating, setCreating] = useState(false);
  const [value, setValue] = useState('');
  return (
    <>
      {creating && (
        <input
          autoFocus
          aria-label="新建文件夹"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            if (!value.trim()) setCreating(false);
          }}
        />
      )}
      <NotesWorkspaceTree
        items={items}
        expandedIds={['fld_a']}
        selectedId={selectedId}
        onToggleExpand={vi.fn()}
        onSelect={setSelectedId}
        onOpen={vi.fn()}
        onMove={vi.fn()}
        onRename={onRename}
        getMenuItems={(_item, helpers) => [
          { id: 'rename', label: '重命名', onSelect: () => helpers.beginRename() },
          { id: 'newFolder', label: '新建文件夹', onSelect: () => setCreating(true) },
          { id: 'noop', label: '收藏', onSelect: () => {} },
        ]}
      />
    </>
  );
}

/** closeMenu hands focus back on the next animation frame; let that frame (and one more) run. */
async function flushFrames() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

describe('NotesWorkspaceTree context menu focus restore', () => {
  it('keeps the inline input opened by a menu action open and focused', async () => {
    render(<Harness />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '笔记：Alpha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }));

    const input = screen.getByRole('textbox', { name: '新建文件夹' });
    expect(input).toHaveFocus();
    await flushFrames();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('keeps the rename input opened from the menu instead of committing it on a stolen blur', async () => {
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '笔记：Alpha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    await flushFrames();

    const input = screen.getByRole('textbox', { name: '重命名' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Alpha v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledExactlyOnceWith('note_1', 'Alpha v2');
  });

  it('still returns focus to the row when the menu action leaves focus nowhere', async () => {
    render(<Harness />);
    const row = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '收藏' }));
    await flushFrames();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(row).toHaveFocus();
  });

  it('still returns focus to the row when the menu is dismissed with Escape', async () => {
    render(<Harness />);
    const row = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    fireEvent.contextMenu(row);
    const first = screen.getByRole('menuitem', { name: '重命名' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    await flushFrames();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(row).toHaveFocus();
  });
});
