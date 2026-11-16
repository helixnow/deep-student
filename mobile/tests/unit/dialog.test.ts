// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileDialogHandler, filtersToAccept, sanitizeDialogFileName } from '../../src/shell/dialog.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import { rendererInvoker } from './support/renderer.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function selectFiles(files: File[]) {
  const input = document.querySelector('input')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

describe('MobileShell plugin:dialog|* routing', () => {
  it('intercepts plugin:dialog|* before forwarding to the Host port', async () => {
    const channel = new MessageChannel();
    const hostReceived: unknown[] = [];
    channel.port2.addEventListener('message', event => hostReceived.push(event.data));
    channel.port2.start();

    const onDialogCommand = vi.fn(async (command: string, args: Record<string, unknown>) => ({ command, args }));
    const shell = new MobileShell({
      handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false },
      onDialogCommand,
    });
    const invoke = rendererInvoker(shell);
    shell.attach(channel.port1, { onReady() {}, onFatal() {}, onExit() {} });

    try {
      const reply = await invoke('plugin:dialog|message', { message: 'hello', title: 'Notice' });
      expect(reply).toEqual({
        ok: true,
        body: { command: 'message', args: { message: 'hello', title: 'Notice' } },
      });
      expect(onDialogCommand).toHaveBeenCalledWith('message', { message: 'hello', title: 'Notice' });
      // Host port must only receive the initial handshake, never the dialog invoke.
      await expect.poll(() => hostReceived.length).toBe(1);
      expect(hostReceived[0]).toMatchObject({ kind: 'handshake' });
    } finally {
      shell.detach('test finished');
      channel.port2.close();
    }
  });

  it('fails cleanly with a non-ACL error when onDialogCommand is omitted', async () => {
    const channel = new MessageChannel();
    const hostReceived: unknown[] = [];
    channel.port2.addEventListener('message', event => hostReceived.push(event.data));
    channel.port2.start();

    const shell = new MobileShell({
      handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false },
    });
    const invoke = rendererInvoker(shell);
    shell.attach(channel.port1, { onReady() {}, onFatal() {}, onExit() {} });

    try {
      const reply = await invoke('plugin:dialog|open', { options: {} });
      expect(reply.ok).toBe(false);
      expect(String(reply.body)).not.toContain('ACL');
      expect(String(reply.body)).toContain('open');
      await expect.poll(() => hostReceived.length).toBe(1);
      expect(hostReceived[0]).toMatchObject({ kind: 'handshake' });
    } finally {
      shell.detach('test finished');
      channel.port2.close();
    }
  });

  it('rejects malformed dialog payloads and surfaces handler errors without touching Host', async () => {
    const shell = new MobileShell({
      handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false },
      onDialogCommand() {
        throw new Error('sync boom');
      },
    });
    const invoke = rendererInvoker(shell);
    await expect(invoke('plugin:dialog|save', { options: {} })).resolves.toEqual({ ok: false, body: 'sync boom' });

    const replies: unknown[] = [];
    shell.bridgeTransport().subscribe(message => replies.push(message));
    shell.bridgeTransport().send({
      type: 'invoke',
      cmd: 'plugin:dialog|open',
      callback: 100,
      error: 101,
      payload: { contentType: 'application/json', data: '{not-json' },
      headers: {},
    });
    expect(replies).toEqual([
      { type: 'result', callbackId: 101, otherId: 100, body: { kind: 'json', data: expect.stringContaining('invalid args JSON') } },
    ]);
  });
});

