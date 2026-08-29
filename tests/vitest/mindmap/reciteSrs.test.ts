/**
 * 背诵闭环（会话级 SRS）测试：
 * - reciteSrs 纯函数：平滑错误率、会话提交语义、难点优先队列排序、localStorage 读写降级；
 * - store 集成：退出背诵模式提交统计、startReciteReview 难点优先聚焦、
 *   stepReciteReview 越界钳制、stopReciteReview 只退复习流程不退背诵模式。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReviewQueue,
  commitReciteSession,
  loadReciteStats,
  saveReciteStats,
  smoothedErrorRate,
  type ReciteStats,
} from '@/features/mindmap/utils/reciteStats';
import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';

function blankedNode(id: string, text: string, children: MindMapNode[] = []): MindMapNode {
  // 整行挖空一段
  return { id, text, children, blankedRanges: [{ start: 0, end: text.length }] };
}

function createDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_srs',
      text: 'Root',
      children: [
        blankedNode('n_easy', 'Easy'),
        blankedNode('n_hard', 'Hard'),
        { id: 'n_plain', text: 'NoBlank', children: [blankedNode('n_deep', 'Deep')] },
      ],
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

afterEach(() => {
  useMindMapStore.getState().reset();
  localStorage.clear();
});

describe('smoothedErrorRate', () => {
  it('gives 0.5 baseline for never-reviewed blanks', () => {
    expect(smoothedErrorRate(undefined)).toBe(0.5);
  });

  it('orders frequently-missed > never-reviewed > stably-remembered', () => {
    const missed = smoothedErrorRate({ attempts: 4, misses: 4 }); // 5/6
    const fresh = smoothedErrorRate(undefined); // 0.5
    const stable = smoothedErrorRate({ attempts: 4, misses: 0 }); // 1/6
    expect(missed).toBeGreaterThan(fresh);
    expect(fresh).toBeGreaterThan(stable);
  });
});

describe('commitReciteSession', () => {
  const doc = createDoc();

  it('increments attempts for every blank in scope and misses only for revealed', () => {
    const next = commitReciteSession({}, doc.root, {
      n_hard: { 0: { presented: true, missed: true } },
      n_easy: { 0: { presented: true } },
      n_deep: { 0: { presented: true } },
    }, 1000);
    expect(next.n_hard[0]).toEqual({ attempts: 1, misses: 1, lastReviewedAt: 1000 });
    // 会话内保持遮盖 = 背出来了：attempts+1，misses 不变
    expect(next.n_easy[0]).toEqual({ attempts: 1, misses: 0, lastReviewedAt: 1000 });
    expect(next.n_deep[0]).toEqual({ attempts: 1, misses: 0, lastReviewedAt: 1000 });
    // 无挖空节点不产生统计
    expect(next.n_plain).toBeUndefined();
  });

  it('ignores sessions with zero reveals (not actually recited)', () => {
    const stats: ReciteStats = { n_easy: { 0: { attempts: 3, misses: 1 } } };
    expect(commitReciteSession(stats, doc.root, {})).toBe(stats);
    expect(commitReciteSession(stats, doc.root, { n_easy: { 0: false } })).toBe(stats);
    // 「显示全部」亮出的空不是作答样本
    expect(commitReciteSession(stats, doc.root, { n_easy: { 0: { presented: true, bulkRevealed: true } } })).toBe(stats);
  });

  it('accumulates across sessions without mutating the input', () => {
    const first = commitReciteSession({}, doc.root, { n_hard: { 0: { presented: true, missed: true } } }, 1);
    const second = commitReciteSession(first, doc.root, { n_hard: { 0: { presented: true, missed: true } } }, 2);
    expect(second.n_hard[0]).toEqual({ attempts: 2, misses: 2, lastReviewedAt: 2 });
    expect(first.n_hard[0].attempts).toBe(1);
  });
});

describe('buildReviewQueue', () => {
  const doc = createDoc();

  it('collects only blanked nodes, hardest first, DFS order for ties', () => {
    // 全空统计：所有节点同分 0.5，保持文档序
    const fresh = buildReviewQueue(doc.root, {});
    expect(fresh.map((item) => item.nodeId)).toEqual(['n_easy', 'n_hard', 'n_deep']);

    const stats: ReciteStats = {
      n_easy: { 0: { attempts: 4, misses: 0 } }, // 稳定记住 → 最后
      n_hard: { 0: { attempts: 4, misses: 4 } }, // 高频翻开 → 最先
      // n_deep 未复习 → 中间（0.5 基线）
    };
    const queue = buildReviewQueue(doc.root, stats);
    expect(queue.map((item) => item.nodeId)).toEqual(['n_hard', 'n_deep', 'n_easy']);
    expect(queue[0].blankCount).toBe(1);
  });

  it('scopes to the given subtree root', () => {
    const subtree = doc.root.children[2]; // n_plain → n_deep
    const queue = buildReviewQueue(subtree, {});
    expect(queue.map((item) => item.nodeId)).toEqual(['n_deep']);
  });
});

describe('load/save stats persistence', () => {
  it('round-trips through localStorage keyed by mindmap id', () => {
    const stats: ReciteStats = { n1: { 0: { attempts: 2, misses: 1 } } };
    saveReciteStats('mm_abc', stats);
    expect(loadReciteStats('mm_abc')).toEqual(stats);
    expect(loadReciteStats('mm_other')).toEqual({});
  });

  it('degrades to empty stats on corrupted storage', () => {
    localStorage.setItem('mindmap-recite-srs:mm_bad', '{not json');
    expect(loadReciteStats('mm_bad')).toEqual({});
    localStorage.setItem('mindmap-recite-srs:mm_null', 'null');
    expect(loadReciteStats('mm_null')).toEqual({});
  });
});

describe('store integration', () => {
  beforeEach(() => {
    useMindMapStore.setState({
      mindmapId: 'mm_store_test',
      document: createDoc(),
      focusedNodeId: null,
      history: { past: [], future: [] },
      reciteMode: false,
      revealedBlanks: {},
      reciteReviewQueue: null,
      reciteReviewIndex: 0,
      viewRootId: null,
    });
  });

  it('exiting recite mode commits revealed blanks into persisted stats', () => {
    const store = useMindMapStore.getState();
    store.setReciteMode(true);
    // 新语义：只统计实际呈现/作答的空。n_easy 呈现且背出，n_hard 翻开=miss。
    useMindMapStore.getState().markBlanksPresented('n_easy', [0]);
    useMindMapStore.getState().revealBlank('n_hard', 0);
    useMindMapStore.getState().setReciteMode(false);

    const stats = loadReciteStats('mm_store_test');
    expect(stats.n_hard[0].misses).toBe(1);
    expect(stats.n_easy[0]).toMatchObject({ attempts: 1, misses: 0 });
    // 退出后瞬态状态清空
    const state = useMindMapStore.getState();
    expect(state.revealedBlanks).toEqual({});
    expect(state.reciteReviewQueue).toBeNull();
  });

  it('exiting without reveals does not pollute stats', () => {
    useMindMapStore.getState().setReciteMode(true);
    useMindMapStore.getState().setReciteMode(false);
    expect(loadReciteStats('mm_store_test')).toEqual({});
  });

  it('startReciteReview builds hardest-first queue, enters recite mode, focuses head', () => {
    saveReciteStats('mm_store_test', {
      n_easy: { 0: { attempts: 4, misses: 0 } },
      n_deep: { 0: { attempts: 4, misses: 4 } },
    });
    const count = useMindMapStore.getState().startReciteReview();
    expect(count).toBe(3);

    const state = useMindMapStore.getState();
    expect(state.reciteMode).toBe(true);
    expect(state.reciteReviewQueue?.map((item) => item.nodeId))
      .toEqual(['n_deep', 'n_hard', 'n_easy']);
    expect(state.reciteReviewIndex).toBe(0);
    expect(state.focusedNodeId).toBe('n_deep');
  });

  it('startReciteReview returns 0 when scope has no blanks', () => {
    useMindMapStore.setState({
      document: {
        version: '1.0',
        root: { id: 'r', text: 'R', children: [{ id: 'c', text: 'C', children: [] }] },
        meta: { createdAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(useMindMapStore.getState().startReciteReview()).toBe(0);
    expect(useMindMapStore.getState().reciteReviewQueue).toBeNull();
  });

  it('stepReciteReview clamps at both ends and focuses the target node', () => {
    useMindMapStore.getState().startReciteReview();
    useMindMapStore.getState().stepReciteReview(1);
    expect(useMindMapStore.getState().reciteReviewIndex).toBe(1);
    expect(useMindMapStore.getState().focusedNodeId).toBe('n_hard');

    useMindMapStore.getState().stepReciteReview(99);
    expect(useMindMapStore.getState().reciteReviewIndex).toBe(2);
    useMindMapStore.getState().stepReciteReview(-99);
    expect(useMindMapStore.getState().reciteReviewIndex).toBe(0);
  });

  it('stopReciteReview clears the queue but keeps recite mode on', () => {
    useMindMapStore.getState().startReciteReview();
    useMindMapStore.getState().stopReciteReview();
    const state = useMindMapStore.getState();
    expect(state.reciteReviewQueue).toBeNull();
    expect(state.reciteReviewIndex).toBe(0);
    expect(state.reciteMode).toBe(true);
  });

  it('review scope follows viewRootId (focused branch only)', () => {
    useMindMapStore.setState({ viewRootId: 'n_plain' });
    const count = useMindMapStore.getState().startReciteReview();
    expect(count).toBe(1);
    expect(useMindMapStore.getState().reciteReviewQueue?.[0].nodeId).toBe('n_deep');
  });
});
