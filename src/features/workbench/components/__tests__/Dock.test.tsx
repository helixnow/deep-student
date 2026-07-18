/**
 * P5 Dock 测试：三分支点击 / 多实例弹层 / 右键菜单固定切换与关闭全部 /
 * badge / 运行指示点 / roving tabindex 键盘 / autohide / 分区排序
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { Dock } from '../Dock';
import { getDockPinned, setDockPinned } from '../DockPinnedStore';
import { closeAppsPanel, isAppsPanelOpen } from '../appsPanelStore';
import { resetMaterialTierForTests, setMaterialTier } from '../../core/materialTier';
import { AGENT_CONTROL_DISCOVERY_SEEN_KEY } from '../AgentControlCenter';

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

function resetStore() {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
}

function openWin(typeId: string, instanceKey: string, title = '') {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

function windowsOf(typeId: string) {
  return Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === typeId);
}

/** Dock 图标按钮（不依赖会随 running/badge 变化的 aria-label） */
function dockButton(typeId: string): HTMLButtonElement {
  const wrap = screen.getByTestId(`wb-dock-item-${typeId}`);
  const button = wrap.querySelector('button');
  if (!button) throw new Error(`Dock button missing for ${typeId}`);
  return button;
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  workbenchBus.setEnabled(true);
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('files', { instanceMode: 'single' }));
});

beforeEach(() => {
  resetStore();
  setDockPinned([]);
  closeAppsPanel();
  localStorage.removeItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Dock 三分支点击', () => {
  it('applies and clamps the configured Dock size', () => {
    const { rerender } = render(<Dock size={120} />);
    const dock = screen.getByTestId('wb-dock');
    expect(dock).toHaveAttribute('data-size', '120');
    expect(dock.style.getPropertyValue('--wb-dock-scale')).toBe('1.2');

    rerender(<Dock size={200} />);
    expect(dock).toHaveAttribute('data-size', '125');
    expect(dock.style.getPropertyValue('--wb-dock-scale')).toBe('1.25');
  });

  it('无实例 → launch 新窗口', () => {
    setDockPinned(['chat']);
    render(<Dock />);
    fireEvent.click(dockButton("chat"));
    expect(windowsOf('chat')).toHaveLength(1);
  });

  it('单实例未聚焦 → 聚焦', () => {
    const chatId = openWin('chat', 'a');
    openWin('files', 'f'); // files 成为焦点栈顶
    render(<Dock />);
    fireEvent.click(dockButton("chat"));
    const state = useWindowStore.getState();
    expect(state.focusStack[state.focusStack.length - 1]).toBe(chatId);
  });

  it('单实例已聚焦 → 最小化；再点击 → 恢复聚焦', async () => {
    const chatId = openWin('chat', 'a');
    render(<Dock />);
    const button = dockButton("chat");

    fireEvent.click(button);
    // O9：requestMinimizeAnimated；无壳时 orphan 下一帧提交
    await waitFor(() => {
      expect(useWindowStore.getState().windows[chatId].minimized).toBe(true);
    });

    fireEvent.click(button);
    const state = useWindowStore.getState();
    expect(state.windows[chatId].minimized).toBe(false);
    expect(state.focusStack[state.focusStack.length - 1]).toBe(chatId);
  });

  it('多实例 → 弹出窗口列表', () => {
    openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.click(dockButton("chat"));

    const list = screen.getByTestId('wb-dock-window-list');
    const items = within(list).getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName('会话 A');
    expect(items[1]).toHaveAccessibleName('会话 B');
  });
});

