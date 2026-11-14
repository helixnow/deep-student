import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import qbank from '../index.ts';
import { vfsTestServices } from './support/vfs-ports.ts';
import type { CreateQuestionParams, ImportingSession, Question } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-import-sessions-');
  const db = storage.database('vfs');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...vfsTestServices(db),
    },
  });
  cleanups.push(async () => {
    await host.dispose();
    storage.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { host, db };
}

function insertExam(db: DatabaseHandle, id: string, status: string, name: string | null,
  state: string | null): void {
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      import_state_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, '{}', '{}', ?5, ?6, ?6)`,
  [id, name, status, `tmp_${id}`, state, NOW]);
}

function questionParams(examId: string, cardId: string): CreateQuestionParams {
  return {
    exam_id: examId, card_id: cardId, question_label: cardId, content: `content ${cardId}`,
    answer: null, options: null, question_type: 'short_answer', difficulty: null,
    tags: [], source_type: 'imported',
  } as CreateQuestionParams;
}

describe('list_importing_sessions', () => {
  it('returns only importing exam sheets with live question counts', async () => {
    const { host, db } = await fixture();
    insertExam(db, 'exam_importing', 'importing', '中途导入', '{"stage":"ocr"}');
    insertExam(db, 'exam_importing_unnamed', 'importing', null, null);
    insertExam(db, 'exam_completed', 'completed', '已完成', null);
    await host.invoke('qbank_create_question', { params: questionParams('exam_importing', 'c1') });
    await host.invoke('qbank_create_question', { params: questionParams('exam_importing', 'c2') });
    await host.invoke('qbank_create_question', { params: questionParams('exam_completed', 'c3') });

    const sessions = await host.invoke('list_importing_sessions') as ImportingSession[];
    expect(sessions).toEqual([
      {
        session_id: 'exam_importing',
        exam_name: '中途导入',
        import_state_json: '{"stage":"ocr"}',
        existing_question_count: 2,
      },
      {
        session_id: 'exam_importing_unnamed',
        exam_name: null,
        import_state_json: null,
        existing_question_count: 0,
      },
    ]);
  });

  it('excludes soft-deleted questions and exam sheets', async () => {
    const { host, db } = await fixture();
    insertExam(db, 'exam_importing', 'importing', '中途导入', null);
    insertExam(db, 'exam_deleted', 'importing', '已删除', null);
    const created = await host.invoke('qbank_create_question',
      { params: questionParams('exam_importing', 'c1') }) as Question;
    await host.invoke('qbank_create_question', { params: questionParams('exam_deleted', 'c2') });
    await host.invoke('qbank_delete_question', { questionId: created.id });
    db.run('UPDATE exam_sheets SET deleted_at = ?1 WHERE id = ?2', [NOW, 'exam_deleted']);

    const sessions = await host.invoke('list_importing_sessions') as ImportingSession[];
    expect(sessions).toEqual([{
      session_id: 'exam_importing',
      exam_name: '中途导入',
      import_state_json: null,
      existing_question_count: 0,
    }]);
  });
});
