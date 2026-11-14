/**
 * 备份 ZIP 经 `ctx.files.openFile` 读写：同一组 `zip-io` 用例在桌面（node:fs + zlib）与移动端
 * （内存 OPFS + Web 编解码）各跑一遍；桌面另测插件层的导出/导入走 `ctx.files`、与无 `files` 宿主字节一致、
 * 根外路径只在调用期间放行，以及官方桌面 profile 下的装配与备份根。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { FileError, type FilesService, type OpenFileOptions } from '../../../platform/files/api.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import { ZipFormatError, nodeZipCodec, webZipCodec, type ZipCodec } from '../../../platform/zip/index.ts';
import { backupDir } from '../src/paths.ts';
import { exportBackupToZip, importBackupFromZip } from '../src/zip.ts';
import { ArchiveReader, ArchiveWriter, allowPath, writeStreamToFile, type ArchiveIo } from '../src/zip-io.ts';
import { createBackupHost, hostBackupRoot, partialManifest, writeBackup } from './helpers.ts';

const hosts: TestHost[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 确定性的伪随机字节（不可压缩，跨多个 1 MiB 读块）。 */
function noise(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
}

const encoder = new TextEncoder();
const SOURCES: Record<string, Uint8Array> = {
  'persistent/webview_settings.json': encoder.encode('{"theme":"dark"}'),
  'persistent/empty.json': new Uint8Array(0),
  'persistent/blob.bin': noise(2.5 * 1024 * 1024 + 17, 7),
};

async function fileError(promise: Promise<unknown>, kind: FileError['kind']): Promise<FileError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error, `expected FileError(${kind})`).toBeInstanceOf(FileError);
  expect((error as FileError).kind, (error as Error).message).toBe(kind);
  return error as FileError;
}

interface Backend {
  readonly files: FilesService;
  readonly codec: ZipCodec;
  /** 允许根内、已存在的工作目录（appData 根）。 */
  readonly base: string;
  /** appData 根下的 `recovery/backups`（Rust `recovery_backups_dir`），无需 `grant()`。 */
  readonly backupRoot: string;
}

const MOBILE_DATA = '/deep-student';

const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['desktop (node:fs + zlib)', async () => {
    const root = tempDir('w08-zip-files-desktop-');
    const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
    expect(files.backupRoot).toBe(backupDir(root));
    return { files, codec: nodeZipCodec, base: root, backupRoot: files.backupRoot };
  }],
  ['mobile (in-memory OPFS + Web codec)', async () => {
    const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(MOBILE_DATA) });
    await files.mkdir(MOBILE_DATA);
    expect(files.backupRoot).toBe(`${MOBILE_DATA}/recovery/backups`);
    return { files, codec: webZipCodec, base: MOBILE_DATA, backupRoot: files.backupRoot };
  }],
];

async function writeSources(files: FilesService, dir: string): Promise<void> {
  for (const [name, bytes] of Object.entries(SOURCES)) {
    const path = `${dir}/${name}`;
    await files.mkdir(path.slice(0, path.lastIndexOf('/')));
    await files.writeBytes(path, bytes);
  }
}

