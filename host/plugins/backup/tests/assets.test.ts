import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createBackupHost } from './helpers.ts';
import {
  AssetRestoreError, assetRequiresExplicitTrust, assetTypes, backupAssets, defaultAssetBackupConfig, defaultAssetOptions,
  isSensitiveFile, restoreAssets, restoreAssetsFromDirWithProgress, restoreAssetsWithProgress,
  verifyAssets,
} from '../src/assets.ts';
import type { BackedUpAsset } from '../src/manifest.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function setup() {
  const { host } = await createBackupHost({
    storageFactory: dataDir => ({ locations: { activeDir: join(dataDir, 'slots', 'slotB') } }),
  });
  hosts.push(host);
  return host;
}

it('test_asset_type_properties', async () => {
  const host = await setup();
  const all = await host.invoke('data_governance_get_asset_types') as ReturnType<typeof assetTypes>;
  expect(all.find(t => t.id === 'images')?.relative_path).toBe('images');
  expect(all.find(t => t.id === 'images')?.priority).toBe(0);
  expect(all.find(t => t.id === 'videos')?.priority).toBe(1);
  expect(all.find(t => t.id === 'pdf_ocr_sessions')?.relative_path).toBe('pdf_ocr_sessions');
  expect(all.find(t => t.id === 'pdf_ocr_sessions')?.priority).toBe(0);
  expect(all).toHaveLength(10);
  expect(all.filter(t => t.priority === 0)).toHaveLength(8);
  expect(all.filter(t => t.priority === 1)).toHaveLength(2);
});

it('test_is_sensitive_file', () => {
  for (const name of ['.env', 'credentials.json', 'private.key', 'password.txt']) expect(isSensitiveFile(`/path/to/${name}`)).toBe(true);
  for (const name of ['image.png', 'document.pdf']) expect(isSensitiveFile(`/path/to/${name}`)).toBe(false);
});

it('test_backup_config_defaults', () => {
  const config = defaultAssetBackupConfig();
  expect(config.asset_types).toHaveLength(10);
  expect(config.compute_checksum).toBe(true);
  expect(config.skip_symlinks).toBe(true);
  expect(config.skip_sensitive_files).toBe(true);
});

it('test_scan_assets', async () => {
  const host = await setup();
  const images = join(host.ctx.storage.locations.activeDir, 'images');
  mkdirSync(images, { recursive: true });
  writeFileSync(join(images, 'a.png'), Buffer.alloc(100));
  writeFileSync(join(images, 'b.png'), Buffer.alloc(200));
  expect(await host.invoke('data_governance_scan_assets', { assetTypes: ['images'] })).toEqual({
    by_type: { images: { file_count: 2, total_size: 300 } }, total_files: 2, total_size: 300,
  });
  expect(await host.invoke('data_governance_scan_assets', { assetTypes: ['unknown'] })).toEqual(await host.invoke('data_governance_scan_assets'));
  symlinkSync(join(images, 'a.png'), join(images, 'link.png'));
  await expect(host.invoke('data_governance_scan_assets')).rejects.toBe(`扫描资产失败: IO 错误: 资产扫描不允许符号链接: ${join(images, 'link.png')}`);
});

it('data_governance_restore_with_assets retains the retired Rust entry point error', async () => {
  const host = await setup();
  await expect(host.invoke('data_governance_restore_with_assets', { backupId: 'any' })).rejects.toBe(
    '该旧恢复入口已停用，因为它无法保证完整快照校验和原子槽切换。请调用 data_governance_restore_backup。',
  );
});


it('test_verify_assets_rejects_relative_path_traversal', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dstu-assets-traversal-'));
  const backupDir = join(parent, 'backup');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(parent, 'outside.bin'), 'outside');
  const errors = await verifyAssets(backupDir, [{
    asset_type: 'documents', relative_path: '../outside.bin',
    original_path: 'documents/outside.bin', size: 7, is_directory: false,
  }]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.error_type).toBe('unsafe_path');
});

it('test_verify_assets_rejects_symlinked_source', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'dstu-assets-external-'));
  mkdirSync(join(backupDir, 'assets', 'documents'), { recursive: true });
  writeFileSync(join(external, 'outside.bin'), 'outside');
  symlinkSync(join(external, 'outside.bin'), join(backupDir, 'assets', 'documents', 'link.bin'));
  const errors = await verifyAssets(backupDir, [{
    asset_type: 'documents', relative_path: 'assets/documents/link.bin',
    original_path: 'documents/link.bin', size: 7, is_directory: false,
  }]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.error_type).toBe('unsafe_path');
});

