import { describe, expect, it } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { VfsFolder } from '@/dstu/types/folder';
import { buildTree } from '../NotesWorkspaceApp';

function folder(id: string, title: string, parentId: string | null = null): VfsFolder {
  return {
    id,
    parentId,
    title,
    isExpanded: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function note(id: string, name: string): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/${id}`,
    name,
    type: 'note',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Notes workspace tree', () => {
  it('keeps same-named folders separate by stable folder identity', () => {
    const first = folder('fld_a', 'Archive');
    const second = folder('fld_b', 'Archive');
    const firstNote = note('note_a', 'First');
    const secondNote = note('note_b', 'Second');
    const tree = buildTree(
      [firstNote, secondNote],
      [first, second],
      new Map([
        ['note:note_a', first.id],
        ['note:note_b', second.id],
      ]),
    );

    const folders = [...tree.folders.values()];
    expect(folders).toHaveLength(2);
    expect(folders.map((item) => item.id).sort()).toEqual(['fld_a', 'fld_b']);
    expect(folders.find((item) => item.id === 'fld_a')?.resources.map((item) => item.id)).toEqual(['note_a']);
    expect(folders.find((item) => item.id === 'fld_b')?.resources.map((item) => item.id)).toEqual(['note_b']);
  });
});
