/**
 * 页面发起的建窗与 DevTools（`plugins/window.ts`）：正式版 Tauri 不带 `devtools` 特性，页面无法打开检查器；
 * 窗口 label 不能与在用的 browser-content 重名（Tauri 的 window/webview label 全局唯一）。
 */
import { describe, expect, it } from 'vitest';
import type { InvokeInput } from '../shell/args.ts';
import { ShellCommandError } from '../shell/errors.ts';
import { webviewPlugin, windowPlugin } from '../shell/plugins/window.ts';
import type { BuiltinCommand, BuiltinPlugin, CommandContext, ShellRuntime } from '../shell/runtime.ts';

interface Fake {
  ctx: CommandContext;
  created: Record<string, unknown>[];
  toggled: string[];
}

function fake(debug: boolean, browser: { label: string; windowLabel: string } | null = null): Fake {
  const created: Record<string, unknown>[] = [];
  const toggled: string[] = [];
  const runtime = {
    debug,
    windows: {
      create: (config: Record<string, unknown>) => created.push(config),
      get: (label: string) => (label === 'main' ? { label, webContents: { toggleDevTools: () => toggled.push(label) } } : undefined),
    },
    browserLabelInUse: (label: string) => (browser === null ? null : browser.windowLabel === label ? 'window' : browser.label === label ? 'webview' : null),
  } as unknown as ShellRuntime;
  return { ctx: { runtime, windowLabel: 'main', webviewLabel: 'main' }, created, toggled };
}

const input = (command: string, json: unknown): InvokeInput => ({ command, json, raw: null, headers: {} });

function handler(plugin: BuiltinPlugin, command: string): BuiltinCommand {
  const found = plugin[command];
  if (found === undefined) throw new Error(`the plugin has no ${command} command`);
  return found;
}

async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error instanceof ShellCommandError ? error.value : error;
  }
  return 'resolved';
}

describe('windows created by a page', () => {
  it('a packaged build ignores the devtools option a page asks for; a development build keeps it', async () => {
    for (const [name, command] of [['create', handler(windowPlugin(), 'create')], ['create_webview_window', handler(webviewPlugin(), 'create_webview_window')]] as const) {
      const packaged = fake(false);
      await command(input(name, { options: { label: 'pop', devtools: true } }), packaged.ctx);
      expect(packaged.created).toEqual([expect.objectContaining({ label: 'pop', devtools: false })]);
      const dev = fake(true);
      await command(input(name, { options: { label: 'pop', devtools: true } }), dev.ctx);
      expect(dev.created).toEqual([expect.objectContaining({ label: 'pop', devtools: true })]);
    }
  });

  it('internal_toggle_devtools does not exist in a packaged build (Tauri compiles it only with debug_assertions or the devtools feature)', async () => {
    const toggle = handler(webviewPlugin(), 'internal_toggle_devtools');
    const packaged = fake(false);
    expect(await rejection(() => toggle(input('internal_toggle_devtools', {}), packaged.ctx))).toBe('Command internal_toggle_devtools not found');
    expect(packaged.toggled).toEqual([]);
    const dev = fake(true);
    await toggle(input('internal_toggle_devtools', {}), dev.ctx);
    expect(dev.toggled).toEqual(['main']);
  });

  it('a window cannot take a label held by a live browser-content webview or its detached window', async () => {
    const create = handler(webviewPlugin(), 'create_webview_window');
    const attached = fake(true, { label: 'browser-content', windowLabel: 'main' });
    expect(await rejection(() => create(input('create_webview_window', { options: { label: 'browser-content' } }), attached.ctx)))
      .toBe('a webview with label `browser-content` already exists');
    const detached = fake(true, { label: 'browser-content', windowLabel: 'browser-content' });
    expect(await rejection(() => handler(windowPlugin(), 'create')(input('create', { options: { label: 'browser-content' } }), detached.ctx)))
      .toBe('a window with label `browser-content` already exists');
    expect([...attached.created, ...detached.created]).toEqual([]);
    const closed = fake(true);
    await create(input('create_webview_window', { options: { label: 'browser-content' } }), closed.ctx);
    expect(closed.created).toHaveLength(1);
  });
});
