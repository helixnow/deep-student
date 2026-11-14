import os from 'node:os';
/**
 * `src/commands.rs:2109 get_enhanced_statistics`（`FileManager::get_image_statistics`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import files, { createNodeFiles } from '../../../platform/files/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import { getEnhancedStatistics, getImageStatistics } from '../src/enhanced-statistics.ts';

const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-enhanced-stats-'));
  roots.push(dir);
  return dir;
}

function desktopFiles(root: string) {
  return createNodeFiles({ roots: [{ name: 'appData', path: root }] });
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('src/commands.rs get_enhanced_statistics', () => {
  it('missing_images_dir_reports_empty_statistics', async () => {
    const root = tempDir();
    expect(await getImageStatistics(desktopFiles(root), path.join(root, 'images'))).toEqual({
      total_files: 0,
      total_size_bytes: 0,
      file_types: {},
      oldest_file: null,
      newest_file: null,
    });
  });

  it('counts_regular_files_and_lowercases_extensions_without_recursing', async () => {
    const root = tempDir();
    const dir = path.join(root, 'images');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'first.PNG'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'second.jpg'), Buffer.alloc(20));
    fs.writeFileSync(path.join(dir, 'no-extension'), Buffer.alloc(3));
    fs.writeFileSync(path.join(dir, 'nested', 'ignored.png'), Buffer.alloc(100));
    fs.utimesSync(path.join(dir, 'first.PNG'), new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'));
    fs.utimesSync(path.join(dir, 'second.jpg'), new Date('2021-01-01T00:00:00Z'),
      new Date('2021-01-01T00:00:00Z'));
    fs.utimesSync(path.join(dir, 'no-extension'), new Date('2019-01-01T00:00:00Z'),
      new Date('2019-01-01T00:00:00Z'));

    const stats = await getImageStatistics(desktopFiles(root), dir);
    expect(stats.total_files).toBe(3);
    expect(stats.total_size_bytes).toBe(33);
    expect(stats.file_types).toEqual({ png: 1, jpg: 1 });
    expect(stats.oldest_file).toBe(1546300800);
    expect(stats.newest_file).toBe(1609459200);
  });

  // Rust `Path::extension`：`a.` 的扩展名是 `Some("")`，计入空键；`.hidden` 是 None。
  it('counts_extensions_like_rust_path_extension', async () => {
    const root = tempDir();
    const dir = path.join(root, 'images');
    fs.mkdirSync(dir);
    for (const name of ['trailing.', '.hidden', 'archive.tar.GZ']) fs.writeFileSync(path.join(dir, name), Buffer.alloc(1));

    const stats = await getImageStatistics(desktopFiles(root), dir);
    expect(stats.total_files).toBe(3);
    expect(stats.file_types).toEqual({ '': 1, gz: 1 });
  });

  it('mobile_profile_counts_images_through_opfs_files', async () => {
    const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') });
    await files.writeBytes('/deep-student/images/a.PNG', new Uint8Array(4), { createParents: true });
    await files.writeBytes('/deep-student/images/b.webp', new Uint8Array(6));
    await files.writeBytes('/deep-student/images/nested/c.png', new Uint8Array(100), { createParents: true });

    const stats = await getImageStatistics(files, '/deep-student/images');
    expect(stats).toMatchObject({ total_files: 2, total_size_bytes: 10, file_types: { png: 1, webp: 1 } });
    expect(stats.oldest_file).not.toBeNull();
    expect(await getImageStatistics(files, '/deep-student/missing')).toMatchObject({ total_files: 0, oldest_file: null });
  });

  it('get_enhanced_statistics_command_reads_base_images_through_ctx_files', async () => {
    const { storage, base } = await createMigratedStorage('qbank-enhanced-cmd-');
    roots.push(base);
    const paths = createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
      : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } });
    const host = await createTestHost({ plugins: [files, qbank], provide: { storage, paths } });
    try {
      fs.mkdirSync(paths.baseJoin('images'), { recursive: true });
      fs.writeFileSync(paths.baseJoin('images', 'page.png'), Buffer.alloc(7));
      const result = await host.invoke<{ image_stats: { total_files: number; total_size_bytes: number;
        file_types: Record<string, number> } }>('get_enhanced_statistics');
      expect(result.image_stats).toMatchObject({ total_files: 1, total_size_bytes: 7, file_types: { png: 1 } });

      fs.rmSync(paths.baseJoin('images'), { recursive: true });
      fs.writeFileSync(paths.baseJoin('images'), 'not a directory');
      // commands.rs:2115 `AppError::database(format!("获取图片统计失败: {}", e))`，e 的 Display 只有 message。
      await expect(host.invoke('get_enhanced_statistics')).rejects.toMatchObject({
        error_type: 'Database', message: process.platform === 'win32'
          ? expect.stringMatching(/^获取图片统计失败: 读取图片目录失败: /)
          : '获取图片统计失败: 读取图片目录失败: Not a directory (os error 20)' });
    } finally {
      await host.dispose();
      storage.dispose();
    }
  });

  it('enhanced_statistics_uses_chrono_compatible_utc_timestamp', async () => {
    const root = tempDir();
    const result = await getEnhancedStatistics(desktopFiles(root), path.join(root, 'images'));
    expect(result.image_stats.total_files).toBe(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00$/);
  });
});
