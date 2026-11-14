/** main 的渲染进程 IPC 装配（`electron/renderer-ipc.ts`）：桥初始化、invoke 路由、拖放作用域与事件、其余消息。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IPC_CHANNEL_INIT, IPC_CHANNEL_TO_MAIN } from '../shell/bridge-messages.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { wireRendererIpc, type RendererIpcDeps } from '../renderer-ipc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'w06-renderer-ipc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const folder = join(tmp, 'folder');
const file = join(tmp, 'note.md');
mkdirSync(folder);
writeFileSync(file, 'x');

interface FakeEvent {
  sender: { getURL(): string };
  senderFrame: { url: string; parent: unknown; detached?: boolean } | null;
  returnValue?: unknown;
}

const mainContents = { getURL: () => 'http://contents.example/main' };
const quickContents = { getURL: () => 'http://contents.example/quick' };
const browserContents = { getURL: () => 'https://site.example/' };
const strangerContents = { getURL: () => 'http://stranger.example/' };

function setup(platform: ShellPlatform = 'darwin') {
  const listeners = new Map<string, (event: FakeEvent, ...args: unknown[]) => void>();
  const calls: unknown[][] = [];
  const logs: string[] = [];
  const windows = new Map<unknown, { label: string; dragDropEnabled: boolean }>([
    [mainContents, { label: 'main', dragDropEnabled: true }],
    [quickContents, { label: 'quick-assistant', dragDropEnabled: false }],
  ]);
  const browser = { label: 'browser-content', windowLabel: 'main', initializationScript: 'window.__probe = 1;' };
  const scope = (name: string) => ({
    allowFile: (path: string) => { calls.push([`${name}.allowFile`, path]); },
    allowDirectory: (path: string, recursive: boolean) => { calls.push([`${name}.allowDirectory`, path, recursive]); },
  });
  const deps = {
    platform,
    ipc: { on: (channel: string, listener: (event: FakeEvent, ...args: unknown[]) => void) => { listeners.set(channel, listener); } },
    runtime: {
      browserWebviewOf: (contents: unknown) => (contents === browserContents ? browser : null),
      handleInvoke: (win: unknown, message: unknown, frameUrl: string) => { calls.push(['handleInvoke', win, message, frameUrl]); },
      handleBrowserInvoke: (contents: unknown, entry: unknown, message: unknown, frameUrl: string) => {
        calls.push(['handleBrowserInvoke', contents, entry, message, frameUrl]);
      },
      emitTo: (target: unknown, event: string, payloadJson: string) => { calls.push(['emitTo', target, event, payloadJson]); },
      windows: { byWebContents: (contents: unknown) => windows.get(contents) },
    },
    fsRuntime: scope('fs'),
    assetScope: scope('asset'),
    stopWindowDrag: (label: string) => { calls.push(['stopWindowDrag', label]); },
    log: (message: string) => { logs.push(message); },
  } as unknown as RendererIpcDeps;
  wireRendererIpc(deps);
  const init = (sender: FakeEvent['sender']) => {
    const event: FakeEvent = { sender, senderFrame: null };
    listeners.get(IPC_CHANNEL_INIT)!(event);
    return event.returnValue;
  };
  const send = (sender: FakeEvent['sender'], message: unknown, frame: FakeEvent['senderFrame'] = { url: `${sender.getURL()}#frame`, parent: null }) => {
    listeners.get(IPC_CHANNEL_TO_MAIN)!({ sender, senderFrame: frame }, message);
  };
  return { init, send, calls, logs, windows, browser };
}

describe('bridge init (sync)', () => {
  it.each([
    ['darwin', 'macos', '/', ':'],
    ['linux', 'linux', '/', ':'],
    ['win32', 'windows', '\\', ';'],
  ] as const)('%s: app windows get their own label and dragDropEnabled, no initialization script', (platform, osName, sep, delimiter) => {
    const { init } = setup(platform);
    expect(init(mainContents)).toStrictEqual({
      osName, windowLabel: 'main', webviewLabel: 'main', protocolScheme: 'http', sep, delimiter, dragDropEnabled: true,
    });
    expect(init(quickContents)).toMatchObject({ windowLabel: 'quick-assistant', webviewLabel: 'quick-assistant', dragDropEnabled: false });
  });

  it('browser-content gets its webview label inside its host window, never drag-drop, and its initialization script', () => {
    const { init } = setup('win32');
    expect(init(browserContents)).toStrictEqual({
      osName: 'windows', windowLabel: 'main', webviewLabel: 'browser-content', protocolScheme: 'http', sep: '\\', delimiter: ';',
      dragDropEnabled: false, initializationScript: 'window.__probe = 1;',
    });
  });

  it('an unknown webContents gets an error instead of a bridge', () => {
    expect(setup().init(strangerContents)).toEqual({ error: 'unknown webContents' });
  });
});

describe('renderer → main messages', () => {
  const invoke = { type: 'invoke', cmd: 'plugin:app|version', callback: 1, error: 2, payload: {}, headers: { origin: 'tauri://localhost' } };

  it('invokes are routed with the frame URL main holds, not the origin the page claims', () => {
    const { send, calls, windows, browser } = setup();
    send(mainContents, invoke);
    send(mainContents, invoke, null);
    send(mainContents, invoke, { url: 'http://gone.example/', parent: null, detached: true });
    send(browserContents, invoke);
    send(strangerContents, invoke);
    expect(calls).toEqual([
      ['handleInvoke', windows.get(mainContents), invoke, 'http://contents.example/main#frame'],
      ['handleInvoke', windows.get(mainContents), invoke, 'http://contents.example/main'],
      ['handleInvoke', windows.get(mainContents), invoke, 'http://contents.example/main'],
      ['handleBrowserInvoke', browserContents, browser, invoke, 'https://site.example/#frame'],
    ]);
  });

  it('window-drag-end stops the simulated drag of the sending window; script errors and malformed messages are logged only', () => {
    const { send, calls, logs } = setup();
    send(quickContents, { type: 'window-drag-end', extra: 1 });
    send(mainContents, { type: 'script-error', message: 'boom' });
    send(mainContents, { type: 'nope' });
    send(mainContents, null);
    send(browserContents, { type: 'script-error', message: 'inject failed' });
    send(browserContents, { type: 'drag-drop', phase: 'drop', paths: [file] });
    send(browserContents, { type: 'teleport' });
    send(strangerContents, { type: 'script-error', message: 'nobody' });
    expect(calls).toEqual([['stopWindowDrag', 'quick-assistant']]);
    expect(logs).toEqual([
      '[main] initialization script failed: boom',
      '[main] ignored a malformed renderer message: unknown message type',
      '[main] ignored a malformed renderer message: message must be an object',
      '[browser-content] initialization script failed: inject failed',
      '[browser-content] ignored a malformed renderer message: unknown message type',
    ]);
  });
});

describe('external file drag-drop (Tauri DragDropEvent)', () => {
  const target = { kind: 'AnyLabel', label: 'main' };

  it('a drop grants fs and asset scope (folders recursively) and emits paths + position to the window', () => {
    const { send, calls, logs } = setup();
    send(mainContents, { type: 'drag-drop', phase: 'drop', paths: [file, folder, join(tmp, 'missing.txt')], position: { x: 3, y: 4 } });
    expect(calls).toEqual([
      ['fs.allowFile', file],
      ['asset.allowFile', file],
      ['fs.allowDirectory', folder, true],
      ['asset.allowDirectory', folder, true],
      ['emitTo', target, 'tauri://drag-drop', JSON.stringify({ paths: [file, folder], position: { x: 3, y: 4 } })],
    ]);
    expect(logs).toEqual([`[main] drag-drop: ignored 1 path(s) that are not existing absolute paths, first ${JSON.stringify(join(tmp, 'missing.txt'))}`]);
  });

  it('enter / over / leave only emit (paths + position, position, null); nothing is granted before the drop', () => {
    const { send, calls } = setup();
    send(mainContents, { type: 'drag-drop', phase: 'enter', paths: [file], position: { x: 1, y: 2 } });
    send(mainContents, { type: 'drag-drop', phase: 'over', paths: [file], position: { x: 5, y: 6 } });
    send(mainContents, { type: 'drag-drop', phase: 'leave' });
    expect(calls).toEqual([
      ['emitTo', target, 'tauri://drag-enter', JSON.stringify({ paths: [file], position: { x: 1, y: 2 } })],
      ['emitTo', target, 'tauri://drag-over', JSON.stringify({ position: { x: 5, y: 6 } })],
      ['emitTo', target, 'tauri://drag-leave', 'null'],
    ]);
  });

  it('windows without dragDropEnabled and sub frames get nothing granted or emitted', () => {
    const { send, calls, logs } = setup();
    send(quickContents, { type: 'drag-drop', phase: 'drop', paths: [file] });
    send(mainContents, { type: 'drag-drop', phase: 'drop', paths: [file] }, { url: 'http://contents.example/main/frame', parent: {} });
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      '[quick-assistant] drag-drop ignored: drag and drop is disabled for this window',
      '[main] drag-drop ignored: not sent by the top-level frame',
    ]);
  });
});
