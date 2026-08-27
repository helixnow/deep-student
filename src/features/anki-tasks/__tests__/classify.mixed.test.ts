/**
 * Wave2-E 第 3 轮（r3-06）独立降级测试 — classify 混合态契约
 *
 * ⚠️ 执行纪律：本文件第 3 轮只写不跑，vitest 统一到第 8 轮执行。
 *
 * 契约对象：`classify`（src/features/anki-tasks/types.ts）的混合态修复
 * （台账 P1-3，r1-09 §1 / §7 插入点 5，第 3 轮产品修改由 AnkiTasksApp/types
 * 负责人落地，本文件只按「拆开后的」目标行为锁定契约）。
 *
 * 核心契约：运行事实优先 —— failedTasks > 0 && activeTasks > 0 的混合态
 * 必须归 'active'，不得因失败短路而丢失「仍在运行」。这是轮询降频
 * （5s→30s）、防休眠误解除、active tab 错位、行内暂停/取消入口被藏的共同根因。
 *
 * 失败+暂停混合态（failedTasks>0 && activeTasks===0 && pausedTasks>0）原为
 * 开放契约点，产品实现者已裁决：active/paused 判定整体先于 failed，
 * 故同样归 'active'（暂停可恢复，行内恢复入口保持可见），本文件已补断言。
 * 失败事实由与 classify 正交的 hasWarnings 以非阻断徽章叠加（组件级断言见
 * AnkiTasksApp.statsOnlyFailure.test.tsx 混合态 describe）。
 */
import { describe, expect, it } from 'vitest';
import { classify, hasWarnings, type DocumentSession, type SessionGroup } from '../types';

function makeSession(overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    documentId: 'doc-mixed',
    documentName: 'mixed doc',
    sourceSessionId: null,
    totalTasks: 10,
    completedTasks: 0,
    failedTasks: 0,
    activeTasks: 0,
    pausedTasks: 0,
    lastUpdated: '2026-08-20T08:00:00.000Z',
    createdAt: '2026-08-20T08:00:00.000Z',
    totalCards: 0,
    ...overrides,
  };
}

describe('classify mixed-state contract (P1-3 round-3 decoupling)', () => {
  it('classifies a failed+running mixed session as active — the running fact must win', () => {
    expect(classify(makeSession({ failedTasks: 2, activeTasks: 1, completedTasks: 7 }))).toBe('active');
  });

  it('stays active regardless of how many segments already failed, as long as one is still running', () => {
    // 失败数远大于运行数也不改变结论：只要还有分段在跑就是 active
    expect(classify(makeSession({ failedTasks: 99, activeTasks: 1, totalTasks: 100 }))).toBe('active');
    // 三态混合（failed + active + paused）同样以运行事实为准
    expect(classify(makeSession({ failedTasks: 3, activeTasks: 2, pausedTasks: 1 }))).toBe('active');
  });

  it('classifies a failed+paused mixed session as active — resumable segments keep the session in the running group', () => {
    // 产品裁决（types.ts classify 注释）：active/paused 整体先于 failed，
    // 暂停可恢复 → 行内恢复入口不被 attention 分组藏住
    expect(classify(makeSession({ failedTasks: 2, pausedTasks: 3, completedTasks: 5 }))).toBe('active');
  });

  it('keeps a purely failed (nothing running) session in attention', () => {
    expect(classify(makeSession({ failedTasks: 1, completedTasks: 9 }))).toBe('attention');
  });

  it('keeps the pure single-state groups unchanged', () => {
    expect(classify(makeSession({ activeTasks: 3, completedTasks: 7 }))).toBe('active');
    // 纯暂停沿用既有语义归 active 组（「已暂停」由 StatusTag 层再区分）
    expect(classify(makeSession({ pausedTasks: 2, completedTasks: 8 }))).toBe('active');
    expect(classify(makeSession({ completedTasks: 10 }))).toBe('completed');
    // 全零兜底：无任何计数视为已完成（空会话不制造关注噪音）
    expect(classify(makeSession())).toBe('completed');
  });

  it('makes the fast-poll predicate see a failed+running session (regression anchor for 5s polling)', () => {
    // AnkiTasksApp.load() 用 sessions.some(s => classify(s) === 'active') 决定 5s/30s 轮询；
    // 拆开前混合态被归 attention，唯一在跑的会话带失败分段时轮询降频 6 倍。
    const sessions = [
      makeSession({ documentId: 'doc-done', completedTasks: 10 }),
      makeSession({ documentId: 'doc-mixed', failedTasks: 4, activeTasks: 2, completedTasks: 4 }),
    ];
    expect(sessions.some(s => classify(s) === 'active')).toBe(true);
  });
});

