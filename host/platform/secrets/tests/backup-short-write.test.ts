import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const host = await createTestHost();
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  await host.install(secrets);
  const dir = await mkdtemp('/tmp/opencode/f4-short-write-');
  const input = join(dir, 'input'), encrypted = join(dir, 'encrypted'), output = join(dir, 'output');
  const data = Buffer.from('真实文件中的多语言 backup bytes 😀\n'.repeat(100));
  await writeFile(input, data);
  const session = await host.ctx.secrets.backup.createFileCipherSession('short-write-password', { mCost: 8, tCost: 1, pCost: 1 });
  return { host, dir, input, encrypted, output, data, session };
}

/** Explicit IO fault injection, not a crypto/file substitute: writes really reach
 * the OS file, but each write returns after only half the requested bytes.
 */
async function injectPartialWrites(probePath: string) {
  const probe = await open(probePath, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.write;
  let calls = 0;
  const spy = vi.spyOn(prototype, 'write').mockImplementation(function (this: FileHandle, ...args: unknown[]) {
    const bytes = args[0] as Uint8Array;
    const offset = typeof args[1] === 'number' ? args[1] : 0;
    const length = typeof args[2] === 'number' ? args[2] : bytes.length - offset;
    const position = typeof args[3] === 'number' ? args[3] : null;
    calls++;
    return Reflect.apply(original, this, [bytes, offset, Math.max(1, Math.floor(length / 2)), position]);
  });
  return { restore: () => spy.mockRestore(), calls: () => calls };
}

// backup_crypto.rs:382-411,570-581: write_all must consume every byte, not one successful partial write.
it('F4-V2-12 DSBK stream encryption retries short header and ciphertext writes', async () => {
  const f = await setup();
  try {
    const writes = await injectPartialWrites(f.input);
    try {
      await f.session.encryptFile(f.input, f.encrypted);
    } finally { writes.restore(); }
    // One final chunk, unchanged DSBK v2 wire layout: header44 + payload + tag16.
    expect((await readFile(f.encrypted)).length).toBe(44 + f.data.length + 16);
    await f.session.decryptFile(f.encrypted, f.output);
    expect(await readFile(f.output)).toEqual(f.data);
    expect(writes.calls()).toBeGreaterThan(2);
  } finally { f.session.dispose(); await f.host.dispose(); await rm(f.dir, { recursive: true, force: true }); }
});

it('F4-V2-12 DSBK stream decryption retries short plaintext writes', async () => {
  const f = await setup();
  try {
    await f.session.encryptFile(f.input, f.encrypted);
    const writes = await injectPartialWrites(f.input);
    try {
      await f.session.decryptFile(f.encrypted, f.output);
    } finally { writes.restore(); }
    expect(await readFile(f.output)).toEqual(f.data);
    expect(writes.calls()).toBeGreaterThan(1);
  } finally { f.session.dispose(); await f.host.dispose(); await rm(f.dir, { recursive: true, force: true }); }
});
