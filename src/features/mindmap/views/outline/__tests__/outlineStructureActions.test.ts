import { afterEach, describe, expect, it } from 'vitest';

import { createMindMapStore, type MindMapStoreApi } from '../../../store/mindmapStore';
import type { MindMapDocument, MindMapNode } from '../../../types';
import {
  OUTLINE_STRUCTURE_FLAG as F,
  getOutlineStructureFlags,
  runOutlineStructureAction,
  toggleOutlineSelection,
  type OutlineStructureAction,
} from '../outlineStructureActions';

const stores: MindMapStoreApi[] = [];

function doc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'root',
      children: [
        {
          id: 'a',
          text: 'A',
          children: [
            { id: 'a1', text: 'A1', children: [] },
            { id: 'a2', text: 'A2', children: [] },
          ],
        },
        { id: 'b', text: 'B', children: [] },
        { id: 'c', text: 'C', children: [] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function mountStore() {
  const store = createMindMapStore();
  store.setState({ document: doc(), focusedNodeId: null, selection: [] });
  stores.push(store);
  return store;
}

const childIds = (node: MindMapNode | undefined) => node?.children.map((c) => c.id) ?? [];
const find = (store: MindMapStoreApi, id: string): MindMapNode | undefined => {
  const walk = (n: MindMapNode): MindMapNode | undefined =>
    n.id === id ? n : n.children.map(walk).find(Boolean);
  return walk(store.getState().document.root);
};

/** 菜单与键盘共用的调用：parentId/indexInParent 取自当前树（等同 flatNode） */
function run(store: MindMapStoreApi, action: OutlineStructureAction, nodeId: string) {
  const root = store.getState().document.root;
  const walk = (n: MindMapNode): { parentId: string; indexInParent: number } | null => {
    const idx = n.children.findIndex((c) => c.id === nodeId);
    if (idx >= 0) return { parentId: n.id, indexInParent: idx };
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  const loc = walk(root);
  runOutlineStructureAction(store.getState(), action, {
    nodeId,
    parentId: loc?.parentId ?? null,
    indexInParent: loc?.indexInParent ?? 0,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.getState().reset();
});

describe('getOutlineStructureFlags', () => {
  it('disables everything on the root', () => {
    expect(getOutlineStructureFlags(doc().root, 'root')).toBe(0);
  });

  it('first top-level child: no indent / outdent / move up, can move down', () => {
    expect(getOutlineStructureFlags(doc().root, 'a')).toBe(F.moveDown);
  });

  it('middle top-level child: indent + move up/down, cannot outdent past root', () => {
    expect(getOutlineStructureFlags(doc().root, 'b')).toBe(F.indent | F.moveUp | F.moveDown);
  });

  it('last nested child: indent + outdent + move up, cannot move down', () => {
    expect(getOutlineStructureFlags(doc().root, 'a2')).toBe(F.indent | F.outdent | F.moveUp);
  });

  it('unknown node yields no actions', () => {
    expect(getOutlineStructureFlags(doc().root, 'missing')).toBe(0);
  });
});

describe('runOutlineStructureAction (shared with keyboard shortcuts)', () => {
  it('indent moves the node under its previous sibling', () => {
    const store = mountStore();
    run(store, 'indent', 'b');
    expect(childIds(store.getState().document.root)).toEqual(['a', 'c']);
    expect(childIds(find(store, 'a'))).toEqual(['a1', 'a2', 'b']);
  });

  it('outdent lifts the node after its parent and is one undo step', () => {
    const store = mountStore();
    run(store, 'outdent', 'a1');
    expect(childIds(store.getState().document.root)).toEqual(['a', 'a1', 'b', 'c']);
    // 反缩进语义：原后续同级被收养
    expect(childIds(find(store, 'a1'))).toEqual(['a2']);
    store.getState().undo();
    expect(childIds(find(store, 'a'))).toEqual(['a1', 'a2']);
  });

  it('move up / move down reorder within the same parent', () => {
    const store = mountStore();
    run(store, 'moveDown', 'a');
    expect(childIds(store.getState().document.root)).toEqual(['b', 'a', 'c']);
    run(store, 'moveUp', 'c');
    expect(childIds(store.getState().document.root)).toEqual(['b', 'c', 'a']);
  });

  it('boundary moves are no-ops (no history entry)', () => {
    const store = mountStore();
    run(store, 'moveUp', 'a');
    run(store, 'moveDown', 'c');
    run(store, 'outdent', 'b');
    expect(childIds(store.getState().document.root)).toEqual(['a', 'b', 'c']);
  });

  it('never moves the root', () => {
    const store = mountStore();
    runOutlineStructureAction(store.getState(), 'moveDown', {
      nodeId: 'root',
      parentId: null,
      indexInParent: 0,
    });
    runOutlineStructureAction(store.getState(), 'indent', {
      nodeId: 'root',
      parentId: null,
      indexInParent: 0,
    });
    expect(store.getState().document.root.id).toBe('root');
    expect(childIds(store.getState().document.root)).toEqual(['a', 'b', 'c']);
  });
});

describe('toggleOutlineSelection (touch select mode tap / Mod+click)', () => {
  it('adds an unselected row', () => {
    expect(toggleOutlineSelection(['a'], 'b', 'root')).toEqual(['a', 'b']);
  });

  it('removes a selected row', () => {
    expect(toggleOutlineSelection(['a', 'b'], 'a', 'root')).toEqual(['b']);
  });

  it('drops the root from the selection when adding', () => {
    expect(toggleOutlineSelection(['root'], 'a', 'root')).toEqual(['a']);
  });
});
