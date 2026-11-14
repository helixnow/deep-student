/**
 * W34 插件包事务安装：真实 `.dsplugin` ZIP → 暂存解压 → `assertInstallable` → 每个文件 SHA-256 →
 * `plugins.lock.json` 指针切换 → 失败回滚；以及 verify / resolveFile / setEnabled / uninstall / restore。
 *
 * ZIP 由可移植核心写出（`ZipWriter` + `MemoryZipSink`），安装时经 `FileScope.openFile` 的真实
 * `RandomAccessFile` 读取，走与桌面相同的内存外解压路径。契约见
 * `.reports/lanes/plugin-closeout/interfaces/plugin-packages.md`。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryZipSink, ZipWriter } from '../../platform/zip/core/index.ts';
import { nodeZipCodec } from '../../platform/zip/node/file.ts';
import { createNodeFiles } from '../../platform/files/index.ts';
import type { FileScope, FilesService } from '../../platform/files/api.ts';
import { PluginLoadError } from '../manifest.ts';
import { PluginPackages, type InstallResult, type PackagesLock } from './index.ts';

const ID = 'alice.sample';
const POSIX = process.platform !== 'win32';

interface ZipSpec {
  name: string;
  data?: string;
  directory?: boolean;
}

interface ManifestSpec {
  id?: string;
  version?: string;
  engines?: string;
  host?: string | null;
  ui?: string | null;
  platforms?: readonly string[];
  permissions?: readonly string[];
}

let root: string;
let pluginsDir: string;
let service: FilesService;
let plugins: FileScope;
let packages: PluginPackages;
let archiveCounter = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'w34-plugin-packages-'));
  pluginsDir = join(root, 'plugins');
  service = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
  plugins = service.scope(pluginsDir);
  packages = new PluginPackages(plugins);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function packageJson(spec: ManifestSpec = {}): string {
  const ds: Record<string, unknown> = {
    manifestVersion: 1,
    id: spec.id ?? ID,
    platforms: spec.platforms ?? ['desktop'],
  };
  if (spec.host !== null) ds.host = spec.host ?? './index.js';
  if (spec.ui !== null && spec.ui !== undefined) ds.ui = spec.ui;
  if (spec.permissions !== undefined) ds.permissions = [...spec.permissions];
  return `${JSON.stringify({
    name: 'deepstudent-plugin-w34',
    version: spec.version ?? '1.0.0',
    engines: { deepStudent: spec.engines ?? '^0.11.0' },
    deepStudent: ds,
  }, null, 2)}\n`;
}

const INDEX_V1 = 'export const version = "1.0.0";\n';
const INDEX_V2 = 'export const version = "2.0.0";\n';

function basicEntries(spec: ManifestSpec = {}, index = INDEX_V1): ZipSpec[] {
  return [
    { name: 'lib', directory: true },
    { name: 'package.json', data: packageJson(spec) },
    { name: 'index.js', data: index },
  ];
}

async function makeZip(entries: readonly ZipSpec[]): Promise<Uint8Array> {
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink, { codec: nodeZipCodec });
  for (const entry of entries) {
    if (entry.directory === true) await writer.addDirectory(entry.name);
    else await writer.addBytes(entry.name, entry.data ?? '');
  }
  await writer.finish();
  return sink.bytes();
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

function lockedFiles(entries: readonly ZipSpec[]): Record<string, string> {
  return Object.fromEntries(entries
    .filter((entry) => entry.directory !== true)
    .map((entry) => [entry.name, sha256(entry.data ?? '')]));
}

const CHECKS = { appVersion: '0.11.0', platform: 'desktop' as const, installed: new Map<string, string>() };

/** 写临时档案并用真实 RandomAccessFile 安装；调用方 archive 归测试所有。 */
async function install(
  target: PluginPackages,
  entries: readonly ZipSpec[],
  archiveName = 'sample.dsplugin',
  checks = CHECKS,
): Promise<InstallResult> {
  const archivePath = join(root, 'incoming', `${archiveCounter += 1}-${archiveName}`);
  await service.writeBytes(archivePath, await makeZip(entries), { createParents: true });
  const archive = await service.openFile(archivePath);
  try {
    return await target.install(archive, archiveName, checks);
  } finally {
    await archive.close();
  }
}

async function readLock(): Promise<PackagesLock> {
  return JSON.parse(await plugins.readText('plugins.lock.json')) as PackagesLock;
}

async function readLockText(): Promise<string> {
  return plugins.readText('plugins.lock.json');
}

async function rejects(promise: Promise<unknown>, pattern: RegExp | null = /^PLUGIN_PACKAGE_INVALID: /): Promise<Error> {
  let caught: unknown;
  await promise.then(
    () => { throw new Error('expected the operation to reject'); },
    (error: unknown) => { caught = error; },
  );
  expect(caught).toBeInstanceOf(Error);
  if (pattern !== null) expect((caught as Error).message).toMatch(pattern);
  return caught as Error;
}

