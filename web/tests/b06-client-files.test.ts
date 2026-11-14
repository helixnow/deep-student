// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeTransport } from '../../electron/preload/bridge.ts';
import type { InvokeMessage, MainToRenderer } from '../../electron/shell/bridge-messages.ts';

const bridge = vi.hoisted(() => ({ transport: null as BridgeTransport | null }));
vi.mock('../../electron/preload/bridge.ts', () => ({
  installTauriBridge: (transport: BridgeTransport) => { bridge.transport = transport; },
}));
import { bootstrapWebClient } from '../client/bootstrap.ts';

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(_url: string) { super(); FakeSocket.instances.push(this); }
  send(data: unknown) { this.sent.push(data); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  reply(message: MainToRenderer) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

const invoke = (cmd: string, callback: number, args: unknown = {}): InvokeMessage => ({
  type: 'invoke', cmd, callback, error: callback + 1, headers: {},
  payload: { contentType: 'application/json', data: JSON.stringify(args) },
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let removeBootstrapListeners: () => void;
let results: MainToRenderer[];
let socket: FakeSocket;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const windowEvents = vi.spyOn(window, 'addEventListener');
  const documentEvents = vi.spyOn(document, 'addEventListener');
  removeBootstrapListeners = () => {
    for (const [name, listener, options] of windowEvents.mock.calls) {
      window.removeEventListener(name, listener, options);
    }
    for (const [name, listener, options] of documentEvents.mock.calls) {
      document.removeEventListener(name, listener, options);
    }
  };
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  fetchMock = vi.fn().mockResolvedValue({ status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  const client = bootstrapWebClient();
  await flush();
  socket = FakeSocket.instances[0]!;
  socket.open();
  await client.connected;
  results = [];
  bridge.transport!.subscribe((message) => results.push(message));
});

beforeEach(() => {
  results.length = 0;
  socket.sent.length = 0;
  fetchMock.mockReset().mockResolvedValue({ status: 200 });
});

afterAll(() => {
  removeBootstrapListeners();
  document.querySelectorAll('input[type=file]').forEach((input) => input.remove());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function selectFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: files });
  input.dispatchEvent(new Event('change'));
}

it('distinguishes picker cancellation from an upload failure', async () => {
  bridge.transport!.send(invoke('plugin:dialog|open', 10));
  document.querySelector('input[type=file]')!.dispatchEvent(new Event('cancel'));
  await flush();
  expect(results.at(-1)).toMatchObject({ callbackId: 10, body: { data: 'null' } });
  expect(fetchMock).not.toHaveBeenCalled();

  bridge.transport!.send(invoke('plugin:dialog|open', 20));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 413, text: async () => 'File exceeds limit' });
  selectFiles([new File(['pdf'], 'report.pdf', { type: 'application/pdf' })]);
  await flush();
  expect(results.at(-1)).toMatchObject({ callbackId: 21, otherId: 20 });
  expect((results.at(-1) as Extract<MainToRenderer, { type: 'result' }>).body.data).toContain('413');
  expect(document.querySelector('input[type=file]')).toBeNull();
});

it('stages PDF and audio as one raw HTTP upload each and waits for all uploads', async () => {
  bridge.transport!.send(invoke('plugin:dialog|open', 30, { options: { multiple: true } }));
  const files = [new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }),
    new File(['audio'], 'lecture.mp3', { type: 'audio/mpeg' })];
  let finishAudio!: (value: unknown) => void;
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ path: '/stage/report.pdf' }) });
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishAudio = resolve; }));
  selectFiles(files);
  await flush();
  expect(results).toHaveLength(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (let i = 0; i < files.length; i++) {
    expect(fetchMock.mock.calls[i]![1]).toMatchObject({ method: 'POST', body: files[i] });
    expect(fetchMock.mock.calls[i]![1].body).toBe(files[i]);
  }
  finishAudio({ ok: true, json: async () => ({ path: '/stage/lecture.mp3' }) });
  await flush();
  expect(results.at(-1)).toMatchObject({ callbackId: 30,
    body: { data: JSON.stringify(['/stage/report.pdf', '/stage/lecture.mp3']) } });
  expect(socket.sent).toHaveLength(0);
});

