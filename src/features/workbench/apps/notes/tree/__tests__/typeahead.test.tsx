import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceTree } from '../NotesWorkspaceTree';
import { resolveTypeaheadTarget } from '../keyboard';
import { flattenVisibleTree } from '../flatten';
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
      { id: 'note_alpha', name: 'Alpha', kind: 'note' },
      { id: 'note_beta', name: 'Beta', kind: 'note' },
      { id: 'note_beta2', name: 'Beacon', kind: 'note' },
    ],
  },
  { id: 'note_root', name: 'Root note', kind: 'note' },
];

const rows = flattenVisibleTree(sampleItems, new Set(['fld_a']));

describe('resolveTypeaheadTarget', () => {
  it('matches by case-insensitive title prefix', () => {
    expect(resolveTypeaheadTarget({ query: 'r', currentId: 'fld_a', rows }))
      .toBe('note_root');
    expect(resolveTypeaheadTarget({ query: 'B', currentId: 'fld_a', rows }))
      .toBe('note_beta');
  });

  it('single char cycles to the next match after the current row (wraps)', () => {
    expect(resolveTypeaheadTarget({ query: 'b', currentId: 'note_beta', rows }))
      .toBe('note_beta2');
    expect(resolveTypeaheadTarget({ query: 'b', currentId: 'note_beta2', rows }))
      .toBe('note_beta');
  });

  it('multi-char query keeps matching from the current row', () => {
    expect(resolveTypeaheadTarget({ query: 'be', currentId: 'note_beta', rows }))
      .toBe('note_beta');
    expect(resolveTypeaheadTarget({ query: 'bea', currentId: 'note_beta', rows }))
      .toBe('note_beta2');
  });

  it('returns null when nothing matches or the query is empty', () => {
    expect(resolveTypeaheadTarget({ query: 'zzz', currentId: 'fld_a', rows })).toBeNull();
    expect(resolveTypeaheadTarget({ query: '', currentId: 'fld_a', rows })).toBeNull();
  });
});

function TypeaheadHarness() {
  const [selectedId, setSelectedId] = useState<string | null>('note_alpha');
  const [expandedIds] = useState(() => new Set(['fld_a']));

  return (
    <NotesWorkspaceTree
      items={sampleItems}
      expandedIds={expandedIds}
      selectedId={selectedId}
      onToggleExpand={vi.fn()}
      onSelect={setSelectedId}
      onOpen={vi.fn()}
      onMove={vi.fn()}
      onRename={vi.fn()}
    />
  );
}

describe('NotesWorkspaceTree type-ahead integration', () => {
  it('typing a letter jumps selection to the next matching row', () => {
    render(<TypeaheadHarness />);

    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'r' });

    expect(screen.getByRole('treeitem', { name: '笔记：Root note' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('accumulated buffer refines the match instead of restarting', () => {
    render(<TypeaheadHarness />);

    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'b' });
    expect(screen.getByRole('treeitem', { name: '笔记：Beta' }))
      .toHaveAttribute('aria-selected', 'true');

    const beta = screen.getByRole('treeitem', { name: '笔记：Beta' });
    fireEvent.keyDown(beta, { key: 'e' });
    fireEvent.keyDown(beta, { key: 'a' });
    fireEvent.keyDown(beta, { key: 'c' });
    expect(screen.getByRole('treeitem', { name: '笔记：Beacon' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('does not hijack modifier shortcuts as type-ahead input', () => {
    render(<TypeaheadHarness />);

    const alpha = screen.getByRole('treeitem', { name: '笔记：Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'r', metaKey: true });

    expect(screen.getByRole('treeitem', { name: '笔记：Root note' }))
      .toHaveAttribute('aria-selected', 'false');
  });
});
