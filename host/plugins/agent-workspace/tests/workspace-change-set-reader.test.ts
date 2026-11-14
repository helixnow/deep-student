import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { tempRoot, type JsonValue } from '../api.ts';
import { MAX_MUTATION_BYTES } from '../src/workspace-change-set.ts';
// Reload the production modules cached by Host setup so their fs imports use this suite's mock.
vi.hoisted(() => vi.resetModules());

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync), statSync: vi.fn(actual.statSync),
    writeSync: vi.fn(actual.writeSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

it.each([false, true])('atomic workspace staging writes the full content across short writes (Interrupted=%s)', async interrupted => {
  const f = await setup();
  try {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let stageFd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(actual.openSync, fs, args);
      if (typeof args[0] === 'string' && path.dirname(args[0]) === f.root && path.basename(args[0]).startsWith('.stage-')) stageFd = fd;
      return fd;
    }) as typeof fs.openSync);
    const offsets: number[] = [];
    let interrupt = interrupted;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (args[0] === stageFd && Buffer.isBuffer(args[1])) {
        if (interrupt) { interrupt = false; throw Object.assign(new Error('interrupted'), { code: 'EINTR' }); }
        const offset = typeof args[2] === 'number' ? args[2] : 0;
        const length = typeof args[3] === 'number' ? args[3] : args[1].length;
        offsets.push(offset);
        return actual.writeSync(args[0], args[1], offset, Math.min(length, 3));
      }
      return Reflect.apply(actual.writeSync, fs, args);
    }) as typeof fs.writeSync);
    const content = 'abcdefghij';
    const result = await f.write({ path: 'short.txt', content });
    expect(result.success, result.error).toBe(true);
    expect(fs.readFileSync(path.join(f.root, 'short.txt'), 'utf8')).toBe(content);
    expect(object(result.output).mutation_receipt).toMatchObject({ bytes: 10, after_hash: hash(content) });
    expect(offsets).toEqual([0, 3, 6, 9]);
    expect(fs.closeSync).toHaveBeenCalledWith(stageFd);
    expect(fs.readdirSync(f.root)).toEqual(['short.txt']);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});

it.each([
  ['open', 'Failed to stage workspace write: injected open failure'],
  ['write', 'Failed to stage workspace content: injected write failure'],
  ['zero', 'Failed to stage workspace content: failed to write whole buffer'],
  ['sync', 'Failed to sync workspace content: injected sync failure'],
] as const)('workspace stage %s failure preserves the original and cleans the stage with the Rust prefix', async (failure, expected) => {
  const f = await setup();
  try {
    const target = path.join(f.root, 'text.txt');
    fs.writeFileSync(target, 'before');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let stageFd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const isStage = typeof args[0] === 'string' && path.dirname(args[0]) === f.root && path.basename(args[0]).startsWith('.stage-');
      if (isStage && failure === 'open') throw new Error('injected open failure');
      const fd = Reflect.apply(actual.openSync, fs, args);
      if (isStage) stageFd = fd;
      return fd;
    }) as typeof fs.openSync);
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (args[0] === stageFd) {
        if (failure === 'write') throw new Error('injected write failure');
        if (failure === 'zero') return 0;
      }
      return Reflect.apply(actual.writeSync, fs, args);
    }) as typeof fs.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (fd === stageFd && failure === 'sync') throw new Error('injected sync failure');
      actual.fsyncSync(fd);
    });
    expect(await f.write({ path: 'text.txt', content: 'after', expected_current_hash: hash('before') }))
      .toMatchObject({ success: false, error: expected });
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
    expect(fs.readdirSync(f.root)).toEqual(['text.txt']);
    if (failure !== 'open') {
      expect(stageFd).toBeDefined();
      expect(fs.closeSync).toHaveBeenCalledWith(stageFd);
    }
  } finally { f.storage.dispose(); await f.host.dispose(); }
});
const workspaces: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function object(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value;
}

async function setup() {
  const fixture = await createWorkspaceHost();
  try {
    // A read-write workspace may not overlap the app data dir.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mutations-'));
    workspaces.push(root);
    // The product stages under the canonical root; on macOS the temp dir sits behind /var → /private/var.
    const canonicalRoot = fs.realpathSync(root);
    await fixture.host.invoke('chat_v2_set_workspace_root', { path: root, access: 'read_write' });
    const executor = fixture.host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const context = { sessionId: 's', dataDir: fixture.host.app.dataDir, settings: fixture.host.ctx.settings };
    const write = (args: JsonValue) => executor.execute({ id: 'write', name: 'workspace_file_write', arguments: args }, context);
    return { ...fixture, root: canonicalRoot, write, executor, context };
  } catch (error) { fixture.storage.dispose(); await fixture.host.dispose(); throw error; }
}

