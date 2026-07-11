import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetMindMapStoreRegistry,
  createMindMapStore,
  registerMindMapStore,
  useMindMapStore,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { resetRunLedgerForTests, runLedger } from '../ledger';
import { createPacer } from '../pacing';
import {
  mindmapDriver,
  validateMindmapSubtreeInput,
} from '../drivers/mindmapDriver';
import type { AcrRunContext, AgentOp } from '../types';

const stores: MindMapStoreApi[] = [];
const unregister: Array<() => void> = [];

function createDocument(label: string): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_shared',
      text: `${label} root`,
      children: [{ id: 'shared', text: `${label} node`, children: [] }],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function createSeededStore(
  resourceId: string,
  label: string,
  overrides: Partial<{ isDirty: boolean; editingNodeId: string | null }> = {},
): MindMapStoreApi {
  const store = createMindMapStore();
  store.setState({
    mindmapId: resourceId,
    document: createDocument(label),
    isDirty: overrides.isDirty ?? false,
    editingNodeId: overrides.editingNodeId ?? null,
    focusedNodeId: 'shared',
    selection: [],
    history: { past: [], future: [] },
    _documentVersion: 0,
    agentEnteringIds: new Set(),
    agentFitViewNonce: 0,
  });
  stores.push(store);
  unregister.push(registerMindMapStore(resourceId, store));
  return store;
}

function makeRun(resourceId: string, label: string): AcrRunContext {
  return {
    runId: `run_${label}_${Math.random().toString(36).slice(2)}`,
    sessionId: 'session',
    target: { typeId: 'mindmap', resourceId },
    windowId: `window_${resourceId}`,
    pacing: createPacer('fast'),
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger: runLedger,
  };
}

function addOp(text: string, children?: unknown): AgentOp {
  return {
    kind: 'add_node',
    anchor: { parent_id: 'root_shared' },
    payload: { data: { text, ...(children === undefined ? {} : { children }) } },
    destructive: false,
    label: `add ${text}`,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetMindMapStoreRegistry();
  resetRunLedgerForTests();
  useMindMapStore.getState().reset();
});

afterEach(() => {
  while (unregister.length > 0) unregister.pop()?.();
  for (const store of stores.splice(0)) store.getState().reset();
  __resetMindMapStoreRegistry();
  resetRunLedgerForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('mindmap driver resource isolation', () => {
  it('probes and applies independently without touching the default store', async () => {
    const storeA = createSeededStore('mm_a', 'A', { isDirty: true });
    const storeB = createSeededStore('mm_b', 'B', { editingNodeId: 'shared' });
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: 'mm_a' })).toBe('dirty');
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: 'mm_b' })).toBe('hot');
    expect(mindmapDriver.probe({ typeId: 'mindmap', resourceId: 'missing' })).toBe('closed');

    storeA.setState({ isDirty: false });
    storeB.setState({ editingNodeId: null });
    const defaultBefore = useMindMapStore.getState().document;
    await mindmapDriver.apply(makeRun('mm_a', 'a'), [addOp('A only')]);
    await mindmapDriver.apply(makeRun('mm_b', 'b'), [addOp('B only')]);

    expect(storeA.getState().document.root.children.map((node) => node.text)).toContain('A only');
    expect(storeA.getState().document.root.children.map((node) => node.text)).not.toContain('B only');
    expect(storeB.getState().document.root.children.map((node) => node.text)).toContain('B only');
    expect(storeB.getState().document.root.children.map((node) => node.text)).not.toContain('A only');
    expect(useMindMapStore.getState().document).toBe(defaultBefore);
  });

  it('ledger reverts the originally captured store after registry replacement', async () => {
    const original = createSeededStore('mm_a', 'A');
    const run = makeRun('mm_a', 'ledger');
    const op: AgentOp = {
      kind: 'update_node',
      anchor: { node_id: 'shared' },
      payload: { patch: { text: 'changed' } },
      destructive: false,
      label: 'update shared',
    };
    await mindmapDriver.apply(run, [op]);
    expect(findNodeById(original.getState().document.root, 'shared')?.text).toBe('changed');

    const replacement = createSeededStore('mm_a', 'replacement');
    expect(await runLedger.revertRun(run.runId)).toBe(true);
    expect(findNodeById(original.getState().document.root, 'shared')?.text).toBe('A node');
    expect(findNodeById(replacement.getState().document.root, 'shared')?.text).toBe(
      'replacement node',
    );
  });
});

