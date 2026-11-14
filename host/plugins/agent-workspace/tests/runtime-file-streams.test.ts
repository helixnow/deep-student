import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import nativePlugin from '../../../platform/native/index.ts';
import { createWorkspaceHost } from './host-support.ts';
import { artifactRoot, type JsonValue } from '../api.ts';
import { createWriteBackupFromFile, sha256File, WRITE_BACKUP_DIR } from '../src/write-backups.ts';

// Host setup preloads the public barrel; reload before installing the fs fault injection.
vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
});
afterEach(() => { vi.restoreAllMocks(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function object(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value;
}

it('W3 production workspace reader, overwrite backup and IPC undo preserve a multichunk file', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    if (process.platform === 'win32' && !host.ctx.get('nativeWindowsFiles')) await host.install(nativePlugin);
    const root = artifactRoot(host.app.dataDir, 's', true);
    const old = 'abcdefgh'.repeat(20_000);
    const target = path.join(root.path, 'stream.txt');
    fs.writeFileSync(target, old);
    const executor = host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const ctx = { sessionId: 's', dataDir: host.app.dataDir, settings: host.ctx.settings };
    const read = await executor.execute({ id: 'read', name: 'workspace_file_read', arguments: {
      root_id: 'artifacts', path: 'stream.txt', offset: 65_535, max_bytes: 8,
    } }, ctx);
    expect(read.success, read.error).toBe(true);
    expect(read.output).toMatchObject({ content: old.slice(65_535, 65_543), bytes: old.length,
      sha256: hash(old), offset: 65_535, next_offset: 65_543, eof: false });
    const write = await executor.execute({ id: 'write', name: 'workspace_artifact_write', arguments: {
      path: 'stream.txt', content: 'replacement',
    } }, ctx);
    expect(write.success, write.error).toBe(true);
    const changes = object(object(write.output).file_change_summary!).changes;
    if (!Array.isArray(changes)) throw new Error('missing changes');
    const change = object(changes[0]!);
    expect(change.before_hash).toBe(hash(old));
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
    expect(await host.invoke('chat_v2_revert_artifact_write', { sessionId: 's', relativePath: 'stream.txt',
      backupRef: change.backup_ref, expectedAfterHash: hash('replacement') }))
      .toMatchObject({ reverted: true, mode: 'restored', bytes_restored: old.length });
    expect(fs.readFileSync(target, 'utf8')).toBe(old);
  } finally { storage.dispose(); await host.dispose(); }
});

it.skipIf(process.platform === 'win32')('read failures keep Rust backup/hash prefixes and close the real opened file', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const source = path.join(host.app.dataDir, 'source.txt');
    const temp = path.join(host.app.dataDir, 'temp');
    fs.mkdirSync(temp);
    fs.writeFileSync(source, 'source');
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).readSync;
    let failedFd: number | undefined;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (Buffer.isBuffer(args[1]) && args[1].length === 64 * 1024) {
        failedFd = args[0];
        throw Object.assign(new Error('read failed'), { code: 'EIO', errno: -5 });
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readSync);
    expect(() => createWriteBackupFromFile(temp, 'source.txt', source))
      .toThrow('Failed to read backup source: Input/output error (os error 5)');
    expect(fs.closeSync).toHaveBeenCalledWith(failedFd);
    expect(fs.readdirSync(path.join(temp, WRITE_BACKUP_DIR))).toEqual([]);
    vi.mocked(fs.closeSync).mockClear();
    expect(() => sha256File(source)).toThrow('Failed to read artifact: Input/output error (os error 5)');
    expect(fs.closeSync).toHaveBeenCalledWith(failedFd);
  } finally { storage.dispose(); await host.dispose(); }
});