it('change-set overwrite checks regular file then required hash before reading, as Rust does', async () => {
  const f = await setup();
  try {
    const target = path.join(f.root, 'large.txt');
    const fd = fs.openSync(target, 'w');
    try { fs.ftruncateSync(fd, MAX_MUTATION_BYTES + 1); } finally { fs.closeSync(fd); }
    expect(await f.write({ path: 'large.txt', content: 'new' })).toMatchObject({ success: false,
      error: 'expected_current_hash is required when overwriting an existing workspace file' });
    // With a supplied hash, read_and_hash's size check precedes verify_current_hash's format check.
    expect(await f.write({ path: 'large.txt', content: 'new', expected_current_hash: 'invalid' })).toMatchObject({
      success: false, error: 'Workspace file exceeds the mutation size limit' });
    fs.mkdirSync(path.join(f.root, 'directory'));
    expect(await f.write({ path: 'directory', content: 'new' })).toMatchObject({ success: false,
      error: 'Workspace write target must be a regular file' });
    expect(fs.statSync(target).size).toBe(MAX_MUTATION_BYTES + 1);
    expect(fs.existsSync(path.join(tempRoot(f.host.app.dataDir, 's', false).path, '.workspace_changes'))).toBe(false);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});

it('successful move retains a zero-byte receipt when destination metadata fails and remains undoable', async () => {
  const f = await setup();
  try {
    const source = path.join(f.root, 'before.txt');
    const destination = path.join(f.root, 'after.txt');
    fs.writeFileSync(source, 'contents');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const failedMetadata = vi.fn();
    vi.mocked(fs.statSync).mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === destination) {
        failedMetadata();
        throw new Error('injected post-move metadata failure');
      }
      return Reflect.apply(actual.statSync, fs, args);
    }) as typeof fs.statSync);
    const moved = await f.executor.execute({ id: 'move', name: 'workspace_file_move', arguments: {
      source_path: 'before.txt', destination_path: 'after.txt', expected_current_hash: hash('contents'),
    } }, f.context);
    expect(moved.success, moved.error).toBe(true);
    const receipt = object(moved.output).mutation_receipt;
    expect(receipt).toMatchObject({ op: 'moved', relative_path: 'before.txt', destination_path: 'after.txt',
      before_hash: hash('contents'), after_hash: hash('contents'), bytes: 0 });
    expect(failedMetadata).toHaveBeenCalledOnce();
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('contents');
    expect(await f.host.invoke('chat_v2_revert_workspace_change', { sessionId: 's', receipt }))
      .toMatchObject({ reverted: true });
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('contents');
  } finally { f.storage.dispose(); await f.host.dispose(); }
});

it('change-set uses the shared reader for short reads and checkpoint restore through real tool/IPC entries', async () => {
  const f = await setup();
  try {
    const target = path.join(f.root, 'text.txt');
    const before = 'abcdefgh'.repeat(20_000);
    fs.writeFileSync(target, before);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const readFds: number[] = [];
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (Buffer.isBuffer(args[1]) && args[1].length === 64 * 1024) {
        readFds.push(args[0]);
        return actual.readSync(args[0], args[1], 0, 8192, null);
      }
      return Reflect.apply(actual.readSync, fs, args);
    }) as typeof fs.readSync);
    const changed = await f.write({ path: 'text.txt', content: 'replacement', expected_current_hash: hash(before) });
    expect(changed.success, changed.error).toBe(true);
    const receipt = object(changed.output).mutation_receipt;
    expect(receipt).toMatchObject({ op: 'modified', before_hash: hash(before), after_hash: hash('replacement') });
    expect(readFds.length).toBeGreaterThan(2);
    expect(await f.host.invoke('chat_v2_revert_workspace_change', { sessionId: 's', receipt }))
      .toMatchObject({ reverted: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    for (const fd of new Set(readFds)) expect(fs.closeSync).toHaveBeenCalledWith(fd);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});

it('change-set open/read errors keep their own prefixes and reads close before any checkpoint/write', async () => {
  const f = await setup();
  try {
    const target = path.join(f.root, 'text.txt');
    fs.writeFileSync(target, 'before');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === target) throw new Error('injected open failure');
      return Reflect.apply(actual.openSync, fs, args);
    }) as typeof fs.openSync);
    expect(await f.write({ path: 'text.txt', content: 'new', expected_current_hash: hash('before') }))
      .toMatchObject({ success: false, error: 'Failed to open workspace file safely: injected open failure' });
    vi.mocked(fs.openSync).mockRestore();
    let failedFd: number | undefined;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (Buffer.isBuffer(args[1]) && args[1].length === 64 * 1024) {
        failedFd = args[0];
        throw new Error('injected read failure');
      }
      return Reflect.apply(actual.readSync, fs, args);
    }) as typeof fs.readSync);
    expect(await f.write({ path: 'text.txt', content: 'new', expected_current_hash: hash('before') }))
      .toMatchObject({ success: false, error: 'Failed to read workspace file: injected read failure' });
    expect(failedFd).toBeDefined();
    expect(fs.closeSync).toHaveBeenCalledWith(failedFd);
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
    expect(fs.existsSync(path.join(tempRoot(f.host.app.dataDir, 's', false).path, '.workspace_changes'))).toBe(false);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});
