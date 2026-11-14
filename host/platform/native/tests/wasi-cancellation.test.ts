import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { holdNextWasmRun } from '../wasm/loader.ts';

describe('spawn_blocking-compatible WASI execution', () => {
  it('cancellation_interrupts_blocked_call: aborts while a real host callback is pending without replaying its side effect', async () => {
    const host = await createTestHost({ plugins: [native] });
    const controller = new AbortController();
    let calls = 0;
    try {
      const evaluation = host.ctx.nativeStarlark.evaluate('call("waiting", {})', {
        limits: { max_callstack_size: 256, max_heap_bytes: 32 * 1024 * 1024, max_tick_count: 10_000_000 },
        signal: controller.signal, deadlineMs: Date.now() + 30_000,
        call: async () => { calls++; controller.abort(); return new Promise(() => {}); },
        objectRead: async () => null, objectWrite: async () => null,
      });
      await expect(evaluation).rejects.toThrow('ptc_run script error: Evaluation cancelled');
      expect(calls).toBe(1);
    } finally { await host.dispose(); }
  });

  it('interrupts CPU-bound Starlark without blocking the Host timer or leaving the next evaluation unusable', async () => {
    const host = await createTestHost({ plugins: [native] });
    const controller = new AbortController();
    const options = { limits: { max_callstack_size: 256, max_heap_bytes: 32 * 1024 * 1024, max_tick_count: 1_000_000_000_000 },
      signal: controller.signal, deadlineMs: Date.now() + 30_000,
      call: async () => null, objectRead: async () => null, objectWrite: async () => null };
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const start = performance.now();
      await expect(host.ctx.nativeStarlark.evaluate('for i in range(1000000000):\n  x = i\n', options)).rejects
        .toThrow('ptc_run script error: Evaluation cancelled');
      expect(performance.now() - start).toBeLessThan(5000);
      expect(await host.ctx.nativeStarlark.evaluate('1+1', { ...options, signal: new AbortController().signal })).toBe(2);
    } finally { clearTimeout(timer); await host.dispose(); }
  });

  it('cancellation_stops_decoding: aborts an in-flight real WAV decode and does not publish PCM afterwards', async () => {
    const host = await createTestHost({ plugins: [native] });
    const root = await mkdtemp(join(tmpdir(), 'f7-cancel-audio-'));
    const controller = new AbortController();
    let samples = 0;
    // One minute, 44.1kHz mono PCM: long enough to exercise worker cancellation.
    const pcm = Buffer.alloc(44100 * 60 * 2), header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(44100, 24); header.writeUInt32LE(88200, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const path = join(root, 'audio.wav');
    await writeFile(path, Buffer.concat([header, pcm]));
    // The engine reads this file in ~170 fd_read calls while it decodes; holding the guest in the
    // 64th keeps the decode in flight until the abort lands, however fast the machine decodes.
    let held = 0;
    holdNextWasmRun({ call: 'fd_read', nth: 64, onHeld: () => { held += 1; controller.abort(); } });
    try {
      await expect(host.ctx.nativeAudio.decodeToMono16k(path, {
        signal: controller.signal, onProgress: () => {}, sink: chunk => { samples += chunk.length; },
      })).rejects.toMatchObject({ code: 'cancelled', message: '已取消' });
      expect(held).toBe(1);
      expect(samples).toBe(0);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('a held guest that is released instead of cancelled completes the request unchanged', async () => {
    const host = await createTestHost({ plugins: [native] });
    const options = { limits: { max_callstack_size: 256, max_heap_bytes: 32 * 1024 * 1024, max_tick_count: 1_000_000 },
      signal: new AbortController().signal, deadlineMs: Date.now() + 30_000,
      call: async () => null, objectRead: async () => null, objectWrite: async () => null };
    let held = 0;
    holdNextWasmRun({ call: 'fd_read', nth: 1, onHeld: release => { held += 1; release(); } });
    try {
      expect(await host.ctx.nativeStarlark.evaluate('20 + 22', options)).toBe(42);
      expect(held).toBe(1);
      expect(await host.ctx.nativeStarlark.evaluate('1 + 1', options)).toBe(2);
      expect(held).toBe(1);
    } finally { await host.dispose(); }
  });
});
