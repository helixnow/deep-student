/**
 * R1-19 — 仲裁状态机规格测试（DESIGN §4.1）
 *
 * 以 types.ts / DESIGN 行为为准；覆盖 acting→paused→resume/abort 全路径。
 * 假 timer：2s 无输入续放、持续输入不续跑、15s abort、显式 stop。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArbitrator } from '../arbitration';

describe('ACR arbitration — DESIGN §4.1', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acting 中 onUserInput → paused；checkPaused 挂起', async () => {
    const onPauseChange = vi.fn();
    const arb = createArbitrator({ onPauseChange });

    expect(arb.paused).toBe(false);
    const immediate = await arb.checkPaused();
    expect(immediate).toBe('resume');

    arb.onUserInput();
    expect(arb.paused).toBe(true);
    expect(onPauseChange).toHaveBeenCalledWith(true);

    let settled: 'resume' | 'abort' | null = null;
    const p = arb.checkPaused().then((d) => {
      settled = d;
      return d;
    });
    // 尚未到 2s：仍挂起
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('resume');
    expect(arb.paused).toBe(false);
    arb.dispose();
  });

  it('2s 无输入 → resume', async () => {
    const arb = createArbitrator({});
    arb.onUserInput();
    const p = arb.checkPaused();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe('resume');
    expect(arb.paused).toBe(false);
    arb.dispose();
  });

  it('持续输入不续跑（每次输入重置 2s 空闲窗）', async () => {
    const arb = createArbitrator({});
    arb.onUserInput();
    const p = arb.checkPaused();

    // 每隔 1.5s 再输入一次，共 3 次 → 始终未满 2s 空闲
    await vi.advanceTimersByTimeAsync(1500);
    arb.onUserInput();
    await vi.advanceTimersByTimeAsync(1500);
    arb.onUserInput();
    await vi.advanceTimersByTimeAsync(1500);
    arb.onUserInput();

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    expect(arb.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('resume');
    arb.dispose();
  });

  it('15s 仍活跃 → abort（持续输入不重置 15s 时钟）', async () => {
    const arb = createArbitrator({});
    arb.onUserInput();
    const p = arb.checkPaused();

    // 每 1s 输入一次，撑满 15s
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      arb.onUserInput();
    }
    // 再推进到首次 pause 起满 15s
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('abort');
    expect(arb.paused).toBe(false);
    arb.dispose();
  });

  it('显式 stop → abort', async () => {
    const arb = createArbitrator({});
    arb.onUserInput();
    const p = arb.checkPaused();
    arb.stop();
    await expect(p).resolves.toBe('abort');
    expect(arb.paused).toBe(false);
    arb.dispose();
  });

  it('checkPaused 在非 paused 时立即 resume', async () => {
    const arb = createArbitrator({});
    await expect(arb.checkPaused()).resolves.toBe('resume');
    // 续放后再调仍立即 resume
    arb.onUserInput();
    const p = arb.checkPaused();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe('resume');
    await expect(arb.checkPaused()).resolves.toBe('resume');
    arb.dispose();
  });

  it('显式 pause 不启动 2s 自动续放，仍受 15s abort', async () => {
    const arb = createArbitrator({});
    arb.pause();
    expect(arb.paused).toBe(true);
    const p = arb.checkPaused();

    await vi.advanceTimersByTimeAsync(2000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    // flush microtasks
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(13000);
    await expect(p).resolves.toBe('abort');
    arb.dispose();
  });

  it('R3-01：显式 pause 后 resume() 立即续放', async () => {
    const onPauseChange = vi.fn();
    const arb = createArbitrator({ onPauseChange });
    arb.pause();
    const p = arb.checkPaused();
    await vi.advanceTimersByTimeAsync(500);
    arb.resume();
    await expect(p).resolves.toBe('resume');
    expect(arb.paused).toBe(false);
    expect(onPauseChange).toHaveBeenCalledWith(false);
    arb.dispose();
  });

  it('显式 pause 后的用户输入不会降级为 2s 自动续放', async () => {
    const arb = createArbitrator({});
    arb.pause();
    const pending = arb.checkPaused();
    arb.onUserInput();
    await vi.advanceTimersByTimeAsync(2000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    arb.resume();
    await expect(pending).resolves.toBe('resume');
    arb.dispose();
  });
});
