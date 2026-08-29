import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WindowBody } from '@/features/workbench/components/WindowBody';
import { publishDockIconRects, clearDockGeometry } from '@/features/workbench/components/dockGeometry';
import {
  LIFEC_ATTR,
  injectMinimizeOrigin,
  requestMinimizeAnimated,
  resolveWindowShell,
} from '@/features/workbench/hooks/useWindowLifecycleAnim';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { openTestWindow, registerTestApp, resetWorkbenchStore } from './testUtils';

function mountShell(windowId: string, rect = { left: 100, top: 50, width: 400, height: 300 }): HTMLElement {
  const el = document.createElement('section');
  el.setAttribute('data-wb-window-id', windowId);
  el.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe('WindowBody 生命周期壳', () => {
  beforeEach(() => {
    resetWorkbenchStore();
    useWindowStore.setState({ transientPhases: {} });
    registerTestApp();
    clearDockGeometry();
  });

  afterEach(() => {
    document.querySelectorAll('[data-wb-window-id]').forEach((n) => n.remove());
    clearDockGeometry();
  });

  it('focused 窗口挂载应用并下传 isActive/isVisible', async () => {
    const id = openTestWindow();
    render(<WindowBody windowId={id} />);
    const app = await screen.findByTestId('app-content');
    expect(app).toHaveAttribute('data-active', 'true');
    expect(app).toHaveAttribute('data-visible', 'true');
  });

  it('background：DOM 保留但 visibility/content-visibility hidden', async () => {
    const id = openTestWindow();
    const { container } = render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    act(() => {
      useWindowStore.getState().setLifecycles({ [id]: 'background' });
    });

    const body = container.querySelector('[data-wb-window-body]') as HTMLElement;
    expect(body.dataset.lifecycle).toBe('background');
    expect(body.style.visibility).toBe('hidden');
    // 应用子树未被卸载
    expect(screen.getByTestId('app-content')).toBeInTheDocument();
    expect(screen.getByTestId('app-content')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('app-content')).toHaveAttribute('data-visible', 'false');
  });

  it('background：停绘收在内容壳上 + Exposé 停绘占位卡随行渲染（CSS 点亮）', async () => {
    const id = openTestWindow({ title: '后台会话' });
    const { container } = render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    // focused 时无占位卡、内容壳不停绘
    expect(container.querySelector('[data-wb-expose-doze]')).toBeNull();
    const contentBefore = container.querySelector('[data-wb-window-content]') as HTMLElement;
    expect(contentBefore.style.visibility).toBe('');

    act(() => {
      useWindowStore.getState().setLifecycles({ [id]: 'background' });
    });

    // 停绘语义收在内容壳：visibility + content-visibility 双隐藏
    const content = container.querySelector('[data-wb-window-content]') as HTMLElement;
    expect(content.style.visibility).toBe('hidden');
    // 应用子树收到 isSuspended（重应用可据此暂停纯视觉提交）
    expect(screen.getByTestId('app-content')).toBeInTheDocument();

    // 占位卡与内容壳为兄弟节点：始终在 DOM（display 由 WindowLifecycle.css
    // 按壳上 data-expose-transform 点亮），带标题 + 停绘提示，且对 a11y 隐藏
    const doze = container.querySelector('[data-wb-expose-doze]') as HTMLElement;
    expect(doze).toBeInTheDocument();
    expect(doze.getAttribute('aria-hidden')).toBe('true');
    expect(doze.textContent).toContain('后台会话');
    expect(doze.textContent).toContain('内容已停止绘制');
    expect(doze.querySelector('.wb-body-frozen-card.wb-glass')).toBeTruthy();
    // 占位卡不在内容壳内（否则会被 content-visibility 一起跳过）
    expect(content.contains(doze)).toBe(false);

    // 回到可见档 → 占位卡卸载、内容壳恢复
    act(() => {
      useWindowStore.getState().setLifecycles({ [id]: 'visible' });
    });
    expect(container.querySelector('[data-wb-expose-doze]')).toBeNull();
    expect(
      (container.querySelector('[data-wb-window-content]') as HTMLElement).style.visibility,
    ).toBe('');
  });

  it('frozen：卸载子树显示休眠占位，点击唤醒后重建（frozen→唤醒 DoD）', async () => {
    const id = openTestWindow({ title: '被冻结的窗口' });
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    act(() => {
      useWindowStore.getState().setLifecycles({ [id]: 'frozen' });
    });

    // 子树已卸载，出现占位
    expect(screen.queryByTestId('app-content')).toBeNull();
    const placeholder = document.querySelector('[data-wb-frozen-placeholder]') as HTMLElement;
    expect(placeholder).toBeInTheDocument();
    expect(placeholder.textContent).toContain('被冻结的窗口');
    expect(placeholder.textContent).toMatch(/点击唤醒/);
    // O9 玻璃卡结构
    expect(placeholder.querySelector('.wb-body-frozen-card.wb-glass')).toBeTruthy();
    expect(placeholder.querySelector('.wb-body-frozen-icon')).toBeTruthy();

    // 点击唤醒 → 解冻 + 聚焦 + 应用重建
    fireEvent.click(placeholder);
    const app = await screen.findByTestId('app-content');
    expect(app).toHaveAttribute('data-active', 'true');
    const state = useWindowStore.getState();
    expect(state.lifecycles[id]).toBe('focused');
    expect(state.focusStack[state.focusStack.length - 1]).toBe(id);
    // 唤醒淡入类
    const body = document.querySelector('[data-wb-window-body]') as HTMLElement;
    expect(body.classList.contains('wb-body-wake-in')).toBe(true);
  });

  it('visible（非焦点）：isActive=false / isVisible=true', async () => {
    const id = openTestWindow();
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');
    act(() => {
      useWindowStore.getState().setLifecycles({ [id]: 'visible' });
    });
    const app = screen.getByTestId('app-content');
    expect(app).toHaveAttribute('data-active', 'false');
    expect(app).toHaveAttribute('data-visible', 'true');
  });

  it('应用 onTitleChange 写回 store', async () => {
    const id = openTestWindow();
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');
    fireEvent.click(screen.getByRole('button', { name: 'set-title' }));
    expect(useWindowStore.getState().windows[id].title).toBe('新标题');
  });

  it('requestClose 走 canClose 拦截：false 阻止关闭', async () => {
    registerTestApp('test-app-block', { canClose: () => false });
    const id = openTestWindow({ typeId: 'test-app-block' });
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'request-close' }));
    });
    expect(useWindowStore.getState().windows[id]).toBeDefined();
  });

  it('requestClose 走 canClose 拦截：true 进入 closing 动画相位（不立即卸载）', async () => {
    registerTestApp('test-app-ok', { canClose: () => true });
    const id = openTestWindow({ typeId: 'test-app-ok' });
    const shell = mountShell(id);
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'request-close' }));
    });
    // O9：先标 closing + data-wb-lifec，真正 close 在 animationend
    expect(useWindowStore.getState().windows[id]).toBeDefined();
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('closing');
    expect(shell.getAttribute(LIFEC_ATTR)).toBe('closing');

    await act(async () => {
      fireEvent.animationEnd(shell);
    });
    expect(useWindowStore.getState().windows[id]).toBeUndefined();
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('未注册的应用类型显示提示', () => {
    const id = useWindowStore.getState().openWindow({ typeId: 'never-registered' });
    render(<WindowBody windowId={id} />);
    expect(screen.getByText(/未知应用类型/)).toBeInTheDocument();
  });

  it('lazy 加载期间显示 Suspense fallback', () => {
    registerTestApp('test-app-slow', {
      render: React.lazy(
        () => new Promise<{ default: React.FC<AppWindowProps> }>(() => {}),
      ),
    });
    const id = openTestWindow({ typeId: 'test-app-slow' });
    render(<WindowBody windowId={id} />);
    expect(screen.getByText(/加载中/)).toBeInTheDocument();
  });

  it('opening：壳挂 pop-in，animationend 后清除标记；无 Dock 图标回退中心源点', async () => {
    const id = openTestWindow();
    const shell = mountShell(id);
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('opening');

    render(<WindowBody windowId={id} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(shell.getAttribute(LIFEC_ATTR)).toBe('opening');
    // L4：opening 也注入源点；无 Dock 坐标时回退 50%/50%（中心弹入）
    expect(shell.style.getPropertyValue('--wb-minimize-origin-x')).toBe('50%');
    expect(shell.style.getPropertyValue('--wb-minimize-origin-y')).toBe('50%');

    await act(async () => {
      fireEvent.animationEnd(shell);
    });
    expect(shell.getAttribute(LIFEC_ATTR)).toBeNull();
    expect(useWindowStore.getState().transientPhases?.[id]).toBeUndefined();
  });

  it('opening：有 Dock 图标时开窗源点对齐图标中心', async () => {
    const id = openTestWindow({ typeId: 'test-app' });
    const shell = mountShell(id, { left: 0, top: 0, width: 200, height: 100 });
    publishDockIconRects({
      'test-app': { x: 100, y: 900, w: 48, h: 48 },
    });

    render(<WindowBody windowId={id} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(shell.getAttribute(LIFEC_ATTR)).toBe('opening');
    // 中心 (124, 924) 相对壳 (0,0,200×100) → 62% / 924%
    expect(shell.style.getPropertyValue('--wb-minimize-origin-x')).toBe('62%');
    expect(shell.style.getPropertyValue('--wb-minimize-origin-y')).toBe('924%');
  });

  it('minimizing：注入 Dock 坐标 + genie-min，结束后才 minimize', async () => {
    const id = openTestWindow({ typeId: 'test-app' });
    const shell = mountShell(id, { left: 0, top: 0, width: 200, height: 100 });
    publishDockIconRects({
      'test-app': { x: 100, y: 900, w: 48, h: 48 },
    });

    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    act(() => {
      requestMinimizeAnimated(id);
    });

    expect(useWindowStore.getState().transientPhases?.[id]).toBe('minimizing');
    expect(useWindowStore.getState().windows[id].minimized).toBe(false);
    expect(shell.getAttribute(LIFEC_ATTR)).toBe('minimizing');
    // 中心 (124, 924) 相对壳 (0,0,200×100) → 62% / 924%
    expect(shell.style.getPropertyValue('--wb-minimize-origin-x')).toBe('62%');
    expect(shell.style.getPropertyValue('--wb-minimize-origin-y')).toBe('924%');

    await act(async () => {
      fireEvent.animationEnd(shell);
    });
    expect(useWindowStore.getState().windows[id].minimized).toBe(true);
    expect(useWindowStore.getState().transientPhases?.[id]).toBeUndefined();
    expect(shell.getAttribute(LIFEC_ATTR)).toBeNull();
  });

  it('restoring：挂 genie-restore，animationend 清除标记', async () => {
    const id = openTestWindow();
    const shell = mountShell(id);
    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    act(() => {
      useWindowStore.getState().minimizeWindow(id, true);
    });
    act(() => {
      useWindowStore.getState().focusWindow(id);
    });
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('restoring');

    await act(async () => {
      await Promise.resolve();
    });
    expect(shell.getAttribute(LIFEC_ATTR)).toBe('restoring');

    await act(async () => {
      fireEvent.animationEnd(shell);
    });
    expect(useWindowStore.getState().transientPhases?.[id]).toBeUndefined();
    expect(shell.getAttribute(LIFEC_ATTR)).toBeNull();
  });

  it('minimizing：残留旧相位时先清相位再量测源点（脏 transform 不污染收敛点）', async () => {
    const id = openTestWindow({ typeId: 'test-app' });
    // 壳模拟「上一段 restoring 动画被打断」：data-wb-lifec 仍挂着时
    // getBoundingClientRect 返回含动画 transform 的中间帧（整体偏移 +60,+40）；
    // 相位清除后返回干净矩形。锚定 useWindowLifecycleAnim 先清相位
    // + 强制回流、后 injectMinimizeOrigin 的顺序。
    const clean = { left: 0, top: 0, width: 200, height: 100 };
    const el = document.createElement('section');
    el.setAttribute('data-wb-window-id', id);
    el.setAttribute(LIFEC_ATTR, 'restoring');
    el.getBoundingClientRect = () => {
      const polluted = el.hasAttribute(LIFEC_ATTR);
      const left = clean.left + (polluted ? 60 : 0);
      const top = clean.top + (polluted ? 40 : 0);
      return {
        x: left,
        y: top,
        left,
        top,
        right: left + clean.width,
        bottom: top + clean.height,
        width: clean.width,
        height: clean.height,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
    document.body.appendChild(el);

    publishDockIconRects({
      'test-app': { x: 100, y: 900, w: 48, h: 48 },
    });

    render(<WindowBody windowId={id} />);
    await screen.findByTestId('app-content');

    act(() => {
      requestMinimizeAnimated(id);
    });

    expect(el.getAttribute(LIFEC_ATTR)).toBe('minimizing');
    // 干净矩形 (0,0,200×100) + 图标中心 (124,924) → 62% / 924%；
    // 若在清相位前量测（脏矩形 60,40 偏移）会得到 32% / 884%。
    expect(el.style.getPropertyValue('--wb-minimize-origin-x')).toBe('62%');
    expect(el.style.getPropertyValue('--wb-minimize-origin-y')).toBe('924%');
  });

  it('injectMinimizeOrigin：无 Dock 坐标时回退 50%/130%', () => {
    const shell = document.createElement('div');
    shell.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, x: 0, y: 0, right: 100, bottom: 100, toJSON() { return {}; } }) as DOMRect;
    injectMinimizeOrigin(shell, 'missing-app');
    expect(shell.style.getPropertyValue('--wb-minimize-origin-x')).toBe('50%');
    expect(shell.style.getPropertyValue('--wb-minimize-origin-y')).toBe('130%');
  });

  it('resolveWindowShell 按 data-wb-window-id 定位', () => {
    const id = 'shell-lookup';
    const el = mountShell(id);
    expect(resolveWindowShell(id)).toBe(el);
    expect(resolveWindowShell('nope')).toBeNull();
  });
});