describe('DockWindowList 弹层', () => {
  it('点击条目聚焦对应窗口并关闭弹层', async () => {
    const idA = openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.click(dockButton("chat"));

    const list = screen.getByTestId('wb-dock-window-list');
    fireEvent.click(within(list).getByRole('menuitem', { name: '会话 A' }));

    // DockWindowList 退场动画结束后才 onSelect / 卸载
    await waitFor(() => {
      const state = useWindowStore.getState();
      expect(state.focusStack[state.focusStack.length - 1]).toBe(idA);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('wb-dock-window-list')).not.toBeInTheDocument();
    });
  });

  it('标记 minimized 窗口', () => {
    openWin('chat', 'a', '会话 A');
    const idB = openWin('chat', 'b', '会话 B');
    useWindowStore.getState().minimizeWindow(idB);
    render(<Dock />);
    fireEvent.click(dockButton("chat"));

    const list = screen.getByTestId('wb-dock-window-list');
    expect(within(list).getByText('已最小化')).toBeInTheDocument();
  });

  it('Esc 关闭并把焦点还给 Dock 按钮', async () => {
    openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    const button = dockButton("chat");
    fireEvent.click(button);

    const list = screen.getByTestId('wb-dock-window-list');
    fireEvent.keyDown(within(list).getByRole('menuitem', { name: '会话 A' }), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('wb-dock-window-list')).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(button);
  });

  it('外部 pointerdown 关闭弹层', () => {
    openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.click(dockButton("chat"));
    expect(screen.getByTestId('wb-dock-window-list')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('wb-dock-window-list')).not.toBeInTheDocument();
  });

  it('弹层内 ↑/↓ 移动 roving 焦点', () => {
    openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.click(dockButton("chat"));

    const list = screen.getByTestId('wb-dock-window-list');
    const items = within(list).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
  });
});

