/**
 * `src/commands.rs:932 list_exam_sheet_sessions` 与
 * `dstu-vision/src/exam_sheet_service.rs:252 list_exam_sheet_sessions`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { decodeExamSheetSessionMetadata, listExamSheetSessions } from '../src/exam-sheet-sessions.ts';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-exam-sessions-');
  const host = await createTestHost({
    plugins: [vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  const exams = (host.ctx.vfsRepo as VfsReposService).exams;
  return {
    db, exams,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('src/commands.rs list_exam_sheet_sessions', () => {
  it('lists_vfs_sessions_with_serde_metadata_and_utc_timestamps', async () => {
    const f = await fixture();
    try {
      const valid = f.exams.createExamSheet(f.db, {
        examName: '整卷 A', tempId: 'tmp-a',
        metadataJson: {
          source_type: 'imported', tags: ['数学'], page_count: 2, card_count: 3,
          import_source: { file_name: 'paper.pdf', file_type: 'pdf' },
        },
        previewJson: { pages: [] }, status: 'completed', folderId: null,
      });
      const invalid = f.exams.createExamSheet(f.db, {
        examName: null, tempId: 'tmp-b',
        metadataJson: { instructions: 5, source_type: 'ocr_image' },
        previewJson: { pages: [] }, status: 'pending', folderId: null,
      });
      f.db.run(`UPDATE exam_sheets SET created_at = '2020-01-01T08:00:00+08:00',
        updated_at = '2021-02-03T04:05:06Z' WHERE id = ?1`, [valid.id]);
      f.db.run(`UPDATE exam_sheets SET created_at = 'not-a-timestamp',
        updated_at = '2022-01-01T00:00:00Z' WHERE id = ?1`, [invalid.id]);

      const response = listExamSheetSessions({ db: f.db, exams: f.exams }, {});
      expect(response.sessions).toHaveLength(2);
      const first = response.sessions.find(session => session.id === valid.id)!;
      expect(first).toMatchObject({
        exam_name: '整卷 A', temp_id: 'tmp-a', status: 'completed',
        created_at: '2020-01-01T00:00:00Z', updated_at: '2021-02-03T04:05:06Z',
        metadata: {
          source_type: 'import_file', tags: ['数学'], page_count: 2, card_count: 3,
          import_source: { file_name: 'paper.pdf', file_type: 'pdf' },
        },
      });
      const second = response.sessions.find(session => session.id === invalid.id)!;
      expect(second.exam_name).toBeUndefined();
      expect(second.metadata).toBeUndefined();
      expect(second.created_at).toBe('1970-01-01T00:00:00Z');
    } finally {
      await f.dispose();
    }
  });

  it('decodes_rust_written_metadata_stats_as_dstu_core_question_bank_stats_with_lossless_numbers', async () => {
    const f = await fixture();
    try {
      const rows: [string, string][] = [
        // exam_sheet_service.rs:1481 import_from_json：stats 只有五个计数，correct_rate 为 None 被跳过。
        ['json', '{"page_count":1,"card_count":3,"source_type":"import_file","import_source":{"file_type":"json",'
          + '"import_time":"2026-01-01T00:00:00+00:00"},"stats":{"total_count":3,"mastered_count":0,"review_count":0,'
          + '"in_progress_count":0,"new_count":3}}'],
        ['rate', '{"page_count":9007199254740993,"raw_model_response":{"score":2.50,"big":12345678901234567890},'
          + '"stats":{"total_count":4,"mastered_count":1,"review_count":0,"in_progress_count":1,"new_count":2,'
          + '"correct_rate":0.5,"last_updated":"2026-01-02T00:00:00+00:00"}}'],
        ['one', '{"stats":{"total_count":1,"mastered_count":1,"review_count":0,"in_progress_count":0,"new_count":0,'
          + '"correct_rate":1.0}}'],
        ['int_rate', '{"stats":{"total_count":1,"mastered_count":0,"review_count":0,"in_progress_count":0,"new_count":1,'
          + '"correct_rate":0}}'],
        ['float_count', '{"source_type":"manual","stats":{"total_count":3.0,"mastered_count":0,"review_count":0,'
          + '"in_progress_count":0,"new_count":3}}'],
        ['i32_overflow', '{"source_type":"manual","stats":{"total_count":2147483648,"mastered_count":0,'
          + '"review_count":0,"in_progress_count":0,"new_count":0}}'],
        ['float_page', '{"source_type":"manual","page_count":2.0}'],
      ];
      for (const [tempId, metadata] of rows) {
        const sheet = f.exams.createExamSheet(f.db, {
          examName: tempId, tempId, metadataJson: {}, previewJson: { pages: [] }, status: 'completed', folderId: null,
        });
        f.db.run('UPDATE exam_sheets SET metadata_json = ?1 WHERE id = ?2', [metadata, sheet.id]);
      }
      const sessions = listExamSheetSessions({ db: f.db, exams: f.exams }, {}).sessions;
      const wire = (tempId: string) => {
        const metadata = sessions.find(session => session.temp_id === tempId)!.metadata;
        return metadata === undefined ? undefined : JSON.stringify(metadata);
      };
      expect(wire('json')).toBe('{"page_count":1,"card_count":3,"source_type":"import_file",'
        + '"import_source":{"file_type":"json","import_time":"2026-01-01T00:00:00+00:00"},'
        + '"stats":{"total_count":3,"mastered_count":0,"review_count":0,"in_progress_count":0,"new_count":3}}');
      expect(wire('rate')).toBe('{"page_count":9007199254740993,'
        + '"raw_model_response":{"score":2.50,"big":12345678901234567890},"source_type":"ocr_image",'
        + '"stats":{"total_count":4,"mastered_count":1,"review_count":0,"in_progress_count":1,"new_count":2,'
        + '"correct_rate":0.5,"last_updated":"2026-01-02T00:00:00+00:00"}}');
      expect(wire('one')).toBe('{"source_type":"ocr_image","stats":{"total_count":1,"mastered_count":1,'
        + '"review_count":0,"in_progress_count":0,"new_count":0,"correct_rate":1.0}}');
      expect(wire('int_rate')).toBe('{"source_type":"ocr_image","stats":{"total_count":1,"mastered_count":0,'
        + '"review_count":0,"in_progress_count":0,"new_count":1,"correct_rate":0.0}}');
      // serde：i32 不接受浮点 `3.0` 与超出 i32 的整数，usize 不接受 `2.0`；整个 metadata 为 None。
      expect(wire('float_count')).toBeUndefined();
      expect(wire('i32_overflow')).toBeUndefined();
      expect(wire('float_page')).toBeUndefined();
    } finally {
      await f.dispose();
    }
  });

  it('metadata_decoder_matches_serde_defaults_and_type_failures', () => {
    expect(decodeExamSheetSessionMetadata({})).toEqual({ source_type: 'ocr_image' });
    expect(decodeExamSheetSessionMetadata({ source_type: 'manual' })).toEqual({
      source_type: 'manual_create',
    });
    expect(decodeExamSheetSessionMetadata({ source_type: 'ocr' })).toEqual({
      source_type: 'ocr_image',
    });
    expect(decodeExamSheetSessionMetadata({ source_type: 'unknown' })).toBeNull();
    expect(decodeExamSheetSessionMetadata({ page_count: -1 })).toBeNull();
    expect(decodeExamSheetSessionMetadata({ tags: ['ok', 2] })).toBeNull();
    expect(decodeExamSheetSessionMetadata({ stats: { exam_id: 'e' } })).toBeNull();
    expect(decodeExamSheetSessionMetadata('not-an-object')).toBeNull();
  });
});
