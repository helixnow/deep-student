import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: 直接构造 L23 传输类的用例不经过插件入口，需自行装上桌面本地文件端口
import '../../sync-providers/tests/local-fs-fixture.ts';
import type { FileInfo } from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L23 生产 CloudStorageBase 的默认 getFile 字节数防线
import { CloudStorageBase } from '../../sync-providers/src/traits.ts';

/**
 * `sync_r10_download.rs` 中 trait 默认 `get_file` 的三条行为。
 *
 * `CloudStorageBase` 是 S3/FTP/WebDAV 传输的共享生产基类；测试子类只提供
 * `put/get/stat` 等存储原语，被测的 `getFile` 直接继承基类默认实现。
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class TruncatingStorage extends CloudStorageBase {
  private readonly objects = new Map<string, Uint8Array>();
  truncateZipTo: number | null = null;
  growZipBy = 0;

  override providerName(): string { return 'memory-truncating-r10'; }
  override async checkConnection(): Promise<void> {}

  override async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
  }

  override async get(key: string): Promise<Uint8Array | null> {
    const data = this.objects.get(key);
    if (data === undefined) return null;
    if (!key.endsWith('.zip')) return new Uint8Array(data);
    if (this.truncateZipTo !== null) {
      return new Uint8Array(data.subarray(0, Math.min(this.truncateZipTo, data.byteLength)));
    }
    if (this.growZipBy > 0) {
      const inflated = new Uint8Array(data.byteLength + this.growZipBy);
      inflated.set(data);
      return inflated;
    }
    return new Uint8Array(data);
  }

  override async list(prefix: string): Promise<FileInfo[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, data]) => this.info(key, data));
  }

  override async delete(key: string): Promise<void> { this.objects.delete(key); }

  override async stat(key: string): Promise<FileInfo | null> {
    const data = this.objects.get(key);
    return data === undefined ? null : this.info(key, data);
  }

  private info(key: string, data: Uint8Array): FileInfo {
    return { key, size: data.byteLength, lastModified: new Date().toISOString(), etag: null };
  }
}

function fakeBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

function destPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `l22-${prefix}-`));
  dirs.push(dir);
  return join(dir, 'download.zip');
}

it('get_file_without_checksum_rejects_half_package', async () => {
  const storage = new TruncatingStorage();
  const payload = fakeBytes(32 * 1024);
  await storage.put('backups/half.zip', payload);
  storage.truncateZipTo = 10_000;

  const dest = destPath('half');
  const error = await storage.getFile('backups/half.zip', dest, null, null)
    .then(() => null, (cause: unknown) => cause as Error);
  expect(error).not.toBeNull();
  expect(error!.message).toContain('下载不完整');
  expect(() => readFileSync(dest)).toThrow();
});

it('get_file_with_consistent_size_succeeds', async () => {
  const storage = new TruncatingStorage();
  const payload = fakeBytes(16 * 1024);
  await storage.put('backups/full.zip', payload);

  const dest = destPath('full');
  const checksum = await storage.getFile('backups/full.zip', dest, null, null);
  expect(checksum).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(new Uint8Array(readFileSync(dest))).toEqual(payload);
});

it('get_file_rejects_object_replaced_with_larger_version', async () => {
  const storage = new TruncatingStorage();
  const payload = fakeBytes(8 * 1024);
  await storage.put('backups/swap.zip', payload);
  storage.growZipBy = 4 * 1024;

  const dest = destPath('swap');
  const error = await storage.getFile('backups/swap.zip', dest, null, null)
    .then(() => null, (cause: unknown) => cause as Error);
  expect(error).not.toBeNull();
  expect(error!.message).toMatch(/已变更|下载不完整/);
  expect(() => readFileSync(dest)).toThrow();
});