describe('RF-W34-offline-package-transaction: offline .dsplugin transaction', () => {
  it('stages a real ZIP, consumes assertInstallable, locks every per-file SHA-256 and flips the lock pointer', async () => {
    const entries: ZipSpec[] = [
      { name: 'lib', directory: true },
      { name: 'package.json', data: packageJson() },
      { name: 'index.js', data: INDEX_V1 },
      { name: 'ui.js', data: 'export default { ui: true };\n' },
      { name: 'lib/data.txt', data: 'nested ✓\n' },
    ];
    const result = await install(packages, entries);

    expect(result.previous).toBeNull();
    expect(result.manifest).toMatchObject({ id: ID, version: '1.0.0', host: './index.js' });
    expect(result.record).toMatchObject({ id: ID, version: '1.0.0', enabled: false });
    expect(result.record.path).toMatch(new RegExp(`^releases/${ID}/1\\.0\\.0-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));

    const lock = await readLock();
    expect(lock.lockVersion).toBe(1);
    expect(Object.keys(lock.plugins)).toEqual([ID]);
    const stored = lock.plugins[ID]!;
    expect(stored).toEqual({
      id: ID,
      version: '1.0.0',
      path: result.record.path,
      enabled: false,
      files: lockedFiles(entries),
    });
    expect(stored.files['package.json']).toBe(sha256(packageJson()));

    // Extracted bytes are the archive payload, at the unique release path.
    expect(await plugins.readText(`${stored.path}/index.js`)).toBe(INDEX_V1);
    expect(await plugins.readText(`${stored.path}/lib/data.txt`)).toBe('nested ✓\n');
    // The caller's archive and staging area are left untouched / cleaned.
    expect(await plugins.exists('plugins.lock.json')).toBe(true);
    expect(await plugins.readDir('.staging')).toEqual([]);
    expect((await plugins.readDir(`releases/${ID}`)).map((entry) => entry.name)).toEqual([stored.path.slice(`releases/${ID}/`.length)]);

    expect(await packages.list()).toEqual([stored]);
    expect(await packages.verify(ID)).toEqual(stored);

    // A freshly installed package starts disabled; resolveFile/verify reflect exactly that.
    await rejects(packages.resolveFile(ID, 'index.js'), /disabled: alice\.sample/);
    const enabled = await packages.setEnabled(ID, true);
    expect(enabled.enabled).toBe(true);
    expect((await readLock()).plugins[ID]!.enabled).toBe(true);

    const absolute = await packages.resolveFile(ID, 'index.js');
    expect(absolute).toBe(plugins.resolve(`${stored.path}/index.js`));
    expect(await service.readText(absolute)).toBe(INDEX_V1);
    await rejects(packages.resolveFile(ID, 'missing.js'), /unlocked file missing\.js/);
    await rejects(packages.resolveFile(ID, '../package.json'), /invalid path/);
  });

  it('preserves the previous lock and release when assertInstallable rejects (engine, reserved id, missing entrypoint)', async () => {
    const v1 = await install(packages, basicEntries());
    await packages.setEnabled(ID, true);
    const before = await readLockText();

    const incompatible = [
      { name: 'package.json', data: packageJson({ version: '2.0.0', engines: '^0.12.0' }) },
      { name: 'index.js', data: INDEX_V2 },
    ];
    const engineError = await rejects(install(packages, incompatible, 'engine.dsplugin'), /ENGINE_INCOMPATIBLE/);
    expect(engineError).toBeInstanceOf(PluginLoadError);
    expect((engineError as PluginLoadError).code).toBe('ENGINE_INCOMPATIBLE');

    const reserved = await rejects(install(packages, basicEntries({ id: 'test.w34' }), 'reserved.dsplugin'), /ID_RESERVED/);
    expect(reserved).toBeInstanceOf(PluginLoadError);
    expect((reserved as PluginLoadError).code).toBe('ID_RESERVED');

    // Manifest passes, but the declared entrypoint is not in the payload: fails after staging + hashing.
    const missing = [
      { name: 'package.json', data: packageJson({ version: '2.0.0', host: './missing.js' }) },
      { name: 'index.js', data: INDEX_V2 },
    ];
    await rejects(install(packages, missing, 'missing.dsplugin'), /missing host entrypoint \.\/missing\.js/);

    expect(await readLockText()).toBe(before);
    expect(await packages.verify(ID)).toEqual({ ...v1.record, enabled: true });
    expect(await plugins.readText(`${v1.record.path}/index.js`)).toBe(INDEX_V1);
    expect(await plugins.readDir(`releases/${ID}`)).toHaveLength(1);
    expect(await plugins.readDir('.staging')).toEqual([]);
  });
});

describe('W34 plugin packages: verified reads and mutations', () => {
  it('verify rejects tampered, extra and missing files, and list stays a structural read only', async () => {
    const result = await install(packages, basicEntries());
    await packages.setEnabled(ID, true);
    const release = result.record.path;
    const index = `${release}/index.js`;

    await plugins.writeText(index, 'tampered');
    await rejects(packages.verify(ID), /SHA256 mismatch index\.js/);
    // list() reads the lock structure, not payload bytes.
    expect(await packages.list()).toEqual([{ ...result.record, enabled: true }]);

    await plugins.writeText(index, INDEX_V1);
    expect((await packages.verify(ID)).path).toBe(release);

    await plugins.writeText(`${release}/extra.js`, 'unlocked');
    await rejects(packages.verify(ID), /unlocked\/non-regular file extra\.js/);
    await plugins.rm(`${release}/extra.js`);

    await plugins.rm(index);
    await rejects(packages.verify(ID), /locked file missing/);
    await plugins.writeText(index, INDEX_V1);

    // Disabling does not need payload integrity, enabling does.
    await plugins.writeText(index, 'tampered again');
    expect((await packages.setEnabled(ID, false)).enabled).toBe(false);
    await rejects(packages.setEnabled(ID, true), /SHA256 mismatch index\.js/);
  });

  it('upgrade keeps enabled state, switches the pointer, and restore rolls back without overwriting a newer install', async () => {
    const v1 = await install(packages, basicEntries());
    await packages.setEnabled(ID, true);
    const v2Entries: ZipSpec[] = [
      { name: 'lib', directory: true },
      { name: 'package.json', data: packageJson({ version: '2.0.0' }) },
      { name: 'index.js', data: INDEX_V2 },
      { name: 'lib/new.txt', data: 'new file\n' },
    ];
    const v2 = await install(packages, v2Entries, 'upgrade.dsplugin');

    expect(v2.previous).toEqual({ ...v1.record, enabled: true });
    expect(v2.record.enabled).toBe(true);
    expect((await readLock()).plugins[ID]!.path).toBe(v2.record.path);
    expect(await service.readText(await packages.resolveFile(ID, 'index.js'))).toBe(INDEX_V2);
    // Old release is retained for rollback/in-flight reads.
    expect(await plugins.exists(`${v1.record.path}/index.js`)).toBe(true);

    await packages.restore(ID, v2.previous, v2.record.path);
    expect((await readLock()).plugins[ID]!.path).toBe(v1.record.path);
    expect(await service.readText(await packages.resolveFile(ID, 'index.js'))).toBe(INDEX_V1);
    expect((await packages.verify(ID)).enabled).toBe(true);

    // A stale rollback (another install already moved the pointer) is rejected without changes.
    await rejects(packages.restore(ID, v1.record, v2.record.path), /rollback conflict: alice\.sample/);
    expect((await readLock()).plugins[ID]!.path).toBe(v1.record.path);

    // Rollback of a fresh install removes the pointer; rollback of an uninstall restores it.
    await packages.restore(ID, null, v1.record.path);
    expect((await readLock()).plugins).toEqual({});
    expect(await packages.list()).toEqual([]);
    await packages.restore(ID, v2.record, '');
    expect((await readLock()).plugins[ID]!.path).toBe(v2.record.path);
    expect(await service.readText(await packages.resolveFile(ID, 'index.js'))).toBe(INDEX_V2);
  });

  it('uninstall removes only the pointer and restore can bring the retained payload back', async () => {
    const result = await install(packages, basicEntries());
    await packages.setEnabled(ID, true);
    const removed = await packages.uninstall(ID);

    expect(removed).toEqual({ ...result.record, enabled: true });
    expect((await readLock()).plugins).toEqual({});
    await rejects(packages.verify(ID), /not installed: alice\.sample/);
    await rejects(packages.resolveFile(ID, 'index.js'), /not installed: alice\.sample/);
    // Payload retained for in-flight reads and rollback.
    expect(await plugins.readText(`${removed.path}/index.js`)).toBe(INDEX_V1);

    await packages.restore(ID, removed, '');
    expect((await packages.verify(ID)).enabled).toBe(true);
    expect(await service.readText(await packages.resolveFile(ID, 'index.js'))).toBe(INDEX_V1);
    await rejects(packages.uninstall('alice.missing'), /not installed: alice\.missing/);
  });

  it.skipIf(!POSIX)('rejects symlinked release ancestors and leaf files', async () => {
    const result = await install(packages, basicEntries());
    const release = result.record.path;
    const index = `${release}/index.js`;
    const outside = join(root, 'outside.js');
    await service.writeText(outside, 'outside payload');

    await plugins.rm(index);
    await symlink(outside, plugins.resolve(index));
    await rejects(packages.verify(ID), /unlocked\/non-regular file index\.js/);

    await plugins.rm(index);
    await plugins.writeText(index, INDEX_V1);

    // Replace the release directory itself with a symlink to a sibling.
    await plugins.rename(release, 'moved-release');
    await symlink(join(pluginsDir, 'moved-release'), plugins.resolve(release));
    await rejects(packages.verify(ID), /not a release directory: releases\/alice\.sample/);
  });
});

describe('W34 plugin packages: archive guards and failed commit', () => {
  it('rejects non-.dsplugin names, ZIP slip, duplicate paths and nested manifests without touching the lock', async () => {
    await rejects(install(packages, basicEntries(), 'plugin.zip'), /expected \.dsplugin ZIP/);
    expect(await plugins.exists('plugins.lock.json')).toBe(false);

    await rejects(install(packages, [
      { name: 'package.json', data: packageJson() },
      { name: '../escape.js', data: 'escape' },
    ], 'slip.dsplugin'), /invalid path "\.\.\/escape\.js"/);
    expect(await service.exists(join(root, 'escape.js'))).toBe(false);
    expect(await service.exists(join(pluginsDir, 'escape.js'))).toBe(false);
    expect(await plugins.exists('plugins.lock.json')).toBe(false);

    await rejects(install(packages, [
      { name: 'package.json', data: packageJson() },
      { name: 'index.js', data: INDEX_V1 },
      { name: 'Index.js', data: 'case duplicate' },
    ], 'duplicate.dsplugin'), /duplicate ZIP path/);

    await rejects(install(packages, [
      { name: 'package.json', data: packageJson() },
      { name: 'a\\b.js', data: 'windows alias' },
    ], 'backslash.dsplugin'), /invalid path/);

    // An enclosing folder means there is no root package.json; the failure must not publish anything.
    await rejects(install(packages, [
      { name: 'nested/package.json', data: packageJson() },
      { name: 'nested/index.js', data: INDEX_V1 },
    ], 'nested.dsplugin'), /package\.json is missing at the archive root/);
    expect(await plugins.exists('plugins.lock.json')).toBe(false);
    expect(await plugins.readDir('.staging')).toEqual([]);
  });

  it('removes the unpublished release when post-publish verification fails', async () => {
    const v1 = await install(packages, basicEntries());
    const before = await readLockText();

    // Corrupt the release after it is moved into place, so verifyRecord (before commit) rejects.
    const corrupting: FileScope = {
      ...plugins,
      rename: async (from, to, options) => {
        await plugins.rename(from, to, options);
        if (to.startsWith('releases/')) await plugins.writeText(`${to}/index.js`, 'corrupted after rename');
      },
    };
    const v2Entries = [
      { name: 'package.json', data: packageJson({ version: '2.0.0' }) },
      { name: 'index.js', data: INDEX_V2 },
    ];
    await rejects(install(new PluginPackages(corrupting), v2Entries, 'corrupt.dsplugin'), /SHA256 mismatch index\.js/);

    expect(await readLockText()).toBe(before);
    expect(await packages.verify(ID)).toEqual(v1.record);
    expect(await plugins.readDir(`releases/${ID}`)).toHaveLength(1);
    expect(await plugins.readDir('.staging')).toEqual([]);
  });

  it('removes the unpublished release and keeps the previous pointer when the atomic lock commit fails', async () => {
    const v1 = await install(packages, basicEntries());
    const before = await readLockText();

    // Fail only the final pointer replacement, after staging -> release and full verification.
    const failing: FileScope = {
      ...plugins,
      writeAtomic: async (path, data, options) => {
        if (path === 'plugins.lock.json') throw new Error('injected commit failure');
        return plugins.writeAtomic(path, data, options);
      },
    };
    const failingPackages = new PluginPackages(failing);
    const v2Entries = [
      { name: 'package.json', data: packageJson({ version: '2.0.0' }) },
      { name: 'index.js', data: INDEX_V2 },
    ];
    await rejects(install(failingPackages, v2Entries, 'commit.dsplugin'), /injected commit failure/);

    expect(await readLockText()).toBe(before);
    expect(await packages.verify(ID)).toEqual(v1.record);
    expect(await plugins.readText(`${v1.record.path}/index.js`)).toBe(INDEX_V1);
    expect(await plugins.readDir(`releases/${ID}`)).toHaveLength(1);
    expect(await plugins.readDir('.staging')).toEqual([]);
    expect((await packages.list())[0]!.path).toBe(v1.record.path);
  });
});
