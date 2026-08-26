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
import { classify, type DocumentSession } from '../types';

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