async function buildArchive(io: ArchiveIo, sourceDir: string, path: string): Promise<number> {
  const writer = await ArchiveWriter.create(io, path);
  try {
    await writer.addBuffer('manifest.json', '{"backup_id":"b1"}');
    await writer.addDirectory('persistent');
    for (const [name, bytes] of Object.entries(SOURCES)) {
      const written = await writer.addFile(name, `${sourceDir}/${name}`, {
        verifyOpened: (size, isFile) => {
          expect([size, isFile]).toEqual([bytes.length, true]);
        },
      });
      expect(written.size).toBe(bytes.length);
    }
    return await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

describe.each(BACKENDS)('zip-io over files.openFile: %s', (_name, backend) => {
  it('round trip: write with addFile, read back and extract into exclusive files', async () => {
    const { files, codec, base, backupRoot: root } = await backend();
    const io: ArchiveIo = { files, codec };
    await writeSources(files, `${root}/b1`);
    const total = await buildArchive(io, `${root}/b1`, `${root}/b1.zip`);
    expect((await files.stat(`${root}/b1.zip`)).size).toBe(total);

    const zip = await JSZip.loadAsync(await files.readBytes(`${root}/b1.zip`));
    expect(Object.keys(zip.files)).toEqual(['manifest.json', 'persistent/', ...Object.keys(SOURCES)]);
    expect(sameBytes(await zip.file('persistent/blob.bin')!.async('uint8array'), SOURCES['persistent/blob.bin']!)).toBe(true);

    const reader = await ArchiveReader.open(io, `${root}/b1.zip`, { maxEntries: 10 });
    try {
      expect(reader.fileSize).toBe(total);
      expect(reader.has('persistent/empty.json')).toBe(true);
      await files.mkdir(`${base}/extracted`);
      for (const [name, bytes] of Object.entries(SOURCES)) {
        const target = `${base}/extracted/${name.replace('/', '-')}`;
        const handle = await files.openFile(target, { mode: 'exclusive' });
        let written: number;
        try {
          written = await writeStreamToFile(await reader.openEntry(reader.find(name)!), handle);
          await handle.sync();
        } finally {
          await handle.close();
        }
        expect(written).toBe(bytes.length);
        expect(sameBytes(await files.readBytes(target), bytes), name).toBe(true);
      }
    } finally {
      await reader.close();
    }
  });

  it('the archive opens exclusive: an existing file is refused and left intact', async () => {
    const { files, codec, base } = await backend();
    await files.writeText(`${base}/taken.zip`, 'keep me');
    await fileError(ArchiveWriter.create({ files, codec }, `${base}/taken.zip`), 'AlreadyExists');
    expect(await files.readText(`${base}/taken.zip`)).toBe('keep me');
  });

  it('abort closes the handle and removes the partial archive', async () => {
    const { files, codec, base } = await backend();
    const io: ArchiveIo = { files, codec };
    const writer = await ArchiveWriter.create(io, `${base}/partial.zip`);
    await writer.addBuffer('a.txt', 'partial');
    await writer.abort();
    expect(await files.exists(`${base}/partial.zip`)).toBe(false);
    expect(() => writer.addBuffer('b.txt', 'late')).toThrow('ZipFileWriter is aborted');
    // 移动端写入句柄持有同步访问锁：abort 后必须已释放，同一路径可以重新独占创建。
    const again = await ArchiveWriter.create(io, `${base}/partial.zip`);
    await again.finish();
    const reader = await ArchiveReader.open(io, `${base}/partial.zip`);
    expect(reader.entries).toEqual([]);
    await reader.close();
  });

  it('a directory source is reported through verifyOpened before any byte is written', async () => {
    const { files, codec, base } = await backend();
    await files.mkdir(`${base}/a-dir`);
    const writer = await ArchiveWriter.create({ files, codec }, `${base}/dir.zip`);
    const seen: Array<[number, boolean]> = [];
    await expect(writer.addFile('a-dir', `${base}/a-dir`, {
      verifyOpened: (size, isFile) => {
        seen.push([size, isFile]);
        if (!isFile) throw new Error('导出文件在打开期间发生变化');
      },
    })).rejects.toThrow('导出文件在打开期间发生变化');
    expect(seen).toEqual([[0, false]]);
    expect(writer.path).toBe(`${base}/dir.zip`);
    await writer.abort();
  });

  it('a corrupt archive is rejected as a ZIP error and its handle is released', async () => {
    const { files, codec, base } = await backend();
    await files.writeBytes(`${base}/corrupt.zip`, noise(4096, 3));
    await expect(ArchiveReader.open({ files, codec }, `${base}/corrupt.zip`)).rejects.toBeInstanceOf(ZipFormatError);
    await files.rm(`${base}/corrupt.zip`);
    expect(await files.exists(`${base}/corrupt.zip`)).toBe(false);
  });

  it('missing sources and paths outside the roots fail with FileError', async () => {
    const { files, codec, base } = await backend();
    const writer = await ArchiveWriter.create({ files, codec }, `${base}/missing.zip`);
    await fileError(writer.addFile('gone.txt', `${base}/gone.txt`), 'NotFound');
    await writer.abort();
    await fileError(ArchiveReader.open({ files, codec }, '/definitely-outside/x.zip'), 'OutsideRoots');
  });
});

describe('mobile: archive bytes and path policy', () => {
  it('the OPFS + Web codec archive is byte-identical to the desktop zlib archive', async () => {
    const outputs: Uint8Array[] = [];
    for (const [, backend] of BACKENDS) {
      const { files, codec, backupRoot: root } = await backend();
      await writeSources(files, `${root}/b1`);
      await buildArchive({ files, codec }, `${root}/b1`, `${root}/b1.zip`);
      outputs.push(await files.readBytes(`${root}/b1.zip`));
    }
    expect(outputs[1]!.length).toBe(outputs[0]!.length);
    expect(sameBytes(outputs[1]!, outputs[0]!)).toBe(true);
  });

  it('paths inside the OPFS roots need no grant; paths outside cannot be granted on mobile', async () => {
    const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(MOBILE_DATA) });
    const before = files.roots.length;
    const revoke = await allowPath(files, `${MOBILE_DATA}/recovery/backups/b1.zip`);
    expect(files.roots.length).toBe(before);
    revoke();
    await fileError(allowPath(files, '/sdcard/Download/b1.zip'), 'UnsupportedOnPlatform');
    expect(files.roots.length).toBe(before);
  });
});

