import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { getAppKernel } from '../bootstrap';
import {
  fnv1a64Hex,
  formatAnchorShortLocator,
  isSemanticAnchorUri,
  parseSemanticAnchor,
  serializeSemanticAnchor,
  type AnchorEdgeRecord,
  type SemanticAnchor,
} from '../../ui-sdk';

let kernel: UiKernel | undefined;

afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
});

describe('Cross-Plugin Interop Protocol v1 - SemanticAnchor URI & Helpers', () => {
  it('computes deterministic 64-bit FNV-1a hex digests', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('mindmap:mm_1:node_2:ds-anchor://v1/pdf/doc?page=3')).toHaveLength(16);
    expect(fnv1a64Hex('note_1:blk_abc')).toBe(fnv1a64Hex('note_1:blk_abc'));
    expect(fnv1a64Hex('note_1:blk_abc')).not.toBe(fnv1a64Hex('note_1:blk_abd'));
  });

  it('round-trips all 7 SemanticAnchor kinds losslessly', () => {
    const cases: SemanticAnchor[] = [
      {
        kind: 'pdf',
        resourceId: 'tb_linear_algebra',
        aliasResourceId: 'res_vfs_99',
        label: '线性代数讲义',
        page: 42,
        rect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
        quote: '特征值之和等于矩阵的迹 E = a + b',
      },
      {
        kind: 'pdf',
        resourceId: 'papers/attention.pdf',
        page: 1,
      },
      {
        kind: 'media',
        resourceId: 'vid_lecture_07',
        aliasResourceId: 'file_07',
        label: '第7讲 傅里叶变换',
        startMs: 862_000,
        endMs: 869_500,
        quote: '频域卷积等价于时域乘积',
      },
      {
        kind: 'note',
        resourceId: 'note_calculus',
        blockId: 'blk_9f8a12bc',
        heading: '泰勒展开余项',
        label: '微积分笔记',
      },
      {
        kind: 'mindmap',
        resourceId: 'mm_cell_bio',
        nodeId: 'node_42',
        label: '细胞呼吸导图',
      },
      {
        kind: 'qbank',
        resourceId: 'exam_2026_mock',
        questionId: 'q_104',
        label: '真题模拟卷',
      },
      {
        kind: 'epub',
        resourceId: 'book_operating_systems',
        cfi: 'epubcfi(/6/14!/4/2/1:0)',
        quote: 'Virtual memory decouples physical frames',
      },
      {
        kind: 'custom',
        namespace: 'acme.graph',
        resourceId: 'graph_01',
        locator: 'vertex:7',
        params: { layer: '2', mode: 'focus' },
        label: '知识图谱节点',
      },
    ];

    for (const anchor of cases) {
      const uri = serializeSemanticAnchor(anchor);
      expect(uri.startsWith('ds-anchor://v1/')).toBe(true);
      expect(isSemanticAnchorUri(uri)).toBe(true);
      const parsed = parseSemanticAnchor(uri);
      expect(parsed).toEqual(anchor);
    }
  });

  it('clamps slight float drift on pdf.rect, clamps media endMs < startMs, and truncates long CJK quotes within 2048 bytes', () => {
    const driftedPdf: SemanticAnchor = {
      kind: 'pdf',
      resourceId: 'doc_1',
      page: 12,
      rect: { x: -5e-7, y: 0.25, w: 1.0000004, h: 0.5 },
      quote: '甲'.repeat(300),
      label: '乙'.repeat(160),
    };
    const pdfUri = serializeSemanticAnchor(driftedPdf);
    expect(new TextEncoder().encode(pdfUri).byteLength).toBeLessThanOrEqual(2048);
    const parsedPdf = parseSemanticAnchor(pdfUri);
    expect(parsedPdf).not.toBeNull();
    if (parsedPdf?.kind === 'pdf') {
      expect(parsedPdf.rect).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
      expect(Array.from(parsedPdf.quote ?? '').length).toBeLessThanOrEqual(240);
      expect(Array.from(parsedPdf.label ?? '').length).toBeLessThanOrEqual(120);
    }

    const mediaAnchor: SemanticAnchor = {
      kind: 'media',
      resourceId: 'aud_1',
      startMs: 5000,
      endMs: 2000,
    };
    const mediaUri = serializeSemanticAnchor(mediaAnchor);
    expect(parseSemanticAnchor(mediaUri)).toEqual({
      kind: 'media',
      resourceId: 'aud_1',
      startMs: 5000,
      endMs: 5000,
    });
    expect(parseSemanticAnchor('ds-anchor://v1/media/aud_1?t=5000&end=1200')).toEqual({
      kind: 'media',
      resourceId: 'aud_1',
      startMs: 5000,
      endMs: 5000,
    });
  });

  it('formats short UI locators accurately across anchor kinds', () => {
    expect(formatAnchorShortLocator({ kind: 'pdf', resourceId: 'd', page: 42 })).toBe('p.42');
    expect(formatAnchorShortLocator({ kind: 'media', resourceId: 'm', startMs: 862_000 })).toBe('14:22');
    expect(formatAnchorShortLocator({ kind: 'media', resourceId: 'm', startMs: 3_723_000 })).toBe('01:02:03');
    expect(
      formatAnchorShortLocator({ kind: 'note', resourceId: 'n', blockId: 'blk_9f8a1234' }),
    ).toBe('#blk_9f8a');
    expect(formatAnchorShortLocator({ kind: 'note', resourceId: 'n' })).toBe('');
    expect(
      formatAnchorShortLocator({ kind: 'mindmap', resourceId: 'mm', label: '导图节点' }),
    ).toBe('导图节点');
  });

  it('rejects malicious, corrupt, and out-of-bounds anchor URIs', () => {
    const invalidUris = [
      '',
      'javascript:alert(1)',
      'https://example.com/pdf/doc?page=1',
      'ds-anchor://v2/pdf/doc?page=1',
      'ds-anchor://v1/pdf/../etc/passwd?page=1',
      'ds-anchor://v1/pdf/..%2F..%2Fetc%2Fpasswd?page=1',
      'ds-anchor://v1/pdf/%20?page=1',
      'ds-anchor://v1/pdf/doc?page=0',
      'ds-anchor://v1/pdf/doc?page=-3',
      'ds-anchor://v1/pdf/doc?page=100001',
      'ds-anchor://v1/pdf/doc?page=NaN',
      'ds-anchor://v1/pdf/doc?page=1&rect=0.5,0.5,0.8,0.2',
      'ds-anchor://v1/pdf/doc?page=1&rect=NaN,0,0.2,0.2',
      'ds-anchor://v1/pdf/doc?page=1&rect=0.1,0.2,0,0.2',
      'ds-anchor://v1/pdf/doc?page=1&rect=0.1,0.2,-0.2,0.2',
      'ds-anchor://v1/media/vid?t=-10',
      'ds-anchor://v1/media/vid?t=999999999999',
      'ds-anchor://v1/epub/book_1',
      'ds-anchor://v1/pdf/doc?page=1&quote=bad\x00char',
      'ds-anchor://v1/pdf/doc?page=1&quote=bad\x1fchar',
      `ds-anchor://v1/pdf/doc?page=1&quote=${'a'.repeat(2050)}`,
    ];

    for (const bad of invalidUris) {
      expect(parseSemanticAnchor(bad)).toBeNull();
      expect(isSemanticAnchorUri(bad)).toBe(false);
    }
  });
});

