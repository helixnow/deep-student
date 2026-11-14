/**
 * `cancel_question_bank_import`（commands.rs:1265-1275）与
 * `QuestionImportCancellation`（question_import_service.rs:141-190）契约测试。
 * Rust 对这两处没有单元测试；以下经生产入口（host.invoke + ctx.qbank 上的登记表）覆盖每个分支。
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank, { type QbankPluginService } from '../index.ts';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-import-cancel-');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const service = host.ctx.qbank as QbankPluginService;
  return {
    host,
    imports: service.questionImports,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('cancel_question_bank_import', () => {
  it('returns false when no import is registered under the id (let-else → Ok(false))', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'missing' })).resolves.toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('accepts the first cancel of a running import and aborts its token', async () => {
    const f = await fixture();
    try {
      const cancellation = f.imports.register('imp_1');
      expect(cancellation).not.toBeNull();
      expect(cancellation!.signal.aborted).toBe(false);
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp_1' })).resolves.toBe(true);
      expect(cancellation!.signal.aborted).toBe(true);
      // 取消先胜出：之后的正常返回必须改报取消
      expect(cancellation!.finishOrCancelled()).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('a prior cancellation wins over later cancel requests', async () => {
    const f = await fixture();
    try {
      f.imports.register('imp_2');
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp_2' })).resolves.toBe(true);
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp_2' })).resolves.toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('completion wins over a late cancel; the token is not aborted', async () => {
    const f = await fixture();
    try {
      const cancellation = f.imports.register('imp_3')!;
      expect(cancellation.finishOrCancelled()).toBe(true);
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp_3' })).resolves.toBe(false);
      expect(cancellation.signal.aborted).toBe(false);
      expect(cancellation.finishOrCancelled()).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('an occupied import id is not re-registered (DashMap Entry::Occupied)', async () => {
    const f = await fixture();
    try {
      const first = f.imports.register('imp_4');
      expect(first).not.toBeNull();
      expect(f.imports.register('imp_4')).toBeNull();
      // 取消仍作用于原登记项
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp_4' })).resolves.toBe(true);
      expect(first!.signal.aborted).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('each plugin instance owns its own registry (one table per AppState)', async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      a.imports.register('shared');
      await expect(b.host.invoke('cancel_question_bank_import', { importId: 'shared' })).resolves.toBe(false);
      await expect(a.host.invoke('cancel_question_bank_import', { importId: 'shared' })).resolves.toBe(true);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
