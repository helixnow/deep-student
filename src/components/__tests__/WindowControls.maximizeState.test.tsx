import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import zhCommon from '@/locales/zh-CN/common.json';
import { WindowControls } from '../WindowControls';

type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const shell = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { event: string; id: number; payload: unknown }) => void>>(),
  maximized: false,
  pending: [] as Array<() => void>,
  hold: false,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    const set = shell.listeners.get(event) ?? new Set();
    set.add(handler);
    shell.listeners.set(event, set);
    return () => set.delete(handler);
  }),
}));

const isMaximized = vi.fn(() =>
  shell.hold
    ? new Promise<boolean>((resolve) => shell.pending.push(() => resolve(shell.maximized)))
    : Promise.resolve(shell.maximized),
);

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: () => isMaximized(),
    maximize: async () => undefined,
    unmaximize: async () => undefined,
    minimize: async () => undefined,
    close: async () => undefined,
  }),
}));

const labels = zhCommon.window_controls;
const toggle = () => document.querySelector('[data-shell-window-button="maximize"]') as HTMLElement;

function shellEmit(event: string, payload: unknown = { width: 800, height: 600 }) {
  for (const handler of shell.listeners.get(event) ?? []) handler({ event, id: 1, payload });
}

beforeEach(() => {
  shell.listeners.clear();
  shell.maximized = false;
  shell.pending = [];
  shell.hold = false;
  isMaximized.mockClear();
});
afterEach(cleanup);

describe('WindowControls maximize icon follows the window', () => {
  it('RF-W09-window-controls-maximize-follows-resize: re-reads isMaximized on tauri://resize', async () => {
    render(<WindowControls />);
    await waitFor(() => expect(shell.listeners.get('tauri://resize')?.size).toBe(1));
    expect(toggle().getAttribute('aria-label')).toBe(labels.maximize);

    // 双击标题栏、系统快捷键、拖到屏幕顶端：最大化不经过这个按钮，壳只发 tauri://resize。
    shell.maximized = true;
    act(() => shellEmit('tauri://resize'));
    await waitFor(() => expect(toggle().getAttribute('aria-label')).toBe(labels.restore));

    shell.maximized = false;
    act(() => shellEmit('tauri://resize'));
    await waitFor(() => expect(toggle().getAttribute('aria-label')).toBe(labels.maximize));
  });

  it('RF-W09-window-controls-maximize-follows-resize: a burst of resize events keeps one query in flight and settles on the last state', async () => {
    render(<WindowControls />);
    await waitFor(() => expect(shell.listeners.get('tauri://resize')?.size).toBe(1));
    isMaximized.mockClear();

    shell.hold = true;
    act(() => {
      for (let i = 0; i < 20; i += 1) shellEmit('tauri://resize');
    });
    expect(isMaximized).toHaveBeenCalledTimes(1);

    shell.maximized = true;
    shell.hold = false;
    await act(async () => {
      shell.pending.splice(0).forEach((resolve) => resolve());
    });
    await waitFor(() => expect(toggle().getAttribute('aria-label')).toBe(labels.restore));
    expect(isMaximized).toHaveBeenCalledTimes(2);
  });

  it('stops listening after unmount, including when unmounted before the listener resolves', async () => {
    const { unmount } = render(<WindowControls />);
    await waitFor(() => expect(shell.listeners.get('tauri://resize')?.size).toBe(1));
    unmount();
    expect(shell.listeners.get('tauri://resize')?.size).toBe(0);

    shell.listeners.clear();
    render(<WindowControls />).unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(shell.listeners.get('tauri://resize')?.size ?? 0).toBe(0);
  });
});
