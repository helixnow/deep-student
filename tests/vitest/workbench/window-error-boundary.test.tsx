import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRASH_COOLDOWN_MS,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  WindowErrorBoundary,
} from '@/features/workbench/components/WindowErrorBoundary';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WindowErrorBoundary 单窗崩溃恢复', () => {
  it('子树抛错显示重载卡片，重载后恢复', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    const Crashy: React.FC = () => {
      if (shouldThrow) throw new Error('boom');
      return <div>recovered-content</div>;
    };

    render(
      <WindowErrorBoundary windowId="w1">
        <Crashy />
      </WindowErrorBoundary>,
    );

    const card = screen.getByRole('alert');
    expect(card).toHaveAttribute('data-wb-crash-card');
    expect(card.classList.contains('wb-body-crash')).toBe(true);
    expect(card.querySelector('.wb-body-crash-card.wb-glass')).toBeTruthy();
    expect(card.querySelector('.wb-body-crash-icon')).toBeTruthy();
    expect(card.textContent).toContain('此窗口的应用出错了');
    expect(card.textContent).toContain('boom');

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(screen.getByText('recovered-content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('重载调用 onReset 钩子', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReset = vi.fn();
    let shouldThrow = true;
    const Crashy: React.FC = () => {
      if (shouldThrow) throw new Error('x');
      return <div>ok</div>;
    };
    render(
      <WindowErrorBoundary onReset={onReset}>
        <Crashy />
      </WindowErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('正常子树原样渲染', () => {
    render(
      <WindowErrorBoundary>
        <div>healthy</div>
      </WindowErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('连续崩溃冷却（避免循环重载）', () => {
  /** 挂载即崩的组件 + 冷却卡片查询辅助 */
  function setupCrashLoop() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const gate = { shouldThrow: true };
    const Crashy: React.FC = () => {
      if (gate.shouldThrow) throw new Error('loop-boom');
      return <div>loop-recovered</div>;
    };
    render(
      <WindowErrorBoundary windowId="loop-w">
        <Crashy />
      </WindowErrorBoundary>,
    );
    const reloadButton = () =>
      document.querySelector('.wb-body-crash-reload') as HTMLButtonElement;
    return { gate, reloadButton };
  }

  it('30s 内连续崩溃达阈值：按钮禁用 + 倒计时 + 循环提示；到点自动恢复可重载', () => {
    const { gate, reloadButton } = setupCrashLoop();

    // 崩溃 1 已发生（挂载即崩）；再连点重载补足到阈值
    for (let i = 1; i < CRASH_LOOP_THRESHOLD; i++) {
      expect(reloadButton().disabled).toBe(false);
      fireEvent.click(reloadButton());
    }

    // 达阈值 → 冷却：按钮禁用、倒计时文案、循环提示可见
    const btn = reloadButton();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain(`${Math.ceil(CRASH_COOLDOWN_MS / 1000)} 秒后可重试`);
    expect(document.querySelector('[data-wb-crash-cooldown]')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain('应用连续崩溃');

    // 冷却期内点击（合成事件绕过 disabled 时由 handleReload 双保险拦截）：不重建子树
    fireEvent.click(btn);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // 到点自动恢复（倒计时 500ms 步进刷新）
    act(() => {
      vi.advanceTimersByTime(CRASH_COOLDOWN_MS + 600);
    });
    const recoveredBtn = reloadButton();
    expect(recoveredBtn.disabled).toBe(false);
    expect(document.querySelector('[data-wb-crash-cooldown]')).toBeNull();
    expect(recoveredBtn.textContent).toContain('重新加载');

    // 应用修好后重载成功
    gate.shouldThrow = false;
    fireEvent.click(recoveredBtn);
    expect(screen.getByText('loop-recovered')).toBeInTheDocument();
  });

  it('崩溃间隔超过 30s 窗口：连击计数重置，不进入冷却', () => {
    const { reloadButton } = setupCrashLoop();

    // 每次崩溃间隔拉开到窗口之外 → 连击数始终为 1
    for (let i = 1; i < CRASH_LOOP_THRESHOLD; i++) {
      act(() => {
        vi.advanceTimersByTime(CRASH_LOOP_WINDOW_MS + 1_000);
      });
      fireEvent.click(reloadButton());
    }

    expect(reloadButton().disabled).toBe(false);
    expect(document.querySelector('[data-wb-crash-cooldown]')).toBeNull();
  });
});