describe('AnchorRegistry routing, Cordis fiber disposal, and backlink edges', () => {
  it('routes to open mounted handlers in <50ms, prefers exact-focused over exact-mounted, and auto-disposes on plugin unload', async () => {
    kernel = new UiKernel();
    const calls: string[] = [];

    let pdfMountedCtx: Context | undefined;
    let pdfFocusedCtx: Context | undefined;

    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.pdf-mounted' },
        async apply(ctx) {
          const { anchors } = ctx.ui;
          await Promise.resolve();
          anchors.registerAnchorRevealHandler('pdf', {
            canHandle: (a) => (a.resourceId === 'doc_42' ? 'exact-mounted' : false),
            reveal: (a, rctx) => {
              calls.push(`mounted:${a.page}:${rctx.pulse}`);
              return true;
            },
          });
          pdfMountedCtx = ctx;
        },
      }),
    );

    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.pdf-focused' },
        apply(ctx) {
          ctx.ui.anchors.registerAnchorRevealHandler('pdf', {
            canHandle: (a) => (a.resourceId === 'doc_42' ? 'exact-focused' : false),
            reveal: (a, rctx) => {
              calls.push(`focused:${a.page}:${rctx.pulse}`);
              return true;
            },
          });
          pdfFocusedCtx = ctx;
        },
      }),
    );

    expect(pdfMountedCtx).toBeDefined();
    expect(pdfFocusedCtx).toBeDefined();

    const first = await kernel.anchors.reveal('ds-anchor://v1/pdf/doc_42?page=15');
    expect(first.ok).toBe(true);
    expect(first.outcome).toBe('revealed-in-open-pane');
    expect(first.elapsedMs).toBeLessThan(50);
    expect(calls).toEqual(['focused:15:true']);

    // Unloading the focused viewer plugin automatically disposes its reveal handler;
    // subsequent reveals route cleanly to the remaining mounted handler.
    await kernel.unload('community.pdf-focused');
    const second = await kernel.anchors.reveal(
      { kind: 'pdf', resourceId: 'doc_42', page: 18 },
      { pulse: false },
    );
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe('revealed-in-open-pane');
    expect(second.elapsedMs).toBeLessThan(50);
    expect(calls).toEqual(['focused:15:true', 'mounted:18:false']);

    // Unloading the mounted plugin leaves zero handlers.
    await kernel.unload('community.pdf-mounted');
    const third = await kernel.anchors.reveal('ds-anchor://v1/pdf/doc_42?page=18', {
      splitIfClosed: false,
    });
    expect(third).toMatchObject({ ok: false, outcome: 'unhandled' });
  });

  it('opens closed panes via adapters.openAnchor and flushes pending reveal when the viewer mounts', async () => {
    const revealedPages: number[] = [];
    const openAnchor = vi.fn(async (anchor: SemanticAnchor) => {
      if (anchor.kind !== 'pdf') return false;
      setTimeout(() => {
        kernel?.anchors.registerAnchorRevealHandler('pdf', {
          canHandle: (candidate) =>
            candidate.resourceId === anchor.resourceId ? 'exact-mounted' : false,
          reveal: (candidate) => {
            revealedPages.push(candidate.page);
            return true;
          },
        });
      }, 15);
      return true;
    });

    kernel = new UiKernel({ openAnchor }, { pendingRevealTimeoutMs: 300 });

    const res = await kernel.anchors.reveal('ds-anchor://v1/pdf/doc_closed?page=27');
    expect(openAnchor).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('opened-and-revealed');
    expect(revealedPages).toEqual([27]);

    const invalid = await kernel.anchors.reveal('javascript:alert(1)');
    expect(invalid).toEqual({ ok: false, outcome: 'invalid-anchor', elapsedMs: 0 });
  });

  it('resolves opened-via-host when openAnchor handles focus without a new handler before timeout', async () => {
    const openAnchor = vi.fn(async () => true);
    kernel = new UiKernel({ openAnchor }, { pendingRevealTimeoutMs: 25 });

    const res = await kernel.anchors.reveal('ds-anchor://v1/note/note_legacy?block=blk_1');
    expect(openAnchor).toHaveBeenCalledWith(
      { kind: 'note', resourceId: 'note_legacy', blockId: 'blk_1' },
      { splitIfClosed: true },
    );
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('opened-via-host');
  });

  it('manages in-memory + adapter vfs_anchor_edges, prunes stale source edges, and notifies subscribers', async () => {
    const persistedStore = new Map<string, AnchorEdgeRecord>();
    const anchorEdgesAdapter = {
      upsert: vi.fn(async (edges: AnchorEdgeRecord[]) => {
        for (const edge of edges) persistedStore.set(edge.edgeId, edge);
      }),
      deleteBySource: vi.fn(
        async (params: { sourceKind: string; sourceResourceId: string; keepEdgeIds?: string[] }) => {
          const keep = new Set(params.keepEdgeIds ?? []);
          for (const [id, edge] of [...persistedStore.entries()]) {
            if (
              edge.sourceKind === params.sourceKind &&
              edge.sourceResourceId === params.sourceResourceId &&
              !keep.has(id)
            ) {
              persistedStore.delete(id);
            }
          }
        },
      ),
      queryByTarget: vi.fn(async ({ targetResourceIds }: { targetResourceIds: string[] }) => {
        const ids = new Set(targetResourceIds);
        return [...persistedStore.values()].filter((e) => ids.has(e.targetResourceId));
      }),
    };

    kernel = new UiKernel({ anchorEdges: anchorEdgesAdapter });

    const notifications: Array<{ targetResourceIds: string[]; sourceResourceId?: string }> = [];
    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.edge-watcher' },
        apply(ctx) {
          ctx.ui.anchors.subscribeAnchorEdgesChanged((detail) => {
            notifications.push(detail);
          });
        },
      }),
    );

    const { upserted, edges } = await kernel.anchors.upsertAnchorEdges([
      {
        sourceKind: 'mindmap',
        sourceResourceId: 'mm_bio',
        sourceSubId: 'node_1',
        sourceAnchor: { kind: 'mindmap', resourceId: 'mm_bio', nodeId: 'node_1', label: '有丝分裂' },
        sourceLabel: '有丝分裂',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_bio',
          aliasResourceId: 'vfs_bio_01',
          page: 12,
          rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.15 },
        },
        studySpaceId: 'space_fall',
      },
      {
        sourceKind: 'mindmap',
        sourceResourceId: 'mm_bio',
        sourceSubId: 'node_2',
        sourceAnchor: { kind: 'mindmap', resourceId: 'mm_bio', nodeId: 'node_2', label: '减数分裂' },
        sourceLabel: '减数分裂',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_bio',
          page: 14,
        },
      },
    ]);

    expect(upserted).toBe(2);
    expect(edges).toHaveLength(2);
    expect(anchorEdgesAdapter.upsert).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].targetResourceIds).toEqual(
      expect.arrayContaining(['tb_bio', 'vfs_bio_01']),
    );

    // Query by primary resourceId or aliasResourceId returns matching edges.
    const byPrimary = await kernel.anchors.queryAnchorEdgesByTarget({
      targetResourceIds: ['tb_bio'],
      targetKind: 'pdf',
    });
    expect(byPrimary.map((e) => e.targetPage)).toEqual([12, 14]);

    const byAlias = await kernel.anchors.queryAnchorEdgesByTarget({
      targetResourceIds: ['vfs_bio_01'],
      targetKind: 'pdf',
    });
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0].targetPage).toBe(12);

    // Prune node_2 while keeping node_1.
    const pruneRes = await kernel.anchors.pruneAnchorEdgesBySource({
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_bio',
      keepEdgeIds: [edges[0].edgeId],
    });
    expect(pruneRes.deleted).toBe(1);

    const remaining = await kernel.anchors.queryAnchorEdgesByTarget({
      targetResourceIds: ['tb_bio'],
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceSubId).toBe('node_1');

    // Unloading the watcher plugin unsubscribes its listener automatically.
    const countBeforeUnload = notifications.length;
    await kernel.unload('community.edge-watcher');
    await kernel.anchors.upsertAnchorEdges([
      {
        sourceKind: 'flashcard',
        sourceResourceId: 'card_1',
        sourceAnchor: { kind: 'note', resourceId: 'note_1', blockId: 'blk_1' },
        targetAnchor: { kind: 'pdf', resourceId: 'tb_bio', page: 19 },
      },
    ]);
    expect(notifications).toHaveLength(countBeforeUnload);
  });

  it('provides getAppKernel() fallback with graceful non-throwing IPC resilience and host event dispatch', async () => {
    const appKernel = getAppKernel();
    expect(appKernel).toBeInstanceOf(UiKernel);

    // Even without Tauri backend running, upserting & querying session edges succeeds cleanly.
    const res = await appKernel.anchors.upsertAnchorEdges([
      {
        sourceKind: 'note',
        sourceResourceId: 'note_fallback',
        sourceSubId: 'blk_a',
        sourceAnchor: { kind: 'note', resourceId: 'note_fallback', blockId: 'blk_a' },
        targetAnchor: { kind: 'media', resourceId: 'media_fallback', startMs: 30_000 },
      },
    ]);
    expect(res.upserted).toBe(1);
    const queried = await appKernel.anchors.queryAnchorEdgesByTarget({
      targetResourceIds: ['media_fallback'],
      targetKind: 'media',
    });
    expect(queried).toHaveLength(1);
    expect(queried[0].targetStartMs).toBe(30_000);

    await appKernel.anchors.pruneAnchorEdgesBySource({
      sourceKind: 'note',
      sourceResourceId: 'note_fallback',
    });
  });
});
