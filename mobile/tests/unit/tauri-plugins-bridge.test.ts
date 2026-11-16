// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcPayload, MainToRenderer } from '../../../electron/shell/bridge-messages.ts';
import type { MobileHttpFetchRequest } from '../../src/shell/http.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import {
  readBlobBytes,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type OpfsRootGetter,
  type OpfsWritableFileStream,
} from '../../src/shell/opfs.ts';

class MemoryFileHandle implements OpfsFileHandle {
  readonly kind = 'file' as const;
  private bytes = new Uint8Array(0);
  private lastModified = Date.now();

  constructor(readonly name: string) {}

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { lastModified: this.lastModified });
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream> {
    let buffer = options?.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    return {
      write: async (data) => {
        let next: Uint8Array;
        if (typeof data === 'string') {
          next = new TextEncoder().encode(data);
        } else if (data instanceof Blob) {
          next = await readBlobBytes(data);
        } else if (data instanceof ArrayBuffer) {
          next = new Uint8Array(data);
        } else {
          next = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        if (options?.keepExistingData) {
          const merged = new Uint8Array(buffer.byteLength + next.byteLength);
          merged.set(buffer, 0);
          merged.set(next, buffer.byteLength);
          buffer = merged;
        } else {
          buffer = next;
        }
      },
      close: async () => {
        this.bytes = buffer;
        this.lastModified = Date.now();
      },
    };
  }
}

class MemoryDirectoryHandle implements OpfsDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new DOMException(`TypeMismatchError: ${name} is a file`, 'TypeMismatchError');
      return existing;
    }
    if (!options?.create) throw new DOMException(`NotFoundError: ${name}`, 'NotFoundError');
    const created = new MemoryDirectoryHandle(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new DOMException(`TypeMismatchError: ${name} is a directory`, 'TypeMismatchError');
      return existing;
    }
    if (!options?.create) throw new DOMException(`NotFoundError: ${name}`, 'NotFoundError');
    const created = new MemoryFileHandle(name);
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) throw new DOMException(`NotFoundError: ${name}`, 'NotFoundError');
    if (existing.kind === 'directory' && existing.children.size > 0 && !options?.recursive) {
      throw new DOMException('InvalidModificationError: directory not empty', 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *entries(): AsyncIterable<[string, OpfsFileHandle | OpfsDirectoryHandle]> {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }
}

function createRawInvoker(shell: MobileShell) {
  const waiters = new Map<number, (reply: { ok: boolean; body: unknown }) => void>();
  shell.bridgeTransport().subscribe((message: MainToRenderer) => {
    if (message.type !== 'result') return;
    const callback = Math.min(message.callbackId, message.otherId);
    const body = message.body.kind === 'json' ? JSON.parse(message.body.data) as unknown : message.body.data;
    waiters.get(callback)?.({ ok: message.callbackId === callback, body });
    waiters.delete(callback);
  });
  let next = 0;
  return (cmd: string, args: unknown = {}, headers: Record<string, string> = {}) =>
    new Promise<{ ok: boolean; body: unknown }>((resolve) => {
      const callback = (next += 2);
      waiters.set(callback, resolve);
      const payload: IpcPayload = ArrayBuffer.isView(args)
        ? { contentType: 'application/octet-stream', data: new Uint8Array(args.buffer, args.byteOffset, args.byteLength) }
        : { contentType: 'application/json', data: JSON.stringify(args) };
      shell.bridgeTransport().send({ type: 'invoke', cmd, callback, error: callback + 1, payload, headers });
    });
}

function createHarness(options: {
  onHttpFetch?: (request: MobileHttpFetchRequest) => Promise<{ url: string; status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }>;
  onExportFile?: (path: string, fileName: string) => Promise<{ method: string }>;
} = {}) {
  const root = new MemoryDirectoryHandle('');
  const opfsRoot: OpfsRootGetter = async () => root;
  const channel = new MessageChannel();
  const hostReceived: unknown[] = [];
  channel.port2.addEventListener('message', event => hostReceived.push(event.data));
  channel.port2.start();

  const shell = new MobileShell({
    handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false },
    opfsRoot,
    onHttpFetch: options.onHttpFetch,
    onExportFile: options.onExportFile,
  });
  const invoke = createRawInvoker(shell);
  shell.attach(channel.port1, { onReady() {}, onFatal() {}, onExit() {} });

  return {
    shell,
    invoke,
    hostReceived,
    cleanup() {
      shell.detach('test done');
      channel.port2.close();
    },
  };
}

