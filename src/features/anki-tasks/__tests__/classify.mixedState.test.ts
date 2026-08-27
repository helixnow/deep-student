/**
 * classify 互斥分类修复（Wave2-E r3）回归测试：
 * failed+running 混合态不得被 failedTasks>0 短路进 attention 而丢掉
 * 「仍在运行」的事实（轮询降频 / 防休眠误解除 / 行内暂停取消被藏）。
 * 仅纯函数断言，不渲染组件。
 */
import { describe, expect, it } from 'vitest';
import { classify, hasWarnings, type DocumentSession } from '../types';

function makeSession(overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    documentId: 'doc-1',
    documentName: 'doc',
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

describe('classify — 互斥分类优先级（active/paused 先于 failed）', () => {
  it('failed+running 混合态归 active，不再进 attention', () => {
    expect(classify(makeSession({ failedTasks: 3, activeTasks: 2 }))).toBe('active');
  });

  it('failed+paused 混合态同样归 active（暂停事实不丢）', () => {
    expect(classify(makeSession({ failedTasks: 1, pausedTasks: 4 }))).toBe('active');
  });

  it('failed+running+paused 三态并存仍归 active', () => {
    expect(
      classify(makeSession({ failedTasks: 2, activeTasks: 1, pausedTasks: 1 })),
    ).toBe('active');
  });

  it('纯失败（全部停止）才归 attention', () => {
    expect(classify(makeSession({ failedTasks: 5, completedTasks: 5 }))).toBe('attention');
  });

  it('纯运行 / 纯暂停归 active', () => {
    expect(classify(makeSession({ activeTasks: 1 }))).toBe('active');
    expect(classify(makeSession({ pausedTasks: 1 }))).toBe('active');
  });

  it('无失败、无运行、无暂停归 completed', () => {
    expect(classify(makeSession({ completedTasks: 10 }))).toBe('completed');
  });
});

describe('hasWarnings — 非阻断警告标记（不改变分组）', () => {
  it('混合态点亮警告，且分组仍是 active', () => {
    const mixed = makeSession({ failedTasks: 3, activeTasks: 2 });
    expect(hasWarnings(mixed)).toBe(true);
    expect(classify(mixed)).toBe('active');
  });

  it('纯 attention 会话不重复点亮（状态标签已表达失败）', () => {
    const attention = makeSession({ failedTasks: 3 });
    expect(classify(attention)).toBe('attention');
    expect(hasWarnings(attention)).toBe(false);
  });

  it('无失败无警告的会话不点亮', () => {
    expect(hasWarnings(makeSession({ activeTasks: 1 }))).toBe(false);
    expect(hasWarnings(makeSession({ completedTasks: 10 }))).toBe(false);
  });

  it('optional warningTasks 点亮「带警告完成」，分组仍是 completed', () => {
    const withWarnings = makeSession({ completedTasks: 10, warningTasks: 2 });
    expect(hasWarnings(withWarnings)).toBe(true);
    expect(classify(withWarnings)).toBe('completed');
  });

  it('optional completedWithWarnings 布尔标记同样点亮，分组不变', () => {
    const withFlag = makeSession({ completedTasks: 10, completedWithWarnings: true });
    expect(hasWarnings(withFlag)).toBe(true);
    expect(classify(withFlag)).toBe('completed');
  });

  it('后端未下发 optional 字段时（undefined）按无警告处理', () => {
    const legacy = makeSession({ completedTasks: 10 });
    expect(legacy.warningTasks).toBeUndefined();
    expect(hasWarnings(legacy)).toBe(false);
  });
});
