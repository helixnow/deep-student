/**
 * R11-01 调用面：生产 `index.ts` 必须消费 F4 的底层身份入口
 * `paths.dataSpaceDeviceId()`（env → primary → legacy），而不是继续调用
 * commands_sync 的 legacy-root-first `deviceId()` 包装。
 *
 * 本测试只证明 L11 选择正式入口并使用同一身份写同步列；真实 env/文件分支
 * 由 F4 的身份测试覆盖，main 未合入 F4 候选前不能宣称 R11-01 已闭合。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsCreateTranslationParams } from '../api.ts';
import plugin from '../index.ts';

const LEGACY_ROOT_ID = 'legacy-root-device';
const DATA_SPACE_ID = 'authoritative-device';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-device-id-'));
  host = await createTestHost({
    plugins: [plugin],
    provide: {
      storage,
      paths: pathsServiceDouble(LEGACY_ROOT_ID, DATA_SPACE_ID),
      notes: notesServiceDouble(() => storage.database('vfs')),
    },
  });
  db = storage.database('vfs');
}, 120_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('translation device identity call site', { timeout: 120_000 }, () => {
  it('uses dataSpaceDeviceId instead of the legacy-root-first wrapper', () => {
    const params: VfsCreateTranslationParams = {
      title: null,
      source: 'hello',
      translated: '你好',
      srcLang: 'en',
      tgtLang: 'zh',
      engine: null,
      model: null,
    };
    const translation = host.ctx.vfsRepo.translations.createTranslation(db, params);

    expect(db.pluck<string>('SELECT device_id FROM translations WHERE id = ?1', [translation.id]))
      .toBe(DATA_SPACE_ID);
    expect(db.pluck<string>('SELECT device_id FROM translations WHERE id = ?1', [translation.id]))
      .not.toBe(LEGACY_ROOT_ID);
  });
});
