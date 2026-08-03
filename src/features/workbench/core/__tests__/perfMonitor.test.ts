/**
 * O10 — perfMonitor 单测
 * 覆盖：纯帧聚合（掉帧/长任务/自适应基线）、开关模型（开发期开关）、
 * 订阅推送（生命周期分布 + 调度器记录）、getLastPerfSample 回填。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LONG_TASK_THRESHOLD_MS,
  SLOW_FRAME_DEGRADE_STREAK,
  SLOW_FRAME_MS,
  advanceSlowFrameStreak,
  getLastPerfSample,
  isPerfMonitorRunning,
  recordSchedulerSample,
  resetPerfMonitorForTests,
  acquirePerfMonitor,
  startPerfMonitor,
  stopPerfMonitor,
  subscribePerfDegrade,
  subscribePerfMonitor,
  summarizeFrameDeltas,
  type PerfSample,
} from '../perfMonitor';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { registerTestApp } from './testUtils';

registerTestApp('perf-app', { memoryWeight: 1 });

function store() {
  return useWindowStore.getState();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1600, h: 900 });
  resetPerfMonitorForTests();
});

afterEach(() => {
  resetPerfMonitorForTests();
});

describe('summarizeFrameDeltas — 纯帧聚合', () => {
  it('空样本 → 全零', () => {
    expect(summarizeFrameDeltas([])).toEqual({
      sampledFrames: 0,
      avgFrameMs: 0,
      maxFrameMs: 0,
      fps: 0,
      droppedFrames: 0,
      longTasks: 0,
      longTaskTotalMs: 0,
    });
  });

  it('均匀 16ms 帧：无掉帧、无长任务、fps≈63', () => {
    const stats = summarizeFrameDeltas([16, 16, 16, 16]);
    expect(stats.sampledFrames).toBe(4);
    expect(stats.avgFrameMs).toBe(16);
    expect(stats.maxFrameMs).toBe(16);
    expect(stats.fps).toBe(63);
    expect(stats.droppedFrames).toBe(0);
    expect(stats.longTasks).toBe(0);
  });

  it('孤立 60ms 帧：计为掉帧 + 回退长任务', () => {
    const stats = summarizeFrameDeltas([16, 16, 60, 16, 16]);
    expect(stats.droppedFrames).toBe(1);
    expect(stats.longTasks).toBe(1);
    expect(stats.longTaskTotalMs).toBeGreaterThan(0);
    expect(stats.maxFrameMs).toBe(60);
  });

  it('高刷屏（7ms 基线）下 18ms 帧算掉帧但不算长任务（自适应基线）', () => {
    const stats = summarizeFrameDeltas([7, 7, 7, 18, 7]);
    expect(stats.droppedFrames).toBe(1);
    expect(stats.longTasks).toBe(0);
    expect(18).toBeLessThan(LONG_TASK_THRESHOLD_MS);
  });
});

describe('perfMonitor — 开关与订阅', () => {
  it('未启动时不推送样本；recordSchedulerSample 仅记录', async () => {
    const samples: PerfSample[] = [];
    const unsubscribe = subscribePerfMonitor((sample) => samples.push(sample));
    recordSchedulerSample({
      recomputeMs: 1.2,
      occlusionMode: 'incremental',
      occlusionDirtyCount: 1,
      occlusionWindowCount: 3,
      usedWeight: 5,
      budget: 12,
      frozenCount: 0,
      pendingFreezeCount: 0,
    });
    await sleep(80);
    expect(isPerfMonitorRunning()).toBe(false);
    expect(samples).toHaveLength(0);
    expect(getLastPerfSample()).toBeNull();
    unsubscribe();
  });

  it('启动后按 interval 推送：帧统计 + 生命周期分布 + 调度器/内存记录', async () => {
    const a = store().openWindow({
      typeId: 'perf-app',
      initialFrame: { x: 0, y: 0, w: 300, h: 300 },
    });
    const b = store().openWindow({
      typeId: 'perf-app',
      initialFrame: { x: 400, y: 0, w: 300, h: 300 },
    });
    store().setLifecycles({ [a]: 'visible', [b]: 'focused' });
    recordSchedulerSample({
      recomputeMs: 0.8,
      occlusionMode: 'incremental',
      occlusionDirtyCount: 2,
      occlusionWindowCount: 2,
      usedWeight: 2,
      budget: 12,
      frozenCount: 0,
      pendingFreezeCount: 1,
    });

    const samples: PerfSample[] = [];
    const unsubscribe = subscribePerfMonitor((sample) => samples.push(sample));
    const stop = startPerfMonitor({ intervalMs: 60 });
    expect(isPerfMonitorRunning()).toBe(true);

    await sleep(300);
    stop();
    unsubscribe();

    expect(samples.length).toBeGreaterThan(0);
    const sample = samples[samples.length - 1];
    expect(sample.frame.sampledFrames).toBeGreaterThan(0);
    expect(sample.frame.avgFrameMs).toBeGreaterThan(0);
    expect(sample.lifecycle.totalWindows).toBe(2);
    expect(sample.lifecycle.counts.focused).toBe(1);
    expect(sample.lifecycle.counts.visible).toBe(1);
    expect(sample.memory).toEqual({
      usedWeight: 2,
      budget: 12,
      overBudget: false,
      frozenCount: 0,
      pendingFreezeCount: 1,
    });
    expect(sample.scheduler.recomputeCount).toBe(1);
    expect(sample.scheduler.lastOcclusionMode).toBe('incremental');
    expect(getLastPerfSample()).toBe(sample);
  });

  it('stop 后不再推送；重复 start 幂等', async () => {
    const samples: PerfSample[] = [];
    const unsubscribe = subscribePerfMonitor((sample) => samples.push(sample));
    startPerfMonitor({ intervalMs: 60 });
    const stopAgain = startPerfMonitor(); // 幂等：不重复启动
    await sleep(200);
    stopAgain();
    expect(isPerfMonitorRunning()).toBe(false);

    const seen = samples.length;
    expect(seen).toBeGreaterThan(0);
    await sleep(150);
    expect(samples.length).toBe(seen);
    unsubscribe();
  });

  it('acquirePerfMonitor：多持有者共享；最后一个 release 才 stop', async () => {
    const releaseA = acquirePerfMonitor({ intervalMs: 60 });
    const releaseB = acquirePerfMonitor({ intervalMs: 60 });
    expect(isPerfMonitorRunning()).toBe(true);

    releaseA();
    await sleep(40);
    expect(isPerfMonitorRunning()).toBe(true);

    releaseB();
    expect(isPerfMonitorRunning()).toBe(false);
  });

  it('订阅方异常不拖垮采集循环', async () => {
    const good: PerfSample[] = [];
    const unsubBad = subscribePerfMonitor(() => {
      throw new Error('boom');
    });
    const unsubGood = subscribePerfMonitor((sample) => good.push(sample));
    startPerfMonitor({ intervalMs: 60 });
    await sleep(200);
    stopPerfMonitor();
    expect(good.length).toBeGreaterThan(0);
    unsubBad();
    unsubGood();
  });
});

describe('perfMonitor — ACR 慢帧降级钩子', () => {
  it('advanceSlowFrameStreak：连续慢帧达阈值触发一次；恢复后可再触发', () => {
    const state = { consecutive: 0, notified: false };

    let r = advanceSlowFrameStreak(state, 16);
    expect(r.shouldNotify).toBe(false);
    expect(r.state.consecutive).toBe(0);

    r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 1);
    expect(r.shouldNotify).toBe(false);
    expect(r.state.consecutive).toBe(1);

    r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 1);
    expect(r.shouldNotify).toBe(false);
    expect(r.state.consecutive).toBe(2);

    r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 1);
    expect(r.shouldNotify).toBe(true);
    expect(r.state.consecutive).toBe(SLOW_FRAME_DEGRADE_STREAK);
    expect(r.state.notified).toBe(true);

    // 同 streak 不重复
    r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 5);
    expect(r.shouldNotify).toBe(false);
    expect(r.state.notified).toBe(true);

    // 快帧恢复
    r = advanceSlowFrameStreak(r.state, 16);
    expect(r.state).toEqual({ consecutive: 0, notified: false });

    // 再攒满可再触发
    for (let i = 0; i < SLOW_FRAME_DEGRADE_STREAK - 1; i++) {
      r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 1);
      expect(r.shouldNotify).toBe(false);
    }
    r = advanceSlowFrameStreak(r.state, SLOW_FRAME_MS + 1);
    expect(r.shouldNotify).toBe(true);
  });

  it('subscribePerfDegrade 可订阅/退订；未启动时不触发', () => {
    const events: unknown[] = [];
    const unsub = subscribePerfDegrade((info) => events.push(info));
    expect(isPerfMonitorRunning()).toBe(false);
    expect(events).toHaveLength(0);
    unsub();
  });
});
