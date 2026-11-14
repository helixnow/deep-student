/**
 * 落盘持久性：Rust 在三处“写临时文件 → 改名发布”的路径上先 `sync_all` 再 `rename`，
 * 断电后不会留下已改名、内容为空的清单、恢复激活标记或暂存密钥。
 * - `BackupManifest::save_to_file`（backup/mod.rs:1615-1631）
 * - `persist_restore_activation_marker`（commands_restore.rs:67-90，另 fsync 父目录）
 * - `copy_crypto_file_to_staging`（backup/mod.rs:244-315）
 */
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveManifest } from '../src/manifest.ts';
import { persistRestoreActivationMarker } from '../src/restore-commands.ts';
import { copyCryptoFileToStaging } from '../src/crypto-restore.ts';
import { ioMessage } from '../src/io.ts';
import { partialManifest } from './helpers.ts';

type FsFn = (...args: unknown[]) => unknown;
const cjs = createRequire(import.meta.url)('node:fs') as Record<string, FsFn>;
const PATCHED = ['openSync', 'closeSync', 'fsyncSync', 'renameSync', 'writeFileSync'] as const;

interface FsEvent { op: string; path: string }

/** 记录 open/fsync/rename 的顺序；`fail` 让指定操作在匹配路径上抛出给定 errno。 */
function traceFs(fail?: { op: 'fsyncSync' | 'renameSync'; match: (path: string) => boolean; code: string; errno: number }) {
  const originals = Object.fromEntries(PATCHED.map(name => [name, cjs[name]!])) as Record<(typeof PATCHED)[number], FsFn>;
  const fdPaths = new Map<number, string>();
  const events: FsEvent[] = [];
  const maybeFail = (op: string, path: string): void => {
    if (fail && fail.op === op && fail.match(path)) {
      throw Object.assign(new Error(`${fail.code}: injected, ${op}`), { code: fail.code, errno: -fail.errno, syscall: op });
    }
  };
  cjs.openSync = (...args) => {
    const fd = originals.openSync(...args) as number;
    fdPaths.set(fd, String(args[0]));
    return fd;
  };
  cjs.closeSync = (...args) => { fdPaths.delete(args[0] as number); return originals.closeSync(...args); };
  cjs.fsyncSync = (...args) => {
    const path = fdPaths.get(args[0] as number) ?? `fd:${String(args[0])}`;
    events.push({ op: 'fsync', path });
    maybeFail('fsyncSync', path);
    return originals.fsyncSync(...args);
  };
  cjs.renameSync = (...args) => {
    events.push({ op: 'rename', path: String(args[0]) });
    maybeFail('renameSync', String(args[0]));
    return originals.renameSync(...args);
  };
  cjs.writeFileSync = (...args) => {
    if (typeof args[0] === 'string') events.push({ op: 'writeFile', path: args[0] });
    return originals.writeFileSync(...args);
  };
  syncBuiltinESMExports();
  return {
    events,
    restore(): void {
      Object.assign(cjs, originals);
      syncBuiltinESMExports();
    },
  };
}

/** 调用方展示错误的方式（`备份 .master_key 失败: ${ioMessage(error)}`）。 */
function failureText(run: () => unknown): string {
  try { run(); }
  catch (error) { return ioMessage(error); }
  throw new Error('expected failure');
}