describe('mobile dialog handler', () => {
  it('maps DialogFilter extensions to <input accept> and ignores wildcards', () => {
    expect(filtersToAccept([
      { name: 'Docs', extensions: ['pdf', '.md', '*', '*.*'] },
      { name: 'Images', extensions: ['png', 'pdf', 'image/jpeg'] },
    ])).toBe('.pdf,.md,.png,image/jpeg');
    expect(filtersToAccept([{ name: 'All', extensions: ['*'] }])).toBe('');
    expect(filtersToAccept(undefined)).toBe('');
  });

  it('sanitizes selected filenames against traversal and control characters', () => {
    expect(sanitizeDialogFileName('notes.md')).toBe('notes.md');
    expect(sanitizeDialogFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDialogFileName('folder\\bad\nfile\0name.txt')).toBe('bad_file_name.txt');
    expect(sanitizeDialogFileName('..')).toBe('file');
    expect(sanitizeDialogFileName('.')).toBe('file');
    expect(sanitizeDialogFileName('   ')).toBe('file');
  });

  it('open streams a single picked File directly into OPFS without arrayBuffer buffering', async () => {
    const written: Array<{ path: string; data: Blob | Uint8Array }> = [];
    const handler = createMobileDialogHandler(async (path, data) => {
      written.push({ path, data });
    });

    const file = new File(['hello'], '../my\tnotes.txt', { type: 'text/plain' });
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBufferSpy });

    const pending = handler('open', {
      options: {
        filters: [{ name: 'Text', extensions: ['txt', '*'] }],
      },
    });

    const input = document.querySelector('input')!;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(false);
    expect(input.accept).toBe('.txt');

    selectFiles([file]);
    const result = await pending;

    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\/deep-student\/tmp\/dialog-picks\/[0-9a-f-]{36}\/my_notes\.txt$/);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe(result);
    expect(written[0]!.data).toBe(file);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(document.querySelector('input')).toBeNull();
  });

  it('open supports multiple selection and returns an array of OPFS paths', async () => {
    const written: Array<{ path: string; data: Blob | Uint8Array }> = [];
    const handler = createMobileDialogHandler(async (path, data) => {
      written.push({ path, data });
    });

    const pending = handler('open', { options: { multiple: true } });
    const input = document.querySelector('input')!;
    expect(input.multiple).toBe(true);

    const f1 = new File(['a'], 'a.png', { type: 'image/png' });
    const f2 = new File(['b'], 'a.png', { type: 'image/png' });
    selectFiles([f1, f2]);

    const result = await pending as string[];
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^\/deep-student\/tmp\/dialog-picks\/[0-9a-f-]{36}\/a\.png$/);
    expect(result[1]).toMatch(/^\/deep-student\/tmp\/dialog-picks\/[0-9a-f-]{36}\/a\.png$/);
    expect(result[0]).not.toBe(result[1]);
    expect(written.map(w => w.data)).toEqual([f1, f2]);
    expect(document.querySelector('input')).toBeNull();
  });

  it('open returns null on cancel or empty selection and cleans up input', async () => {
    const writeFile = vi.fn(async () => undefined);
    const handler = createMobileDialogHandler(writeFile);

    const pendingCancel = handler('open', { options: {} });
    document.querySelector('input')!.dispatchEvent(new Event('cancel'));
    await expect(pendingCancel).resolves.toBeNull();
    expect(document.querySelector('input')).toBeNull();

    const pendingEmpty = handler('open', { options: {} });
    selectFiles([]);
    await expect(pendingEmpty).resolves.toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('open rejects directory selection and OPFS write errors cleanly', async () => {
    const handler = createMobileDialogHandler(async () => {
      throw new Error('opfs full');
    });

    await expect(handler('open', { options: { directory: true } }))
      .rejects.toThrow('当前移动端暂不支持选择本地文件夹');

    const pending = handler('open', { options: {} });
    selectFiles([new File(['x'], 'x.bin')]);
    await expect(pending).rejects.toThrow('opfs full');
    expect(document.querySelector('input')).toBeNull();
  });

  it('save allocates a writable staged OPFS path with sanitized filename and default export.bin', async () => {
    const ensureDir = vi.fn(async () => undefined);
    const handler = createMobileDialogHandler(async () => undefined, ensureDir);

    const saved = await handler('save', { options: { defaultPath: '/tmp/nested/notes?.md' } });
    expect(saved).toMatch(/^\/deep-student\/tmp\/dialog-saves\/[^/]+\/notes\?\.md$/);
    expect(ensureDir).toHaveBeenCalledTimes(1);
    const parentDir = String(saved).slice(0, String(saved).lastIndexOf('/'));
    expect(ensureDir).toHaveBeenCalledWith(parentDir);

    const fallbackDefault = await handler('save', { options: {} });
    expect(fallbackDefault).toMatch(/^\/deep-student\/tmp\/dialog-saves\/[^/]+\/export\.bin$/);

    const fallbackTraversal = await handler('save', { options: { defaultPath: '../..' } });
    expect(fallbackTraversal).toMatch(/^\/deep-student\/tmp\/dialog-saves\/[^/]+\/export\.bin$/);
  });

  it('message calls alert with formatted title/message and returns okButtonLabel or Ok', async () => {
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => undefined);
    const handler = createMobileDialogHandler(async () => undefined);

    await expect(handler('message', { message: 'Saved', title: 'Info', okButtonLabel: 'Got it' }))
      .resolves.toBe('Got it');
    expect(alertSpy).toHaveBeenCalledWith('Info\n\nSaved');

    await expect(handler('message', { message: 'Only message' })).resolves.toBe('Ok');
    expect(alertSpy).toHaveBeenCalledWith('Only message');
  });

  it('ask and confirm call confirm and return boolean results', async () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const handler = createMobileDialogHandler(async () => undefined);

    await expect(handler('ask', { message: 'Proceed?', title: 'Confirm' })).resolves.toBe(true);
    expect(confirmSpy).toHaveBeenNthCalledWith(1, 'Confirm\n\nProceed?');

    await expect(handler('confirm', { message: 'Delete item?' })).resolves.toBe(false);
    expect(confirmSpy).toHaveBeenNthCalledWith(2, 'Delete item?');
  });
});
