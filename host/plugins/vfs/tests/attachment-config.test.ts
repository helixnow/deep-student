import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install real owner plugin for folder creation
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install real owner plugin for folder creation
import reposPlugin from '../../vfs-repos/index.ts';
let root: string, host: TestHost, storage: ReturnType<typeof createStorageService>;
const config = new Map<string, string>();
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-config-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const result = await storage.migrations.runAll(); expect(result.success, result.error ?? '').toBe(true);
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: {
    storage, memoryConfig: { get: (key: string) => config.get(key) ?? null,
      set: (key: string, value: string) => { config.set(key, value); } },
  } });
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
it('test_config_key_constants', () => {
  const service = host.ctx.vfs.attachmentConfig;
  const id = service.getOrCreateRootFolder();
  expect(config.get('attachment_root_folder_id')).toBe(id);
  expect(service.getRootFolderTitle()).toBe('附件');
  expect(service.getOrCreateRootFolder()).toBe(id);
});
it('recreates a missing configured folder and keeps caller-specified titles', () => {
  const service = host.ctx.vfs.attachmentConfig;
  service.setRootFolderId('fld_missing');
  expect(service.getOrCreateRootFolder()).not.toBe('fld_missing');
  const id = service.createRootFolder('上传文件');
  expect(service.getRootFolderId()).toBe(id);
  expect(service.getRootFolderTitle()).toBe('上传文件');
});
