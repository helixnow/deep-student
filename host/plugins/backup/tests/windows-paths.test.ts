/**
 * Windows 路径形态下的两处包含判断：本文件把 `node:path` 与平台 `util/path.ts` 换成 `win32`，并用一个内存里的
 * “文件系统”模拟 Windows 上 `realpath` 的结果，在 POSIX 机器上复现分隔符相关的问题。
 * - `ensureZipOutputOutsideSource`（Rust `zip_export.rs:713`）：ZIP 不能写进备份源目录；
 * - `safeExistingFileUnderRoot`（Rust `assets.rs:270`）：资产必须位于备份根之内；
 * - ZIP 条目名（Rust zip 0.6.6 `enclosed_name`）：带盘符前缀的条目在 Windows 上是越界路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    /** 已存在的路径（小写键，Windows 大小写不敏感），值为 `realpath` 返回的规范路径。 */
    entries: new Map<string, string>(),
  };
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
    code: 'ENOENT', errno: -2, path,
  });
  const key = (path: string) => path.toLowerCase().replace(/[\\/]+$/, '');
  return {
    state,
    key,
    realpath(path: string): string {
      const found = state.entries.get(key(path));
      if (found === undefined) throw enoent(path);
      return found;
    },
  };
});

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});
vi.mock('../../../platform/util/path.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../platform/util/path.ts')>('../../../platform/util/path.ts');
  return { ...actual, ...actual.win32, hostPath: actual.win32 };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const realpathSync = (path: string) => fake.realpath(path);
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const realpath = async (path: string) => fake.realpath(path);
  const lstat = async (path: string) => {
    fake.realpath(path);
    return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
  };
  return { ...actual, realpath, lstat, default: { ...actual, realpath, lstat } };
});

const { ensureZipOutputOutsideSource, isUnsafeArchivePath, validateSecretsArchive } = await import('../src/zip.ts');
const { safeExistingFileUnderRoot } = await import('../src/assets.ts');

function exists(...paths: Array<[string, string?]>): void {
  for (const [path, real] of paths) fake.state.entries.set(fake.key(path), real ?? path);
}

beforeEach(() => {
  fake.state.entries.clear();
  exists(['C:\\Users\\me'], ['C:\\Users\\me\\backups'], ['C:\\Users\\me\\backups\\b1'], ['C:\\Users\\me\\backups\\b10'], ['D:\\']);
});

describe('ensureZipOutputOutsideSource with Windows paths', () => {
  const source = 'C:\\Users\\me\\backups\\b1';

  it('rejects an output path inside the source directory', async () => {
    await expect(ensureZipOutputOutsideSource(source, 'C:\\Users\\me\\backups\\b1\\out.zip'))
      .rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
    await expect(ensureZipOutputOutsideSource(source, 'C:/Users/me/backups/b1/out.zip'))
      .rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  });

  it('rejects inside paths that differ only by letter case (NTFS is case-insensitive)', async () => {
    await expect(ensureZipOutputOutsideSource(source, 'c:\\users\\ME\\Backups\\B1\\out.zip'))
      .rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  });

  it('rejects an output under a directory that does not exist yet inside the source', async () => {
    await expect(ensureZipOutputOutsideSource(source, 'C:\\Users\\me\\backups\\b1\\exports\\out.zip'))
      .rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  });

  it('rejects an existing output that resolves into the source directory', async () => {
    exists(['C:\\Users\\me\\link.zip', 'C:\\Users\\me\\backups\\b1\\inside.zip']);
    await expect(ensureZipOutputOutsideSource(source, 'C:\\Users\\me\\link.zip'))
      .rejects.toThrow('ZIP 输出路径不能指向备份源目录内');
  });

  it('accepts siblings, name-prefix neighbours and other drives', async () => {
    await expect(ensureZipOutputOutsideSource(source, 'C:\\Users\\me\\backups\\b1.zip')).resolves.toBeUndefined();
    await expect(ensureZipOutputOutsideSource(source, 'C:\\Users\\me\\backups\\b10\\out.zip')).resolves.toBeUndefined();
    await expect(ensureZipOutputOutsideSource(source, 'D:\\out.zip')).resolves.toBeUndefined();
  });
});

describe('safeExistingFileUnderRoot with Windows paths', () => {
  const root = 'C:\\Users\\me\\backups\\b1';

  it('accepts a regular asset below the backup root', () => {
    exists(['C:\\Users\\me\\backups\\b1\\assets\\images\\a.png']);
    expect(safeExistingFileUnderRoot(root, 'assets/images/a.png')).toBe('C:\\Users\\me\\backups\\b1\\assets\\images\\a.png');
    expect(safeExistingFileUnderRoot(root, 'assets\\images\\a.png')).toBe('C:\\Users\\me\\backups\\b1\\assets\\images\\a.png');
  });

  it('rejects an asset whose real path leaves the root (junction / symlink)', () => {
    exists(['C:\\Users\\me\\backups\\b1\\assets\\link.png', 'C:\\Users\\me\\secret.png']);
    expect(() => safeExistingFileUnderRoot(root, 'assets/link.png')).toThrow('路径越界: assets/link.png');
  });

  it('rejects a real path in a sibling directory sharing the root name as prefix', () => {
    exists(['C:\\Users\\me\\backups\\b1\\assets\\p.png', 'C:\\Users\\me\\backups\\b10\\p.png']);
    expect(() => safeExistingFileUnderRoot(root, 'assets/p.png')).toThrow('路径越界: assets/p.png');
  });
});

describe('ZIP entry names with a Windows drive prefix', () => {
  // V10 P3-3：修复前这些名字通过校验，解压时 mkdir/open 报 EINVAL；Rust enclosed_name 遇到 Prefix 分量返回 None。
  it.each(['C:/x', 'c:x', 'a:b', 'C:', 'Z:/dir/file.txt'])('%s is an out-of-bounds archive path', name => {
    expect(isUnsafeArchivePath(name)).toBe(true);
  });

  it('a colon after the first component stays a normal component, as in Rust', () => {
    expect(isUnsafeArchivePath('foo:bar')).toBe(false);
    expect(isUnsafeArchivePath('persistent/c:x')).toBe(false);
  });

  it('a drive-prefixed sealed payload entry reports the Rust out-of-bounds error', () => {
    const info = (name: string) => ({ name, isDirectory: false, size: 2, compressedSize: 2, entry: {} as never });
    expect(() => validateSecretsArchive([info('manifest.json'), info('C:/crypto/.master_key')]))
      .toThrow('密封载荷包含越界或空路径: C:/crypto/.master_key');
  });
});
