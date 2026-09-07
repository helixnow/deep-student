/**
 * N11（2026-09-07 审阅）回归：已失败的持久化记录不得从 flush 边界消失。
 * flush 的契约是「所有已接受记录均已提交」，而非「当前没有在飞请求」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPomodoroRecord = vi.fn();
vi.mock('../../api', () => ({
  createPomodoroRecord: (...args: unknown[]) => createPomodoroRecord(...args),
}));

import { usePomodoroStore } from '../usePomodoroStore';

/** 触发一次 interrupted 工作记录：start → 走过 5s → stop */
async function triggerOneRecord() {
  usePomodoroStore.getState().start();
  await vi.advanceTimersByTimeAsync(5000);
  usePomodoroStore.getState().stop();
  // 让 recordSession 的 promise 链 settle
  await vi.advanceTimersByTimeAsync(0);
}

describe('pomodoro flush N11 — 失败记录重放', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createPomodoroRecord.mockReset();
  });

  afterEach(async () => {
    // 排空待重试集合，避免用例间泄漏
    createPomodoroRecord.mockResolvedValue({ id: 'cleanup' });
    await usePomodoroStore.getState().flushPendingRecords().catch(() => {});
    vi.useRealTimers();
  });

  it('无记录时 flush 直接成功', async () => {
    await expect(
      usePomodoroStore.getState().flushPendingRecords()
    ).resolves.toBeUndefined();
    expect(createPomodoroRecord).not.toHaveBeenCalled();
  });

  it('记录先失败、flush 时后端恢复：flush 重放并成功落库', async () => {
    createPomodoroRecord.mockRejectedValueOnce(new Error('db locked'));
    await triggerOneRecord();
    expect(createPomodoroRecord).toHaveBeenCalledTimes(1);

    createPomodoroRecord.mockResolvedValue({ id: 'rec-1' });
    await expect(
      usePomodoroStore.getState().flushPendingRecords()
    ).resolves.toBeUndefined();
    // 同一输入被重放
    expect(createPomodoroRecord).toHaveBeenCalledTimes(2);
    expect(createPomodoroRecord.mock.calls[1][0]).toEqual(createPomodoroRecord.mock.calls[0][0]);
  });

  it('flush 期间仍失败：flush 报错且记录保留到下次 flush 重放', async () => {
    createPomodoroRecord.mockRejectedValue(new Error('db locked'));
    await triggerOneRecord();

    await expect(
      usePomodoroStore.getState().flushPendingRecords()
    ).rejects.toThrow('db locked');
    expect(createPomodoroRecord).toHaveBeenCalledTimes(2);

    // 后端恢复后，下一次 flush 仍能补写同一条记录
    createPomodoroRecord.mockResolvedValue({ id: 'rec-2' });
    await expect(
      usePomodoroStore.getState().flushPendingRecords()
    ).resolves.toBeUndefined();
    expect(createPomodoroRecord).toHaveBeenCalledTimes(3);
  });

  it('即时 flush 撞上在飞失败：错误仍向调用方暴露', async () => {
    let rejectInflight: (e: Error) => void = () => {};
    createPomodoroRecord.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectInflight = reject; })
    );
    usePomodoroStore.getState().start();
    await vi.advanceTimersByTimeAsync(5000);
    usePomodoroStore.getState().stop();

    const flushPromise = usePomodoroStore.getState().flushPendingRecords();
    const assertion = expect(flushPromise).rejects.toThrow('inflight failure');
    rejectInflight(new Error('inflight failure'));
    await assertion;
  });
});