it('test_skip_sensitive_files', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-sensitive-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-sensitive-out-'));
  const docs = join(appDataDir, 'documents');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'normal.txt'), 'normal content');
  writeFileSync(join(docs, '.env'), 'secret content');
  writeFileSync(join(docs, 'credentials.json'), 'secret credentials');

  const config = { ...defaultAssetOptions(['documents']), skip_sensitive_files: true };
  const result = await backupAssets(appDataDir, backupDir, config);
  expect(result.total_files).toBe(1);
  expect(result.skipped_files).toBe(2);
  expect(result.skip_reasons.sensitive_file).toBe(2);
  expect(result.incomplete_asset_types).toEqual(['documents']);
});

it('test_file_size_limit', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-size-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-size-out-'));
  const images = join(appDataDir, 'images');
  mkdirSync(images, { recursive: true });
  writeFileSync(join(images, 'small.png'), new Uint8Array(100));
  writeFileSync(join(images, 'large.png'), new Uint8Array(1000));

  const config = { ...defaultAssetOptions(['images']), max_file_size: 500 };
  const result = await backupAssets(appDataDir, backupDir, config);
  expect(result.total_files).toBe(1);
  expect(result.skipped_files).toBe(1);
  expect(result.skip_reasons.file_too_large).toBe(1);
  expect(result.incomplete_asset_types).toEqual(['images']);
});

it('test_unreadable_asset_metadata_aborts_backup', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-loop-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-loop-out-'));
  const documents = join(appDataDir, 'documents');
  mkdirSync(documents, { recursive: true });
  symlinkSync('loop', join(documents, 'loop'));
  const config = { ...defaultAssetOptions(['documents']), skip_symlinks: false };
  await expect(backupAssets(appDataDir, backupDir, config)).rejects.toThrow();
});


it('test_backup_and_restore_assets', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-roundtrip-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-roundtrip-out-'));
  const images = join(appDataDir, 'images');
  mkdirSync(join(images, 'subdir'), { recursive: true });
  writeFileSync(join(images, 'test.png'), 'fake png data');
  writeFileSync(join(images, 'subdir', 'nested.jpg'), 'fake jpg data');
  const pdfOcr = join(appDataDir, 'pdf_ocr_sessions', 'session-1');
  mkdirSync(pdfOcr, { recursive: true });
  writeFileSync(join(pdfOcr, 'original.pdf'), 'fake pdf data');

  const result = await backupAssets(appDataDir, backupDir, defaultAssetOptions(['images', 'pdf_ocr_sessions']));
  expect(result.total_files).toBe(3);
  expect(result.total_size).toBeGreaterThan(0);
  expect(result.skipped_files).toBe(0);
  expect(await verifyAssets(backupDir, result.files)).toEqual([]);

  rmSync(images, { recursive: true, force: true });
  rmSync(join(appDataDir, 'pdf_ocr_sessions'), { recursive: true, force: true });
  expect(await restoreAssets(backupDir, appDataDir, result.files)).toBe(3);
  expect(existsSync(join(images, 'test.png'))).toBe(true);
  expect(existsSync(join(images, 'subdir', 'nested.jpg'))).toBe(true);
  expect(existsSync(join(pdfOcr, 'original.pdf'))).toBe(true);
});

it('test_restore_assets_rejects_symlinked_destination_parent', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-link-in-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-link-app-'));
  const external = mkdtempSync(join(tmpdir(), 'dstu-assets-link-out-'));
  mkdirSync(join(backupDir, 'assets', 'documents'), { recursive: true });
  writeFileSync(join(backupDir, 'assets', 'documents', 'file.bin'), 'payload');
  symlinkSync(external, join(appDataDir, 'documents'));
  const assets: BackedUpAsset[] = [{
    asset_type: 'documents',
    relative_path: 'assets/documents/file.bin',
    original_path: 'documents/file.bin',
    size: 7,
    checksum: undefined,
    modified_at: undefined,
    is_directory: false,
  }];
  await expect(restoreAssets(backupDir, appDataDir, assets)).rejects.toThrow(AssetRestoreError);
  expect(existsSync(join(external, 'file.bin'))).toBe(false);
});