describe('mindmap nested subtree validation', () => {
  it('rejects duplicate/existing IDs, shared ownership and cycles', () => {
    const root = createDocument('base').root;
    const duplicate = [
      { id: 'dup', text: 'one', children: [] },
      { id: 'dup', text: 'two', children: [] },
    ];
    expect(validateMindmapSubtreeInput(root, root.id, duplicate).code).toBe('DUPLICATE_ID');
    expect(
      validateMindmapSubtreeInput(root, root.id, [
        { id: 'outer', text: 'outer', children: [{ id: 'shared', text: 'conflict', children: [] }] },
      ]).code,
    ).toBe('EXISTING_ID');

    const shared = { id: 'owned_once', text: 'shared', children: [] };
    expect(
      validateMindmapSubtreeInput(root, root.id, [
        { id: 'p1', text: 'p1', children: [shared] },
        { id: 'p2', text: 'p2', children: [shared] },
      ]).code,
    ).toBe('SHARED_NODE');

    const cyclic: { id: string; text: string; children: unknown[] } = {
      id: 'cycle',
      text: 'cycle',
      children: [],
    };
    cyclic.children.push(cyclic);
    expect(validateMindmapSubtreeInput(root, root.id, [cyclic]).code).toBe('CYCLE');
  });

  it('enforces depth and 10k total-node boundaries', () => {
    const root = createDocument('base').root;
    root.children = [];
    const chain = (length: number): MindMapNode[] => {
      let child: MindMapNode | null = null;
      for (let index = length - 1; index >= 0; index--) {
        child = { id: `depth_${index}`, text: `${index}`, children: child ? [child] : [] };
      }
      return child ? [child] : [];
    };
    expect(validateMindmapSubtreeInput(root, root.id, chain(98)).ok).toBe(true);
    expect(validateMindmapSubtreeInput(root, root.id, chain(99)).code).toBe('DEPTH_LIMIT');

    const leaves = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `leaf_${index}`,
        text: `${index}`,
        children: [],
      }));
    expect(validateMindmapSubtreeInput(root, root.id, leaves(9_998)).ok).toBe(true);
    expect(validateMindmapSubtreeInput(root, root.id, leaves(9_999)).code).toBe('NODE_LIMIT');
  });

  it('fails invalid input atomically and inserts a valid subtree in one mutation', async () => {
    const store = createSeededStore('mm_validate', 'V');
    const beforeDocument = store.getState().document;
    const beforeVersion = store.getState()._documentVersion;
    const invalidRun = makeRun('mm_validate', 'invalid');
    const invalid = await mindmapDriver.apply(invalidRun, [
      addOp('invalid', [
        { id: 'duplicate', text: 'one', children: [] },
        { id: 'duplicate', text: 'two', children: [] },
      ]),
    ]);
    expect(invalid.status).toBe('failed');
    expect(invalid.applied).toBe(0);
    expect(store.getState().document).toBe(beforeDocument);
    expect(store.getState()._documentVersion).toBe(beforeVersion);
    expect(runLedger.hasRun(invalidRun.runId)).toBe(false);

    const validRun = makeRun('mm_validate', 'valid');
    const valid = await mindmapDriver.apply(validRun, [
      addOp('valid', [
        {
          id: 'child_valid',
          text: 'child',
          children: [{ id: 'grandchild_valid', text: 'grandchild', children: [] }],
        },
      ]),
    ]);
    expect(valid.status).toBe('completed');
    const added = findNodeById(store.getState().document.root, valid.entityIds[0]);
    expect(added?.children[0].children[0].id).toBe('grandchild_valid');
    expect(store.getState()._documentVersion).toBe(beforeVersion + 1);
    expect(await runLedger.revertRun(validRun.runId)).toBe(true);
    expect(findNodeById(store.getState().document.root, valid.entityIds[0])).toBeNull();
  });

  it('reports moving a node into its own subtree as a failed operation', async () => {
    const store = createSeededStore('mm_move_guard', 'M');
    store.setState({
      document: {
        ...store.getState().document,
        root: {
          ...store.getState().document.root,
          children: [
            {
              id: 'parent_move',
              text: 'parent',
              children: [{ id: 'child_move', text: 'child', children: [] }],
            },
          ],
        },
      },
    });
    const before = store.getState().document;
    const run = makeRun('mm_move_guard', 'move_guard');
    const receipt = await mindmapDriver.apply(run, [
      {
        kind: 'move_node',
        anchor: { node_id: 'parent_move', new_parent_id: 'child_move' },
        payload: { index: 0 },
        destructive: true,
        label: 'invalid move',
      },
    ]);
    expect(receipt.status).toBe('failed');
    expect(receipt.applied).toBe(0);
    expect(store.getState().document).toBe(before);
    expect(runLedger.hasRun(run.runId)).toBe(false);
  });
});
