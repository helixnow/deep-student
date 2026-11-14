/**
 * `ctx.files` 一致性用例：不依赖测试框架，同一套用例在三处运行——
 * 桌面实现（真实文件系统）与内存 OPFS（files/tests/opfs.test.ts），以及真实浏览器 Worker 中的 OPFS
 * （移动端诊断插件 `filesConformance` → mobile/tests/files-opfs.spec.ts）。
 *
 * 每个用例拿到一个已存在的空目录 `base`（在允许根内），只用 `/` 拼路径（两端都是 POSIX 风味）。
 * 这里只放两端语义相同的行为；平台差异（符号链接、权限位、目录改名、grant）各自在实现的测试里断言。
 */
import { ZipReader, ZipWriter } from '../../zip/core/index.ts';
import { FileError, type FileErrorKind, type FilesService } from '../api.ts';

export interface ConformanceCase {
  readonly name: string;
  run(files: FilesService, base: string): Promise<void>;
}

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}

async function rejects(promise: Promise<unknown>, kind: FileErrorKind, label: string): Promise<FileError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof FileError)) fail(`${label}: expected FileError(${kind}), got ${String(error)}`);
    if (error.kind !== kind) fail(`${label}: expected FileError(${kind}), got FileError(${error.kind}): ${error.message}`);
    return error;
  }
  return fail(`${label}: expected FileError(${kind}), but it resolved`);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ bytes: number[]; chunks: number }> {
  const bytes: number[] = [];
  let chunks = 0;
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    bytes.push(...next.value);
    chunks++;
  }
  return { bytes, chunks };
}

async function names(files: FilesService, dir: string): Promise<string[]> {
  return (await files.readDir(dir)).map((entry) => entry.name);
}

const text = (bytes: Iterable<number>) => new TextDecoder().decode(Uint8Array.from(bytes));
const enc = (s: string) => new TextEncoder().encode(s);

