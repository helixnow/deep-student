import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import {
  createMindMapStore,
  registerMindMapStore,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import {
  __resetMindMapCardProjectionForTests,
  registerMindMapCardProjectionSink,
} from '@/features/mindmap/interop/mindmapCardProjection';
import {
  __resetMindMapAnchorEdgeSyncForTests,
  registerMindMapAnchorEdgeSink,
} from '@/features/mindmap/utils/excerptIngest';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';
import { mindmapToolsSkill } from '@/features/chat/skills/builtin-tools/mindmap-tools';
import { sanitizeDocumentSummaries } from '@/features/mindmap/utils/summaryBraces';
import { ExcerptDndHub } from '@/ui-kernel/services/excerpt-dnd';
import {
  acceptMindmapSuggestion,
  mindmapDriver,
  proposeMindmapOps,
  revertLastAcceptedMindmapSuggestion,
  snapshotNodeFields,
  validateMindmapSubtreeInput,
} from '../drivers/mindmapDriver';
import { cloneNodeImages, normalizeUpdateNodePatch } from '../drivers/mindmapDriverValidation';
import { clearAcceptedMindmapCheckpoint, clearMindmapSuggestion } from '../drivers/mindmapSuggestionStore';
import { runLedger } from '../ledger';
import type { AcrRunContext, AgentOp } from '../types';

const MM_ID = 'mm_validation_c7';
const WIN_ID = 'win_validation_c7';

const pdfAnchor: SemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_analysis',
  page: 12,
  quote: 'Cauchy criterion',
};

function makeDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '实分析',
      children: [
        {
          id: 'n1',
          text: '柯西收敛准则',
          blankedRanges: [{ start: 0, end: 2 }],
          children: [],
        },
        {
          id: 'n2',
          text: '已完成节点',
          completed: true,
          children: [],
        },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00Z' },
  };
}

function makeRun(runId: string, ledger = runLedger): AcrRunContext {
  return {
    runId,
    sessionId: 'sess_validation',
    target: { typeId: 'mindmap', resourceId: MM_ID },
    windowId: WIN_ID,
    pacing: {
      profile: {
        name: 'fast',
        opIntervalMs: 0,
        typeBatchMin: 0,
        typeBatchMax: 0,
        typeIntervalMs: 0,
        instant: true,
      },
      tick: async () => {},
      dispose: () => {},
    },
    reportProgress: () => {},
    checkPaused: async () => 'resume',
    ledger,
  };
}

