import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShellError, type ShellErrorData } from '../api.ts';
import { serveHost } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { messagePortTransport } from '../transports.ts';
import type { HostToMain, ShellRequest, ShellResponse } from '../protocol.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0)) await close(); }
  finally { vi.useRealTimers(); }
});

async function boot() {
  const dir = mkdtempSync('/tmp/opencode/wp193-');
  const profile = join(dir, 'empty.json');
  writeFileSync(profile, '{"plugins":[]}');
  const { port1, port2 } = new MessageChannel();
  const ready = new Promise<void>(resolve => {
    port2.on('message', (message: HostToMain) => { if (message.kind === 'ready') resolve(); });
  });
  let exit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const session = serveHost(messagePortTransport(port1), {
    profile, contracts: () => new ContractSet([]), exit,
  });
  cleanup.push(async () => {
    await session.shutdown();
    port2.close();
    rmSync(dir, { recursive: true, force: true });
  });
  port2.postMessage({ kind: 'handshake', protocol: 1, appDataDir: dir, appVersion: 'test', platform: 'linux', debug: true });
  const runtime = await session.ready;
  if (!runtime) throw new Error('Host did not become ready');
  await ready;
  // Keep actual MessagePort delivery; only the existing Shell timeout clock is controlled.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const request = async (op: string, args?: unknown) => {
    const sent = new Promise<ShellRequest>(resolve => {
      const receive = (message: HostToMain) => {
        if (message.kind !== 'shell-request') return;
        port2.off('message', receive);
        resolve(message);
      };
      port2.on('message', receive);
    });
    const resolved = vi.fn((value: unknown) => value);
    const rejected = vi.fn((error: unknown) => error);
    // Attach rejection observation before the main endpoint can reply or disconnect.
    const result = runtime.ctx.shell.request(op, args).then(resolved, rejected);
    return { message: await sent, result, resolved, rejected };
  };
  const reply = (response: ShellResponse) => port2.postMessage(response);
  return { runtime, request, reply, port2, exited };
}