export const FILES_CONFORMANCE: readonly ConformanceCase[] = [
  {
    name: 'round-trips text and bytes as plain Uint8Array',
    async run(files, base) {
      await files.writeText(`${base}/a.txt`, '错题 ✓');
      eq(await files.readText(`${base}/a.txt`), '错题 ✓', 'text');
      await files.writeBytes(`${base}/b.bin`, Uint8Array.of(0, 1, 254, 255));
      const bytes = await files.readBytes(`${base}/b.bin`);
      eq(Object.getPrototypeOf(bytes) === Uint8Array.prototype, true, 'prototype');
      eq([...bytes], [0, 1, 254, 255], 'bytes');
      await files.writeText(`${base}/a.txt`, 'x');
      eq(await files.readText(`${base}/a.txt`), 'x', 'overwrite truncates');
    },
  },
  {
    name: 'readText keeps the BOM, replaces or rejects invalid UTF-8',
    async run(files, base) {
      await files.writeBytes(`${base}/bom.txt`, Uint8Array.of(0xef, 0xbb, 0xbf, 0x61));
      eq(await files.readText(`${base}/bom.txt`), '\ufeffa', 'bom');
      await files.writeBytes(`${base}/bad.txt`, Uint8Array.of(0x61, 0xff));
      eq(await files.readText(`${base}/bad.txt`), 'a\ufffd', 'replace');
      await rejects(files.readText(`${base}/bad.txt`, { invalidUtf8: 'error' }), 'InvalidData', 'error mode');
    },
  },
  {
    name: 'maxBytes rejects larger files with TooLarge',
    async run(files, base) {
      await files.writeText(`${base}/big.txt`, '12345');
      eq((await files.readBytes(`${base}/big.txt`, { maxBytes: 5 })).length, 5, 'at limit');
      await rejects(files.readBytes(`${base}/big.txt`, { maxBytes: 4 }), 'TooLarge', 'over limit');
    },
  },
  {
    name: 'write options: exclusive, createParents, missing parent, directory target, file as parent',
    async run(files, base) {
      await files.writeText(`${base}/x.txt`, 'one');
      await rejects(files.writeText(`${base}/x.txt`, 'two', { exclusive: true }), 'AlreadyExists', 'exclusive');
      eq(await files.readText(`${base}/x.txt`), 'one', 'exclusive leaves target');
      await rejects(files.writeText(`${base}/no/such/y.txt`, 'y'), 'NotFound', 'missing parent');
      await files.writeText(`${base}/made/deep/y.txt`, 'y', { createParents: true });
      eq(await files.readText(`${base}/made/deep/y.txt`), 'y', 'createParents');
      await rejects(files.writeText(`${base}/made`, 'z'), 'IsADirectory', 'directory target');
      await rejects(files.writeText(`${base}/x.txt/child.txt`, 'z'), 'NotADirectory', 'file as parent');
      await rejects(files.readText(`${base}/missing.txt`), 'NotFound', 'read missing');
      await rejects(files.readText(`${base}/made`), 'IsADirectory', 'read directory');
    },
  },
  {
    name: 'append creates then appends strings and bytes',
    async run(files, base) {
      await files.append(`${base}/log.txt`, 'a');
      await files.append(`${base}/log.txt`, Uint8Array.of(0x62));
      await files.append(`${base}/sub/log.txt`, 'c', { createParents: true });
      eq(await files.readText(`${base}/log.txt`), 'ab', 'appended');
      eq(await files.readText(`${base}/sub/log.txt`), 'c', 'createParents');
    },
  },
  {
    name: 'writeAtomic replaces the target and leaves no temporary files',
    async run(files, base) {
      await files.writeText(`${base}/state.json`, '{"v":1}');
      await files.writeAtomic(`${base}/state.json`, '{"v":2}');
      await files.writeAtomic(`${base}/new/state.bin`, Uint8Array.of(7), { createParents: true });
      eq(await files.readText(`${base}/state.json`), '{"v":2}', 'replaced');
      eq([...await files.readBytes(`${base}/new/state.bin`)], [7], 'created');
      eq(await names(files, base), ['new', 'state.json'], 'no temp files');
      await rejects(files.writeAtomic(`${base}/new`, 'x'), 'IsADirectory', 'directory target');
      eq(await names(files, base), ['new', 'state.json'], 'no temp files after failure');
    },
  },
  {
    name: 'openRead honours start, end and chunkSize',
    async run(files, base) {
      await files.writeText(`${base}/r.txt`, 'abcdefghij');
      const all = await collect(await files.openRead(`${base}/r.txt`, { chunkSize: 4 }));
      eq([text(all.bytes), all.chunks], ['abcdefghij', 3], 'chunks');
      const part = await collect(await files.openRead(`${base}/r.txt`, { start: 2, end: 7, chunkSize: 2 }));
      eq([text(part.bytes), part.chunks], ['cdefg', 3], 'range');
      const empty = await collect(await files.openRead(`${base}/r.txt`, { start: 20 }));
      eq(empty.bytes, [], 'past end');
      await rejects(files.openRead(`${base}/missing`), 'NotFound', 'missing');
      await rejects(files.openRead(base), 'IsADirectory', 'directory');
      await rejects(files.openRead(`${base}/r.txt`, { start: -1 }), 'Other', 'negative start');
    },
  },
  {
    name: 'openWrite overwrite, append, exclusive and atomic modes',
    async run(files, base) {
      async function writeAll(path: string, parts: string[], options: Parameters<FilesService['openWrite']>[1]): Promise<void> {
        const writer = (await files.openWrite(path, options)).getWriter();
        for (const part of parts) await writer.write(enc(part));
        await writer.close();
      }
      await writeAll(`${base}/w.txt`, ['hello ', 'world'], {});
      eq(await files.readText(`${base}/w.txt`), 'hello world', 'overwrite');
      await writeAll(`${base}/w.txt`, ['!'], { mode: 'append' });
      eq(await files.readText(`${base}/w.txt`), 'hello world!', 'append');
      await writeAll(`${base}/w.txt`, ['new'], { mode: 'overwrite' });
      eq(await files.readText(`${base}/w.txt`), 'new', 'truncates');
      await rejects(files.openWrite(`${base}/w.txt`, { mode: 'exclusive' }), 'AlreadyExists', 'exclusive');
      await writeAll(`${base}/a/atomic.txt`, ['1', '2'], { mode: 'atomic', createParents: true });
      eq(await files.readText(`${base}/a/atomic.txt`), '12', 'atomic');
      const aborted = (await files.openWrite(`${base}/a/atomic.txt`, { mode: 'atomic' })).getWriter();
      await aborted.write(enc('partial'));
      await aborted.abort();
      eq(await files.readText(`${base}/a/atomic.txt`), '12', 'abort keeps target');
      eq(await names(files, `${base}/a`), ['atomic.txt'], 'abort removes temp');
    },
  },
  {
    name: 'openFile reads and writes at explicit positions; size follows this handle',
    async run(files, base) {
      await files.writeText(`${base}/p.bin`, 'abcdef');
      const ro = await files.openFile(`${base}/p.bin`);
      eq([ro.path, ro.mode, ro.size], [`${base}/p.bin`, 'read', 6], 'read handle');
      const middle = await ro.read(2, 3);
      eq([Object.getPrototypeOf(middle) === Uint8Array.prototype, text(middle)], [true, 'cde'], 'middle');
      eq(text(await ro.read(4, 10)), 'ef', 'short at end');
      eq([(await ro.read(6, 4)).length, (await ro.read(100, 4)).length, (await ro.read(0, 0)).length], [0, 0, 0], 'at, past end, zero length');
      await rejects(ro.write(enc('x'), 0), 'PermissionDenied', 'read-only write');
      await rejects(ro.truncate(0), 'PermissionDenied', 'read-only truncate');
      await rejects(ro.read(-1, 1), 'Other', 'negative position');
      await rejects(ro.read(0, 1.5), 'Other', 'fractional length');
      await ro.sync();
      await ro.close();
      await ro.close();
      await rejects(ro.read(0, 1), 'Other', 'read after close');

      const rw = await files.openFile(`${base}/p.bin`, { mode: 'readWrite' });
      eq([rw.mode, rw.size], ['readWrite', 6], 'readWrite handle');
      await rw.write(enc('XY'), 1);
      eq(text(await rw.read(0, 6)), 'aXYdef', 'overwrite in place');
      await rw.write(enc('!'), 8);
      eq(rw.size, 9, 'size after write past end');
      eq([...await rw.read(5, 10)], [0x66, 0, 0, 0x21], 'gap is zero-filled');
      await rw.truncate(3);
      eq(rw.size, 3, 'size after truncate');
      await rw.write(new Uint8Array(0), 50);
      eq(rw.size, 3, 'empty write does not extend');
      await rw.truncate(5);
      eq([...await rw.read(0, 10)], [0x61, 0x58, 0x59, 0, 0], 'truncate extends with zeros');
      await rejects(rw.write(enc('z'), -1), 'Other', 'negative write position');
      await rw.sync();
      await rw.close();
      await rejects(rw.write(enc('z'), 0), 'Other', 'write after close');
      eq([...await files.readBytes(`${base}/p.bin`)], [0x61, 0x58, 0x59, 0, 0], 'visible after close');
      const after = await files.openFile(`${base}/p.bin`);
      eq(after.size, 5, 'reopened size');
      await after.close();
    },
  },
  {
    name: 'openFile modes: create keeps, truncate empties, exclusive, readWrite needs the file, parents, directories, scopes',
    async run(files, base) {
      await files.writeText(`${base}/m.txt`, 'keep');
      const kept = await files.openFile(`${base}/m.txt`, { mode: 'create' });
      eq(kept.size, 4, 'create keeps size');
      await kept.close();
      eq(await files.readText(`${base}/m.txt`), 'keep', 'create keeps content');
      const created = await files.openFile(`${base}/new/c.txt`, { mode: 'create', createParents: true });
      eq(created.size, 0, 'created empty');
      await created.write(enc('c'), 0);
      await created.close();
      eq(await files.readText(`${base}/new/c.txt`), 'c', 'created content');
      const emptied = await files.openFile(`${base}/m.txt`, { mode: 'truncate' });
      eq(emptied.size, 0, 'truncate size');
      await emptied.close();
      eq(await files.readText(`${base}/m.txt`), '', 'truncate content');
      await rejects(files.openFile(`${base}/m.txt`, { mode: 'exclusive' }), 'AlreadyExists', 'exclusive existing');
      await rejects(files.openFile(`${base}/new`, { mode: 'exclusive' }), 'AlreadyExists', 'exclusive directory');
      const fresh = await files.openFile(`${base}/x.txt`, { mode: 'exclusive' });
      await fresh.close();
      eq(await files.exists(`${base}/x.txt`), true, 'exclusive creates');
      await rejects(files.openFile(`${base}/missing.txt`), 'NotFound', 'read missing');
      await rejects(files.openFile(`${base}/missing.txt`, { mode: 'readWrite' }), 'NotFound', 'readWrite missing');
      await rejects(files.openFile(`${base}/no/such.txt`, { mode: 'create' }), 'NotFound', 'missing parent');
      await rejects(files.openFile(`${base}/no/such.txt`, { mode: 'readWrite', createParents: true }), 'NotFound', 'readWrite ignores createParents');
      eq(await names(files, base), ['m.txt', 'new', 'x.txt'], 'failed opens leave nothing behind');
      await rejects(files.openFile(`${base}/new`), 'IsADirectory', 'read directory');
      await rejects(files.openFile(`${base}/new`, { mode: 'readWrite' }), 'IsADirectory', 'readWrite directory');
      await rejects(files.openFile(`${base}/new`, { mode: 'create' }), 'IsADirectory', 'create directory');
      await rejects(files.openFile(`${base}/m.txt/child`, { mode: 'create' }), 'NotADirectory', 'file as parent');
      await rejects(files.openFile('/definitely/outside/roots'), 'OutsideRoots', 'outside');
      const scope = files.scope(`${base}/s`);
      const scoped = await scope.openFile('d/s.bin', { mode: 'create', createParents: true });
      eq(scoped.path, 'd/s.bin', 'scoped path');
      await scoped.write(enc('s'), 0);
      await scoped.close();
      eq(await files.readText(`${base}/s/d/s.bin`), 's', 'scoped write');
      await rejects(scope.openFile('../escape.bin', { mode: 'create' }), 'OutsideRoots', 'scope escape');
    },
  },
  {
    name: 'openFile handles are a ZIP byte sink and source (ZipWriter / ZipReader round trip)',
    async run(files, base) {
      const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
      const sink = await files.openFile(`${base}/a.zip`, { mode: 'exclusive' });
      const writer = new ZipWriter(sink);
      await writer.addBytes('notes/a.txt', '错题 ✓');
      await writer.addBytes('blob.bin', big, { compression: 'stored' });
      await writer.addDirectory('empty');
      const total = await writer.finish();
      await sink.close();
      eq([(await files.stat(`${base}/a.zip`)).size, sink.size], [total, total], 'zip size');
      const source = await files.openFile(`${base}/a.zip`);
      const reader = await ZipReader.open(source);
      eq(reader.entries.map((entry) => entry.name), ['notes/a.txt', 'blob.bin', 'empty/'], 'entries');
      eq(text(await reader.readEntry(reader.find('notes/a.txt')!)), '错题 ✓', 'deflated entry');
      const blob = await reader.readEntry(reader.find('blob.bin')!);
      eq([blob.length, blob.every((value, i) => value === big[i])], [big.length, true], 'stored entry');
      await source.close();
    },
  },
  {
    name: 'stat and exists',
    async run(files, base) {
      await files.writeText(`${base}/s.txt`, 'abc');
      await files.mkdir(`${base}/d`);
      const file = await files.stat(`${base}/s.txt`);
      eq([file.kind, file.size, typeof file.modifiedMs], ['file', 3, 'number'], 'file stat');
      eq((await files.stat(`${base}/d`)).kind, 'directory', 'directory stat');
      await rejects(files.stat(`${base}/missing`), 'NotFound', 'missing');
      eq(await files.exists(`${base}/s.txt`), true, 'exists file');
      eq(await files.exists(`${base}/d`), true, 'exists dir');
      eq(await files.exists(`${base}/missing`), false, 'missing');
      eq(await files.exists(`${base}/s.txt/below`), false, 'below a file');
      await rejects(files.exists('/definitely/outside/roots'), 'OutsideRoots', 'outside');
      await rejects(files.exists('relative/path'), 'InvalidPath', 'relative');
    },
  },
  {
    name: 'readDir sorts by name and reports kinds and absolute paths',
    async run(files, base) {
      await files.writeText(`${base}/b.txt`, '');
      await files.writeText(`${base}/A.txt`, '');
      await files.mkdir(`${base}/c`);
      eq(await files.readDir(base), [
        { name: 'A.txt', path: `${base}/A.txt`, kind: 'file' },
        { name: 'b.txt', path: `${base}/b.txt`, kind: 'file' },
        { name: 'c', path: `${base}/c`, kind: 'directory' },
      ], 'entries');
      await rejects(files.readDir(`${base}/b.txt`), 'NotADirectory', 'file');
      await rejects(files.readDir(`${base}/missing`), 'NotFound', 'missing');
    },
  },
  {
    name: 'walk is pre-order, sorted, and honours maxDepth and includeDirectories',
    async run(files, base) {
      await files.writeText(`${base}/t/b/2.txt`, '', { createParents: true });
      await files.writeText(`${base}/t/a.txt`, '');
      await files.writeText(`${base}/t/b/c/3.txt`, '', { createParents: true });
      const all = [];
      for await (const entry of files.walk(`${base}/t`)) all.push([entry.relativePath, entry.kind, entry.depth, entry.path === `${base}/t/${entry.relativePath}`]);
      eq(all, [['a.txt', 'file', 1, true], ['b', 'directory', 1, true], ['b/2.txt', 'file', 2, true], ['b/c', 'directory', 2, true], ['b/c/3.txt', 'file', 3, true]], 'all');
      const shallow = [];
      for await (const entry of files.walk(`${base}/t`, { maxDepth: 2, includeDirectories: false })) shallow.push(entry.relativePath);
      eq(shallow, ['a.txt', 'b/2.txt'], 'shallow files');
    },
  },
  {
    name: 'mkdir recursive, non-recursive and over a file',
    async run(files, base) {
      await files.mkdir(`${base}/m/n/o`);
      await files.mkdir(`${base}/m/n/o`);
      eq((await files.stat(`${base}/m/n/o`)).kind, 'directory', 'recursive');
      await rejects(files.mkdir(`${base}/m`, { recursive: false }), 'AlreadyExists', 'existing');
      await rejects(files.mkdir(`${base}/x/y`, { recursive: false }), 'NotFound', 'missing parent');
      await files.mkdir(`${base}/m/p`, { recursive: false });
      await files.writeText(`${base}/f`, '');
      await rejects(files.mkdir(`${base}/f`), 'AlreadyExists', 'over file');
      await rejects(files.mkdir(`${base}/f/sub`), 'NotADirectory', 'under file');
    },
  },
  {
    name: 'rename files: overwrite by default, overwrite false, createParents',
    async run(files, base) {
      await files.writeText(`${base}/from.txt`, 'from');
      await files.writeText(`${base}/to.txt`, 'to');
      await rejects(files.rename(`${base}/from.txt`, `${base}/to.txt`, { overwrite: false }), 'AlreadyExists', 'overwrite false');
      await files.rename(`${base}/from.txt`, `${base}/to.txt`);
      eq(await files.readText(`${base}/to.txt`), 'from', 'replaced');
      eq(await files.exists(`${base}/from.txt`), false, 'source gone');
      await files.rename(`${base}/to.txt`, `${base}/x/y/moved.txt`, { createParents: true });
      eq(await files.readText(`${base}/x/y/moved.txt`), 'from', 'moved');
      await rejects(files.rename(`${base}/missing`, `${base}/z`), 'NotFound', 'missing');
    },
  },
  {
    name: 'copyFile overwrite, overwrite false, directory source',
    async run(files, base) {
      const big = new Uint8Array(200_000).map((_, i) => i % 251);
      await files.writeBytes(`${base}/src.bin`, big);
      await files.copyFile(`${base}/src.bin`, `${base}/dst.bin`);
      eq((await files.readBytes(`${base}/dst.bin`)).every((value, i) => value === big[i]), true, 'copied');
      eq((await files.stat(`${base}/dst.bin`)).size, big.length, 'size');
      await files.writeText(`${base}/small.txt`, 's');
      await files.copyFile(`${base}/small.txt`, `${base}/dst.bin`);
      eq(await files.readText(`${base}/dst.bin`), 's', 'overwrite truncates');
      await rejects(files.copyFile(`${base}/src.bin`, `${base}/dst.bin`, { overwrite: false }), 'AlreadyExists', 'overwrite false');
      await files.copyFile(`${base}/small.txt`, `${base}/n/c.txt`, { createParents: true });
      eq(await files.readText(`${base}/n/c.txt`), 's', 'createParents');
      await rejects(files.copyFile(`${base}/missing`, `${base}/x`), 'NotFound', 'missing');
    },
  },
  {
    name: 'rm files, empty and non-empty directories, force, roots',
    async run(files, base) {
      await files.writeText(`${base}/f.txt`, '');
      await files.mkdir(`${base}/empty`);
      await files.writeText(`${base}/full/x.txt`, '', { createParents: true });
      await files.rm(`${base}/f.txt`);
      await files.rm(`${base}/empty`);
      await rejects(files.rm(`${base}/full`), 'DirectoryNotEmpty', 'non-empty');
      await files.rm(`${base}/full`, { recursive: true });
      eq(await names(files, base), [], 'all removed');
      await rejects(files.rm(`${base}/missing`), 'NotFound', 'missing');
      await files.rm(`${base}/missing`, { force: true });
      const root = files.roots[0]!.path;
      await rejects(files.rm(root, { recursive: true }), 'InvalidPath', 'allowed root');
    },
  },
  {
    name: 'lexical confinement: .. escapes, relative paths, NUL',
    async run(files, base) {
      const root = files.roots[0]!.path;
      await rejects(files.readText(`${root}/../outside.txt`), 'OutsideRoots', 'escape root');
      await rejects(files.writeText('relative.txt', ''), 'InvalidPath', 'relative');
      await rejects(files.writeText(`${base}/a\u0000b`, ''), 'InvalidPath', 'NUL');
      await files.writeText(`${base}/./x/../dots.txt`, 'ok');
      eq(await files.readText(`${base}/dots.txt`), 'ok', 'normalized');
      eq(await files.isAllowed(`${base}/anything`), true, 'isAllowed inside');
      eq(await files.isAllowed('/definitely/outside'), false, 'isAllowed outside');
    },
  },
  {
    name: 'scopes take relative paths, report relative entries and protect their root',
    async run(files, base) {
      const scope = files.scope(`${base}/s`);
      eq(scope.root, `${base}/s`, 'root');
      eq(scope.resolve('a/../b.txt'), `${base}/s/b.txt`, 'resolve');
      await scope.writeText('dir/x.txt', 'x', { createParents: true });
      eq(await files.readText(`${base}/s/dir/x.txt`), 'x', 'written under root');
      eq(await scope.readDir('dir'), [{ name: 'x.txt', path: 'dir/x.txt', kind: 'file' }], 'relative entries');
      await rejects(scope.readText('../escape.txt'), 'OutsideRoots', 'escape');
      await rejects(scope.readText(`${base}/s/dir/x.txt`), 'InvalidPath', 'absolute');
      await rejects(scope.rm('', { recursive: true }), 'InvalidPath', 'scope root');
      const sub = scope.scope('dir');
      eq(await sub.readText('x.txt'), 'x', 'sub-scope');
      await sub.rm('x.txt');
      eq(await scope.readDir('dir'), [], 'removed through sub-scope');
    },
  },
  {
    name: 'backupRoot is recovery/backups under the appData root, outside the data slots, usable without grant',
    async run(files) {
      const appData = files.roots.find((root) => root.name === 'appData') ?? fail('no appData root');
      eq(files.backupRoot, `${appData.path}/recovery/backups`, 'backupRoot');
      eq(files.backupRoot.split('/').includes('slots'), false, 'outside the data slots');
      eq(await files.isAllowed(files.backupRoot), true, 'inside the allowed roots');
      const probe = `${files.backupRoot}/conformance-probe`;
      await files.rm(probe, { recursive: true, force: true });
      const handle = await files.openFile(`${probe}/b.zip`, { mode: 'exclusive', createParents: true });
      await handle.write(enc('PK'), 0);
      await handle.close();
      const backups = files.scope(files.backupRoot);
      eq(await backups.readDir('conformance-probe'), [{ name: 'b.zip', path: 'conformance-probe/b.zip', kind: 'file' }], 'listed through a scope');
      eq(text(await backups.readBytes('conformance-probe/b.zip')), 'PK', 'read back');
      await rejects(backups.readBytes('../../escape'), 'OutsideRoots', 'backup ids cannot leave the root');
      await files.rm(probe, { recursive: true });
      eq(await files.exists(probe), false, 'cleaned up');
    },
  },
];

/** 在 `base` 下为每个用例建一个独立子目录依次运行，汇总结果（不中途抛出）。 */
export async function runFilesConformance(files: FilesService, base: string): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const [index, testCase] of FILES_CONFORMANCE.entries()) {
    const dir = `${base}/case-${index}`;
    try {
      await files.mkdir(dir);
      await testCase.run(files, dir);
      results.push({ name: testCase.name, ok: true });
    } catch (error) {
      results.push({ name: testCase.name, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  return results;
}
