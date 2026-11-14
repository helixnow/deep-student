import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { artifactRoot, tempRoot, type JsonValue } from '../api.ts';
import { createWriteBackup, WRITE_BACKUP_DIR } from '../src/write-backups.ts';

// Host setup preloads the public barrel; reload before installing the fs fault injection.
vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync), closeSync: vi.fn(actual.closeSync) };
});
afterEach(() => { vi.restoreAllMocks(); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function object(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value;
}
type StageKind = 'backup' | 'artifact';
type Failure = 'open' | 'write' | 'zero' | 'sync';

/** Faults only the requested staging syscall; all other bytes reach real files. */
async function observeStages(fault?: { kind: StageKind; step: Failure }) {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const opened: Array<{ kind: StageKind; closed: boolean; writes: number; interrupted: boolean }> = [];
  const active = new Map<number, typeof opened[number]>();
  vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const file = args[0];
    const kind = typeof file === 'string' && path.basename(file).startsWith('.stage-') && path.basename(path.dirname(file)) === WRITE_BACKUP_DIR
      ? 'backup' : typeof file === 'string' && path.basename(file).startsWith('.artifact-') ? 'artifact' : null;
    if (kind !== null && fault?.kind === kind && fault.step === 'open') throw new Error('injected open failure');
    const fd = Reflect.apply(actual.openSync, fs, args);
    if (kind !== null) {
      const entry: typeof opened[number] = { kind, closed: false, writes: 0, interrupted: false };
      opened.push(entry); active.set(fd, entry);
    }
    return fd;
  }) as typeof fs.openSync);
  vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
    const entry = active.get(args[0]);
    if (entry && Buffer.isBuffer(args[1])) {
      entry.writes++;
      if (fault?.kind === entry.kind) {
        if (fault.step === 'zero') return 0;
        if (fault.step === 'write' && entry.writes > 1) throw new Error('injected write failure');
      }
      if (!fault && !entry.interrupted) {
        entry.interrupted = true;
        throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
      }
      const offset = typeof args[2] === 'number' ? args[2] : 0;
      const length = typeof args[3] === 'number' ? args[3] : args[1].length;
      return actual.writeSync(args[0], args[1], offset, Math.min(length, fault?.step === 'write' ? 3 : 4096));
    }
    return Reflect.apply(actual.writeSync, fs, args);
  }) as typeof fs.writeSync);
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (active.get(fd)?.kind === fault?.kind && fault?.step === 'sync') throw new Error('injected sync failure');
    actual.fsyncSync(fd);
  });
  vi.mocked(fs.closeSync).mockImplementation(fd => {
    actual.closeSync(fd);
    const entry = active.get(fd);
    if (entry) { entry.closed = true; active.delete(fd); }
  });
  return opened;
}

async function setup(before: string) {
  const fixture = await createWorkspaceHost();
  try {
    const root = artifactRoot(fixture.host.app.dataDir, 's', true).path;
    const temp = tempRoot(fixture.host.app.dataDir, 's', true).path;
    const target = path.join(root, 'note.txt');
    fs.writeFileSync(target, before);
    const executor = fixture.host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const write = (content: string) => executor.execute({ id: 'artifact', name: 'workspace_artifact_write',
      arguments: { path: 'note.txt', content } }, { sessionId: 's', settings: fixture.host.ctx.settings, dataDir: fixture.host.app.dataDir });
    return { ...fixture, root, temp, target, write };
  } catch (error) { fixture.storage.dispose(); await fixture.host.dispose(); throw error; }
}

it('artifact overwrite, backup and IPC restore persist complete multichunk bytes across Interrupted and short writes', async () => {
  const before = 'old bytes\n'.repeat(16_000);
  const after = 'new bytes\n'.repeat(10_000);
  const f = await setup(before);
  try {
    const stages = await observeStages();
    const result = await f.write(after);
    expect(result.success, result.error).toBe(true);
    const changes = object(object(result.output).file_change_summary!).changes;
    if (!Array.isArray(changes)) throw new Error('expected changes');
    const change = object(changes[0]!);
    if (typeof change.backup_ref !== 'string') throw new Error('expected backup reference');
    expect(change.before_hash).toBe(hash(before));
    expect(change.after_hash).toBe(hash(after));
    expect(fs.readFileSync(f.target, 'utf8')).toBe(after);
    expect(fs.readFileSync(path.join(f.temp, change.backup_ref), 'utf8')).toBe(before);
    expect(await f.host.invoke('chat_v2_revert_artifact_write', { sessionId: 's', relativePath: 'note.txt',
      backupRef: change.backup_ref, expectedAfterHash: hash(after) })).toMatchObject({ bytes_restored: before.length });
    expect(fs.readFileSync(f.target, 'utf8')).toBe(before);
    expect(stages.map(stage => stage.kind)).toEqual(['backup', 'artifact', 'artifact']);
    expect(stages.every(stage => stage.closed && stage.interrupted && stage.writes > 2)).toBe(true);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});

it.each([
  ['backup', 'open', 'Failed to create staged backup: injected open failure'],
  ['backup', 'write', 'Failed to write staged backup: injected write failure'],
  ['backup', 'sync', 'Failed to sync staged backup: injected sync failure'],
  ['artifact', 'write', 'Failed to stage artifact: injected write failure'],
  ['artifact', 'zero', 'Failed to stage artifact: failed to write whole buffer'],
  ['artifact', 'sync', 'Failed to sync staged artifact: injected sync failure'],
  ['restore', 'open', 'Failed to create staged artifact: injected open failure'],
  ['restore', 'write', 'Failed to stage artifact content: injected write failure'],
  ['restore', 'sync', 'Failed to sync staged artifact: injected sync failure'],
] as const)('%s %s failure keeps the existing artifact and the Rust error/cleanup behavior', async (phase, step, expected) => {
  const before = 'the original bytes must survive';
  const f = await setup(before);
  try {
    const backupRef = phase === 'restore' ? createWriteBackup(f.temp, 'note.txt', Buffer.from('restored bytes')) : null;
    const stages = await observeStages({ kind: phase === 'backup' ? 'backup' : 'artifact', step });
    if (backupRef !== null) {
      await expect(f.host.invoke('chat_v2_revert_artifact_write', { sessionId: 's', relativePath: 'note.txt',
        backupRef, expectedAfterHash: hash(before) })).rejects.toBe(expected);
    } else {
      expect(await f.write('replacement bytes')).toMatchObject({ success: false, error: expected });
    }
    expect(fs.readFileSync(f.target, 'utf8')).toBe(before);
    expect(fs.readdirSync(f.root)).toEqual(['note.txt']);
    expect(fs.readdirSync(path.join(f.temp, WRITE_BACKUP_DIR))).toEqual(backupRef === null ? [] : [path.basename(backupRef)]);
    expect(stages.every(stage => stage.closed)).toBe(true);
  } finally { f.storage.dispose(); await f.host.dispose(); }
});
