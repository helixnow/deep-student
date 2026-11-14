/**
 * `plugin:window|start_dragging`（`plugins/window.ts`）：拖动结束时撤掉为它挂的 `blur` 监听（V09 P3-5）。
 * 之前每次拖动挂一个 `once('blur')`，页面松开鼠标正常结束时不移除，窗口一直不失焦就会越积越多。
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  nativeTheme: {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
}));

const { stopWindowDrag, windowPlugin } = await import('../shell/plugins/window.ts');
type CommandContext = import('../shell/runtime.ts').CommandContext;

class FakeBrowserWindow extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
  isMaximized(): boolean { return false; }
  isFullScreen(): boolean { return false; }
  getPosition(): number[] { return [10, 20]; }
  setPosition(): void {}
}

function context(win: FakeBrowserWindow): CommandContext {
  const shellWindow = { label: 'main', browserWindow: win };
  return {
    runtime: { windows: { get: (label: string) => (label === 'main' ? shellWindow : undefined) }, sendToWebview: () => undefined },
    windowLabel: 'main',
    webviewLabel: 'main',
  } as unknown as CommandContext;
}

const startDragging = (ctx: CommandContext) => windowPlugin().start_dragging!({ command: 'start_dragging', json: {}, raw: null, headers: {} }, ctx);

afterEach(() => {
  stopWindowDrag('main');
});

describe('start_dragging', () => {
  it('a drag that ends with the page releasing the mouse leaves no blur listener behind', () => {
    const win = new FakeBrowserWindow();
    const ctx = context(win);
    for (let drag = 0; drag < 20; drag++) {
      startDragging(ctx);
      expect(win.listenerCount('blur')).toBe(1);
      stopWindowDrag('main');
      expect(win.listenerCount('blur')).toBe(0);
    }
  });

  it('a new drag replaces the previous one, and losing focus still ends it', () => {
    vi.useFakeTimers();
    try {
      const win = new FakeBrowserWindow();
      const ctx = context(win);
      startDragging(ctx);
      startDragging(ctx);
      expect(win.listenerCount('blur')).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      win.emit('blur');
      expect(win.listenerCount('blur')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping a drag on a destroyed window does not touch it', () => {
    const win = new FakeBrowserWindow();
    startDragging(context(win));
    win.destroyed = true;
    const removeListener = vi.spyOn(win, 'removeListener');
    stopWindowDrag('main');
    expect(removeListener).not.toHaveBeenCalled();
  });
});
