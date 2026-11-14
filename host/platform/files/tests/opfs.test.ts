/**
 * `ctx.files` 移动端（OPFS）实现：与桌面实现跑同一套一致性用例；平台差异（UnsupportedOnPlatform）、
 * 失败路径（配额、写锁、缺少 move）与插件注册单独断言。真实浏览器上的同一套用例见 mobile/tests/files-opfs.spec.ts。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { createTestHost } from '../../../kernel/testing.ts';
import { FileError, type FilesService } from '../api.ts';
import { createNodeFiles } from '../index.ts';
import filesMobile from '../mobile.ts';
import { createOpfsFiles, mobileRoots } from '../opfs.ts';
import { FILES_CONFORMANCE, runFilesConformance } from './conformance.ts';
import { createFakeOpfs, type FakeOpfsOptions } from './__fixtures__/fake-opfs.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DATA = '/deep-student';

function opfsFiles(options: FakeOpfsOptions = {}): FilesService {
  return createOpfsFiles({ root: createFakeOpfs(options), roots: mobileRoots(DATA) });
}

async function fileError(promise: Promise<unknown>, kind: FileError['kind']): Promise<FileError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error, `expected FileError(${kind})`).toBeInstanceOf(FileError);
  expect((error as FileError).kind, (error as Error).message).toBe(kind);
  return error as FileError;
}

describe('conformance: desktop (node:fs) and mobile (OPFS) agree', () => {
  let desktopRoot: string;
  let desktop: FilesService;
  let mobile: FilesService;
  beforeAll(async () => {
    desktopRoot = await mkdtemp(join(tmpdir(), 'w14-files-conf-'));
    desktop = createNodeFiles({ roots: [{ name: 'appData', path: desktopRoot }], flavor: 'posix' });
    mobile = opfsFiles();
  });
  afterAll(async () => {
    await rm(desktopRoot, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32').each(FILES_CONFORMANCE.map((testCase, index) => [testCase.name, index] as const))('desktop: %s', async (_name, index) => {
    const base = `${desktopRoot}/d${index}`;
    await desktop.mkdir(base);
    await FILES_CONFORMANCE[index]!.run(desktop, base);
  });

  it.each(FILES_CONFORMANCE.map((testCase, index) => [testCase.name, index] as const))('opfs: %s', async (_name, index) => {
    const base = `${DATA}/m${index}`;
    await mobile.mkdir(base);
    await FILES_CONFORMANCE[index]!.run(mobile, base);
  });

  it('runFilesConformance reports every case (the runner the mobile Worker uses)', async () => {
    const results = await runFilesConformance(opfsFiles(), `${DATA}/runner`);
    expect(results.map((result) => result.name)).toEqual(FILES_CONFORMANCE.map((testCase) => testCase.name));
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });
});

describe('OPFS platform rules (explicit UnsupportedOnPlatform, no silent fallback)', () => {
  it('grant() is unsupported: user-picked files reach mobile as content, not paths', () => {
    let caught: unknown;
    try {
      opfsFiles().grant('/var/mobile/Documents/import.zip');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
    expect((caught as FileError).kind).toBe('UnsupportedOnPlatform');
    expect((caught as FileError).message).toMatch(/^UNSUPPORTED_ON_PLATFORM: files\.grant is not available on mobile/);
  });

  it('backupRoot is <dataDir>/recovery/backups; a custom backup directory is not available (grant() above), like Rust pick_backup_directory', async () => {
    const files = opfsFiles();
    expect(files.backupRoot).toBe('/deep-student/recovery/backups');
    expect(files.roots.map((root) => root.path).filter((path) => files.backupRoot.startsWith(`${path}/`))).toEqual([DATA]);
    expect(createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(DATA), backupRoot: `${DATA}/elsewhere` }).backupRoot).toBe(`${DATA}/elsewhere`);
    let caught: unknown;
    try {
      void createOpfsFiles({ root: createFakeOpfs(), roots: [{ name: 'temp', path: `${DATA}/tmp` }] }).backupRoot;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileError);
    expect((caught as FileError).kind).toBe('UnsupportedOnPlatform');
    expect((caught as FileError).message).toBe('UNSUPPORTED_ON_PLATFORM: files.backupRoot needs an appData root');
  });

  it('directory rename without FileSystemDirectoryHandle.move() is unsupported and leaves both sides intact', async () => {
    const files = opfsFiles();
    await files.writeText(`${DATA}/dir/a.txt`, 'a', { createParents: true });
    const error = await fileError(files.rename(`${DATA}/dir`, `${DATA}/moved`), 'UnsupportedOnPlatform');
    expect(error.message).toMatch(/^UNSUPPORTED_ON_PLATFORM: directory rename/);
    expect(await files.readText(`${DATA}/dir/a.txt`)).toBe('a');
    expect(await files.exists(`${DATA}/moved`)).toBe(false);
  });

  it('directory rename uses move() where the engine provides it', async () => {
    const files = opfsFiles({ withDirectoryMove: true });
    await files.writeText(`${DATA}/dir/a.txt`, 'a', { createParents: true });
    await files.rename(`${DATA}/dir`, `${DATA}/moved`);
    expect(await files.readText(`${DATA}/moved/a.txt`)).toBe('a');
    expect(await files.exists(`${DATA}/dir`)).toBe(false);
  });

  it('without FileSystemFileHandle.move(), atomic writes and file renames are unsupported and the target is untouched', async () => {
    const root = createFakeOpfs({ withoutFileMove: true });
    const files = createOpfsFiles({ root, roots: mobileRoots(DATA) });
    await files.writeText(`${DATA}/state.json`, 'old', { createParents: true });
    await fileError(files.writeAtomic(`${DATA}/state.json`, 'new'), 'UnsupportedOnPlatform');
    await fileError(files.openWrite(`${DATA}/state.json`, { mode: 'atomic' }), 'UnsupportedOnPlatform');
    await fileError(files.rename(`${DATA}/state.json`, `${DATA}/renamed.json`), 'UnsupportedOnPlatform');
    expect(await files.readText(`${DATA}/state.json`)).toBe('old');
    expect((await files.readDir(DATA)).map((entry) => entry.name)).toEqual(['state.json']);
  });

  it('writes outside a Worker (no sync access handle) are unsupported and leave no empty file behind', async () => {
    const root = createFakeOpfs({ withoutSyncAccess: true });
    const files = createOpfsFiles({ root, roots: mobileRoots(DATA) });
    await files.mkdir(`${DATA}/d`);
    const error = await fileError(files.writeText(`${DATA}/d/x.txt`, 'x'), 'UnsupportedOnPlatform');
    expect(error.message).toMatch(/FileSystemSyncAccessHandle exists only in a dedicated Worker/);
    await fileError(files.openWrite(`${DATA}/d/y.txt`), 'UnsupportedOnPlatform');
    await fileError(files.writeAtomic(`${DATA}/d/z.txt`, 'z'), 'UnsupportedOnPlatform');
    expect(await files.readDir(`${DATA}/d`)).toEqual([]);
  });

  it('metadata OPFS does not keep is reported as null / 0, never invented', async () => {
    const files = opfsFiles();
    await files.writeText(`${DATA}/f.txt`, 'abc', { createParents: true });
    const stat = await files.stat(`${DATA}/f.txt`);
    expect(stat).toMatchObject({ kind: 'file', size: 3, createdMs: null, unixMode: null });
    expect(stat.modifiedMs).toBeGreaterThan(0);
    expect(await files.stat(DATA)).toEqual({ kind: 'directory', size: 0, modifiedMs: 0, createdMs: null, unixMode: null });
  });

  it('roots sit under AppInfo.dataDir; the SQLite pool directory is unreachable', async () => {
    expect(mobileRoots('/deep-student/')).toEqual([
      { name: 'appData', path: '/deep-student' },
      { name: 'appLocalData', path: '/deep-student/local' },
      { name: 'appConfig', path: '/deep-student/config' },
      { name: 'appCache', path: '/deep-student/cache' },
      { name: 'appLog', path: '/deep-student/logs' },
      { name: 'temp', path: '/deep-student/tmp' },
    ]);
    const files = opfsFiles();
    expect(files.flavor).toBe('posix');
    await fileError(files.readDir('/.deep-student'), 'OutsideRoots');
    await fileError(files.writeText(`${DATA}/../.deep-student/vfs.db`, 'x'), 'OutsideRoots');
  });
});

describe('OPFS failure paths', () => {
  it('quota exhaustion is StorageFull; writeAtomic keeps the old content and removes its temp file', async () => {
    const files = opfsFiles({ quotaBytes: 8 });
    await files.writeText(`${DATA}/q.txt`, 'small', { createParents: true });
    await fileError(files.writeAtomic(`${DATA}/q.txt`, 'much too large'), 'StorageFull');
    expect(await files.readText(`${DATA}/q.txt`)).toBe('small');
    expect((await files.readDir(DATA)).map((entry) => entry.name)).toEqual(['q.txt']);
    const error = await fileError(files.writeText(`${DATA}/q.txt`, 'much too large'), 'StorageFull');
    expect(error.osCode).toBe('QuotaExceededError');
  });

  it('a second writer on the same file is rejected while the first stream is open', async () => {
    const files = opfsFiles();
    const first = (await files.openWrite(`${DATA}/locked.txt`, { createParents: true })).getWriter();
    await first.write(new TextEncoder().encode('one'));
    const error = await fileError(files.writeText(`${DATA}/locked.txt`, 'two'), 'Other');
    expect(error.osCode).toBe('NoModificationAllowedError');
    await first.close();
    await files.writeText(`${DATA}/locked.txt`, 'two');
    expect(await files.readText(`${DATA}/locked.txt`)).toBe('two');
  });

  it('a writable openFile handle holds the file until close(); reads still work and see its writes', async () => {
    const files = opfsFiles();
    const path = `${DATA}/held.bin`;
    const handle = await files.openFile(path, { mode: 'create', createParents: true });
    await handle.write(new TextEncoder().encode('held'), 0);
    expect((await fileError(files.writeText(path, 'other'), 'Other')).osCode).toBe('NoModificationAllowedError');
    expect((await fileError(files.openFile(path, { mode: 'readWrite' }), 'Other')).osCode).toBe('NoModificationAllowedError');
    expect(await files.readText(path)).toBe('held');
    const reader = await files.openFile(path);
    await handle.write(new TextEncoder().encode('!'), 4);
    expect(new TextDecoder().decode(await reader.read(0, 10))).toBe('held!');
    await reader.close();
    await handle.close();
    await files.writeText(path, 'free');
    expect(await files.readText(path)).toBe('free');
  });

  it('openFile outside a Worker: read mode works, writable modes are unsupported and leave no file behind', async () => {
    const root = createFakeOpfs({ withoutSyncAccess: true });
    const files = createOpfsFiles({ root, roots: mobileRoots(DATA) });
    await files.mkdir(`${DATA}/d`);
    for (const mode of ['create', 'truncate', 'exclusive'] as const) {
      const error = await fileError(files.openFile(`${DATA}/d/new.bin`, { mode }), 'UnsupportedOnPlatform');
      expect(error.message).toMatch(/FileSystemSyncAccessHandle exists only in a dedicated Worker/);
    }
    expect(await files.readDir(`${DATA}/d`)).toEqual([]);
    await (await (await root.getDirectoryHandle(DATA.slice(1))).getDirectoryHandle('d')).getFileHandle('empty.bin', { create: true });
    await fileError(files.openFile(`${DATA}/d/empty.bin`, { mode: 'readWrite' }), 'UnsupportedOnPlatform');
    const reader = await files.openFile(`${DATA}/d/empty.bin`);
    expect([reader.size, (await reader.read(0, 4)).length]).toEqual([0, 0]);
    await reader.close();
    expect((await files.readDir(`${DATA}/d`)).map((entry) => entry.name)).toEqual(['empty.bin']);
  });

  it('a read-only handle reads the current content each time and reports NotFound once the file is gone', async () => {
    const files = opfsFiles();
    const path = `${DATA}/r.txt`;
    await files.writeText(path, 'one', { createParents: true });
    const reader = await files.openFile(path);
    await files.writeText(path, 'two!');
    expect(reader.size).toBe(3);
    expect(new TextDecoder().decode(await reader.read(0, 10))).toBe('two!');
    await files.rm(path);
    await fileError(reader.read(0, 1), 'NotFound');
    await reader.close();
  });

  it('openFile quota exhaustion is StorageFull for write and truncate; the handle stays usable', async () => {
    const files = opfsFiles({ quotaBytes: 8 });
    const handle = await files.openFile(`${DATA}/q.bin`, { mode: 'create', createParents: true });
    await handle.write(new TextEncoder().encode('12345678'), 0);
    expect((await fileError(handle.write(Uint8Array.of(9), 8), 'StorageFull')).osCode).toBe('QuotaExceededError');
    await fileError(handle.truncate(9), 'StorageFull');
    expect(handle.size).toBe(8);
    await handle.truncate(4);
    expect(new TextDecoder().decode(await handle.read(0, 10))).toBe('1234');
    await handle.close();
  });

  it('names OPFS rejects are InvalidPath', async () => {
    const files = opfsFiles();
    await fileError(files.writeText(`${DATA}/back\\slash.txt`, 'x', { createParents: true }), 'InvalidPath');
  });
});

describe('dstu.platform.files (mobile entry)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('provides ctx.files over navigator.storage.getDirectory() with roots under app.dataDir', async () => {
    const opfs = createFakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs } });
    const host = await createTestHost({ plugins: [filesMobile] });
    try {
      const dataDir = host.ctx.app.dataDir.replace(/\/+$/, '');
      expect(host.ctx.files.roots).toEqual(mobileRoots(dataDir));
      expect(host.ctx.files.backupRoot).toBe(`${dataDir}/recovery/backups`);
      await host.ctx.files.writeText(`${dataDir}/local/probe.txt`, 'ok', { createParents: true });
      expect(await host.ctx.files.readText(`${dataDir}/local/probe.txt`)).toBe('ok');
      expect((await opfs.entries()[Symbol.asyncIterator]().next()).value?.[0]).toBe(dataDir.split('/')[1]);
    } finally {
      await host.dispose();
    }
  });

  it('refuses to start without OPFS instead of providing a degraded service', async () => {
    vi.stubGlobal('navigator', {});
    const provided: unknown[] = [];
    const ctx = { app: { dataDir: DATA }, reflect: { provide: (...args: unknown[]) => provided.push(args) } };
    const error = await fileError((filesMobile as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx), 'UnsupportedOnPlatform');
    expect(error.message).toMatch(/^UNSUPPORTED_ON_PLATFORM: ctx\.files is not available on mobile/);
    expect(provided).toEqual([]);
  });

  it('declares mobile only and its runtime closure is Node-free', () => {
    expect(filesMobile.meta?.platforms).toEqual(['mobile']);
    expect(checkModulesClosure(ROOT, ['host/platform/files/mobile.ts', 'host/platform/files/opfs.ts'])).toEqual([]);
  });
});
