import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '../../types';
import {
  buildReviewQueue,
  commitReciteSession,
  smoothedErrorRate,
  type ReciteSessionLog,
  type ReciteStats,
} from '../reciteStats';

function node(id: string, text: string, blanks: Array<[number, number]>, children: MindMapNode[] = []): MindMapNode {
  return {
    id,
    text,
    blankedRanges: blanks.map(([start, end]) => ({ start, end })),
    children,
  } as MindMapNode;
}

/** root(a: 2 blanks, b: 1 blank, c: 1 blank) */
function sampleTree(): MindMapNode {
  return node('root', 'Root title', [], [
    node('a', 'alpha beta gamma', [[0, 5], [6, 10]]),
    node('b', 'delta epsilon', [[0, 5]]),
    node('c', 'zeta eta', [[0, 4]]),
  ]);
}

describe('commitReciteSession', () => {
  it('commits only blanks that were actually presented or answered', () => {
    // 用户只与 a 交互：翻开 a#0，a#1 呈现但保持遮盖；b/c 从未滚到
    const session: ReciteSessionLog = {
      a: {
        0: { presented: true, missed: true },
        1: { presented: true },
      },
    };
    const stats = commitReciteSession({}, sampleTree(), session, 1000);

    expect(stats.a?.[0]).toMatchObject({ attempts: 1, misses: 1 });
    expect(stats.a?.[1]).toMatchObject({ attempts: 1, misses: 0 });
    // 未呈现的空不产生任何样本（修复「未访问记成答对」）
    expect(stats.b).toBeUndefined();
    expect(stats.c).toBeUndefined();
  });

  it('commits an all-correct session with zero reveals as success samples', () => {
    const session: ReciteSessionLog = {
      a: { 0: { presented: true }, 1: { presented: true } },
      b: { 0: { presented: true } },
    };
    const stats = commitReciteSession({}, sampleTree(), session, 1000);

    expect(stats.a?.[0]).toMatchObject({ attempts: 1, misses: 0 });
    expect(stats.a?.[1]).toMatchObject({ attempts: 1, misses: 0 });
    expect(stats.b?.[0]).toMatchObject({ attempts: 1, misses: 0 });
  });

  it('keeps a sticky miss even when the blank was re-covered before exit', () => {
    // 事件模型：miss 是会话事件而非退出瞬间的 UI 状态；
    // store 的 resetAllBlanks 只清 revealedBlanks，不清事件日志
    const session: ReciteSessionLog = {
      a: { 0: { presented: true, missed: true } },
    };
    const stats = commitReciteSession({}, sampleTree(), session, 1000);
    expect(stats.a?.[0]).toMatchObject({ attempts: 1, misses: 1 });
  });

  it('treats bulk reveal as ungraded unless the blank was individually revealed', () => {
    const session: ReciteSessionLog = {
      // 呈现后被「显示全部」亮出：不算 miss 也不算成功
      a: { 0: { presented: true, bulkRevealed: true } },
      // 先单独翻开、后被显示全部覆盖：miss 保留
      b: { 0: { presented: true, missed: true, bulkRevealed: true } },
      // 只被显示全部亮出、从未以遮盖态呈现：不计
      c: { 0: { bulkRevealed: true } },
    };
    const stats = commitReciteSession({}, sampleTree(), session, 1000);

    expect(stats.a).toBeUndefined();
    expect(stats.b?.[0]).toMatchObject({ attempts: 1, misses: 1 });
    expect(stats.c).toBeUndefined();
  });

  it('returns the input reference unchanged when nothing is gradable', () => {
    const prior: ReciteStats = { a: { 0: { attempts: 3, misses: 1 } } };
    expect(commitReciteSession(prior, sampleTree(), {}, 1000)).toBe(prior);
    expect(
      commitReciteSession(prior, sampleTree(), { a: { 0: { bulkRevealed: true } } }, 1000),
    ).toBe(prior);
  });

  it('accumulates onto prior stats and stamps lastReviewedAt', () => {
    const prior: ReciteStats = { a: { 0: { attempts: 2, misses: 1, lastReviewedAt: 1 } } };
    const stats = commitReciteSession(
      prior,
      sampleTree(),
      { a: { 0: { presented: true, missed: true } } },
      42,
    );
    expect(stats.a?.[0]).toEqual({ attempts: 3, misses: 2, lastReviewedAt: 42 });
    // 入参不被修改
    expect(prior.a[0]).toEqual({ attempts: 2, misses: 1, lastReviewedAt: 1 });
  });

  it('ignores stale log entries for deleted nodes and out-of-range indices', () => {
    const session: ReciteSessionLog = {
      ghost: { 0: { presented: true, missed: true } },
      b: { 5: { presented: true, missed: true } },
    };
    const prior: ReciteStats = {};
    expect(commitReciteSession(prior, sampleTree(), session, 1000)).toBe(prior);
  });
});

describe('buildReviewQueue', () => {
  it('orders nodes by highest smoothed error rate, stable on ties', () => {
    const stats: ReciteStats = {
      a: { 0: { attempts: 4, misses: 4 } }, // 5/6 ≈ 0.83
      b: { 0: { attempts: 4, misses: 0 } }, // 1/6 ≈ 0.17
      // c 无统计 → 0.5 基线
    };
    const queue = buildReviewQueue(sampleTree(), stats);
    expect(queue.map((item) => item.nodeId)).toEqual(['a', 'c', 'b']);
    expect(queue[0].blankCount).toBe(2);
  });

  it('uses the 0.5 baseline for unreviewed blanks', () => {
    expect(smoothedErrorRate(undefined)).toBe(0.5);
    expect(smoothedErrorRate({ attempts: 1, misses: 1 })).toBeCloseTo(2 / 3);
  });
});
