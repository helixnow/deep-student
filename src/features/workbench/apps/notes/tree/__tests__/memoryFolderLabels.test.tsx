import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import enLearningHub from '@/locales/en-US/learningHub.json';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
import { mapWorkspaceTreeFolder, type WorkspaceTreeFolderSource } from '../flatten';

const memoryFolders = enLearningHub.memoryFolders as Record<string, string>;

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) => {
      const memoryMatch = /^learningHub:memoryFolders\.(\w+)$/.exec(key);
      const catalog: Record<string, string> = {
        'workbench:notesWorkspace.tree.aria': 'File tree',
        'workbench:notesWorkspace.tree.root': 'Library root',
        'workbench:notesWorkspace.tree.folder': 'Folder: {{name}}',
        'workbench:notesWorkspace.tree.note': 'Note: {{name}}',
        'workbench:notesWorkspace.tree.renameInput': 'Rename',
      };
      const value = (memoryMatch ? memoryFolders[memoryMatch[1]] : undefined)
        ?? catalog[key] ?? options?.defaultValue ?? key;
      return typeof options?.name === 'string' ? value.replace(/\{\{name\}\}/g, options.name) : value;
    },
  }),
}));

function folder(
  id: string | undefined,
  name: string,
  path: string,
  children: WorkspaceTreeFolderSource[] = [],
): WorkspaceTreeFolderSource {
  return {
    id,
    name,
    path,
    folders: new Map(children.map((child) => [child.path, child])),
    resources: [],
  };
}

const source = folder(undefined, '', '/', [
  folder('fld_mem', '记忆', '/fld_mem', [
    folder('fld_exp', '经历', '/fld_mem/fld_exp', [
      folder('fld_state', '学科状态', '/fld_mem/fld_exp/fld_state'),
      folder('fld_free', '笔记风格', '/fld_mem/fld_exp/fld_free'),
    ]),
  ]),
  // 记忆根之外的同名用户文件夹不翻译
  folder('fld_user', '经历', '/fld_user'),
]);

describe('notes workspace tree: memory folder labels', () => {
  it('tags system memory folders inside the memory root only', () => {
    const items = mapWorkspaceTreeFolder(source, { memoryRoot: { id: 'fld_mem' } });
    const mem = items.find((item) => item.id === 'fld_mem')!;
    expect(mem.displayNameKey).toBe('learningHub:memoryFolders.root');
    const exp = mem.children![0];
    expect(exp.displayNameKey).toBe('learningHub:memoryFolders.experience');
    expect(exp.children!.find((c) => c.id === 'fld_state')!.displayNameKey)
      .toBe('learningHub:memoryFolders.subjectStatus');
    expect(exp.children!.find((c) => c.id === 'fld_free')!.displayNameKey).toBeUndefined();
    expect(items.find((item) => item.id === 'fld_user')!.displayNameKey).toBeUndefined();
    // 存储名保持不变
    expect(exp.name).toBe('经历');
  });

  it('falls back to the default root title when the memory root id is unknown', () => {
    const items = mapWorkspaceTreeFolder(source);
    expect(items.find((item) => item.id === 'fld_mem')!.displayNameKey).toBe('learningHub:memoryFolders.root');
    expect(items.find((item) => item.id === 'fld_user')!.displayNameKey).toBeUndefined();
  });

  it('renders localized labels while rename edits the stored name', () => {
    const items = mapWorkspaceTreeFolder(source, { memoryRoot: { id: 'fld_mem' } });
    const onRename = vi.fn();
    render(
      <NotesWorkspaceTree
        items={items}
        expandedIds={new Set(['fld_mem', 'fld_exp'])}
        selectedId={null}
        onToggleExpand={vi.fn()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onMove={vi.fn()}
        onRename={onRename}
      />,
    );
    expect(screen.getByRole('treeitem', { name: 'Folder: Memory' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Folder: Subject status' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Folder: 笔记风格' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Folder: 经历' })).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: 'Folder: Experience' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('经历');
  });
});