describe('mindmapDriverValidation & MN5/C7 learning fields', () => {
  let store: MindMapStoreApi;
  let unregisterStore: () => void;

  beforeEach(() => {
    __resetMindMapCardProjectionForTests();
    __resetMindMapAnchorEdgeSyncForTests();
    clearMindmapSuggestion(MM_ID);
    clearAcceptedMindmapCheckpoint(MM_ID);

    store = createMindMapStore();
    store.setState({
      mindmapId: MM_ID,
      document: makeDoc(),
      isDirty: false,
      save: vi.fn().mockResolvedValue(true),
    });
    unregisterStore = registerMindMapStore(MM_ID, store, WIN_ID);
  });

  afterEach(() => {
    unregisterStore();
    __resetMindMapCardProjectionForTests();
    __resetMindMapAnchorEdgeSyncForTests();
    clearMindmapSuggestion(MM_ID);
    clearAcceptedMindmapCheckpoint(MM_ID);
  });

  it('validates and sanitizes full MN5/C7 fields in validateMindmapSubtreeInput', () => {
    const result = validateMindmapSubtreeInput(store.getState().document.root, 'root', [
      {
        id: 'n_rich',
        text: '一致收敛',
        cardNote: '控制一致上确界误差',
        isFlashcard: true,
        priority: 2,
        progress: 75.4,
        href: 'https://example.com/analysis',
        anchors: [pdfAnchor],
        excerpts: [
          {
            id: 'slot_1',
            kind: 'text',
            text: 'Supremum norm goes to 0',
            anchor: pdfAnchor,
          },
        ],
        images: [{ id: 'img_1', src: 'https://example.com/fig1.png', name: 'fig1.png' }],
        children: [
          {
            id: 'n_unsafe',
            text: 'Unsafe values stripped',
            priority: 99,
            progress: 150,
            href: 'javascript:alert(1)',
            children: [],
          },
        ],
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.forest).toHaveLength(1);
    const rich = result.forest[0];
    expect(rich).toMatchObject({
      id: 'n_rich',
      cardNote: '控制一致上确界误差',
      isFlashcard: true,
      priority: 2,
      progress: 75,
      href: 'https://example.com/analysis',
    });
    expect(rich.anchors).toHaveLength(1);
    expect(rich.excerpts).toHaveLength(1);
    expect(rich.images).toEqual([{ id: 'img_1', src: 'https://example.com/fig1.png', name: 'fig1.png' }]);

    const unsafe = rich.children[0];
    expect(unsafe.priority).toBeUndefined();
    expect(unsafe.progress).toBeUndefined();
    expect(unsafe.href).toBeUndefined();
  });

  it('snapshots and rolls back MN5/C7 fields losslessly via ledger', async () => {
    const run = makeRun('run_c7_update', runLedger);
    const beforeSnapshot = snapshotNodeFields(store.getState().document.root.children[0]);
    expect(beforeSnapshot.isFlashcard).toBeUndefined();

    const updateOp: AgentOp = {
      kind: 'update_node',
      label: '完善学习卡片属性',
      destructive: false,
      anchor: { node_id: 'n1' },
      payload: {
        patch: {
          cardNote: '等价于完备性',
          isFlashcard: true,
          priority: 1,
          progress: 60,
          href: 'https://example.com/cauchy',
          anchors: [pdfAnchor],
          excerpts: [{ id: 'slot_c', kind: 'text', text: 'Cauchy', anchor: pdfAnchor }],
          images: [{ src: 'https://example.com/cauchy.png' }],
        },
      },
    };

    const receipt = await mindmapDriver.apply(run, [updateOp]);
    expect(receipt.status).toBe('completed');
    const updatedNode = store.getState().document.root.children[0] as MindMapNode;
    expect(updatedNode.cardNote).toBe('等价于完备性');
    expect(updatedNode.isFlashcard).toBe(true);
    expect(updatedNode.priority).toBe(1);
    expect(updatedNode.progress).toBe(60);
    expect(updatedNode.href).toBe('https://example.com/cauchy');
    expect(updatedNode.anchors).toHaveLength(1);
    expect(updatedNode.excerpts).toHaveLength(1);
    expect(updatedNode.images).toHaveLength(1);

    // Ledger rollback restores every MN5/C7 field back to undefined
    const reverted = await runLedger.revertRun(run.runId);
    expect(reverted).toBe(true);
    const rolledBack = store.getState().document.root.children[0] as MindMapNode;
    expect(rolledBack.cardNote).toBeUndefined();
    expect(rolledBack.isFlashcard).toBeUndefined();
    expect(rolledBack.priority).toBeUndefined();
    expect(rolledBack.progress).toBeUndefined();
    expect(rolledBack.href).toBeUndefined();
    expect(rolledBack.anchors).toBeUndefined();
    expect(rolledBack.excerpts).toBeUndefined();
    expect(rolledBack.images).toBeUndefined();
  });

  it('reconciles flashcards, anchor edges, revealedBlanks, and filtered selection on batch suggestion accept and checkpoint revert', async () => {
    const upsertedCards: string[] = [];
    const removedCards: string[] = [];
    const edgeUpserts: number[] = [];
    const edgePrunes: number[] = [];

    const offCardSink = registerMindMapCardProjectionSink({
      upsertProjectedCard: (payload) => {
        upsertedCards.push(payload.nodeId);
      },
      removeProjectedCard: (params) => {
        removedCards.push(params.nodeId);
      },
    });
    const offEdgeSink = registerMindMapAnchorEdgeSink({
      upsertAnchorEdges: (edges) => {
        edgeUpserts.push(edges.length);
      },
      pruneAnchorEdgesBySource: () => {
        edgePrunes.push(1);
      },
    });

    // 预置挖空揭示态与隐藏已完成过滤态
    store.setState({
      revealedBlanks: { n1: { 0: true } },
      hideCompleted: true,
      selection: ['n1'],
      focusedNodeId: 'n1',
    });

    const suggestion = proposeMindmapOps({
      mindmapId: MM_ID,
      windowId: WIN_ID,
      ops: [
        {
          kind: 'add_node',
          label: '添加带锚点闪卡',
          destructive: false,
          anchor: { parent_id: 'root' },
          payload: {
            data: {
              id: 'n_ai_card',
              text: '紧致性',
              isFlashcard: true,
              cardNote: '有限开覆盖',
              anchors: [pdfAnchor],
            },
          },
        },
        {
          kind: 'update_node',
          label: '清除挖空并标记完成',
          destructive: false,
          anchor: { node_id: 'n1' },
          payload: {
            patch: {
              blankedRanges: [],
              completed: true,
            },
          },
        },
      ],
    });

    const applyResult = await acceptMindmapSuggestion(suggestion.id, MM_ID);
    expect(applyResult?.applied).toBe(2);
    // 批量采纳后：闪卡与锚点边已对账
    expect(upsertedCards).toContain('n_ai_card');
    expect(edgeUpserts.some((count) => count > 0)).toBe(true);
    // 挖空被清除后，revealedBlanks 中失效条目被自动清理
    expect(store.getState().revealedBlanks.n1).toBeUndefined();
    // hideCompleted 过滤态下，标记完成后的 n1 从 selection 移除
    expect(store.getState().selection).not.toContain('n1');

    // 一键撤回 AI 检查点
    store.setState({
      revealedBlanks: { n_ai_card: { 0: true } },
      selection: ['n_ai_card'],
    });
    const reverted = await revertLastAcceptedMindmapSuggestion(MM_ID);
    expect(reverted).toBe(true);
    // 撤回后：n_ai_card 已不存在 -> 闪卡被移除、锚点边被修剪、revealedBlanks 与 selection 均已对账
    expect(removedCards).toContain('n_ai_card');
    expect(edgePrunes.length).toBeGreaterThan(0);
    expect(store.getState().revealedBlanks.n_ai_card).toBeUndefined();
    expect(store.getState().selection).not.toContain('n_ai_card');

    offCardSink();
    offEdgeSink();
  });

  it('declares MN5/C7 learning fields and summaries in mindmap-tools embedded schemas', () => {
    const createTool = mindmapToolsSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-mindmap_create',
    );
    const editTool = mindmapToolsSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-mindmap_edit_nodes',
    );

    const createContentProps = createTool?.inputSchema.properties.content.properties ?? {};
    const createRootProps = createContentProps.root?.properties ?? {};
    const editOpProps = editTool?.inputSchema.properties.operations.items?.properties ?? {};
    const editPatchProps = editOpProps.patch?.properties ?? {};
    const editDataProps = editOpProps.data?.properties ?? {};

    const learningFields = [
      'anchors',
      'excerpts',
      'cardNote',
      'isFlashcard',
      'priority',
      'progress',
      'href',
      'images',
    ];
    for (const field of learningFields) {
      expect(createRootProps).toHaveProperty(field);
      expect(editPatchProps).toHaveProperty(field);
      expect(editDataProps).toHaveProperty(field);
    }
    expect(createContentProps).toHaveProperty('summaries');
    expect(editTool?.inputSchema.properties).toHaveProperty('summaries');
    const anchorProps = createRootProps.anchors?.items?.properties ?? {};
    expect(anchorProps).toHaveProperty('namespace');
    expect(anchorProps).toHaveProperty('locator');
  });

  it('auto-generates unique stable IDs in sanitizeDocumentSummaries when id is omitted or empty', () => {
    const root: MindMapNode = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c0', text: 'A', children: [] },
        { id: 'c1', text: 'B', children: [] },
        { id: 'c2', text: 'C', children: [] },
      ],
    };

    const sanitized = sanitizeDocumentSummaries(
      [
        { parentId: 'root', startChildId: 'c0', endChildId: 'c1', label: 'First Pair' },
        { id: 'sum_root_0_1_0', parentId: 'root', startChildId: 'c1', endChildId: 'c2', label: 'Explicit Colliding ID' },
        { id: '   ', parentId: 'root', startChildId: 'c0', endChildId: 'c2', label: 'All Three' },
      ],
      root,
    );

    expect(sanitized).toHaveLength(3);
    expect(sanitized?.[0].id).toBe('sum_root_0_1_1');
    expect(sanitized?.[1].id).toBe('sum_root_0_1_0');
    expect(sanitized?.[2].id).toBe('sum_root_0_2_2');
    expect(new Set(sanitized?.map((s) => s.id)).size).toBe(3);
  });

  it('rejects parent-child duplicate ID in add_node via reservedIds', async () => {
    const direct = validateMindmapSubtreeInput(
      store.getState().document.root,
      'root',
      [{ id: 'dup_parent', text: 'Nested same ID', children: [] }],
      ['dup_parent'],
    );
    expect(direct.ok).toBe(false);
    expect(direct.code).toBe('DUPLICATE_ID');

    const run = makeRun('run_dup_parent_child', runLedger);
    const receipt = await mindmapDriver.apply(run, [
      {
        kind: 'add_node',
        label: '添加父子同ID节点',
        destructive: false,
        anchor: { parent_id: 'root' },
        payload: {
          data: {
            id: 'dup_parent',
            text: 'Parent',
            children: [{ id: 'dup_parent', text: 'Child with same ID', children: [] }],
          },
        },
      },
    ]);

    expect(receipt.applied).toBe(0);
    expect(receipt.status).toBe('failed');
    expect(store.getState().document.root.children.some((c) => c.id === 'dup_parent')).toBe(false);
  });

  it('binds each valid image to its own id in cloneNodeImages even when earlier entries are filtered out', () => {
    const cloned = cloneNodeImages([
      { id: 'bad_id_0', src: 'http://insecure.example/0.png', name: 'bad.png' },
      { id: 'good_id_1', src: 'https://example.com/1.png', name: 'one.png' },
      { id: 'bad_id_2', src: 'javascript:alert(1)', name: 'xss.png' },
      { src: 'https://example.com/2.png', name: 'two.png' },
    ]);

    expect(cloned).toEqual([
      { id: 'good_id_1', src: 'https://example.com/1.png', name: 'one.png' },
      { src: 'https://example.com/2.png', name: 'two.png' },
    ]);
  });

  it('omits invalid values in normalizeUpdateNodePatch without erasing existing valid fields, while honoring explicit clears', () => {
    const existing: MindMapNode = {
      id: 'n1',
      text: 'Node',
      priority: 2,
      progress: 50,
      href: 'https://example.com/valid',
      images: [{ id: 'img_ok', src: 'https://example.com/a.png' }],
      anchors: [pdfAnchor],
      cardNote: '原有批注',
      isFlashcard: true,
      children: [],
    };

    const invalidPatch = normalizeUpdateNodePatch(existing, {
      priority: 7,
      progress: 150,
      href: 'javascript:alert(1)',
      images: [{ src: 'http://insecure.example/x.png' }],
      anchors: [{ kind: 'invalid' } as unknown as SemanticAnchor],
      cardNote: 123 as unknown as string,
      isFlashcard: 'nope' as unknown as boolean,
    });

    expect('priority' in invalidPatch).toBe(false);
    expect('progress' in invalidPatch).toBe(false);
    expect('href' in invalidPatch).toBe(false);
    expect('images' in invalidPatch).toBe(false);
    expect('anchors' in invalidPatch).toBe(false);
    expect('cardNote' in invalidPatch).toBe(false);
    expect('isFlashcard' in invalidPatch).toBe(false);

    const clearPatch = normalizeUpdateNodePatch(existing, {
      priority: null as unknown as undefined,
      progress: null as unknown as undefined,
      href: '',
      images: [],
      anchors: [],
      cardNote: '',
      isFlashcard: false,
    });

    expect('priority' in clearPatch).toBe(true);
    expect(clearPatch.priority).toBeUndefined();
    expect('progress' in clearPatch).toBe(true);
    expect(clearPatch.progress).toBeUndefined();
    expect('href' in clearPatch).toBe(true);
    expect(clearPatch.href).toBeUndefined();
    expect('images' in clearPatch).toBe(true);
    expect(clearPatch.images).toBeUndefined();
    expect(clearPatch.anchors).toBeNull();
    expect(clearPatch.cardNote).toBeNull();
    expect(clearPatch.isFlashcard).toBeNull();
  });

  it('exposes public hasAutoExcerptListeners() on ExcerptDndHub', () => {
    const hub = new ExcerptDndHub();
    expect(hub.hasAutoExcerptListeners()).toBe(false);
    const off = hub.subscribeAutoExcerpt(() => {});
    expect(hub.hasAutoExcerptListeners()).toBe(true);
    off();
    expect(hub.hasAutoExcerptListeners()).toBe(false);
    hub.dispose();
  });
});