// Rust assets.rs:1254-1268：恢复任务所用的 with_progress 版本分别报告源/目标路径非法。
it('restore_assets_with_progress distinguishes illegal source and destination paths', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-paths-in-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-paths-app-'));
  const external = mkdtempSync(join(tmpdir(), 'dstu-assets-paths-ext-'));
  mkdirSync(join(backupDir, 'assets', 'documents'), { recursive: true });
  writeFileSync(join(backupDir, 'assets', 'documents', 'file.bin'), 'payload');
  const asset = (relative: string): BackedUpAsset => ({
    asset_type: 'documents', relative_path: relative, original_path: 'documents/file.bin',
    size: 7, checksum: undefined, modified_at: undefined, is_directory: false,
  });
  const messageOf = async (assets: BackedUpAsset[]): Promise<string> => {
    try { await restoreAssetsWithProgress(backupDir, appDataDir, assets, () => true); }
    catch (error) { return (error as Error).message; }
    return '';
  };

  expect(await messageOf([asset('assets/documents/missing.bin')])).toBe('资产源路径非法');
  symlinkSync(external, join(appDataDir, 'documents'));
  expect(await messageOf([asset('assets/documents/file.bin')])).toBe('资产目标路径非法');
  expect(existsSync(join(external, 'file.bin'))).toBe(false);
});

it('test_restore_assets_with_progress_can_cancel', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-cancel-in-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-cancel-app-'));
  mkdirSync(join(backupDir, 'assets', 'images'), { recursive: true });
  writeFileSync(join(backupDir, 'assets', 'images', 'test.png'), 'fake png data');
  const assets: BackedUpAsset[] = [{
    asset_type: 'images',
    relative_path: 'assets/images/test.png',
    original_path: 'images/test.png',
    size: 13,
    checksum: undefined,
    modified_at: undefined,
    is_directory: false,
  }];
  let caught: unknown;
  try { await restoreAssetsWithProgress(backupDir, appDataDir, assets, () => false); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AssetRestoreError);
  expect((caught as AssetRestoreError).cancelled).toBe(true);
});

it('test_restore_assets_with_progress_skips_untrusted_executable_assets', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-trust-in-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-trust-app-'));
  mkdirSync(join(backupDir, 'assets', 'workspaces', 'agents'), { recursive: true });
  mkdirSync(join(backupDir, 'assets', 'workspaces', 'notes'), { recursive: true });
  writeFileSync(join(backupDir, 'assets', 'workspaces', 'agents', 'hook.sh'), '#!/bin/sh\nrm -rf /');
  writeFileSync(join(backupDir, 'assets', 'workspaces', 'notes', 'readme.md'), 'plain notes');
  const agent: BackedUpAsset = {
    asset_type: 'workspaces',
    relative_path: 'assets/workspaces/agents/hook.sh',
    original_path: 'workspaces/agents/hook.sh',
    size: 18, checksum: undefined, modified_at: undefined, is_directory: false,
  };
  const ordinary: BackedUpAsset = {
    ...agent,
    relative_path: 'assets/workspaces/notes/readme.md',
    original_path: 'workspaces/notes/readme.md',
    size: 11,
  };
  // Rust assets.rs:1962-1963。
  expect(assetRequiresExplicitTrust(agent)).toBe(true);
  expect(assetRequiresExplicitTrust(ordinary)).toBe(false);
  const progress: Array<[number, number]> = [];
  const restored = await restoreAssetsWithProgress(backupDir, appDataDir, [agent, ordinary], (done, total) => {
    progress.push([done, total]);
    return true;
  });
  expect(restored).toBe(1);
  expect(existsSync(join(appDataDir, 'workspaces', 'agents', 'hook.sh'))).toBe(false);
  expect(readFileSync(join(appDataDir, 'workspaces', 'notes', 'readme.md'), 'utf8')).toBe('plain notes');
  expect(progress).toEqual([[1, 1]]);
});

it('test_restore_assets_from_dir_with_progress_can_cancel', async () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'dstu-assets-dir-cancel-in-'));
  const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-assets-dir-cancel-app-'));
  mkdirSync(join(backupDir, 'assets', 'images'), { recursive: true });
  writeFileSync(join(backupDir, 'assets', 'images', 'test.png'), 'fake png data');
  let caught: unknown;
  try { await restoreAssetsFromDirWithProgress(join(backupDir, 'assets'), appDataDir, () => false); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AssetRestoreError);
  expect((caught as AssetRestoreError).cancelled).toBe(true);
});