/** `ioMessage` 对给定 errno 的文案（`Xxx (os error N)`）。 */
const osText = (errno: number): string => ioMessage(Object.assign(new Error('injected'), { errno: -errno }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dstu-durability-')));
  roots.push(root);
  return root;
}

describe('saveManifest (BackupManifest::save_to_file)', () => {
  it('fsyncs the temporary manifest before renaming it over manifest.json', () => {
    const root = tempRoot();
    const path = join(root, 'manifest.json');
    const trace = traceFs();
    try { saveManifest(path, partialManifest('durable', { files: { 'persistent/a.json': 'a' } })); }
    finally { trace.restore(); }
    const temp = join(root, 'manifest.json.tmp');
    expect(trace.events.filter(event => event.path === temp)).toEqual([
      { op: 'fsync', path: temp },
      { op: 'rename', path: temp },
    ]);
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).backup_id).toBe('durable');
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('a failed fsync leaves manifest.json untouched and removes the temporary file', () => {
    const root = tempRoot();
    const path = join(root, 'manifest.json');
    fs.writeFileSync(path, '{"previous":true}');
    const trace = traceFs({ op: 'fsyncSync', match: p => p.endsWith('.json.tmp'), code: 'EIO', errno: 5 });
    let message = '';
    try { saveManifest(path, partialManifest('durable', { files: { 'persistent/a.json': 'a' } })); }
    catch (error) { message = (error as Error).message; }
    finally { trace.restore(); }
    expect(message).toBe(osText(5));
    expect(fs.readFileSync(path, 'utf8')).toBe('{"previous":true}');
    expect(fs.existsSync(join(root, 'manifest.json.tmp'))).toBe(false);
  });
});

describe('persistRestoreActivationMarker (persist_restore_activation_marker)', () => {
  const marker = { backup_id: 'b1', snapshot_epoch: 'e1', created_at: '2026-11-07T00:00:00Z' };

  it('fsyncs the temporary marker, renames it, then fsyncs the directory (unix)', () => {
    const root = tempRoot();
    const trace = traceFs();
    try { persistRestoreActivationMarker(root, marker); }
    finally { trace.restore(); }
    const temp = join(root, '.restore_activation_pending.json.tmp');
    const expected: FsEvent[] = [{ op: 'fsync', path: temp }, { op: 'rename', path: temp }];
    if (process.platform !== 'win32') expected.push({ op: 'fsync', path: root });
    expect(trace.events.filter(event => event.op !== 'writeFile')).toEqual(expected);
    expect(JSON.parse(fs.readFileSync(join(root, '.restore_activation_pending.json'), 'utf8'))).toEqual(marker);
  });

  it('reports each failing step with the Rust error prefix', () => {
    const root = tempRoot();
    const syncFail = traceFs({ op: 'fsyncSync', match: p => p.endsWith('.tmp'), code: 'EIO', errno: 5 });
    try { expect(() => persistRestoreActivationMarker(root, marker)).toThrow(`同步恢复激活标记失败: ${osText(5)}`); }
    finally { syncFail.restore(); }
    expect(fs.existsSync(join(root, '.restore_activation_pending.json'))).toBe(false);

    const renameFail = traceFs({ op: 'renameSync', match: () => true, code: 'EACCES', errno: 13 });
    try { expect(() => persistRestoreActivationMarker(root, marker)).toThrow(`发布恢复激活标记失败: ${osText(13)}`); }
    finally { renameFail.restore(); }

    expect(() => persistRestoreActivationMarker(join(root, 'missing'), marker))
      .toThrow(`创建恢复激活标记失败: ${osText(2)}`);

    if (process.platform !== 'win32') {
      const dirFail = traceFs({ op: 'fsyncSync', match: p => p === root, code: 'EIO', errno: 5 });
      try { expect(() => persistRestoreActivationMarker(root, marker)).toThrow(`同步恢复目录失败: ${osText(5)}`); }
      finally { dirFail.restore(); }
    }
  });
});

describe('copyCryptoFileToStaging (copy_crypto_file_to_staging)', () => {
  it('fsyncs the staged copy and restricts it to the owner', () => {
    const root = tempRoot();
    const source = join(root, '.master_key');
    fs.writeFileSync(source, 'a'.repeat(44), { mode: 0o644 });
    fs.chmodSync(source, 0o644);
    const destination = join(root, 'staged');
    const trace = traceFs();
    let copied = 0;
    try { copied = copyCryptoFileToStaging(source, destination, 4096); }
    finally { trace.restore(); }
    expect(copied).toBe(44);
    expect(trace.events).toContainEqual({ op: 'fsync', path: destination });
    expect(fs.readFileSync(destination, 'utf8')).toBe('a'.repeat(44));
    if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing staging file (create_new)', () => {
    const root = tempRoot();
    const source = join(root, 'src.enc');
    fs.writeFileSync(source, 'x'.repeat(40));
    const destination = join(root, 'staged.enc');
    fs.writeFileSync(destination, 'existing');
    expect(failureText(() => copyCryptoFileToStaging(source, destination, 4096))).toBe(osText(17));
    expect(fs.readFileSync(destination, 'utf8')).toBe('existing');
  });

  it('a failed fsync surfaces the I/O error and leaves no staged copy behind', () => {
    const root = tempRoot();
    const source = join(root, 'src.enc');
    fs.writeFileSync(source, 'y'.repeat(40));
    const destination = join(root, 'staged.enc');
    const trace = traceFs({ op: 'fsyncSync', match: p => p === destination, code: 'EIO', errno: 5 });
    try { expect(failureText(() => copyCryptoFileToStaging(source, destination, 4096))).toBe(osText(5)); }
    finally { trace.restore(); }
    expect(fs.readFileSync(source, 'utf8')).toBe('y'.repeat(40));
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('missing source uses the Rust inspection message', () => {
    const root = tempRoot();
    const source = join(root, 'absent.enc');
    expect(() => copyCryptoFileToStaging(source, join(root, 'staged.enc'), 4096))
      .toThrow(`无法检查备份密钥文件 ${source}: ${osText(2)}`);
  });
});
