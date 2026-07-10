/**
 * O19 无障碍 hook 测试：窗口 aria 生成器 / aria-live 公告双缓冲 /
 * roving tabindex / 焦点归还 / 系统偏好订阅
 */
import React, { useRef } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, renderHook, fireEvent } from '@testing-library/react';
import {
  getWindowA11yProps,
  announceWorkbench,
  useWorkbenchAnnouncer,
  disposeWorkbenchAnnouncerForTests,
  useRovingFocus,
  useFocusReturn,
  useHighContrast,
  usePrefersReducedMotion,
} from '../useWorkbenchA11y';

afterEach(() => {
  disposeWorkbenchAnnouncerForTests();
});

// ============================================================================
// getWindowA11yProps
// ============================================================================

describe('getWindowA11yProps', () => {
  it('标题 + 应用名拼合 aria-label，非模态 dialog，可编程聚焦', () => {
    const props = getWindowA11yProps({
      title: '高数笔记',
      appName: '笔记',
      roleDescription: '窗口',
    });
    expect(props.role).toBe('dialog');
    expect(props['aria-label']).toBe('高数笔记 — 笔记');
    expect(props['aria-roledescription']).toBe('窗口');
    expect(props.tabIndex).toBe(-1);
    expect(props['aria-modal' as keyof typeof props]).toBeUndefined();
    expect(props['aria-hidden']).toBeUndefined();
  });

  it('空标题回退应用名；标题与应用名相同不重复', () => {
    expect(getWindowA11yProps({ title: '', appName: '设置' })['aria-label']).toBe('设置');
    expect(getWindowA11yProps({ title: '设置', appName: '设置' })['aria-label']).toBe('设置');
  });

  it('最小化窗口对 AT 隐藏', () => {
    expect(getWindowA11yProps({ title: 'x', minimized: true })['aria-hidden']).toBe(true);
  });
});

// ============================================================================
// 公告
// ============================================================================

describe('announceWorkbench / useWorkbenchAnnouncer', () => {
  function politeTexts(): string[] {
    const root = document.getElementById('wb-a11y-announcer');
    if (!root) return [];
    return Array.from(root.querySelectorAll('[aria-live="polite"]')).map(
      (el) => el.textContent ?? '',
    );
  }

  it('公告写入 aria-live 区，双缓冲让相同文案也能重播', () => {
    announceWorkbench('窗口已平铺至左侧');
    expect(politeTexts()).toContain('窗口已平铺至左侧');

    const firstBuffers = politeTexts();
    announceWorkbench('窗口已平铺至左侧');
    const secondBuffers = politeTexts();
    // 写入位置交替（另一个缓冲承载新消息，旧缓冲被清空）
    expect(secondBuffers).toContain('窗口已平铺至左侧');
    expect(secondBuffers).not.toEqual(firstBuffers);
  });

  it('assertive 通道使用 role=alert', () => {
    announceWorkbench('应用崩溃', 'assertive');
    const root = document.getElementById('wb-a11y-announcer')!;
    const alerts = Array.from(root.querySelectorAll('[aria-live="assertive"]'));
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((el) => el.getAttribute('role') === 'alert')).toBe(true);
    expect(alerts.some((el) => el.textContent === '应用崩溃')).toBe(true);
  });

  it('hook 引用计数：最后一个消费者卸载时移除 live region', () => {
    const a = renderHook(() => useWorkbenchAnnouncer());
    const b = renderHook(() => useWorkbenchAnnouncer());
    expect(document.getElementById('wb-a11y-announcer')).not.toBeNull();

    a.result.current.announce('测试');
    expect(politeTexts()).toContain('测试');

    a.unmount();
    expect(document.getElementById('wb-a11y-announcer')).not.toBeNull();
    b.unmount();
    expect(document.getElementById('wb-a11y-announcer')).toBeNull();
  });
});

// ============================================================================
// roving tabindex
// ============================================================================

const RovingDemo: React.FC<{ orientation?: 'horizontal' | 'vertical' | 'both' }> = ({
  orientation,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useRovingFocus({ container: ref, orientation });
  return (
    <div ref={ref} data-testid="group">
      <button data-wb-roving>一</button>
      <button data-wb-roving>二</button>
      <button data-wb-roving>三</button>
    </div>
  );
};

describe('useRovingFocus', () => {
  it('初始仅首项可 Tab 达；方向键巡航并回卷', () => {
    const { getAllByRole, getByTestId } = render(<RovingDemo orientation="horizontal" />);
    const [first, second, third] = getAllByRole('button');
    const group = getByTestId('group');

    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    expect(third.tabIndex).toBe(-1);

    first.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    // 回卷：末项 → 首项
    third.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(group, { key: 'End' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('horizontal 轴向不响应 ↑/↓', () => {
    const { getAllByRole, getByTestId } = render(<RovingDemo orientation="horizontal" />);
    const [first] = getAllByRole('button');
    first.focus();
    fireEvent.keyDown(getByTestId('group'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  it('焦点进入某项时同步 tabindex（鼠标点击 / 外部聚焦）', () => {
    const { getAllByRole } = render(<RovingDemo />);
    const [first, second] = getAllByRole('button');
    fireEvent.focusIn(second);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
  });
});

// ============================================================================
// 焦点归还
// ============================================================================

describe('useFocusReturn', () => {
  it('浮层关闭时焦点归还给打开前的元素', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderHook(({ active }) => useFocusReturn(active), {
      initialProps: { active: false },
    });

    rerender({ active: true });
    const inside = document.createElement('button');
    document.body.appendChild(inside);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    rerender({ active: false });
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
    inside.remove();
  });

  it('浮层激活期间卸载也归还焦点；原元素已移除则放弃', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const first = renderHook(({ active }) => useFocusReturn(active), {
      initialProps: { active: false },
    });
    first.rerender({ active: true });
    first.unmount();
    expect(document.activeElement).toBe(trigger);

    // 原元素被移除的场景不抛错
    const second = renderHook(({ active }) => useFocusReturn(active), {
      initialProps: { active: true },
    });
    trigger.remove();
    expect(() => second.rerender({ active: false })).not.toThrow();
  });

  it('skipNextReturn 后关闭不归还打开前焦点', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { result, rerender } = renderHook(({ active }) => useFocusReturn(active), {
      initialProps: { active: false },
    });

    rerender({ active: true });
    const inside = document.createElement('button');
    document.body.appendChild(inside);
    inside.focus();

    const shell = document.createElement('div');
    shell.tabIndex = -1;
    document.body.appendChild(shell);

    result.current.skipNextReturn();
    rerender({ active: false });
    shell.focus();

    expect(document.activeElement).toBe(shell);
    expect(document.activeElement).not.toBe(trigger);

    trigger.remove();
    inside.remove();
    shell.remove();
  });
});

// ============================================================================
// 系统偏好
// ============================================================================

describe('useHighContrast / usePrefersReducedMotion', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function mockMatchMedia(matching: string[]): void {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matching.includes(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  it('默认（无偏好）均为 false', () => {
    expect(renderHook(() => useHighContrast()).result.current).toBe(false);
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(false);
  });

  it('forced-colors 或 prefers-contrast 命中 → 高对比 true', () => {
    mockMatchMedia(['(forced-colors: active)']);
    expect(renderHook(() => useHighContrast()).result.current).toBe(true);

    mockMatchMedia(['(prefers-contrast: more)']);
    expect(renderHook(() => useHighContrast()).result.current).toBe(true);
  });

  it('prefers-reduced-motion 命中 → true', () => {
    mockMatchMedia(['(prefers-reduced-motion: reduce)']);
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(true);
  });
});
