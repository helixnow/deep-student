/**
 * ACR 4.0（A5）— AgentStrip 续放按钮 / 自动中止倒计时 / placementHint 括注
 *
 * stageManager 整体 mock（避免拉起桥 / Tauri 依赖）；presenceStore 用真实 store。
 * i18n mock：t 返回 "key|插值"，断言 key 与插值同时命中。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'seconds' in opts) return `${key}|${String(opts.seconds)}`;
      if (opts && 'label' in opts) return `${key}|${String(opts.label)}`;
      return key;
    },
  }),
}));

vi.mock('@/features/workbench/hooks/useWorkbenchA11y', () => ({
  announceWorkbench: vi.fn(),
}));

const stageManagerMock = vi.hoisted(() => ({
  pauseRun: vi.fn(),
  stopRun: vi.fn(),
  resumeRun: vi.fn(),
  revertRun: vi.fn(async () => true),
  hasReversibleRun: vi.fn(() => false),
  isRunActive: vi.fn(() => false),
}));

vi.mock('../../stageManager', () => ({
  stageManager: stageManagerMock,
}));

import { usePresenceStore } from '../../presenceStore';
import type { PresenceState } from '../../types';
import { AgentStrip } from '../AgentStrip';

const WINDOW_ID = 'w-strip';

function setPresence(over: Partial<PresenceState> = {}): PresenceState {
  const presence: PresenceState = {
    runKey: 'rk-strip',
    runId: 'run-strip',
    sessionId: 'sess-strip',
    windowId: WINDOW_ID,
    typeId: 'note',
    status: 'acting',
    label: '插入段落',
    startedAt: Date.now(),
    ttlMs: 8000,
    ...over,
  };
  act(() => {
    usePresenceStore.getState().setPresence(presence);
  });
  return presence;
}

beforeEach(() => {
  usePresenceStore.getState().clearAll();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  usePresenceStore.getState().clearAll();
});

describe('AgentStrip — 续放按钮（ACR 4.0）', () => {
  it('pausedByUser + resumable → 渲染「继续」，点击调 resumeRun(runKey)', () => {
    setPresence({ status: 'pausedByUser', resumable: true });
    render(<AgentStrip windowId={WINDOW_ID} />);

    const resumeBtn = screen.getByRole('button', { name: 'agent.core.resume' });
    expect(resumeBtn).toBeEnabled();
    // 替换暂停按钮位：不再渲染暂停按钮
    expect(screen.queryByRole('button', { name: 'agent.core.pause' })).toBeNull();

    fireEvent.click(resumeBtn);
    expect(stageManagerMock.resumeRun).toHaveBeenCalledTimes(1);
    expect(stageManagerMock.resumeRun).toHaveBeenCalledWith('rk-strip');
  });

  it('pausedByUser 但不可续放（用户输入暂停）→ 无「继续」，暂停按钮禁用', () => {
    setPresence({ status: 'pausedByUser' });
    render(<AgentStrip windowId={WINDOW_ID} />);

    expect(screen.queryByRole('button', { name: 'agent.core.resume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'agent.core.pause' })).toBeDisabled();
  });

  it('acting 态不渲染「继续」', () => {
    setPresence({ status: 'acting', resumable: true });
    render(<AgentStrip windowId={WINDOW_ID} />);
    expect(screen.queryByRole('button', { name: 'agent.core.resume' })).toBeNull();
  });
});

describe('AgentStrip — 自动中止倒计时（ACR 4.0）', () => {
  it('abortDeadline 存在时逐秒更新；aria-hidden；到期后消失', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    setPresence({
      status: 'pausedByUser',
      resumable: true,
      abortDeadline: Date.now() + 8500,
    });
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);

    const countdown = () =>
      container.querySelector('[data-acr-countdown]') as HTMLElement | null;

    expect(countdown()?.textContent).toBe('agent.core.autoStopCountdown|9');
    expect(countdown()?.getAttribute('aria-hidden')).toBe('true');
    // 倒计时不在 aria-live 区域内（避免逐秒轰炸读屏）
    expect(countdown()?.closest('[aria-live]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdown()?.textContent).toBe('agent.core.autoStopCountdown|8');

    // 越过 deadline：剩余 ≤0 → 不显示（也不显示负数）
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(countdown()).toBeNull();
  });

  it('acting 态（无 abortDeadline 语义）不渲染倒计时', () => {
    setPresence({ status: 'acting', abortDeadline: Date.now() + 5000 });
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);
    expect(container.querySelector('[data-acr-countdown]')).toBeNull();
  });
});

describe('AgentStrip — placementHint 括注（ACR 4.0）', () => {
  it.each([
    ['background', 'agent.core.placementBackground'],
    ['stage-full', 'agent.core.placementStageFull'],
    ['frozen', 'agent.core.placementFrozen'],
  ] as const)('placementHint=%s → 渲染 %s', (hint, key) => {
    setPresence({ placementHint: hint });
    render(<AgentStrip windowId={WINDOW_ID} />);
    const note = screen.getByText(key);
    expect(note).toHaveClass('acr-agent-strip-placement');
    expect(note.getAttribute('data-acr-placement')).toBe(hint);
  });

  it('无 placementHint → 不渲染括注', () => {
    setPresence();
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);
    expect(container.querySelector('.acr-agent-strip-placement')).toBeNull();
  });
});

describe('AgentStrip — reviewing 视觉（ACR 4.0 核对）', () => {
  it('reviewing：空心点样式 + 直接展示数据层 label（无「正在操作」双前缀）', () => {
    setPresence({ status: 'reviewing', label: '等待确认：替换段落' });
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);

    const dot = container.querySelector('.acr-agent-strip-dot');
    expect(dot?.getAttribute('data-state')).toBe('reviewing');
    expect(screen.getByTitle('等待确认：替换段落')).toBeInTheDocument();
    // 不再包一层 operating 文案
    expect(container.textContent).not.toContain('agent.core.operating');
  });

  // A8 裁决：reviewing 通常 run 已结束（仅建议挂起），pauseRun/stopRun 是静默
  // no-op；按 stageManager.isRunActive(runKey) 的 run 活性决定按钮可用性。
  it('reviewing 且 run 已结束（仅建议挂起）→ 暂停/停止禁用，不给假可用按钮', () => {
    stageManagerMock.isRunActive.mockReturnValue(false);
    setPresence({ status: 'reviewing', label: '等待确认：替换段落' });
    render(<AgentStrip windowId={WINDOW_ID} />);

    expect(stageManagerMock.isRunActive).toHaveBeenCalledWith('rk-strip');
    expect(screen.getByRole('button', { name: 'agent.core.pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'agent.core.stop' })).toBeDisabled();
  });

  it('reviewing 且 run 仍活跃 → 暂停/停止可用', () => {
    stageManagerMock.isRunActive.mockReturnValue(true);
    setPresence({ status: 'reviewing', label: '等待确认：替换段落' });
    render(<AgentStrip windowId={WINDOW_ID} />);

    expect(screen.getByRole('button', { name: 'agent.core.pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'agent.core.stop' })).toBeEnabled();
  });
});

describe('AgentStrip — 退场收拢保持（演出优化轮）', () => {
  it('无 presence 时不渲染任何 DOM', () => {
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it('presence 清除 → 条保持渲染并带 data-closing；超时后卸载', () => {
    vi.useFakeTimers();
    setPresence({ status: 'acting' });
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);

    const host = () =>
      container.querySelector('.acr-agent-strip-host') as HTMLElement | null;
    expect(host()).not.toBeNull();
    expect(host()?.hasAttribute('data-closing')).toBe(false);

    act(() => {
      usePresenceStore.getState().clearByRun('rk-strip');
    });
    // 关键：presence 清空的同一次提交条仍在（不先卸载一帧），且进入收拢态
    expect(host()).not.toBeNull();
    expect(host()?.hasAttribute('data-closing')).toBe(true);
    // 收拢期动作全部禁用（run 已结束，交互无意义）
    expect(screen.getByRole('button', { name: 'agent.core.pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'agent.core.stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'agent.core.revert' })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(host()).toBeNull();
  });

  it('收拢期内新 run 开始 → 立即恢复常态（不卸载）', () => {
    vi.useFakeTimers();
    setPresence({ status: 'acting' });
    const { container } = render(<AgentStrip windowId={WINDOW_ID} />);

    act(() => {
      usePresenceStore.getState().clearByRun('rk-strip');
    });
    const host = () =>
      container.querySelector('.acr-agent-strip-host') as HTMLElement | null;
    expect(host()?.hasAttribute('data-closing')).toBe(true);

    setPresence({ status: 'acting', runId: 'run-2', runKey: 'rk-2', label: '新任务' });
    expect(host()?.hasAttribute('data-closing')).toBe(false);
    expect(screen.getByRole('button', { name: 'agent.core.pause' })).toBeEnabled();

    // 旧收拢定时器已清：时间推进后条仍在
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(host()).not.toBeNull();
  });
});
