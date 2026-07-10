/**
 * R1-16 — pomodoroDriver strictMode 分支
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/pomodoro/api', () => ({
  createPomodoroRecord: vi.fn(async () => undefined),
}));

import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { pomodoroDriver } from '../drivers/pomodoroDriver';
import type { AcrRunContext, AgentOp, Pacer, RunLedger } from '../types';
import { ACR_ERROR_CODES } from '../types';

function makeRun(overrides: Partial<AcrRunContext> = {}): AcrRunContext {
  const ledger: RunLedger = {
    record: vi.fn(),
    revertRun: vi.fn(async () => true),
    hasRun: vi.fn(() => false),
    sealRun: vi.fn(),
  };
  const pacing: Pacer = {
    profile: {
      name: 'fast',
      opIntervalMs: 0,
      typeBatchMin: 8,
      typeBatchMax: 40,
      typeIntervalMs: 0,
      instant: true,
    },
    tick: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return {
    runId: 'run-pomo-1',
    sessionId: 'sess-1',
    target: { typeId: 'pomodoro' },
    windowId: 'win-pomo',
    pacing,
    reportProgress: vi.fn(),
    checkPaused: vi.fn(async () => 'resume' as const),
    ledger,
    ...overrides,
  };
}

describe('pomodoroDriver R1-16', () => {
  beforeEach(() => {
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskId: null,
      currentTaskTitle: null,
      sessionStartTime: null,
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: false },
      completedPomodorosToday: 0,
      lastActiveDate: null,
      isImmersive: false,
    });
  });

  it('probe 恒为 clean', () => {
    expect(pomodoroDriver.probe({ typeId: 'pomodoro' })).toBe('clean');
  });

  it('strictMode + work 运行中：pomodoro_pause 进 undone 且 message 带 STRICT_MODE', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 600,
      phaseEndsAt: Date.now() + 600_000,
      phaseStartedAt: null,
      sessionStartTime: new Date().toISOString(),
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: true },
    });

    const op: AgentOp = {
      kind: 'pomodoro_pause',
      destructive: false,
      label: '暂停番茄钟',
      payload: {},
    };
    const receipt = await pomodoroDriver.apply(makeRun(), [op]);

    expect(receipt.applied).toBe(0);
    expect(receipt.undone).toContain('暂停番茄钟');
    expect(receipt.done).toEqual([]);
    expect(receipt.status).toBe('failed');
    expect(receipt.message).toBeTruthy();
    const parsed = JSON.parse(receipt.message!);
    expect(parsed.code).toBe(ACR_ERROR_CODES.STRICT_MODE);
    expect(parsed.hint).toContain('严格模式');
    // store 仍在运行（pause 被拒）
    expect(usePomodoroStore.getState().status).toBe('running');
    expect(usePomodoroStore.getState().mode).toBe('work');
  });

  it('非 strictMode：pomodoro_pause 成功', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 600,
      phaseEndsAt: Date.now() + 600_000,
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: false },
    });

    const receipt = await pomodoroDriver.apply(makeRun(), [
      { kind: 'pomodoro_pause', destructive: false, label: '暂停', payload: {} },
    ]);

    expect(receipt.status).toBe('completed');
    expect(receipt.applied).toBe(1);
    expect(receipt.undone).toEqual([]);
    expect(usePomodoroStore.getState().status).toBe('paused');
  });

  it('records a real inverse only after a reversible pause run completes', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 600,
      phaseEndsAt: Date.now() + 600_000,
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: false },
    });
    const run = makeRun();

    await pomodoroDriver.apply(run, [
      { kind: 'pomodoro_pause', destructive: false, label: 'pause', payload: {} },
    ]);

    expect(run.ledger.record).toHaveBeenCalledTimes(1);
    const invert = vi.mocked(run.ledger.record).mock.calls[0]![1];
    await invert();
    expect(usePomodoroStore.getState().status).toBe('running');
  });

  it('does not expose whole-run undo when start and non-reversible stop are mixed', async () => {
    const run = makeRun();

    const receipt = await pomodoroDriver.apply(run, [
      { kind: 'pomodoro_start', destructive: false, label: 'start', payload: {} },
      { kind: 'pomodoro_stop', destructive: false, label: 'stop', payload: {} },
    ]);

    expect(receipt.status).toBe('completed');
    expect(run.ledger.record).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });


  it('commits the reversible prefix when checkPaused cancels the run', async () => {
    const run = makeRun({
      checkPaused: vi
        .fn()
        .mockResolvedValueOnce('resume')
        .mockResolvedValueOnce('abort'),
    });

    const receipt = await pomodoroDriver.apply(run, [
      { kind: 'pomodoro_start', destructive: false, label: 'start', payload: {} },
      { kind: 'pomodoro_pause', destructive: false, label: 'pause', payload: {} },
    ]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(1);
    expect(run.ledger.record).toHaveBeenCalledTimes(1);

    const invert = vi.mocked(run.ledger.record).mock.calls[0]![1];
    await invert();
    expect(usePomodoroStore.getState().mode).toBe('idle');
  });

  it('commits the reversible prefix when abort(runId) interrupts pacing', async () => {
    let releaseTick!: () => void;
    const tickBlocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const run = makeRun();
    run.pacing.tick = vi.fn(() => tickBlocked);

    const applyPromise = pomodoroDriver.apply(run, [
      { kind: 'pomodoro_start', destructive: false, label: 'start', payload: {} },
    ]);
    await vi.waitFor(() => {
      expect(run.pacing.tick).toHaveBeenCalledTimes(1);
    });

    const abortReceipt = pomodoroDriver.abort(run.runId);
    expect(abortReceipt.status).toBe('cancelled');
    expect(abortReceipt.applied).toBe(1);
    expect(run.ledger.record).toHaveBeenCalledTimes(1);

    releaseTick();
    const applyReceipt = await applyPromise;
    expect(applyReceipt.status).toBe('cancelled');
    expect(run.ledger.record).toHaveBeenCalledTimes(1);
  });

  it('keeps the whole cancelled run non-reversible after an applied stop', async () => {
    const run = makeRun({
      checkPaused: vi
        .fn()
        .mockResolvedValueOnce('resume')
        .mockResolvedValueOnce('resume')
        .mockResolvedValueOnce('abort'),
    });

    const receipt = await pomodoroDriver.apply(run, [
      { kind: 'pomodoro_start', destructive: false, label: 'start', payload: {} },
      { kind: 'pomodoro_stop', destructive: false, label: 'stop', payload: {} },
      { kind: 'pomodoro_start', destructive: false, label: 'later', payload: {} },
    ]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(2);
    expect(run.ledger.record).not.toHaveBeenCalled();
  });

});