describe('WP-193 Shell errors over real MessagePort', () => {
  const bodies: ShellErrorData[] = [
    {
      code: 'BLOCKED', message: 'password fields cannot be typed by agent bridge',
      details: { reason: 'password_field', ref: 'e1', nested: [null, false, 0, '原样', { retry: false }] },
    },
    { code: 'EVAL_THROW', message: 'x' },
    { code: 'NOT_READY', message: 'bridge not ready', details: null },
  ];

  // bridge.rs::parse_envelope_password_blocked / finish_script_result_maps_bridge_error_envelope
  // supply the data semantics; this test covers the additional main→Host transport seam.
  it.each(bodies)('retains code/message/details and the separate display string ($code)', async errorData => {
    const { runtime, request, reply } = await boot();
    const call = await request('browser.type', { ref: 'e1', text: 'hello' });
    expect(call.message).toEqual({ kind: 'shell-request', id: expect.any(String), op: 'browser.type', args: { ref: 'e1', text: 'hello' } });
    expect(runtime.shell._pending.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    // Deliberately independent of data.message: error remains the authoritative display.
    const display = `main operation failed: bridge error ${errorData.code}: ${errorData.message}`;
    reply({ kind: 'shell-result', id: call.message.id, ok: false, error: display, errorData });
    const error = await call.result;
    expect(error).toHaveProperty('data', errorData);
    expect(error).toBeInstanceOf(ShellError); // public api.ts is the actual rejection class
    if (!(error instanceof ShellError)) throw new Error('expected ShellError');
    expect(error.op).toBe('browser.type');
    expect(error.message).toBe(display);
    expect(String(error)).toBe(`ShellError: ${display}`);
    expect(error.data).toStrictEqual(errorData);
    expect(error.data).not.toBe(errorData); // structured clone, not an in-memory reply
    expect(error).not.toHaveProperty('kind');
    expect(call.resolved).not.toHaveBeenCalled();
    expect(call.rejected).toHaveBeenCalledTimes(1);
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.rejected).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary string failures without deriving data from bridge-looking text', async () => {
    const { runtime, request, reply } = await boot();
    const call = await request('browser.click');
    const display = 'bridge error BLOCKED: user cancelled';
    reply({ kind: 'shell-result', id: call.message.id, ok: false, error: display });
    expect(await call.result).toMatchObject({ name: 'ShellError', op: 'browser.click', message: display });
    expect(await call.result).toHaveProperty('data', undefined);
    expect(call.rejected).toHaveBeenCalledTimes(1);
    expect(call.resolved).not.toHaveBeenCalled();
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pairs successful replies by id and ignores duplicate/unknown results without disturbing another timer', async () => {
    const { runtime, request, reply } = await boot();
    const first = await request('window.title');
    const second = await request('dialog.open');
    expect(first.message.args).toBeNull();
    expect(second.message.id).not.toBe(first.message.id);
    expect(vi.getTimerCount()).toBe(2);
    reply({ kind: 'shell-result', id: second.message.id, ok: true, value: { paths: ['文件.pdf'] } });
    expect(await second.result).toEqual({ paths: ['文件.pdf'] });
    expect(runtime.shell._pending.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    reply({ kind: 'shell-result', id: second.message.id, ok: false, error: 'duplicate', errorData: bodies[0] });
    reply({ kind: 'shell-result', id: 'unknown', ok: true, value: 'ignored' });
    // Same port preserves message order: the first result is a barrier for the two ignored replies.
    reply({ kind: 'shell-result', id: first.message.id, ok: true, value: 'title' });
    expect(await first.result).toBe('title');
    expect(first.resolved).toHaveBeenCalledTimes(1);
    expect(second.resolved).toHaveBeenCalledTimes(1);
    expect(first.rejected).not.toHaveBeenCalled();
    expect(second.rejected).not.toHaveBeenCalled();
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.rejected).not.toHaveBeenCalled();
    expect(second.rejected).not.toHaveBeenCalled();
  });

  it('retains the existing timeout and discards a late typed failure', async () => {
    const { runtime, request, reply } = await boot();
    const call = await request('browser.snapshot');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.resolved).not.toHaveBeenCalled();
    expect(call.rejected).not.toHaveBeenCalled();
    expect(runtime.shell._pending.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await call.result;
    expect(error).toMatchObject({ name: 'ShellError', op: 'browser.snapshot', message: 'shell request "browser.snapshot" timed out after 30000ms' });
    expect(error).toHaveProperty('data', undefined);
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const next = await request('window.title');
    reply({ kind: 'shell-result', id: call.message.id, ok: false, error: 'late', errorData: bodies[0] });
    reply({ kind: 'shell-result', id: next.message.id, ok: true, value: 'still connected' });
    expect(await next.result).toBe('still connected');
    expect(await call.result).toBe(error);
    expect(call.rejected).toHaveBeenCalledTimes(1);
    expect(call.resolved).not.toHaveBeenCalled();
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects every pending request on actual port close and clears all timers', async () => {
    const { runtime, request, port2, exited } = await boot();
    const calls = [await request('browser.ready'), await request('dialog.open')];
    expect(runtime.shell._pending.size).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    port2.close();
    for (const call of calls) {
      const error = await call.result;
      expect(error).toMatchObject({ name: 'ShellError', op: call.message.op,
        message: `shell request "${call.message.op}" failed: Host is shutting down` });
      expect(error).toHaveProperty('data', undefined);
      expect(call.rejected).toHaveBeenCalledTimes(1);
      expect(call.resolved).not.toHaveBeenCalled();
    }
    await expect(exited).resolves.toBe(0);
    expect(runtime.shell._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const call of calls) expect(call.rejected).toHaveBeenCalledTimes(1);
  });
});
