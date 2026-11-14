import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import {
  QUICK_ASSISTANT_BOUNDS_KEY, QUICK_ASSISTANT_ENABLED_KEY, QUICK_ASSISTANT_SHOWN_EVENT,
} from '../src/quick-assistant.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

interface ShellHarness {
  windows: Set<string>;
  visible: boolean;
  calls: string[];
  shell: (op: string, args: unknown) => unknown;
}

function shellHarness(): ShellHarness {
  const harness: ShellHarness = {
    windows: new Set<string>(),
    visible: false,
    calls: [],
    shell: (op, args) => {
      harness.calls.push(op);
      const value = (args ?? {}) as Record<string, unknown>;
      switch (op) {
        case 'plugin:window|get_all_windows': return [...harness.windows];
        case 'plugin:window|create': {
          const options = value['options'] as Record<string, unknown>;
          harness.windows.add(options['label'] as string);
          return null;
        }
        case 'plugin:window|destroy':
          harness.windows.delete(value['label'] as string);
          return null;
        case 'plugin:window|show':
          harness.visible = true;
          return null;
        case 'plugin:window|hide':
          harness.visible = false;
          return null;
        case 'plugin:window|is_visible': return harness.visible;
        case 'plugin:window|is_focused': return false;
        case 'plugin:window|cursor_position': return { x: 100, y: 100 };
        case 'plugin:window|monitor_from_point':
        case 'plugin:window|primary_monitor':
          return { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };
        case 'plugin:window|outer_position': return { x: 10, y: 20 };
        case 'plugin:window|inner_size': return { width: 520, height: 420 };
        case 'plugin:window|scale_factor': return 2;
        case 'plugin:window|set_size':
        case 'plugin:window|set_position':
        case 'plugin:window|set_focus':
        case 'plugin:window|unminimize':
        case 'plugin:window|minimize':
        case 'plugin:window|set_visible_on_all_workspaces':
        case 'plugin:window|set_effects':
        case 'plugin:app|app_hide':
          return null;
        default:
          return null;
      }
    },
  };
  return harness;
}

describe('quick assistant commands', () => {
  it('show creates the window, positions it and emits the shown event', async () => {
    const shell = shellHarness();
    current = await setupMemoryHost({ shell: shell.shell });
    await current.host.invoke('quick_assistant_show', {}, { window: 'main', webview: 'main' });

    expect(shell.windows.has('quick-assistant')).toBe(true);
    expect(shell.calls).toContain('plugin:window|create');
    expect(shell.calls).toContain('plugin:window|set_position');
    expect(current.host.eventsNamed(QUICK_ASSISTANT_SHOWN_EVENT)).toEqual([null]);
  });

  // quick_assistant.rs:193 `window.emit(SHOWN_EVENT, ())`：Tauri 2 的 WebviewWindow::emit 是全局广播
  // （webview_window.rs:2663 默认 Emitter::emit → manager().emit），不限定到快速助手窗口（V03-05）。
  it('the shown event is broadcast to every listener like Tauri 2 WebviewWindow::emit', async () => {
    const shell = shellHarness();
    current = await setupMemoryHost({ shell: shell.shell });
    await current.host.invoke('quick_assistant_show', {}, { window: 'main', webview: 'main' });

    const shown = current.host.events.filter(event => event.event === QUICK_ASSISTANT_SHOWN_EVENT);
    expect(shown.map(event => event.target)).toEqual([{ kind: 'Any' }]);
  });

  it('hide persists logical bounds then hides the window', async () => {
    const shell = shellHarness();
    current = await setupMemoryHost({ shell: shell.shell });
    await current.host.invoke('quick_assistant_show');
    shell.calls.length = 0;

    await current.host.invoke('quick_assistant_hide');
    expect(shell.calls).toContain('plugin:window|hide');
    expect(current.host.ctx.settings.get(QUICK_ASSISTANT_BOUNDS_KEY)).toBe('10,20,400,320');
  });

  it('apply_enabled(false) persists bounds and destroys the window', async () => {
    const shell = shellHarness();
    current = await setupMemoryHost({ shell: shell.shell });
    await current.host.invoke('quick_assistant_show');

    await current.host.invoke('quick_assistant_apply_enabled', { enabled: false });
    expect(shell.calls).toContain('plugin:window|destroy');
    expect(shell.windows.has('quick-assistant')).toBe(false);
    expect(current.host.ctx.settings.get(QUICK_ASSISTANT_BOUNDS_KEY)).toBe('10,20,400,320');
  });

  it('global shortcut toggles only while pressed and enabled', async () => {
    const shell = shellHarness();
    current = await setupMemoryHost({ shell: shell.shell });
    await current.host.invoke('quick_assistant_show');
    expect(shell.visible).toBe(true);

    current.host.emitFrontend('global-shortcut://triggered', { state: 'Released', shortcut: 'x' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(shell.visible).toBe(true);

    current.host.emitFrontend('global-shortcut://triggered', { state: 'Pressed', shortcut: 'x' });
    await vi.waitFor(() => { expect(shell.visible).toBe(false); }, { timeout: 3000, interval: 25 });

    current.host.ctx.settings.save(QUICK_ASSISTANT_ENABLED_KEY, 'false');
    current.host.emitFrontend('global-shortcut://triggered', { state: 'Pressed', shortcut: 'x' });
    await vi.waitFor(() => { expect(shell.visible).toBe(false); }, { timeout: 3000, interval: 25 });
  });
});