describe('DockContextMenu 右键菜单', () => {
  it('固定 / 取消固定切换', () => {
    openWin('chat', 'a', '会话 A');
    render(<Dock />);

    fireEvent.contextMenu(dockButton("chat"));
    fireEvent.click(screen.getByText('固定到 Dock'));
    expect(getDockPinned()).toEqual(['chat']);

    // 固定后条目从运行区移动到固定区（DOM 重建），需重新查询
    fireEvent.contextMenu(dockButton("chat"));
    fireEvent.click(screen.getByText('从 Dock 移除'));
    expect(getDockPinned()).toEqual([]);
  });

  it('未运行的固定应用：菜单无「关闭全部窗口」，仍可取消固定', () => {
    setDockPinned(['chat']);
    render(<Dock />);
    fireEvent.contextMenu(dockButton("chat"));

    expect(screen.queryByText('关闭全部窗口')).not.toBeInTheDocument();
    expect(screen.getByText('从 Dock 移除')).toBeInTheDocument();
  });

  it('逐窗列表点击聚焦', () => {
    const idA = openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.contextMenu(dockButton("chat"));

    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('会话 A'));

    const state = useWindowStore.getState();
    expect(state.focusStack[state.focusStack.length - 1]).toBe(idA);
  });

  it('关闭全部窗口', async () => {
    openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    render(<Dock />);
    fireEvent.contextMenu(dockButton("chat"));

    fireEvent.click(screen.getByText('关闭全部窗口'));
    await waitFor(() => expect(windowsOf('chat')).toHaveLength(0));
  });

  it('关闭全部窗口尊重 canClose 拦截', async () => {
    appRegistry.register(makeApp('locked', { canClose: () => false }));
    openWin('locked', 'x', '不可关');
    openWin('locked', 'y', '也不可关');
    render(<Dock />);
    fireEvent.contextMenu(dockButton("locked"));

    fireEvent.click(screen.getByText('关闭全部窗口'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(windowsOf('locked')).toHaveLength(2);
  });
});

describe('badge 与运行指示点', () => {
  it('badgeSource 计数角标，2s 内反映变化，源清空后消失', () => {
    vi.useFakeTimers();
    let value: number | null = 3;
    appRegistry.register(
      makeApp('tasks', {
        badgeSource: () => (value == null ? null : { kind: 'count', value }),
      }),
    );
    setDockPinned(['tasks']);
    render(<Dock />);

    expect(screen.getByTestId('wb-dock-badge-tasks')).toHaveTextContent('3');

    value = 5;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('wb-dock-badge-tasks')).toHaveTextContent('5');

    value = null;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId('wb-dock-badge-tasks')).not.toBeInTheDocument();
  });

  it('dot 角标无文本', () => {
    appRegistry.register(makeApp('dotapp', { badgeSource: () => ({ kind: 'dot' }) }));
    setDockPinned(['dotapp']);
    render(<Dock />);
    const badge = screen.getByTestId('wb-dock-badge-dotapp');
    expect(badge).toHaveAttribute('data-kind', 'dot');
    expect(badge).toHaveTextContent('');
  });

  it('运行指示点只在有窗口时显示', () => {
    setDockPinned(['chat']);
    const { rerender } = render(<Dock />);
    expect(screen.queryByTestId('wb-dock-indicator-chat')).not.toBeInTheDocument();

    openWin('chat', 'a');
    rerender(<Dock />);
    expect(screen.getByTestId('wb-dock-indicator-chat')).toBeInTheDocument();
  });

  it('aria-label 合并应用名、运行中与角标数量；角标节点 aria-hidden', () => {
    appRegistry.register(
      makeApp('tasks', {
        badgeSource: () => ({ kind: 'count', value: 3 }),
      }),
    );
    setDockPinned(['tasks']);
    openWin('tasks', 't');
    render(<Dock />);

    const button = screen.getByTestId('wb-dock-item-tasks').querySelector('button');
    expect(button).toHaveAttribute('aria-label', 'tasks, 运行中, 3');
    expect(screen.getByTestId('wb-dock-badge-tasks')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('分区与排序', () => {
  it('固定区在前、运行区在后、之间有分隔符', () => {
    setDockPinned(['chat']);
    openWin('files', 'f');
    render(<Dock />);

    const dock = screen.getByTestId('wb-dock');
    const buttons = within(dock).getAllByRole('button');
    expect(buttons[0]).toHaveAccessibleName('chat');
    expect(buttons[1]).toHaveAccessibleName(/files.*运行中/);
    expect(screen.getByTestId('wb-dock-separator')).toBeInTheDocument();
  });

  it('运行中的固定应用不重复出现、无运行区分隔符；仍有 Apps 入口', () => {
    setDockPinned(['chat']);
    openWin('chat', 'a');
    render(<Dock />);

    const dock = screen.getByTestId('wb-dock');
    // chat + 右侧全部应用入口 + 常驻 AI 操控入口
    expect(within(dock).getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByTestId('wb-dock-separator')).not.toBeInTheDocument();
    expect(screen.getByTestId('wb-dock-apps-separator')).toBeInTheDocument();
    expect(screen.getByTestId('wb-dock-apps-button')).toBeInTheDocument();
    expect(screen.getByTestId('wb-dock-agent-control-button')).toBeInTheDocument();
  });

  it('Apps 按钮 toggle 面板并同步 aria-expanded', () => {
    setDockPinned(['chat']);
    render(<Dock />);
    const appsBtn = screen.getByTestId('wb-dock-apps-button');

    expect(appsBtn).toHaveAttribute('aria-expanded', 'false');
    expect(isAppsPanelOpen()).toBe(false);

    fireEvent.click(appsBtn);
    expect(isAppsPanelOpen()).toBe(true);
    expect(appsBtn).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(appsBtn);
    expect(isAppsPanelOpen()).toBe(false);
    expect(appsBtn).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('键盘可达（roving tabindex）', () => {
  it('只有活动项 tabIndex=0，←/→/Home/End 移动焦点（含 Apps 与 AI 操控入口）', () => {
    setDockPinned(['chat', 'files']);
    render(<Dock />);
    const dock = screen.getByTestId('wb-dock');
    const chatBtn = dockButton("chat");
    const filesBtn = dockButton("files");
    const appsBtn = screen.getByTestId('wb-dock-apps-button');
    const agentBtn = screen.getByTestId('wb-dock-agent-control-button');

    expect(chatBtn).toHaveAttribute('tabindex', '0');
    expect(filesBtn).toHaveAttribute('tabindex', '-1');
    expect(appsBtn).toHaveAttribute('tabindex', '-1');
    expect(agentBtn).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(dock, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(filesBtn);
    expect(filesBtn).toHaveAttribute('tabindex', '0');
    expect(chatBtn).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(dock, { key: 'ArrowRight' }); // → Apps
    expect(document.activeElement).toBe(appsBtn);

    fireEvent.keyDown(dock, { key: 'ArrowRight' }); // → AI 操控
    expect(document.activeElement).toBe(agentBtn);

    fireEvent.keyDown(dock, { key: 'ArrowRight' }); // 循环回第一个
    expect(document.activeElement).toBe(chatBtn);

    fireEvent.keyDown(dock, { key: 'End' });
    expect(document.activeElement).toBe(agentBtn);
    fireEvent.keyDown(dock, { key: 'Home' });
    expect(document.activeElement).toBe(chatBtn);
  });
});

describe('dock magnification gate', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-wb-dock-mag');
    resetMaterialTierForTests();
  });

  it('data-wb-dock-mag=off 时不挂 magging（不启动放大循环）', () => {
    setMaterialTier('full');
    document.documentElement.dataset.wbDockMag = 'off';
    setDockPinned(['chat']);
    render(<Dock />);
    const dock = screen.getByTestId('wb-dock');
    fireEvent.pointerEnter(dock, { pointerType: 'mouse', clientX: 100 });
    expect(dock).not.toHaveAttribute('data-wb-dock-magging');
  });

  it('默认悬停也不挂 magging，只显示 tooltip', () => {
    setMaterialTier('full');
    setDockPinned(['chat']);
    render(<Dock />);
    const dock = screen.getByTestId('wb-dock');
    fireEvent.pointerEnter(dock, { pointerType: 'mouse', clientX: 100 });
    expect(dock).not.toHaveAttribute('data-wb-dock-magging');
    expect(screen.getByTestId('wb-dock-tip-chat')).toBeInTheDocument();
  });

  it('minimal 材质档不挂 magging', () => {
    setMaterialTier('minimal');
    setDockPinned(['chat']);
    render(<Dock />);
    const dock = screen.getByTestId('wb-dock');
    fireEvent.pointerEnter(dock, { pointerType: 'mouse', clientX: 100 });
    expect(dock).not.toHaveAttribute('data-wb-dock-magging');
  });
});

describe('autohide', () => {
  it('默认隐藏，热区指针进入延迟滑出，指针离开延迟收回', () => {
    vi.useFakeTimers();
    setDockPinned(['chat']);
    render(<Dock autohide />);
    const dock = screen.getByTestId('wb-dock');
    expect(dock).toHaveAttribute('data-hidden', 'true');

    fireEvent.pointerEnter(screen.getByTestId('wb-dock-hotzone'));
    // reveal 延迟 180ms：未到时仍隐藏
    expect(dock).toHaveAttribute('data-hidden', 'true');
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(dock).not.toHaveAttribute('data-hidden');

    fireEvent.pointerLeave(dock);
    // conceal 延迟 150ms
    expect(dock).not.toHaveAttribute('data-hidden');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(dock).toHaveAttribute('data-hidden', 'true');
  });

  it('热区短暂划过（未满 reveal 延迟）不弹出', () => {
    vi.useFakeTimers();
    setDockPinned(['chat']);
    render(<Dock autohide />);
    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');

    fireEvent.pointerEnter(hotzone);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(dock).toHaveAttribute('data-hidden', 'true');
  });

  it('弹出后指针未进入 Dock 直接离开底缘 → 收起', () => {
    vi.useFakeTimers();
    setDockPinned(['chat']);
    render(<Dock autohide />);
    const dock = screen.getByTestId('wb-dock');
    const hotzone = screen.getByTestId('wb-dock-hotzone');

    fireEvent.pointerEnter(hotzone);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(dock).not.toHaveAttribute('data-hidden');

    // 指针一直停在底缘热区（从未上移到 Dock）就离开 → conceal 150ms 后隐藏
    fireEvent.pointerLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(dock).toHaveAttribute('data-hidden', 'true');
  });

  it('焦点在 Dock 内时不收回', () => {
    vi.useFakeTimers();
    setDockPinned(['chat']);
    render(<Dock autohide />);
    const dock = screen.getByTestId('wb-dock');
    const button = dockButton("chat");

    act(() => button.focus());
    expect(dock).not.toHaveAttribute('data-hidden');

    fireEvent.pointerLeave(dock);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(dock).not.toHaveAttribute('data-hidden');

    act(() => button.blur());
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(dock).toHaveAttribute('data-hidden', 'true');
  });

  it('非 autohide 模式无热区且始终可见', () => {
    setDockPinned(['chat']);
    render(<Dock />);
    expect(screen.queryByTestId('wb-dock-hotzone')).not.toBeInTheDocument();
    expect(screen.getByTestId('wb-dock')).not.toHaveAttribute('data-hidden');
  });
});