const FILES_TEXT = {
  'persistent/webview_settings.json': '{"theme":"dark"}',
  'persistent/custom_grading_modes.json': '{"modes":[]}',
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const noProgress = (): void => undefined;
const notCancelled = (): boolean => false;

function recordingFiles(inner: FilesService, calls: Array<[string, string]>): FilesService {
  return new Proxy(inner, {
    get(target, key) {
      if (key === 'openFile') {
        return (path: string, options?: OpenFileOptions) => {
          calls.push([options?.mode ?? 'read', path]);
          return target.openFile(path, options);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else out[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return out;
}

describe('desktop: backup export/import through ctx.files', () => {
  it('the archive, its sources and every extracted file are opened through ctx.files.openFile', async () => {
    const calls: Array<[string, string]> = [];
    const { host } = await createBackupHost({
      secrets: true,
      files: dataDir => recordingFiles(createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] }), calls),
    });
    hosts.push(host);
    const root = hostBackupRoot(host);
    const dir = writeBackup(root, partialManifest('recorded', { files: FILES_TEXT }), FILES_TEXT);

    const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, noProgress, notCancelled);
    await importBackupFromZip(host.ctx, result.zipPath, join(root, 'imported'), {
      password: null, skipExisting: false, onProgress: noProgress, isCancelled: notCancelled,
    });
    expect(calls.map(([mode, path]) => [mode, relative(root, path).replace(UUID, '<uuid>')])).toEqual([
      ['exclusive', '.recorded.zip.<uuid>.tmp'],
      ['read', 'recorded/persistent/custom_grading_modes.json'],
      ['read', 'recorded/persistent/webview_settings.json'],
      ['read', '.recorded.zip.<uuid>.tmp'],
      ['read', 'recorded.zip'],
      ['exclusive', 'imported/.manifest.json.<uuid>.tmp'],
      ['exclusive', 'imported/persistent/.custom_grading_modes.json.<uuid>.tmp'],
      ['exclusive', 'imported/persistent/.webview_settings.json.<uuid>.tmp'],
      ['exclusive', 'imported/.checksums.sha256.<uuid>.tmp'],
    ]);
  });

  it('archives and imports are byte-identical with and without a files service (fs handle fallback)', async () => {
    const manifest = partialManifest('same-bytes', { files: { ...FILES_TEXT, 'persistent/blob.bin': SOURCES['persistent/blob.bin']! } });
    const sources = { ...FILES_TEXT, 'persistent/blob.bin': SOURCES['persistent/blob.bin']! };
    const outputs: Array<{ zip: Buffer; checksum: string; count: number; tree: Record<string, string> }> = [];
    for (const files of [undefined, false] as const) {
      const { host } = await createBackupHost({ secrets: true, ...(files === false ? { files } : {}) });
      hosts.push(host);
      expect(host.ctx.get('files') === undefined).toBe(files === false);
      const dir = writeBackup(hostBackupRoot(host), manifest, sources);
      const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, noProgress, notCancelled);
      const target = join(hostBackupRoot(host), 'imported');
      const count = await importBackupFromZip(host.ctx, result.zipPath, target, {
        password: null, skipExisting: false, onProgress: noProgress, isCancelled: notCancelled,
      });
      outputs.push({ zip: readFileSync(result.zipPath), checksum: result.zipChecksum, count, tree: readTree(target) });
    }
    expect(outputs[1]!.zip.equals(outputs[0]!.zip)).toBe(true);
    expect(outputs[1]!.checksum).toBe(outputs[0]!.checksum);
    expect(outputs[1]!.count).toBe(outputs[0]!.count);
    expect(outputs[1]!.tree).toEqual(outputs[0]!.tree);
    expect(Object.keys(outputs[0]!.tree)).toContain('persistent/blob.bin');
  });

  it('overlapping operations on the same outside directory each hold their own grant (R01 I1)', async () => {
    const files = createNodeFiles({ roots: [{ name: 'appData', path: tempDir('w08-zip-roots-') }] });
    const outside = tempDir('w08-zip-overlap-');
    const target = join(outside, 'portable.zip');
    const rootsBefore = files.roots.length;

    const revokeFirst = await allowPath(files, outside);
    const revokeSecond = await allowPath(files, outside);
    revokeFirst();
    expect(await files.isAllowed(target)).toBe(true);
    const handle = await files.openFile(target, { mode: 'exclusive' });
    await handle.close();
    revokeSecond();
    expect(await files.isAllowed(target)).toBe(false);
    expect(files.roots.length).toBe(rootsBefore);
  });

  it('a user-chosen export target and import source outside the roots are granted only during the call', async () => {
    const { host } = await createBackupHost({ secrets: true });
    hosts.push(host);
    const files = host.ctx.get('files') as FilesService;
    const rootsBefore = files.roots.length;
    const outside = tempDir('w08-zip-outside-');
    const zipPath = join(outside, 'nested', 'portable.zip');
    expect(await files.isAllowed(outside)).toBe(false);

    const dir = writeBackup(hostBackupRoot(host), partialManifest('granted', { files: FILES_TEXT }), FILES_TEXT);
    const result = await exportBackupToZip(host.ctx, dir, {
      compressionLevel: 6, includeChecksums: true, outputPath: zipPath,
    }, noProgress, notCancelled);
    expect(result.zipPath).toBe(zipPath);
    expect(files.roots.length).toBe(rootsBefore);
    expect(await files.isAllowed(zipPath)).toBe(false);

    const count = await importBackupFromZip(host.ctx, zipPath, join(hostBackupRoot(host), 'from-outside'), {
      password: null, skipExisting: false, onProgress: noProgress, isCancelled: notCancelled,
    });
    expect(count).toBe(4);
    expect(files.roots.length).toBe(rootsBefore);
    expect(await files.isAllowed(zipPath)).toBe(false);

    // 失败路径同样撤销：导出在压缩阶段被取消。
    let progressed = false;
    await expect(exportBackupToZip(host.ctx, dir, {
      compressionLevel: 6, includeChecksums: true, outputPath: join(outside, 'cancelled.zip'),
    }, progress => { if (progress.phase === 'compress') progressed = true; }, () => progressed)).rejects.toThrow('用户取消导出');
    expect(files.roots.length).toBe(rootsBefore);
    expect(readdirSync(outside).sort()).toEqual(['nested']);
  });

  it('official desktop profile: export/import run on the profile files service; the backup root is inside its roots and needs no grant', async () => {
    const root = tempDir('w08-zip-profile-');
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
    try {
      const host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
      hosts.push(host);
      new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
        store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
      expect((await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH })).degraded).toEqual([]);
      const files = host.ctx.get('files') as FilesService;
      const backupRoot = backupDir(host.app.dataDir);
      expect(files.backupRoot).toBe(backupRoot);
      expect(files.backupRoot).toBe(backupDir(join(host.app.dataDir, 'slots', 'slotA')));
      expect(await files.isAllowed(join(backupRoot, 'profile.zip'))).toBe(true);
      const rootsBefore = files.roots.length;

      const dir = writeBackup(backupRoot, partialManifest('profile', { files: FILES_TEXT }), FILES_TEXT);
      const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, noProgress, notCancelled);
      expect(result.zipPath).toBe(join(backupRoot, 'profile.zip'));
      expect(files.roots.length).toBe(rootsBefore);
      const count = await importBackupFromZip(host.ctx, result.zipPath, join(backupRoot, 'profile-imported'), {
        password: null, skipExisting: false, onProgress: noProgress, isCancelled: notCancelled,
      });
      expect(count).toBe(4);
      expect(files.roots.length).toBe(rootsBefore);
      expect(readTree(join(backupRoot, 'profile-imported'))['persistent/webview_settings.json'])
        .toBe(Buffer.from(FILES_TEXT['persistent/webview_settings.json']).toString('base64'));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});
