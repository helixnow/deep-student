/**
 * `ctx.files` 桌面实现：真实文件系统上的读写、流、遍历、根目录包含判断与符号链接逃逸。
 */
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileError, isFileNotFound, type FilesService } from '../api.ts';
import files, { createNodeFiles } from '../index.ts';
import paths from '../../paths/index.ts';
import { createTestHost } from '../../../kernel/testing.ts';

const POSIX = process.platform !== 'win32';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let root: string;
let outside: string;
let service: FilesService;

async function expectFileError(promise: Promise<unknown>, kind: FileError['kind']): Promise<FileError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected FileError(${kind})`).toBeInstanceOf(FileError);
  expect((caught as FileError).kind).toBe(kind);
  return caught as FileError;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ text: string; chunks: number }> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value);
  return { text: Buffer.concat(parts).toString('utf8'), chunks: parts.length };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'w14-files-root-'));
  outside = await mkdtemp(join(tmpdir(), 'w14-files-outside-'));
  service = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('reading and writing', () => {
  it('round-trips text and bytes; returned bytes are plain Uint8Array', async () => {
    await service.writeText(join(root, 'a.txt'), '错题 ✓');
    expect(await service.readText(join(root, 'a.txt'))).toBe('错题 ✓');
    await service.writeBytes(join(root, 'b.bin'), Uint8Array.of(0, 1, 254, 255));
    const bytes = await service.readBytes(join(root, 'b.bin'));
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect([...bytes]).toEqual([0, 1, 254, 255]);
  });

  it('readText is lossy by default and strict with invalidUtf8: "error"; BOM is preserved', async () => {
    await writeFile(join(root, 'bad.txt'), Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0xff));
    expect(await service.readText(join(root, 'bad.txt'))).toBe('\uFEFFa\uFFFD');
    await expectFileError(service.readText(join(root, 'bad.txt'), { invalidUtf8: 'error' }), 'InvalidData');
  });

  it('honours createParents, exclusive and append', async () => {
    const nested = join(root, 'x', 'y', 'z.txt');
    await expectFileError(service.writeText(nested, '1'), 'NotFound');
    await service.writeText(nested, '1', { createParents: true });
    await expectFileError(service.writeText(nested, '2', { exclusive: true }), 'AlreadyExists');
    await service.append(nested, '2');
    await service.append(nested, Uint8Array.of(0x33));
    expect(await readFile(nested, 'utf8')).toBe('123');
    await service.append(join(root, 'new', 'log.txt'), 'first', { createParents: true });
    expect(await readFile(join(root, 'new', 'log.txt'), 'utf8')).toBe('first');
  });

  it('enforces maxBytes', async () => {
    await writeFile(join(root, 'big.bin'), new Uint8Array(1024));
    await expectFileError(service.readBytes(join(root, 'big.bin'), { maxBytes: 1023 }), 'TooLarge');
    expect(await service.readBytes(join(root, 'big.bin'), { maxBytes: 1024 })).toHaveLength(1024);
  });

  it('maps OS errors to portable kinds and keeps the Rust io::Error display', async () => {
    const error = await expectFileError(service.readText(join(root, 'missing.txt')), 'NotFound');
    expect(isFileNotFound(error)).toBe(true);
    expect(error.osCode).toBe('ENOENT');
    expect(error.operation).toBe('read');
    expect(error.path).toBe(join(root, 'missing.txt'));
    if (POSIX) expect(error.message).toBe('No such file or directory (os error 2)');
    await mkdir(join(root, 'dir'));
    await expectFileError(service.readText(join(root, 'dir')), 'IsADirectory');
  });
});

describe('writeAtomic', () => {
  it('replaces the target, leaves no temporary files and defaults to 0600', async () => {
    const target = join(root, 'state.json');
    await service.writeAtomic(target, '{"v":1}');
    await service.writeAtomic(target, Uint8Array.from(Buffer.from('{"v":2}')), { durable: true });
    expect(await readFile(target, 'utf8')).toBe('{"v":2}');
    expect(await readdir(root)).toEqual(['state.json']);
    if (POSIX) expect((await stat(target)).mode & 0o777).toBe(0o600);
    await service.writeAtomic(join(root, 'deep', 'er', 'x.json'), '1', { createParents: true, unixMode: 0o644 });
    if (POSIX) expect((await stat(join(root, 'deep', 'er', 'x.json'))).mode & 0o777).toBe(0o644);
  });

  it('keeps the original and cleans up when the rename fails', async () => {
    await mkdir(join(root, 'occupied'));
    await writeFile(join(root, 'occupied', 'keep.txt'), 'keep');
    await expect(service.writeAtomic(join(root, 'occupied'), 'x')).rejects.toBeInstanceOf(FileError);
    expect(await readFile(join(root, 'occupied', 'keep.txt'), 'utf8')).toBe('keep');
    expect((await readdir(root)).sort()).toEqual(['occupied']);
  });
});

describe('Windows sharing violations', () => {
  const RF = 'RF-W14-files-rename-retry';

  it(`${RF}: rename and atomic openWrite retry a transient EBUSY when the service platform is win32; other platforms fail on the first one`, async () => {
    const busy = Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    const spy = vi.spyOn(fs.promises, 'rename');
    const windows = createNodeFiles({ roots: [{ name: 'appData', path: root }], platform: 'win32', flavor: service.flavor });
    await writeFile(join(root, 'a.txt'), 'a');
    spy.mockRejectedValueOnce(busy);
    await windows.rename(join(root, 'a.txt'), join(root, 'b.txt'));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRejectedValueOnce(busy);
    const writer = (await windows.openWrite(join(root, 'c.json'), { mode: 'atomic' })).getWriter();
    await writer.write(new TextEncoder().encode('{"v":1}'));
    await writer.close();
    expect(spy).toHaveBeenCalledTimes(4);
    expect((await readdir(root)).sort()).toEqual(['b.txt', 'c.json']);
    expect(await readFile(join(root, 'c.json'), 'utf8')).toBe('{"v":1}');

    for (const platform of ['linux', 'darwin'] as const) {
      const posix = createNodeFiles({ roots: [{ name: 'appData', path: root }], platform, flavor: service.flavor });
      const calls = spy.mock.calls.length;
      spy.mockRejectedValueOnce(busy);
      await expect(posix.rename(join(root, 'b.txt'), join(root, 'd.txt'))).rejects.toBeInstanceOf(FileError);
      spy.mockRejectedValueOnce(busy);
      const failing = (await posix.openWrite(join(root, 'e.json'), { mode: 'atomic' })).getWriter();
      await failing.write(new TextEncoder().encode('{"v":2}'));
      await expect(failing.close()).rejects.toBeInstanceOf(FileError);
      expect(spy.mock.calls.length - calls, platform).toBe(2);
    }
    expect((await readdir(root)).sort()).toEqual(['b.txt', 'c.json']);
  });

  it(`${RF}: writeAtomic retries a transient EBUSY on win32 (paths/compat atomicWriteFile reads process.platform)`, async () => {
    const busy = Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    const spy = vi.spyOn(fs.promises, 'rename');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      spy.mockRejectedValueOnce(busy);
      await service.writeAtomic(join(root, 'e.json'), '{"v":2}');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(await readdir(root)).toEqual(['e.json']);
    expect(await readFile(join(root, 'e.json'), 'utf8')).toBe('{"v":2}');
  });

  it('the service platform alone decides Unix modes and the directory fsync, whatever the host process runs on', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const dirOpens = () => open.mock.calls.filter(([path]) => path === root).length;
    const windows = createNodeFiles({ roots: [{ name: 'appData', path: root }], platform: 'win32', flavor: service.flavor });
    await windows.writeAtomic(join(root, 'w.json'), '1', { durable: true });
    expect(dirOpens()).toBe(0);
    expect((await windows.stat(join(root, 'w.json'))).unixMode).toBeNull();
    if (!POSIX) return;
    const linux = createNodeFiles({ roots: [{ name: 'appData', path: root }], platform: 'linux' });
    await linux.writeAtomic(join(root, 'l.json'), '1', { durable: true });
    expect(dirOpens()).toBe(1);
    expect((await linux.stat(join(root, 'l.json'))).unixMode).toBe(0o600);
  });

  it(`${RF}: every rename in the desktop files service goes through the shared retry policy`, () => {
    const source = fs.readFileSync(join(REPO_ROOT, 'host/platform/files/index.ts'), 'utf8');
    const lines = source.split('\n');
    expect(lines.filter(line => /import\s*\{[^}]*\brename\b[^}]*\}\s*from\s*'node:fs/.test(line))).toEqual([]);
    expect(lines.filter(line => !/^\s*async rename\(from, to, options = \{\}\) \{$/.test(line))
      .filter(line => /\bfs\.(promises\.)?rename(Sync)?\(|(^|[^.\w])rename\(/.test(line))).toEqual([]);
    expect(lines.filter(line => /\brenameWithRetry\(/.test(line)).length).toBe(2);
    expect(source).toContain("from '../util/durable-fs.ts'");
    expect(fs.readFileSync(join(REPO_ROOT, 'host/platform/util/durable-fs.ts'), 'utf8')).toContain("from '../paths/rename-retry.ts'");
  });
});

describe('streams', () => {
  it('openRead streams the whole file or a byte range in chunks', async () => {
    const target = join(root, 'stream.txt');
    await writeFile(target, 'abcdefghijklmnopqrstuvwxyz');
    expect((await collect(await service.openRead(target))).text).toBe('abcdefghijklmnopqrstuvwxyz');
    const ranged = await collect(await service.openRead(target, { start: 2, end: 12, chunkSize: 4 }));
    expect(ranged).toEqual({ text: 'cdefghijkl', chunks: 3 });
    expect((await collect(await service.openRead(target, { start: 20 }))).text).toBe('uvwxyz');
    const reader = (await service.openRead(target, { chunkSize: 1 })).getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(0x61));
    await reader.cancel();
    await expectFileError(service.openRead(join(root, 'missing')), 'NotFound');
  });

  it('openWrite supports overwrite, append and exclusive', async () => {
    const target = join(root, 'out.txt');
    const encoder = new TextEncoder();
    let writer = (await service.openWrite(target)).getWriter();
    await writer.write(encoder.encode('one'));
    await writer.close();
    writer = (await service.openWrite(target, { mode: 'append' })).getWriter();
    await writer.write(encoder.encode('+two'));
    await writer.close();
    expect(await readFile(target, 'utf8')).toBe('one+two');
    await expectFileError(service.openWrite(target, { mode: 'exclusive' }), 'AlreadyExists');
    writer = (await service.openWrite(join(root, 'sub', 'new.txt'), { createParents: true })).getWriter();
    await writer.write(encoder.encode('n'));
    await writer.close();
    expect(await readFile(join(root, 'sub', 'new.txt'), 'utf8')).toBe('n');
  });

  it('atomic write streams publish on close and discard on abort', async () => {
    const target = join(root, 'atomic.txt');
    await writeFile(target, 'old');
    const encoder = new TextEncoder();
    let writer = (await service.openWrite(target, { mode: 'atomic' })).getWriter();
    await writer.write(encoder.encode('new '));
    await writer.write(encoder.encode('content'));
    expect(await readFile(target, 'utf8')).toBe('old');
    await writer.close();
    expect(await readFile(target, 'utf8')).toBe('new content');
    writer = (await service.openWrite(target, { mode: 'atomic' })).getWriter();
    await writer.write(encoder.encode('half'));
    await writer.abort(new Error('cancelled'));
    expect(await readFile(target, 'utf8')).toBe('new content');
    expect(await readdir(root)).toEqual(['atomic.txt']);
  });
});

describe('openFile (positional handles)', () => {
  it('new files get unixMode (default 0666 under umask); existing files keep their mode', async () => {
    const handle = await service.openFile(join(root, 'secret.bin'), { mode: 'exclusive', unixMode: 0o600 });
    await handle.close();
    const plain = await service.openFile(join(root, 'plain.bin'), { mode: 'create' });
    await plain.close();
    const reopened = await service.openFile(join(root, 'secret.bin'), { mode: 'truncate', unixMode: 0o644 });
    await reopened.close();
    if (POSIX) {
      expect((await stat(join(root, 'secret.bin'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'plain.bin'))).mode & 0o777).toBe(0o666 & ~process.umask());
    }
  });

  it('writes are visible to other readers before close and survive sync()', async () => {
    const handle = await service.openFile(join(root, 'live.bin'), { mode: 'create' });
    await handle.write(new TextEncoder().encode('hello'), 0);
    expect(await readFile(join(root, 'live.bin'), 'utf8')).toBe('hello');
    const reader = await service.openFile(join(root, 'live.bin'));
    await handle.write(new TextEncoder().encode('!'), 5);
    expect(reader.size).toBe(5);
    expect(new TextDecoder().decode(await reader.read(0, 10))).toBe('hello!');
    await handle.sync();
    await reader.close();
    await handle.close();
  });

  it('desktop allows two writable handles on the same file (mobile rejects the second)', async () => {
    const first = await service.openFile(join(root, 'shared.bin'), { mode: 'create' });
    const second = await service.openFile(join(root, 'shared.bin'), { mode: 'readWrite' });
    await first.write(Uint8Array.of(1), 0);
    await second.write(Uint8Array.of(2), 1);
    await Promise.all([first.close(), second.close()]);
    expect([...await readFile(join(root, 'shared.bin'))]).toEqual([1, 2]);
  });

  it.skipIf(!POSIX)('cannot open through a symlink that points outside the roots', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link-file'));
    await symlink(outside, join(root, 'link-dir'));
    await expectFileError(service.openFile(join(root, 'link-file')), 'OutsideRoots');
    await expectFileError(service.openFile(join(root, 'link-file'), { mode: 'readWrite' }), 'OutsideRoots');
    await expectFileError(service.openFile(join(root, 'link-dir', 'planted.txt'), { mode: 'create' }), 'OutsideRoots');
    expect(await readdir(outside)).toEqual(['secret.txt']);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });
});

describe('metadata, listing and traversal', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'tree', 'b', 'deep'), { recursive: true });
    await writeFile(join(root, 'tree', 'z.txt'), 'zz');
    await writeFile(join(root, 'tree', 'a.txt'), 'a');
    await writeFile(join(root, 'tree', 'b', 'c.txt'), 'c');
    await writeFile(join(root, 'tree', 'b', 'deep', 'd.txt'), 'd');
  });

  it('stat and exists', async () => {
    const info = await service.stat(join(root, 'tree', 'z.txt'));
    expect(info.kind).toBe('file');
    expect(info.size).toBe(2);
    expect(typeof info.modifiedMs).toBe('number');
    if (POSIX) expect(info.unixMode).toBeTypeOf('number');
    expect((await service.stat(join(root, 'tree'))).kind).toBe('directory');
    expect(await service.exists(join(root, 'tree', 'a.txt'))).toBe(true);
    expect(await service.exists(join(root, 'tree', 'nope'))).toBe(false);
    await expectFileError(service.stat(join(root, 'tree', 'nope')), 'NotFound');
  });

  it('readDir is sorted and reports kinds', async () => {
    const entries = await service.readDir(join(root, 'tree'));
    expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([['a.txt', 'file'], ['b', 'directory'], ['z.txt', 'file']]);
    expect(entries[0]!.path).toBe(join(root, 'tree', 'a.txt'));
  });

  it('walk is pre-order, sorted, depth-limited and can skip directories', async () => {
    const all: string[] = [];
    for await (const entry of service.walk(join(root, 'tree'))) all.push(`${entry.depth}:${entry.relativePath}:${entry.kind}`);
    expect(all).toEqual([
      '1:a.txt:file', '1:b:directory', '2:b/c.txt:file', '2:b/deep:directory', '3:b/deep/d.txt:file', '1:z.txt:file',
    ]);
    const shallow: string[] = [];
    for await (const entry of service.walk(join(root, 'tree'), { maxDepth: 1, includeDirectories: false })) shallow.push(entry.relativePath);
    expect(shallow).toEqual(['a.txt', 'z.txt']);
  });

  it('mkdir, rename, copyFile and rm', async () => {
    await service.mkdir(join(root, 'm', 'n'));
    await expectFileError(service.mkdir(join(root, 'm'), { recursive: false }), 'AlreadyExists');
    await service.rename(join(root, 'tree', 'a.txt'), join(root, 'm', 'n', 'a.txt'));
    expect(await readFile(join(root, 'm', 'n', 'a.txt'), 'utf8')).toBe('a');
    await expectFileError(service.rename(join(root, 'tree', 'z.txt'), join(root, 'm', 'n', 'a.txt'), { overwrite: false }), 'AlreadyExists');
    await service.rename(join(root, 'tree', 'z.txt'), join(root, 'moved', 'z.txt'), { createParents: true });
    await service.copyFile(join(root, 'moved', 'z.txt'), join(root, 'copy.txt'));
    await expectFileError(service.copyFile(join(root, 'moved', 'z.txt'), join(root, 'copy.txt'), { overwrite: false }), 'AlreadyExists');
    expect(await readFile(join(root, 'copy.txt'), 'utf8')).toBe('zz');
    await expectFileError(service.rm(join(root, 'tree')), 'DirectoryNotEmpty');
    await service.rm(join(root, 'tree'), { recursive: true });
    expect(await service.exists(join(root, 'tree'))).toBe(false);
    await service.mkdir(join(root, 'empty'));
    await service.rm(join(root, 'empty'));
    await expectFileError(service.rm(join(root, 'gone')), 'NotFound');
    await service.rm(join(root, 'gone'), { force: true });
  });

  it('refuses to remove an allowed root itself', async () => {
    await expectFileError(service.rm(root, { recursive: true, force: true }), 'InvalidPath');
    expect(await service.exists(join(root, 'tree'))).toBe(true);
  });
});

describe('root containment', () => {
  it('rejects paths outside every root, including ".." escapes and sibling prefixes', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await expectFileError(service.readText(join(outside, 'secret.txt')), 'OutsideRoots');
    await expectFileError(service.readText(join(root, '..', outside.split(/[\\/]/).pop()!, 'secret.txt')), 'OutsideRoots');
    await expectFileError(service.writeText(`${root}-evil${POSIX ? '/' : '\\'}x.txt`, 'x'), 'OutsideRoots');
    await expectFileError(service.rename(join(outside, 'secret.txt'), join(root, 'stolen.txt')), 'OutsideRoots');
    await expectFileError(service.copyFile(join(root, 'x'), join(outside, 'leak.txt')), 'OutsideRoots');
    await expectFileError(service.exists(join(outside, 'secret.txt')), 'OutsideRoots');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(await service.isAllowed(join(outside, 'secret.txt'))).toBe(false);
    expect(await service.isAllowed(join(root, 'anything', 'deeper'))).toBe(true);
  });

  it('rejects relative paths and NUL bytes as InvalidPath', async () => {
    await expectFileError(service.readText('relative/file.txt'), 'InvalidPath');
    await expectFileError(service.readText(join(root, 'a\u0000b')), 'InvalidPath');
    expect(await service.isAllowed('relative')).toBe(false);
  });

  it.skipIf(!POSIX)('follows symlinks for containment: links pointing outside cannot be read through, but can be removed', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'link-dir'));
    await symlink(join(outside, 'secret.txt'), join(root, 'link-file'));
    await expectFileError(service.readText(join(root, 'link-dir', 'secret.txt')), 'OutsideRoots');
    await expectFileError(service.readText(join(root, 'link-file')), 'OutsideRoots');
    await expectFileError(service.writeText(join(root, 'link-dir', 'planted.txt'), 'x'), 'OutsideRoots');
    await expectFileError(service.writeText(join(root, 'link-file'), 'overwrite'), 'OutsideRoots');
    await expectFileError(service.stat(join(root, 'link-file')), 'OutsideRoots');
    expect((await service.stat(join(root, 'link-file'), { followSymlinks: false })).kind).toBe('symlink');
    const listed = await service.readDir(root);
    expect(listed.map((entry) => [entry.name, entry.kind])).toEqual([['link-dir', 'symlink'], ['link-file', 'symlink']]);
    const walked: string[] = [];
    for await (const entry of service.walk(root)) walked.push(entry.relativePath);
    expect(walked).toEqual(['link-dir', 'link-file']);
    await service.rm(join(root, 'link-dir'));
    await service.rm(join(root, 'link-file'));
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it.skipIf(!POSIX)('allows symlinks that stay inside the roots', async () => {
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'f.txt'), 'inside');
    await symlink(join(root, 'real'), join(root, 'alias'));
    expect(await service.readText(join(root, 'alias', 'f.txt'))).toBe('inside');
  });

  it('grant() temporarily allows a user-selected path and revoke() withdraws it', async () => {
    await writeFile(join(outside, 'import.json'), '{}');
    await expectFileError(service.readText(join(outside, 'import.json')), 'OutsideRoots');
    const grant = service.grant(outside);
    expect(service.roots).toContainEqual({ name: 'granted', path: outside });
    expect(await service.readText(join(outside, 'import.json'))).toBe('{}');
    grant.revoke();
    grant.revoke();
    expect(service.roots.some((entry) => entry.name === 'granted')).toBe(false);
    await expectFileError(service.readText(join(outside, 'import.json')), 'OutsideRoots');
    expect(() => service.grant('relative/dir')).toThrow(FileError);
  });
});

describe('backupRoot', () => {
  it('defaults to recovery/backups under the appData root (posix and win32), an explicit value wins', () => {
    expect(service.backupRoot).toBe(join(root, 'recovery', 'backups'));
    const win = createNodeFiles({ roots: [{ name: 'appData', path: 'C:\\Users\\Ann\\AppData\\Roaming\\com.deepstudent.app' }], flavor: 'win32' });
    expect(win.backupRoot).toBe('C:\\Users\\Ann\\AppData\\Roaming\\com.deepstudent.app\\recovery\\backups');
    expect(createNodeFiles({ roots: [{ name: 'appData', path: root }], backupRoot: join(root, 'elsewhere') }).backupRoot).toBe(join(root, 'elsewhere'));
  });

  it('throws UnsupportedOnPlatform when the service has no appData root', () => {
    const tempOnly = createNodeFiles({ roots: [{ name: 'temp', path: root }] });
    let caught: unknown;
    try {
      void tempOnly.backupRoot;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
    expect((caught as FileError).kind).toBe('UnsupportedOnPlatform');
    expect((caught as FileError).message).toBe('UNSUPPORTED_ON_PLATFORM: files.backupRoot needs an appData root');
  });

  it('a user-picked backup directory outside the roots needs grant(); revoke() closes it again', async () => {
    const custom = join(outside, 'My Backups');
    await expectFileError(service.mkdir(custom), 'OutsideRoots');
    const grant = service.grant(custom);
    const handle = await service.openFile(join(custom, 'b.zip'), { mode: 'exclusive', createParents: true });
    await handle.write(new TextEncoder().encode('PK'), 0);
    await handle.close();
    expect(await readFile(join(custom, 'b.zip'), 'utf8')).toBe('PK');
    grant.revoke();
    await expectFileError(service.readBytes(join(custom, 'b.zip')), 'OutsideRoots');
  });
});

describe('scopes', () => {
  it('resolve relative paths under the scope root and reject escapes', async () => {
    const scope = service.scope(join(root, 'workspace'));
    expect(scope.root).toBe(join(root, 'workspace'));
    await scope.writeText('notes/a.md', '# a', { createParents: true });
    expect(await readFile(join(root, 'workspace', 'notes', 'a.md'), 'utf8')).toBe('# a');
    expect(await scope.readText('notes/./a.md')).toBe('# a');
    expect(scope.resolve('notes/a.md')).toBe(join(root, 'workspace', 'notes', 'a.md'));
    expect((await scope.readDir('notes')).map((entry) => entry.path)).toEqual(['notes/a.md']);
    const walked: string[] = [];
    for await (const entry of scope.walk('')) walked.push(`${entry.path}|${entry.relativePath}`);
    expect(walked).toEqual(['notes|notes', 'notes/a.md|notes/a.md']);
    expect(() => scope.resolve('../outside.txt')).toThrow(FileError);
    await expectFileError(scope.readText('../../etc/passwd'), 'OutsideRoots');
    await expectFileError(scope.readText('/etc/passwd'), 'InvalidPath');
    await expectFileError(scope.rm('', { recursive: true }), 'InvalidPath');
    const sub = scope.scope('notes');
    expect(await sub.readText('a.md')).toBe('# a');
    await expectFileError(sub.readText('../a.md'), 'OutsideRoots');
    await scope.rename('notes/a.md', 'archive/a.md', { createParents: true });
    expect(await scope.exists('archive/a.md')).toBe(true);
  });

  it('cannot be created outside the roots', () => {
    expect(() => service.scope(outside)).toThrow(FileError);
    expect(() => service.scope('relative')).toThrow(FileError);
  });
});

describe('dstu.platform.files plugin', () => {
  it('derives roots from ctx.paths and confines writes to them', async () => {
    const host = await createTestHost({ plugins: [paths, files] });
    try {
      const names = host.ctx.files.roots.map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(['appData', 'appLocalData', 'appConfig', 'appCache', 'appLog', 'temp', 'legacy']));
      expect(host.ctx.files.roots).toContainEqual({ name: 'appData', path: host.ctx.paths.appDataDir });
      expect(host.ctx.files.backupRoot).toBe(host.ctx.paths.recoveryBackupsDir);
      expect(await host.ctx.files.isAllowed(host.ctx.files.backupRoot)).toBe(true);
      const target = host.ctx.paths.slot.join(host.ctx.paths.slotDir('slotA'), 'w14-probe.txt');
      await host.ctx.files.writeText(target, 'ok', { createParents: true });
      expect(await host.ctx.files.readText(target)).toBe('ok');
      await expectFileError(host.ctx.files.writeText(join(REPO_ROOT, 'w14-never-written.txt'), 'x'), 'OutsideRoots');
    } finally {
      await host.dispose();
    }
  });
});
