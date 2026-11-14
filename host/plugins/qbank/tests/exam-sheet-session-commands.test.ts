/**
 * `src-tauri/src/commands.rs:945/957/980` 的三条整卷会话命令。
 *
 * 命令由 L14 注册，业务由 L18 的真实 `examSheetSession` 服务执行；这里组合
 * 真实 media 插件与真实 vfs 迁移，验证参数/返回值、Rust 的重命名语义以及
 * `mistake_status_update` 事件发送点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import media from '../../media/index.ts';
import { ExamSheetSessionError } from '../../media/api.ts';
import qbank from '../index.ts';
import type {
  ExamSheetSessionDetailResponse, RenameExamSheetSessionResponse,
  UpdateExamSheetCardsResponse,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

function settingsStore(): { get(key: string): string | null; save(key: string, value: string): void } {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key) ?? null,
    save: (key, value) => { values.set(key, value); },
  };
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-exam-sheet-commands-');
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', '整卷 A', 'empty', 'tmp_1', '{}',
      '{"pages":[]}', ?1, ?1)`, [NOW]);
  const host = await createTestHost({
    plugins: [vfsRepos, media, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      settings: settingsStore(),
      // L18 的 ExamSheetService 通过平台 vfsDatabase 取 conn；这里用真实迁移后的库。
      vfsDatabase: { getConnSafe: () => db },
    },
  });
  const events: unknown[] = [];
  host.ctx.backendEvents.listen('mistake_status_update', payload => events.push(payload));
  return {
    host, db, events,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('src/commands.rs exam sheet session commands', () => {
  it('serves detail, updates cards, and clears a missing name through rename', async () => {
    const f = await fixture();
    try {
      const detail = await f.host.invoke('get_exam_sheet_session_detail', {
        request: { session_id: 'exam_1' },
      }) as ExamSheetSessionDetailResponse;
      expect(detail.detail.summary).toMatchObject({
        id: 'exam_1', exam_name: '整卷 A', status: 'empty',
      });
      expect(detail.detail.preview.session_id).toBe('exam_1');
      expect(detail.detail.preview.pages).toEqual([]);

      const updated = await f.host.invoke('update_exam_sheet_cards', {
        request: { session_id: 'exam_1', exam_name: '改名后' },
      }) as UpdateExamSheetCardsResponse;
      expect(updated.detail.summary.exam_name).toBe('改名后');
      expect(f.events).toEqual([]);

      // Rust commands.rs:991-992：缺失/None 的 exam_name 用空串清空，而不是不改名。
      const renamed = await f.host.invoke('rename_exam_sheet_session', {
        request: { session_id: 'exam_1' },
      }) as RenameExamSheetSessionResponse;
      expect(renamed.summary.exam_name).toBeUndefined();
      expect(f.events).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('maps the L18 not-found error to the command AppError envelope', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('get_exam_sheet_session_detail', {
        request: { session_id: 'missing' },
      })).rejects.toMatchObject({ error_type: 'NotFound' });
    } finally { await f.dispose(); }
  });

  it('only unwraps ExamSheetSessionError, not other errors carrying an appError field', async () => {
    const { storage, base } = await createMigratedStorage('qbank-exam-sheet-instanceof-');
    let failure: unknown = null;
    const host = await createTestHost({
      plugins: [vfsRepos, qbank],
      provide: {
        storage,
        paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
          : process.platform === 'linux' ? 'linux' : 'darwin',
          env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
        settings: settingsStore(),
        examSheetSession: {
          getExamSheetSessionDetail: async () => { throw failure; },
        },
      },
    });
    try {
      failure = new ExamSheetSessionError({ error_type: 'NotFound', message: '整卷不存在', details: null });
      await expect(host.invoke('get_exam_sheet_session_detail', { request: { session_id: 'x' } }))
        .rejects.toMatchObject({ error_type: 'NotFound', message: '整卷不存在' });

      failure = Object.assign(new Error('底层失败'), {
        appError: { error_type: 'Validation', message: '伪造的线缆值', details: null },
      });
      await expect(host.invoke('get_exam_sheet_session_detail', { request: { session_id: 'x' } }))
        .rejects.toMatchObject({ error_type: 'Database', message: '底层失败' });
    } finally {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
