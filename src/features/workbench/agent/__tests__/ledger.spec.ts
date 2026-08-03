/**
 * R1-19 — Run Ledger 规格测试（types.ts RunLedger + DESIGN §2.4）
 *
 * record / 逆序 revert / 幂等二次 revert / hasRun / sealRun 后仍可 revert。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRunLedgerForTests, runLedger } from '../ledger';

describe('ACR ledger — RunLedger 契约', () => {
  beforeEach(() => {
    resetRunLedgerForTests();
  });

  afterEach(() => {
    resetRunLedgerForTests();
  });

  it('record 后 hasRun 为 true；未知 run 为 false', () => {
    expect(runLedger.hasRun('run-a')).toBe(false);
    runLedger.record('run-a', () => {}, 'step-1');
    expect(runLedger.hasRun('run-a')).toBe(true);
    expect(runLedger.hasRun('run-missing')).toBe(false);
  });

  it('revertRun 逆序执行 invert', async () => {
    const order: string[] = [];
    runLedger.record('run-b', () => {
      order.push('a');
    }, 'a');
    runLedger.record('run-b', () => {
      order.push('b');
    }, 'b');
    runLedger.record('run-b', async () => {
      order.push('c');
    }, 'c');

    const ok = await runLedger.revertRun('run-b');
    expect(ok).toBe(true);
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('二次 revert 幂等返回 false', async () => {
    runLedger.record('run-c', () => {}, 'x');
    expect(await runLedger.revertRun('run-c')).toBe(true);
    expect(await runLedger.revertRun('run-c')).toBe(false);
    expect(runLedger.hasRun('run-c')).toBe(false);
  });

  it('sealRun 后仍可 revert', async () => {
    const calls: string[] = [];
    runLedger.record('run-d', () => {
      calls.push('inv');
    }, 'sealed-step');
    runLedger.sealRun('run-d');
    expect(runLedger.hasRun('run-d')).toBe(true);

    const ok = await runLedger.revertRun('run-d');
    expect(ok).toBe(true);
    expect(calls).toEqual(['inv']);
    expect(runLedger.hasRun('run-d')).toBe(false);
  });

  it('空 / 未知 run 的 revert 返回 false', async () => {
    expect(await runLedger.revertRun('never')).toBe(false);
  });

  it('invert 失败时停止回滚并保留未完成条目供重试', async () => {
    const order: string[] = [];
    let failOnce = true;
    runLedger.record('run-e', () => {
      order.push('first');
    }, 'first');
    runLedger.record('run-e', () => {
      order.push('retryable');
      if (failOnce) {
        failOnce = false;
        throw new Error('boom');
      }
    }, 'retryable');
    runLedger.record('run-e', () => {
      order.push('last');
    }, 'last');

    expect(await runLedger.revertRun('run-e')).toBe(false);
    expect(order).toEqual(['last', 'retryable']);
    expect(runLedger.hasRun('run-e')).toBe(true);

    expect(await runLedger.revertRun('run-e')).toBe(true);
    expect(order).toEqual(['last', 'retryable', 'retryable', 'first']);
    expect(runLedger.hasRun('run-e')).toBe(false);
  });

  it('sealRun 后拒绝迟到 record，不扩大已冻结的撤销范围', async () => {
    const calls: string[] = [];
    runLedger.record('run-late', () => {
      calls.push('before-seal');
    }, 'before-seal');
    runLedger.sealRun('run-late');
    runLedger.record('run-late', () => {
      calls.push('late');
    }, 'late');

    expect(await runLedger.revertRun('run-late')).toBe(true);
    expect(calls).toEqual(['before-seal']);
  });

  it('seal 超过 20 个 run 时按 LRU 淘汰最旧', async () => {
    for (let i = 0; i < 21; i++) {
      const id = `lru-${i}`;
      runLedger.record(id, () => {}, `step-${i}`);
      runLedger.sealRun(id);
    }
    // 最旧 lru-0 应被淘汰
    expect(runLedger.hasRun('lru-0')).toBe(false);
    expect(await runLedger.revertRun('lru-0')).toBe(false);
    // 最新仍在
    expect(runLedger.hasRun('lru-20')).toBe(true);
    expect(runLedger.hasRun('lru-1')).toBe(true);
  });

  it('未 seal 的活跃 run 不受 sealed LRU 淘汰', () => {
    runLedger.record('active-keep', () => {}, 'live');
    for (let i = 0; i < 21; i++) {
      const id = `sealed-${i}`;
      runLedger.record(id, () => {}, `s-${i}`);
      runLedger.sealRun(id);
    }
    expect(runLedger.hasRun('active-keep')).toBe(true);
  });

  it('并发 revert 共享同一 flight，inverse 只执行一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    runLedger.record('single-flight', async () => {
      calls += 1;
      await gate;
    }, 'once');
    const first = runLedger.revertRun('single-flight');
    const second = runLedger.revertRun('single-flight');
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(calls).toBe(1);
    expect(await runLedger.revertRun('single-flight')).toBe(false);
  });

  it('成功后的 tombstone 拒绝迟到 record 复活旧 run', async () => {
    const calls: string[] = [];
    runLedger.record('tombstone', () => { calls.push('first'); }, 'first');
    expect(await runLedger.revertRun('tombstone')).toBe(true);
    runLedger.record('tombstone', () => { calls.push('late'); }, 'late');
    expect(runLedger.hasRun('tombstone')).toBe(false);
    expect(await runLedger.revertRun('tombstone')).toBe(false);
    expect(calls).toEqual(['first']);
  });
});
