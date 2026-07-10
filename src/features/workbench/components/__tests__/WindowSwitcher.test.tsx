/**
 * O8 WindowSwitcher 测试：会话渲染 / 滑动焦点框定位 / 循环步进 /
 * 失效 id 过滤 / 鼠标悬停与点选 / commit vs cancel 退出动画 /
 * animationend 快路径与超时兜底卸载 / 退出中重开恢复 / 最小化标记 / 缩略卡
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { useWorkbenchOverlay } from '../../core/shortcuts';
import { WindowSwitcher } from '../WindowSwitcher';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string, over?: Partial<AppDefinition>): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span data-testid={`icon-${typeId}`}>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
    ...over,
  };
}

function resetStores() {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
  useWorkbenchOverlay.setState({
    exposeOpen: false,
    switcherOpen: false,
    switcherIds: [],
    switcherIndex: 0,
  });
}

function openWin(typeId: string, instanceKey: string, title = '') {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

function openSession(ids: string[], index: number) {
  act(() => {
    useWorkbenchOverlay.getState().openSwitcher(ids, index);
  });
}

function rootEl(): HTMLElement | null {
  return document.querySelector('[data-wb-switcher-root]');
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('files'));
});

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('会话渲染', () => {
  it('会话未开启时不渲染', () => {
    render(<WindowSwitcher />);
    expect(rootEl()).toBeNull();
  });

  it('按会话快照顺序渲染候选项，选中项 aria-selected + activedescendant', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 1);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].id).toBe(`wb-switcher-item-${b}`);
    expect(options[1].id).toBe(`wb-switcher-item-${a}`);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-activedescendant',
      `wb-switcher-item-${a}`,
    );
  });

  it('显示选中窗口标题与操作提示', () => {
    const a = openWin('chat', 'a', '会话 A');
    render(<WindowSwitcher />);
    openSession([a], 0);

    // 勿用 getByText：a11y announcer 会同文案播报标题
    expect(document.querySelector('.wb-switcher-title')?.textContent).toBe('会话 A');
    expect(screen.getByText('按住 Ctrl 循环选择，松开切换')).toBeInTheDocument();
  });

  it('过滤已关闭窗口的失效 id；全部失效时不渲染', () => {
    const a = openWin('chat', 'a', '会话 A');
    render(<WindowSwitcher />);
    openSession([a, 'gone_1', 'gone_2'], 0);
    expect(screen.getAllByRole('option')).toHaveLength(1);

    act(() => {
      useWorkbenchOverlay.getState().closeSwitcher();
    });
    openSession(['gone_1'], 0);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('最小化窗口带 data-minimized 与指示点', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    act(() => {
      useWindowStore.getState().minimizeWindow(a);
    });
    render(<WindowSwitcher />);
    openSession([b, a], 0);

    const minimized = document.getElementById(`wb-switcher-item-${a}`);
    expect(minimized).toHaveAttribute('data-minimized', 'true');
    expect(screen.getByLabelText('已最小化')).toBeInTheDocument();
    expect(document.getElementById(`wb-switcher-item-${b}`)).not.toHaveAttribute('data-minimized');
  });
});

describe('滑动玻璃焦点框', () => {
  it('焦点框存在且被定位（translate3d 直写 DOM）', () => {
    const a = openWin('chat', 'a', '会话 A');
    render(<WindowSwitcher />);
    openSession([a], 0);

    const frame = screen.getByTestId('wb-switcher-frame');
    expect(frame.style.transform).toContain('translate3d');
  });

  it('循环步进更新选中项，焦点框保持定位', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    const c = openWin('chat', 'c', '会话 C');
    render(<WindowSwitcher />);
    openSession([c, b, a], 1);

    act(() => {
      useWorkbenchOverlay.getState().stepSwitcher(1);
    });
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-activedescendant',
      `wb-switcher-item-${a}`,
    );

    // 回绕：a → c
    act(() => {
      useWorkbenchOverlay.getState().stepSwitcher(1);
    });
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-activedescendant',
      `wb-switcher-item-${c}`,
    );
    expect(screen.getByTestId('wb-switcher-frame').style.transform).toContain('translate3d');
  });

  it('选中窗口被关闭时隐藏焦点框', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 1);

    act(() => {
      useWindowStore.getState().closeWindow(a);
    });
    expect(screen.getByTestId('wb-switcher-frame').style.opacity).toBe('0');
  });
});

describe('鼠标交互', () => {
  it('悬停设置选中索引', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 0);

    fireEvent.mouseEnter(document.getElementById(`wb-switcher-item-${a}`)!);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(1);
  });

  it('点击候选项聚焦该窗口并结束会话（commit 反馈）', () => {
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 0);

    fireEvent.click(document.getElementById(`wb-switcher-item-${a}`)!);

    const state = useWindowStore.getState();
    expect(state.focusStack[state.focusStack.length - 1]).toBe(a);
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(rootEl()).toHaveAttribute('data-phase', 'closing');
    expect(rootEl()).toHaveAttribute('data-commit', 'true');
  });
});

describe('退出动画（commit / cancel）', () => {
  it('松开聚焦（commit）：closing 阶段带 data-commit，超时后卸载', () => {
    vi.useFakeTimers();
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 1);

    // 模拟 useWorkbenchShortcuts.commitSwitcher：先关会话，再聚焦选中窗口
    act(() => {
      useWorkbenchOverlay.getState().closeSwitcher();
      useWindowStore.getState().focusWindow(a);
    });

    expect(rootEl()).toHaveAttribute('data-phase', 'closing');
    expect(rootEl()).toHaveAttribute('data-commit', 'true');
    expect(rootEl()).toHaveAttribute('aria-hidden', 'true');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(rootEl()).toBeNull();
  });

  it('取消（Esc/失焦）：closing 阶段无 data-commit', () => {
    vi.useFakeTimers();
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    // b 为当前焦点栈顶，选中 a 后取消 → 焦点未移动 → cancel
    openSession([b, a], 1);

    act(() => {
      useWorkbenchOverlay.getState().closeSwitcher();
    });

    expect(rootEl()).toHaveAttribute('data-phase', 'closing');
    expect(rootEl()).not.toHaveAttribute('data-commit');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(rootEl()).toBeNull();
  });

  it('animationend 快路径：退出动画结束立即卸载', () => {
    vi.useFakeTimers();
    const a = openWin('chat', 'a', '会话 A');
    render(<WindowSwitcher />);
    openSession([a], 0);

    act(() => {
      useWorkbenchOverlay.getState().closeSwitcher();
    });
    expect(rootEl()).toHaveAttribute('data-phase', 'closing');

    // jsdom 无 AnimationEvent 构造器：手工构造并附加 animationName
    const animEnd = new Event('animationend', { bubbles: true });
    Object.assign(animEnd, { animationName: 'wb-switcher-out' });
    act(() => {
      screen.getByRole('listbox', { hidden: true }).dispatchEvent(animEnd);
    });
    expect(rootEl()).toBeNull();
  });

  it('退出中重开会话立即恢复 live（快速连按）', () => {
    vi.useFakeTimers();
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    render(<WindowSwitcher />);
    openSession([b, a], 1);

    act(() => {
      useWorkbenchOverlay.getState().closeSwitcher();
    });
    expect(rootEl()).toHaveAttribute('data-phase', 'closing');

    openSession([b, a], 1);
    expect(rootEl()).toHaveAttribute('data-phase', 'open');
    expect(rootEl()).not.toHaveAttribute('aria-hidden');

    // 旧退出兜底定时器已清理，不会误卸载 live 会话
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(rootEl()).toHaveAttribute('data-phase', 'open');
  });
});

describe('可选窗口内容缩略', () => {
  it('默认不渲染缩略卡', () => {
    const a = openWin('chat', 'a', '会话 A');
    render(<WindowSwitcher />);
    openSession([a], 0);
    expect(screen.queryByTestId(`wb-switcher-thumb-${a}`)).not.toBeInTheDocument();
  });

  it('thumbnails 开启：渲染按窗口宽高比的迷你窗口卡', () => {
    const a = openWin('chat', 'a', '会话 A');
    act(() => {
      useWindowStore.getState().moveWindow(a, { x: 0, y: 0, w: 800, h: 500 });
    });
    render(<WindowSwitcher thumbnails />);
    openSession([a], 0);

    const thumb = screen.getByTestId(`wb-switcher-thumb-${a}`);
    expect(thumb.style.aspectRatio).toBe('1.6');
    expect(rootEl()).toHaveAttribute('data-thumbs', 'true');
  });
});