afterEach(() => {
  document.documentElement.style.zoom = '';
  document.title = '';
  vi.restoreAllMocks();
});

describe('MobileShell Tauri plugin bridges (never forwarded to Host ACL)', () => {
  it('handles plugin:path|* directory resolution and POSIX path operations', async () => {
    const harness = createHarness();
    try {
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 14, path: 'vault/db.sqlite' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/data/vault/db.sqlite' });
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 'AppConfig', path: 'settings.json' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/config/settings.json' });
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 16 }))
        .resolves.toEqual({ ok: true, body: '/deep-student/tmp' });
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 'AppLog', path: 'app.log' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/logs/app.log' });
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 6, path: 'notes.md' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/files/notes.md' });
      await expect(harness.invoke('plugin:path|resolve_directory', { directory: 5, path: 'cache.db' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/local/cache.db' });

      await expect(harness.invoke('plugin:path|join', { paths: ['/deep-student', 'notes', './a.md'] }))
        .resolves.toEqual({ ok: true, body: '/deep-student/notes/a.md' });
      await expect(harness.invoke('plugin:path|resolve', { paths: ['/deep-student/a', '../b/c.txt'] }))
        .resolves.toEqual({ ok: true, body: '/deep-student/b/c.txt' });
      await expect(harness.invoke('plugin:path|normalize', { path: '/deep-student//a/../b/' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/b/' });
      await expect(harness.invoke('plugin:path|basename', { path: '/deep-student/b/c.txt', ext: '.txt' }))
        .resolves.toEqual({ ok: true, body: 'c' });
      await expect(harness.invoke('plugin:path|dirname', { path: '/deep-student/b/c.txt' }))
        .resolves.toEqual({ ok: true, body: '/deep-student/b' });
      await expect(harness.invoke('plugin:path|extname', { path: '/deep-student/b/c.txt' }))
        .resolves.toEqual({ ok: true, body: 'txt' });
      await expect(harness.invoke('plugin:path|is_absolute', { path: '/deep-student' }))
        .resolves.toEqual({ ok: true, body: true });

      await expect.poll(() => harness.hostReceived.length).toBe(1);
      expect(harness.hostReceived[0]).toMatchObject({ kind: 'handshake' });
    } finally {
      harness.cleanup();
    }
  });

  it('handles plugin:fs|* and plugin:resources|close against sandboxed OPFS and rejects path traversal', async () => {
    const harness = createHarness();
    try {
      await expect(harness.invoke('plugin:fs|mkdir', { path: '/deep-student/data/notes', options: { recursive: true } }))
        .resolves.toEqual({ ok: true, body: null });

      const textBytes = new TextEncoder().encode('hello mobile');
      await expect(harness.invoke('plugin:fs|write_text_file', textBytes, {
        path: encodeURIComponent('/deep-student/data/notes/readme.txt'),
        options: JSON.stringify({}),
      })).resolves.toEqual({ ok: true, body: null });

      await expect(harness.invoke('plugin:fs|write_text_file', new TextEncoder().encode('!'), {
        path: encodeURIComponent('/deep-student/data/notes/readme.txt'),
        options: JSON.stringify({ append: true }),
      })).resolves.toEqual({ ok: true, body: null });

      const readText = await harness.invoke('plugin:fs|read_text_file', { path: '/deep-student/data/notes/readme.txt' });
      expect(readText.ok).toBe(true);
      expect(readText.body).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(readText.body as Uint8Array)).toBe('hello mobile!');

      await expect(harness.invoke('plugin:fs|mkdir', { path: 'bin', options: { baseDir: 14, recursive: true } }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:fs|write_file', Uint8Array.from([1, 2, 3, 4]), {
        path: encodeURIComponent('bin/raw.dat'),
        options: JSON.stringify({ baseDir: 14 }),
      })).resolves.toEqual({ ok: true, body: null });

      const readBin = await harness.invoke('plugin:fs|read_file', { path: 'bin/raw.dat', options: { baseDir: 14 } });
      expect(readBin.ok).toBe(true);
      expect(Array.from(readBin.body as Uint8Array)).toEqual([1, 2, 3, 4]);

      await expect(harness.invoke('plugin:fs|exists', { path: '/deep-student/data/notes/readme.txt' }))
        .resolves.toEqual({ ok: true, body: true });
      await expect(harness.invoke('plugin:fs|copy_file', {
        fromPath: '/deep-student/data/notes/readme.txt',
        toPath: '/deep-student/data/notes/copy.txt',
      })).resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:fs|rename', {
        oldPath: '/deep-student/data/notes/copy.txt',
        newPath: '/deep-student/data/notes/moved.txt',
      })).resolves.toEqual({ ok: true, body: null });

      const entries = await harness.invoke('plugin:fs|read_dir', { path: '/deep-student/data/notes' });
      expect(entries.ok).toBe(true);
      expect((entries.body as Array<{ name: string }>).map(item => item.name).sort()).toEqual(['moved.txt', 'readme.txt']);

      const stat = await harness.invoke('plugin:fs|stat', { path: '/deep-student/data/notes/moved.txt' });
      expect(stat).toMatchObject({ ok: true, body: { isFile: true, isDirectory: false, size: 13 } });
      await expect(harness.invoke('plugin:fs|lstat', { path: '/deep-student/data/notes/moved.txt' }))
        .resolves.toMatchObject({ ok: true, body: { isFile: true, size: 13 } });

      // Open / write / seek / read / fstat / truncate / close handle lifecycle
      const opened = await harness.invoke('plugin:fs|open', {
        path: '/deep-student/data/notes/handle.txt',
        options: { read: true, write: true, create: true },
      });
      expect(opened.ok).toBe(true);
      const rid = opened.body as number;
      await expect(harness.invoke('plugin:fs|write', { rid, data: [65, 66, 67, 68] }))
        .resolves.toEqual({ ok: true, body: 4 });
      await expect(harness.invoke('plugin:fs|seek', { rid, offset: 1, whence: 0 }))
        .resolves.toEqual({ ok: true, body: 1 });
      const chunk = await harness.invoke('plugin:fs|read', { rid, len: 2 });
      expect(chunk.ok).toBe(true);
      const rawChunk = chunk.body as Uint8Array;
      expect(Array.from(rawChunk.subarray(0, 2))).toEqual([66, 67]);
      const nread = new DataView(rawChunk.buffer, rawChunk.byteOffset + 2, 8).getBigUint64(0, false);
      expect(nread).toBe(2n);
      await expect(harness.invoke('plugin:fs|fstat', { rid }))
        .resolves.toMatchObject({ ok: true, body: { isFile: true, size: 4 } });
      await expect(harness.invoke('plugin:resources|close', { rid }))
        .resolves.toEqual({ ok: true, body: null });

      await expect(harness.invoke('plugin:fs|remove', { path: '/deep-student/data/notes', options: { recursive: true } }))
        .resolves.toEqual({ ok: true, body: null });

      // Security: reject traversal and out-of-sandbox paths
      const traversal = await harness.invoke('plugin:fs|read_text_file', { path: '/deep-student/../etc/passwd' });
      expect(traversal.ok).toBe(false);
      expect(String(traversal.body)).toContain('cannot traverse directory');

      const outside = await harness.invoke('plugin:fs|exists', { path: '/etc/passwd' });
      expect(outside.ok).toBe(false);
      expect(String(outside.body)).toContain('forbidden path');

      await expect.poll(() => harness.hostReceived.length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('handles plugin:http|* fetch lifecycle, JSON body forwarding, data URLs, and cancel', async () => {
    const fetcher = vi.fn(async (req: MobileHttpFetchRequest) => {
      return {
        url: req.url,
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ method: req.method, receivedBody: req.body })),
      };
    });
    const harness = createHarness({ onHttpFetch: fetcher });
    try {
      const jsonBytes = Array.from(new TextEncoder().encode('{"hello":"world"}'));
      const reqReply = await harness.invoke('plugin:http|fetch', {
        clientConfig: {
          method: 'POST',
          url: 'https://api.example.com/v1/models',
          headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer test']],
          data: jsonBytes,
          connectTimeout: 5000,
        },
      });
      expect(reqReply.ok).toBe(true);
      const rid = reqReply.body as number;

      const sendReply = await harness.invoke('plugin:http|fetch_send', { rid });
      expect(sendReply).toMatchObject({
        ok: true,
        body: { status: 201, statusText: 'Created', url: 'https://api.example.com/v1/models' },
      });
      expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://api.example.com/v1/models',
        method: 'POST',
        body: '{"hello":"world"}',
        timeoutMs: 5000,
      }));
      const resRid = (sendReply.body as { rid: number }).rid;

      const chunk1 = await harness.invoke('plugin:http|fetch_read_body', { rid: resRid });
      expect(chunk1.ok).toBe(true);
      const bytes1 = chunk1.body as Uint8Array;
      expect(bytes1[bytes1.byteLength - 1]).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(bytes1.subarray(0, bytes1.byteLength - 1)))).toEqual({
        method: 'POST',
        receivedBody: '{"hello":"world"}',
      });

      const eof = await harness.invoke('plugin:http|fetch_read_body', { rid: resRid });
      expect(eof.ok).toBe(true);
      expect(Array.from(eof.body as Uint8Array)).toEqual([1]);

      // data: URL support
      const dataReq = await harness.invoke('plugin:http|fetch', {
        clientConfig: { method: 'GET', url: 'data:text/plain;base64,aGVsbG8=' },
      });
      const dataSend = await harness.invoke('plugin:http|fetch_send', { rid: dataReq.body });
      const dataBody = await harness.invoke('plugin:http|fetch_read_body', { rid: (dataSend.body as { rid: number }).rid });
      const dataBytes = dataBody.body as Uint8Array;
      expect(new TextDecoder().decode(dataBytes.subarray(0, dataBytes.byteLength - 1))).toBe('hello');

      // fetch_cancel & fetch_cancel_body
      const cancelReq = await harness.invoke('plugin:http|fetch', {
        clientConfig: { method: 'GET', url: 'https://api.example.com/slow' },
      });
      await expect(harness.invoke('plugin:http|fetch_cancel', { rid: cancelReq.body }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:http|fetch_cancel_body', { rid: 999999 }))
        .resolves.toEqual({ ok: true, body: null });

      await expect.poll(() => harness.hostReceived.length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('handles plugin:opener|* url validation and OPFS sandbox export', async () => {
    const onExportFile = vi.fn(async () => ({ method: 'share' }));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const harness = createHarness({ onExportFile });
    try {
      await expect(harness.invoke('plugin:opener|open_url', { url: 'https://example.com/docs' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(openSpy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');

      await expect(harness.invoke('plugin:opener|open_url', { url: 'mailto:help@example.com' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(openSpy).toHaveBeenCalledWith('mailto:help@example.com', '_blank', 'noopener,noreferrer');

      const blocked = await harness.invoke('plugin:opener|open_url', { url: 'javascript:alert(1)' });
      expect(blocked.ok).toBe(false);

      await expect(harness.invoke('plugin:fs|mkdir', { path: '/deep-student/tmp', options: { recursive: true } }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:fs|write_text_file', new TextEncoder().encode('report'), {
        path: encodeURIComponent('/deep-student/tmp/report.txt'),
      })).resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:opener|open_path', { path: '/deep-student/tmp/report.txt' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(onExportFile).toHaveBeenCalledWith('/deep-student/tmp/report.txt', 'report.txt');

      await expect(harness.invoke('plugin:opener|reveal_item_in_dir', { paths: ['/deep-student/tmp/report.txt'] }))
        .resolves.toEqual({ ok: true, body: null });
      expect(onExportFile).toHaveBeenCalledTimes(2);

      const externalPath = await harness.invoke('plugin:opener|open_path', { path: '/etc/hosts' });
      expect(externalPath.ok).toBe(false);
      expect(String(externalPath.body)).not.toContain('ACL');

      await expect.poll(() => harness.hostReceived.length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('handles plugin:clipboard-manager|*, webview|*, haptics|*, and window|* commands', async () => {
    const harness = createHarness();
    try {
      // Clipboard: navigator.clipboard primary path
      let clipValue = '';
      const writeText = vi.fn(async (text: string) => { clipValue = text; });
      const readText = vi.fn(async () => clipValue);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText, readText },
        configurable: true,
      });

      await expect(harness.invoke('plugin:clipboard-manager|write_text', { text: 'copied text' }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:clipboard-manager|read_text', {}))
        .resolves.toEqual({ ok: true, body: 'copied text' });

      // Clipboard: textarea fallback when navigator.clipboard rejects
      writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
      const execSpy = vi.fn(() => true);
      Object.defineProperty(document, 'execCommand', { value: execSpy, configurable: true });
      await expect(harness.invoke('plugin:clipboard-manager|write_text', { text: 'fallback text' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(execSpy).toHaveBeenCalledWith('copy');

      // Webview zoom (clamped [0.5, 2.0]) and layout queries
      await expect(harness.invoke('plugin:webview|get_all_webviews', {}))
        .resolves.toEqual({ ok: true, body: [{ windowLabel: 'main', label: 'main' }] });
      await expect(harness.invoke('plugin:webview|set_webview_zoom', { value: 3.5 }))
        .resolves.toEqual({ ok: true, body: null });
      expect(document.documentElement.style.zoom).toBe('2');
      await expect(harness.invoke('plugin:webview|set_webview_zoom', { value: 0.2 }))
        .resolves.toEqual({ ok: true, body: null });
      expect(document.documentElement.style.zoom).toBe('0.5');
      await expect(harness.invoke('plugin:webview|set_webview_size', { label: 'main', size: { Logical: { width: 400, height: 800 } } }))
        .resolves.toEqual({ ok: true, body: null });

      // Haptics: bridges to navigator.vibrate and never throws if blocked
      const vibrate = vi.fn(() => true);
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      await expect(harness.invoke('plugin:haptics|impact', { style: 'medium' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(vibrate).toHaveBeenCalledWith(20);
      await expect(harness.invoke('plugin:haptics|notification', { type: 'error' }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:haptics|selection_changed', {}))
        .resolves.toEqual({ ok: true, body: null });
      vibrate.mockImplementationOnce(() => { throw new Error('blocked'); });
      await expect(harness.invoke('plugin:haptics|vibrate', { duration: 30 }))
        .resolves.toEqual({ ok: true, body: null });

      // Window commands
      await expect(harness.invoke('plugin:window|get_all_windows', {}))
        .resolves.toEqual({ ok: true, body: ['main'] });
      await expect(harness.invoke('plugin:window|is_maximized', {}))
        .resolves.toEqual({ ok: true, body: false });
      await expect(harness.invoke('plugin:window|set_title', { value: 'Deep Student Mobile' }))
        .resolves.toEqual({ ok: true, body: null });
      expect(document.title).toBe('Deep Student Mobile');
      await expect(harness.invoke('plugin:window|scale_factor', {}))
        .resolves.toEqual({ ok: true, body: 1 });
      await expect(harness.invoke('plugin:window|inner_size', {}))
        .resolves.toEqual({ ok: true, body: { width: window.innerWidth, height: window.innerHeight } });
      await expect(harness.invoke('plugin:window|theme', {}))
        .resolves.toEqual({ ok: true, body: 'light' });
      await expect(harness.invoke('plugin:window|set_resizable', { value: false }))
        .resolves.toEqual({ ok: true, body: null });
      await expect(harness.invoke('plugin:window|center', {}))
        .resolves.toEqual({ ok: true, body: null });

      await expect.poll(() => harness.hostReceived.length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });
});