it('does not deliver a slow drop to a different target mounted during upload', async () => {
  socket.reply({ type: 'listen-js', event: 'tauri://drag-drop', eventId: 100,
    target: { kind: 'Any' }, handlerId: 200 });
  let finishUpload!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
  const drop = new Event('drop', { cancelable: true });
  Object.defineProperties(drop, { dataTransfer: { value: { files: [new File(['pdf'], 'report.pdf')] } },
    clientX: { value: 20 }, clientY: { value: 30 } });
  window.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  bridge.transport!.send(invoke('plugin:event|unlisten', 40, { event: 'tauri://drag-drop', eventId: 100 }));
  socket.reply({ type: 'listen-js', event: 'tauri://drag-drop', eventId: 101,
    target: { kind: 'Any' }, handlerId: 201 });
  finishUpload({ ok: true, json: async () => ({ path: '/stage/report.pdf' }) });
  await flush();
  expect(results.filter((message) => message.type === 'emit-js' && message.event === 'tauri://drag-drop')).toEqual([]);
  bridge.transport!.send(invoke('plugin:event|unlisten', 42, { event: 'tauri://drag-drop', eventId: 101 }));
});

it('delivers a drop once to its surviving listener, excluding listeners mounted during upload', async () => {
  socket.reply({ type: 'listen-js', event: 'tauri://drag-drop', eventId: 103,
    target: { kind: 'Any' }, handlerId: 203 });
  let finishUpload!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
  const file = new File(['video'], 'lecture.mp4', { type: 'video/mp4' });
  const drop = new Event('drop', { cancelable: true });
  Object.defineProperties(drop, { dataTransfer: { value: { files: [file] } },
    clientX: { value: 20 }, clientY: { value: 30 } });
  window.dispatchEvent(drop);
  socket.reply({ type: 'listen-js', event: 'tauri://drag-drop', eventId: 102,
    target: { kind: 'Any' }, handlerId: 202 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1].body).toBe(file);
  finishUpload({ ok: true, json: async () => ({ path: '/stage/lecture.mp4' }) });
  await flush();
  const drops = results.filter((message) => message.type === 'emit-js' && message.event === 'tauri://drag-drop');
  expect(drops).toHaveLength(1);
  expect(drops[0]).toMatchObject({ ids: [103] });
});

it('starts one direct HTTP export only after a successful server-side copy', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
    path: '/exports/report.pdf', exportId: 'export-1', fileName: 'report.pdf',
  }) });
  bridge.transport!.send(invoke('plugin:dialog|save', 50, { options: { defaultPath: 'report.pdf' } }));
  await flush();
  bridge.transport!.send(invoke('copy_file', 52, { sourcePath: '/stage/report.pdf', destPath: '/exports/report.pdf' }));
  expect(click).not.toHaveBeenCalled();
  socket.reply({ type: 'result', callbackId: 53, otherId: 52, body: { kind: 'json', data: '"failed"' } });
  expect(click).not.toHaveBeenCalled();
  bridge.transport!.send(invoke('copy_file', 54, { sourcePath: '/stage/report.pdf', destPath: '/exports/report.pdf' }));
  socket.reply({ type: 'result', callbackId: 54, otherId: 55, body: { kind: 'json', data: 'null' } });
  expect(click).toHaveBeenCalledTimes(1);
  const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
  expect(anchor.getAttribute('href')).toBe('/api/files/export?exportId=export-1');
  expect(anchor.download).toBe('report.pdf');
  expect(fetchMock).toHaveBeenCalledTimes(1); // No fetch/blob/base64 round-trip for downloading.
});
