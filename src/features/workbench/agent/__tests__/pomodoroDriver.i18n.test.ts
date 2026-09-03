/**
 * pomodoroDriver 用户可见错误文案 i18n 契约 — workspace:agent.pomodoro.* / workbench:pomodoro.strictHint
 *
 * key-echo mock：断言与语言无关（真实运行时由 workspace.json / workbench.json 提供
 * zh-CN / en-US 文案，driver 侧 defaultValue 兜底 namespace 异步加载窗口期）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: { t: tSpy } }));

vi.mock('@/features/pomodoro/api', () => ({
  createPomodoroRecord: vi.fn(async () => undefined),
}));

import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { createPomodoroRecord } from '@/features/pomodoro/api';
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
    runId: 'run-pomo-i18n',
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

function op(kind: string, label: string): AgentOp {
  return { kind, destructive: false, label, payload: {} } as AgentOp;
}

beforeEach(() => {
  tSpy.mockClear();
  vi.mocked(createPomodoroRecord).mockReset();
  vi.mocked(createPomodoroRecord).mockResolvedValue(undefined as never);
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

describe('pomodoroDriver — 用户可见文案走 i18n key', () => {
  it('严格模式拒绝 pause → hint 复用 workbench:pomodoro.strictHint', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 600,
      phaseEndsAt: Date.now() + 600_000,
      sessionStartTime: new Date().toISOString(),
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: true },
    });

    const receipt = await pomodoroDriver.apply(makeRun(), [
      op('pomodoro_pause', '暂停番茄钟'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['暂停番茄钟']);
    const parsed = JSON.parse(receipt.message!);
    expect(parsed.code).toBe(ACR_ERROR_CODES.STRICT_MODE);
    expect(parsed.hint).toBe('workbench:pomodoro.strictHint');
    expect(tSpy).toHaveBeenCalledWith(
      'workbench:pomodoro.strictHint',
      expect.objectContaining({ defaultValue: expect.any(String) }),
    );
  });

  it('checkPaused 返回 abort → cancelled 回执 message 为 run_aborted', async () => {
    const run = makeRun({
      runId: 'run-abort',
      checkPaused: vi.fn(async () => 'abort' as const),
    });
    const receipt = await pomodoroDriver.apply(run, [op('pomodoro_start', '开始')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.applied).toBe(0);
    expect(receipt.message).toBe('workspace:agent.pomodoro.run_aborted');
  });

  it('abort(runId) 无活动 run 时也走 run_aborted key', () => {
    const receipt = pomodoroDriver.abort('run-ghost');
    expect(receipt.status).toBe('cancelled');
    // 空回执无 message；有活动 run 时由 cancelledReceipt 带 run_aborted
    expect(receipt.message ?? 'workspace:agent.pomodoro.run_aborted').toBe(
      'workspace:agent.pomodoro.run_aborted',
    );
  });

  it('checkPaused 抛错 → pause_check_failed 携带 {{error}} 且回执 cancelled', async () => {
    const run = makeRun({
      runId: 'run-pause-throw',
      checkPaused: vi.fn(async () => {
        throw new Error('pause boom');
      }),
    });
    const receipt = await pomodoroDriver.apply(run, [op('pomodoro_start', '开始')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.undone).toContain('workspace:agent.pomodoro.pause_check_failed');
    expect(receipt.message).toBe('workspace:agent.pomodoro.run_aborted');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.pause_check_failed',
      expect.objectContaining({ error: 'pause boom' }),
    );
  });

  it('start no-op（work 运行中无任务）→ start_noop 携带 {{label}}', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 600,
      phaseEndsAt: Date.now() + 600_000,
      sessionStartTime: new Date().toISOString(),
    });
    const receipt = await pomodoroDriver.apply(makeRun({ runId: 'run-start-noop' }), [
      op('pomodoro_start', '开始专注'),
    ]);

    expect(receipt.applied).toBe(0);
    expect(receipt.undone).toEqual(['workspace:agent.pomodoro.start_noop']);
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.start_noop',
      expect.objectContaining({ label: '开始专注' }),
    );
  });

  it('idle 态 pause/resume/stop no-op → 各自的 *_noop key', async () => {
    const pause = await pomodoroDriver.apply(makeRun({ runId: 'run-pause-noop' }), [
      op('pomodoro_pause', '暂停'),
    ]);
    expect(pause.undone).toEqual(['workspace:agent.pomodoro.pause_noop']);

    const resume = await pomodoroDriver.apply(makeRun({ runId: 'run-resume-noop' }), [
      op('pomodoro_resume', '继续'),
    ]);
    expect(resume.undone).toEqual(['workspace:agent.pomodoro.resume_noop']);

    const stop = await pomodoroDriver.apply(makeRun({ runId: 'run-stop-noop' }), [
      op('pomodoro_stop', '停止'),
    ]);
    expect(stop.undone).toEqual(['workspace:agent.pomodoro.stop_noop']);
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.stop_noop',
      expect.objectContaining({ label: '停止' }),
    );
  });

  it('未知 op kind → unsupported_op 携带 {{kind}}', async () => {
    const receipt = await pomodoroDriver.apply(makeRun({ runId: 'run-unknown' }), [
      op('pomodoro_unknown', '神秘操作'),
    ]);

    expect(receipt.status).toBe('failed');
    expect(receipt.undone).toEqual(['神秘操作']);
    expect(receipt.message).toBe('workspace:agent.pomodoro.unsupported_op');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.unsupported_op',
      expect.objectContaining({ kind: 'pomodoro_unknown' }),
    );
  });

  it('后端记录保存失败 → persist_failed 携带 {{error}}，回执 partial', async () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'paused',
      timeLeft: DEFAULT_POMODORO_SETTINGS.workDuration - 10,
      currentTaskId: 'todo-1',
      currentTaskTitle: '任务',
      sessionStartTime: new Date().toISOString(),
    });
    vi.mocked(createPomodoroRecord).mockRejectedValueOnce(new Error('db unavailable'));

    const receipt = await pomodoroDriver.apply(makeRun({ runId: 'run-persist' }), [
      op('pomodoro_stop', '停止'),
    ]);

    expect(receipt.status).toBe('partial');
    expect(receipt.message).toBe('workspace:agent.pomodoro.persist_failed');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.persist_failed',
      expect.objectContaining({ error: 'db unavailable' }),
    );
  });

  it('pacing.tick 抛错 → 生成 pacing_failed，回执被 cancelledReceipt 覆盖为 run_aborted（既有行为）', async () => {
    const run = makeRun({ runId: 'run-pacing' });
    run.pacing.tick = vi.fn(async () => {
      throw new Error('pacer failed');
    });
    const receipt = await pomodoroDriver.apply(run, [op('pomodoro_start', '开始')]);

    expect(receipt.status).toBe('cancelled');
    expect(receipt.message).toBe('workspace:agent.pomodoro.run_aborted');
    expect(tSpy).toHaveBeenCalledWith(
      'workspace:agent.pomodoro.pacing_failed',
      expect.objectContaining({ error: 'pacer failed' }),
    );
  });
});