/**
 * 第 7 轮扩展（r7-07）：把逐例断言升级为全真值表 + 分区性质锁定。
 *
 * ⚠️ 执行纪律：第 7 轮同样只写不跑，vitest 统一到第 8 轮执行。
 *
 * 上方 describe 逐例锁定了代表性混合态；本 describe 补三类系统性契约：
 * 1. (failed, active, paused) 零/非零 8 组合全覆盖 —— 优先级次序整体钉死，
 *    任何对 classify 分支顺序的改动都会在这里精确暴露是哪个组合翻了。
 * 2. hasWarnings 与 classify 的正交性在同一张真值表上成立（徽章从不搬组）。
 * 3. 分组是全划分（每个会话恰好落一组）—— FilterTab 计数依赖该性质。
 */
describe('classify mixed-state contract — r7 extensions (truth table & partition)', () => {
  /** 与 types.ts 注释中声明的优先级同构的独立预期函数（非照抄实现分支）。 */
  function expectedGroup(failed: number, active: number, paused: number): SessionGroup {
    if (active > 0 || paused > 0) return 'active';
    if (failed > 0) return 'attention';
    return 'completed';
  }

  it('locks the full zero/non-zero truth table over (failedTasks, activeTasks, pausedTasks)', () => {
    // 用互不相同的非零值（2/3/4）避免「恰好 1」掩盖计数被调换的回归。
    for (const failedTasks of [0, 2]) {
      for (const activeTasks of [0, 3]) {
        for (const pausedTasks of [0, 4]) {
          const label = `failed=${failedTasks} active=${activeTasks} paused=${pausedTasks}`;
          expect(
            classify(makeSession({ failedTasks, activeTasks, pausedTasks })),
            label,
          ).toBe(expectedGroup(failedTasks, activeTasks, pausedTasks));
        }
      }
    }
  });

  it('keeps hasWarnings orthogonal on the same truth table — the badge lights up iff failed coexists with running/paused, and never moves the group', () => {
    for (const failedTasks of [0, 2]) {
      for (const activeTasks of [0, 3]) {
        for (const pausedTasks of [0, 4]) {
          const s = makeSession({ failedTasks, activeTasks, pausedTasks });
          const label = `failed=${failedTasks} active=${activeTasks} paused=${pausedTasks}`;
          // 无 optional 警告字段时，点亮条件 = 失败与运行/暂停并存（纯 attention 不点亮）。
          expect(hasWarnings(s), label).toBe(
            failedTasks > 0 && (activeTasks > 0 || pausedTasks > 0),
          );
          // 正交性：徽章计算不改变分组结论。
          expect(classify(s), label).toBe(expectedGroup(failedTasks, activeTasks, pausedTasks));
        }
      }
    }
  });

  it('partitions any session list into exactly one tab group (FilterTab count contract)', () => {
    const sessions: DocumentSession[] = [
      makeSession({ documentId: 'd1', activeTasks: 2 }),
      makeSession({ documentId: 'd2', failedTasks: 1, activeTasks: 1 }),
      makeSession({ documentId: 'd3', failedTasks: 2, pausedTasks: 1 }),
      makeSession({ documentId: 'd4', failedTasks: 3, completedTasks: 7 }),
      makeSession({ documentId: 'd5', completedTasks: 10 }),
      makeSession({ documentId: 'd6' }),
    ];
    const counts: Record<SessionGroup, number> = { active: 0, attention: 0, completed: 0 };
    for (const s of sessions) counts[classify(s)] += 1;
    // 三组计数之和 = 会话总数（无遗漏、无重复）——「全部」tab 的口径依赖此性质。
    expect(counts.active + counts.attention + counts.completed).toBe(sessions.length);
    expect(counts).toEqual({ active: 3, attention: 1, completed: 2 });
  });

  it('fast-poll predicate also sees a failed+paused (nothing running) session', () => {
    // 上方轮询锚点只覆盖了 failed+running；failed+paused 同样必须维持 5s 轮询，
    // 否则「恢复」入口所在的会话在 30s 降频下状态迟滞。
    const sessions = [
      makeSession({ documentId: 'doc-done', completedTasks: 10 }),
      makeSession({ documentId: 'doc-paused-mixed', failedTasks: 2, pausedTasks: 3 }),
    ];
    expect(sessions.some(s => classify(s) === 'active')).toBe(true);
  });

  it('counter drift beyond totalTasks does not flip the grouping — classify reads only the three state counters', () => {
    // 后端计数漂移（分段计数与 totalTasks 不一致）不应影响分组：
    // classify 的契约输入只有 failed/active/paused 三个计数。
    expect(classify(makeSession({ activeTasks: 5, totalTasks: 3 }))).toBe('active');
    expect(classify(makeSession({ failedTasks: 11, activeTasks: 1, totalTasks: 10 }))).toBe('active');
    expect(classify(makeSession({ failedTasks: 11, totalTasks: 10 }))).toBe('attention');
  });

  it('optional warning fields on a mixed active session light the badge without moving the group', () => {
    const s = makeSession({
      failedTasks: 1,
      activeTasks: 1,
      warningTasks: 2,
      completedWithWarnings: true,
    });
    expect(classify(s)).toBe('active');
    expect(hasWarnings(s)).toBe(true);
  });
});
