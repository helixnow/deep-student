/**
 * CSV 四条命令（`commands.rs:1709/1859/1875/1967`）经 `host.invoke` 的生产入口测试。
 *
 * - `csv_import_tests::cancelled_csv_import_does_not_create_questions_or_an_empty_exam`
 *   与 `cancellation_and_completion_have_a_single_terminal_winner` 按 Rust 断言移植；
 * - 其余为 Rust 无测试的命令契约：编码探测、flexible 读取、去重策略、事件序列、
 *   行间取消、导出编码与错误分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { CsvImportCancellation, type CsvImportProgress, type CsvImportResult, type CsvPreviewResult } from '../src/csv-import.ts';
import type { CsvExportResult } from '../src/csv-export.ts';
import { encodeGbk } from '../src/csv-codec.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture(appPlatform?: 'darwin' | 'linux' | 'win32') {
  const { storage, base } = await createMigratedStorage('qbank-csv-');
  const host = await createTestHost({
    ...(appPlatform === undefined ? {} : { app: { platform: appPlatform } }),
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  const events: CsvImportProgress[] = [];
  host.ctx.backendEvents.listen('csv_import_progress', payload => events.push(payload as CsvImportProgress));
  const dir = path.join(base, 'csv-files');
  fs.mkdirSync(dir, { recursive: true });
  return {
    host, db, events, dir,
    write(name: string, content: string | Uint8Array): string {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    },
    count(sql: string, params: (string | number)[] = []): number {
      return Number((db.get<{ n: number }>(sql.replace('COUNT(*)', 'COUNT(*) AS n'), params))!.n);
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedExam(db: DatabaseHandle, id: string): void {
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES (?1, '题目集', 'completed', ?1, '{}', '{}', ?2, ?2)`, [id, NOW]);
}

describe('question_import_service.rs csv_import_tests', () => {
  it('cancelled_csv_import_does_not_create_questions_or_an_empty_exam', async () => {
    const f = await fixture();
    try {
      const csvPath = f.write('cancelled.csv', 'question\nfirst row\nsecond row\n');
      const pending = f.host.invoke<CsvImportResult>('import_questions_csv', { request: {
        file_path: csvPath,
        exam_id: 'exam_cancelled_before_write',
        field_mapping: { question: 'content' },
        duplicate_strategy: 'skip',
        folder_id: null,
        exam_name: 'Cancelled import',
        import_id: 'imp-cancel-first',
      } });
      // Rust 测试在启动前 request_cancel()；命令入口下同一轮事件循环内到达的取消等价。
      expect(await f.host.invoke('cancel_questions_csv_import', { importId: 'imp-cancel-first' })).toBe(true);
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.success_count).toBe(0);
      expect(f.count('SELECT COUNT(*) FROM questions')).toBe(0);
      expect(f.count('SELECT COUNT(*) FROM exam_sheets')).toBe(0);
      // 结束后令牌已注销：迟到的取消返回 false。
      expect(await f.host.invoke('cancel_questions_csv_import', { importId: 'imp-cancel-first' })).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('cancellation_and_completion_have_a_single_terminal_winner', () => {
    const cancelledFirst = new CsvImportCancellation();
    expect(cancelledFirst.requestCancel()).toBe(true);
    expect(cancelledFirst.finishOrCancelled()).toBe(true);

    const completedFirst = new CsvImportCancellation();
    expect(completedFirst.finishOrCancelled()).toBe(false);
    expect(completedFirst.requestCancel()).toBe(false);
  });
});

describe('get_csv_preview (commands.rs:1967)', () => {
  it('detects UTF-8 with BOM, keeps quoted commas/newlines and counts all rows', async () => {
    const f = await fixture();
    try {
      const file = f.write('a.csv', '﻿题干,答案\r\n"含,逗号","多\n行"\r\n\r\n短行\n"a ""q"" b",x,额外\n');
      const preview = await f.host.invoke<CsvPreviewResult>('get_csv_preview', { filePath: file, rows: 2 });
      expect(preview).toEqual({
        headers: ['题干', '答案'],
        rows: [['含,逗号', '多\n行'], ['短行']],
        total_rows: 3,
        encoding: 'UTF-8',
      });
      const all = await f.host.invoke<CsvPreviewResult>('get_csv_preview', { filePath: file });
      expect(all.rows[2]).toEqual(['a "q" b', 'x', '额外']);
    } finally {
      await f.dispose();
    }
  });

  it('falls back to GBK when the bytes are not UTF-8', async () => {
    const f = await fixture();
    try {
      const bytes = encodeGbk('题干,答案\n你好,世界\n')!;
      const file = f.write('gbk.csv', bytes);
      const preview = await f.host.invoke<CsvPreviewResult>('get_csv_preview', { filePath: file, rows: null });
      expect(preview).toEqual({ headers: ['题干', '答案'], rows: [['你好', '世界']], total_rows: 1, encoding: 'GBK' });
    } finally {
      await f.dispose();
    }
  });

  it('rejects .. traversal and reports missing files as internal 打开文件失败', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('get_csv_preview', { filePath: `${f.dir}/../x.csv` }))
        .rejects.toMatchObject({ error_type: 'Validation', message: "路径不允许包含 '..' 目录遍历" });
      // AppError::internal 的 error_type 为 Unknown（platform/errors 与 Rust 同）。
      await expect(f.host.invoke('get_csv_preview', { filePath: path.join(f.dir, 'missing.csv') }))
        .rejects.toMatchObject({ error_type: 'Unknown', message: expect.stringMatching(/^打开文件失败: /) });
    } finally {
      await f.dispose();
    }
  });

  // io::Error Display 取宿主平台 libc 的 strerror（platform/paths/io-error.ts ioMessageFor）；平台来自 ctx.app.platform。
  it.skipIf(process.platform === 'win32')('the io::Error text follows ctx.app.platform', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const f = await fixture(platform);
      try {
        await expect(f.host.invoke('get_csv_preview', { filePath: path.join(f.dir, 'missing.csv') }))
          .rejects.toMatchObject({ error_type: 'Unknown', message: '打开文件失败: No such file or directory (os error 2)' });
      } finally {
        await f.dispose();
      }
    }
    const f = await fixture('win32');
    try {
      const file = path.join(f.dir, 'missing.csv');
      await expect(f.host.invoke('get_csv_preview', { filePath: file }))
        .rejects.toMatchObject({ message: `打开文件失败: ENOENT: no such file or directory, open '${file}'` });
    } finally {
      await f.dispose();
    }
  });
});

describe('import_questions_csv (commands.rs:1709)', () => {
  it('creates a new exam, imports rows, emits Started/Progress/Completed and dedups by content', async () => {
    const f = await fixture();
    try {
      const file = f.write('题库.csv', [
        '题号,题干,选项,答案,类型,难度,标签',
        '1,1+1=?,A. 1;B. 2,B,单选,简单,"数学,基础"',
        '2,  ,,,,,',
        '3,1+1=?,,,,,',
        '4,地球是圆的,,对,判断题,3,[\"地理\"]',
      ].join('\n'));
      const result = await f.host.invoke<CsvImportResult>('import_questions_csv', { request: {
        file_path: file,
        exam_id: 'tmp_new_exam',
        field_mapping: { 题号: 'question_label', 题干: 'content', 选项: 'options', 答案: 'answer',
          类型: 'question_type', 难度: 'difficulty', 标签: 'tags' },
      } });
      expect(result).toMatchObject({ success_count: 2, skipped_count: 1, failed_count: 1, total_rows: 4, cancelled: false });
      expect(result.errors).toEqual([{ row: 3, message: '第 3 行: content 为空', raw_data: '2,  ,,,,,' }]);
      expect(result.exam_id).not.toBe('tmp_new_exam');
      const exam = f.db.get<{ exam_name: string; status: string; temp_id: string }>(
        'SELECT exam_name, status, temp_id FROM exam_sheets WHERE id = ?1', [result.exam_id])!;
      expect(exam).toEqual({ exam_name: 'CSV导入 - 题库', status: 'completed', temp_id: 'tmp_new_exam' });
      const rows = f.db.all<Record<string, unknown>>(`SELECT question_label, content, options_json, answer,
        question_type, difficulty, tags, source_type, source_ref, card_id FROM questions
        WHERE exam_id = ?1 ORDER BY question_label`, [result.exam_id]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        question_label: '1', content: '1+1=?', answer: 'B', question_type: 'single_choice',
        difficulty: 'easy', source_type: 'imported', source_ref: 'csv',
      });
      expect(JSON.parse(rows[0]!.options_json as string)).toEqual([{ key: 'A', content: '1' }, { key: 'B', content: '2' }]);
      expect(JSON.parse(rows[0]!.tags as string)).toEqual(['数学', '基础']);
      expect(rows[0]!.card_id).toMatch(/^csv_[A-Za-z0-9_-]{10}$/);
      expect(rows[1]).toMatchObject({ question_label: '4', question_type: 'true_false', difficulty: 'hard' });
      expect(JSON.parse(rows[1]!.tags as string)).toEqual(['地理']);
      expect(f.events.map(event => event.type)).toEqual(['Started', 'Progress', 'Completed']);
      expect(f.events[0]).toEqual({ type: 'Started', total_rows: 4, file_path: file, exam_id: result.exam_id });
      expect(f.events[1]).toEqual({ type: 'Progress', current: 4, total: 4, success: 2, skipped: 1, failed: 1, exam_id: result.exam_id });
      expect(f.events[2]).toEqual({ type: 'Completed', ...result });
    } finally {
      await f.dispose();
    }
  });

  it('overwrite and merge strategies update the duplicate in place; default label is Q<row-1>', async () => {
    const f = await fixture();
    try {
      seedExam(f.db, 'exam_1');
      const first = f.write('a.csv', 'content,answer,explanation\n题目 一,A,\n');
      await f.host.invoke('import_questions_csv', { request: {
        file_path: first, exam_id: 'exam_1', field_mapping: { content: 'content', answer: 'answer' },
      } });
      const q = f.db.get<{ id: string; question_label: string; answer: string }>(
        'SELECT id, question_label, answer FROM questions WHERE exam_id = ?1', ['exam_1'])!;
      expect(q.question_label).toBe('Q1');

      const second = f.write('b.csv', 'content,answer,explanation\n题目一,B,解析\n');
      const merged = await f.host.invoke<CsvImportResult>('import_questions_csv', { request: {
        file_path: second, exam_id: 'exam_1', duplicate_strategy: 'merge',
        field_mapping: { content: 'content', answer: 'answer', explanation: 'explanation' },
      } });
      expect(merged).toMatchObject({ success_count: 1, skipped_count: 0, exam_id: 'exam_1' });
      expect(f.db.get('SELECT answer, explanation FROM questions WHERE id = ?1', [q.id]))
        .toEqual({ answer: 'A', explanation: '解析' });

      const overwritten = await f.host.invoke<CsvImportResult>('import_questions_csv', { request: {
        file_path: second, exam_id: 'exam_1', duplicate_strategy: 'overwrite',
        field_mapping: { content: 'content', answer: 'answer' },
      } });
      expect(overwritten.success_count).toBe(1);
      expect(f.db.get('SELECT answer, content FROM questions WHERE id = ?1', [q.id]))
        .toEqual({ answer: 'B', content: '题目一' });
      expect(f.count('SELECT COUNT(*) FROM questions WHERE exam_id = ?1', ['exam_1'])).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it('validates the field mapping and emits Failed with the request exam_id', async () => {
    const f = await fixture();
    try {
      const file = f.write('a.csv', 'q,a\nx,y\n');
      await expect(f.host.invoke('import_questions_csv', { request: {
        file_path: file, exam_id: 'e', field_mapping: { a: 'answer' } } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: '字段映射中必须包含 content 字段' });
      await expect(f.host.invoke('import_questions_csv', { request: {
        file_path: file, exam_id: 'e', field_mapping: { nope: 'content' } } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: "CSV 文件中不存在列 'nope'" });
      await expect(f.host.invoke('import_questions_csv', { request: {
        file_path: file, exam_id: 'e', field_mapping: { q: 'content', a: 'status' } } }))
        .rejects.toMatchObject({ error_type: 'Validation', message:
          "不支持的目标字段 'status', 仅支持: question_label, content, options, answer, explanation, question_type, difficulty, tags, images" });
      await expect(f.host.invoke('import_questions_csv', { request: {
        file_path: file, exam_id: 'e', field_mapping: { q: 'content', a: 'content' } } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: "目标字段 'content' 被重复映射，请确保每个目标字段只映射一次" });
      expect(f.events).toContainEqual({ type: 'Failed', error: '字段映射中必须包含 content 字段', exam_id: 'e' });
      expect(f.count('SELECT COUNT(*) FROM exam_sheets')).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('reports invalid images per row without aborting the import', async () => {
    const f = await fixture();
    try {
      seedExam(f.db, 'exam_1');
      const file = f.write('img.csv', 'content,images\n甲,not-json\n乙,"[{""id"":""i1""}]"\n丙,"[{""id"":""i"",""name"":""n"",""mime"":""image/png"",""hash"":""h""}]"\n');
      const result = await f.host.invoke<CsvImportResult>('import_questions_csv', { request: {
        file_path: file, exam_id: 'exam_1', field_mapping: { content: 'content', images: 'images' } } });
      expect(result.success_count).toBe(1);
      expect(result.errors.map(error => [error.row, error.message])).toEqual([
        [2, '第 2 行: images 字段必须是 JSON 数组格式'],
        [3, '第 3 行: images 字段解析失败: missing field `name`'],
      ]);
      const images = f.db.get<{ images_json: string }>('SELECT images_json FROM questions WHERE content = ?1', ['丙'])!;
      expect(JSON.parse(images.images_json)).toEqual([{ id: 'i', name: 'n', mime: 'image/png', hash: 'h' }]);
    } finally {
      await f.dispose();
    }
  });

  it('cancel between rows keeps written rows, refreshes stats and rejects a concurrent duplicate import id', async () => {
    const f = await fixture();
    try {
      seedExam(f.db, 'exam_1');
      const lines = ['content'];
      for (let i = 1; i <= 25; i += 1) lines.push(`第${i}题`);
      const file = f.write('many.csv', `${lines.join('\n')}\n`);
      let cancelReply: Promise<unknown> | null = null;
      f.host.ctx.backendEvents.listen('csv_import_progress', payload => {
        const event = payload as CsvImportProgress;
        if (event.type === 'Progress' && cancelReply === null) {
          cancelReply = f.host.invoke('cancel_questions_csv_import', { importId: 'imp-mid' });
        }
      });
      const request = { file_path: file, exam_id: 'exam_1', field_mapping: { content: 'content' }, import_id: 'imp-mid' };
      const pending = f.host.invoke<CsvImportResult>('import_questions_csv', { request });
      await expect(f.host.invoke('import_questions_csv', { request }))
        .rejects.toMatchObject({ error_type: 'Validation', message: '该 CSV 导入仍在进行中，请稍后再试' });
      const result = await pending;
      expect(await cancelReply).toBe(true);
      expect(result).toMatchObject({ cancelled: true, success_count: 10, total_rows: 25, exam_id: 'exam_1' });
      expect(f.count('SELECT COUNT(*) FROM questions WHERE exam_id = ?1', ['exam_1'])).toBe(10);
      expect(f.db.get('SELECT total_count FROM question_bank_stats WHERE exam_id = ?1', ['exam_1']))
        .toEqual({ total_count: 10 });
      expect(f.events.at(-1)).toEqual({ type: 'Cancelled', ...result });
      expect(f.count('SELECT COUNT(*) FROM exam_sheets WHERE id = ?1', ['exam_1'])).toBe(1);
    } finally {
      await f.dispose();
    }
  });
});

describe('export_questions_csv (commands.rs:1875)', () => {
  async function seeded() {
    const f = await fixture();
    seedExam(f.db, 'exam_1');
    const file = f.write('src.csv', 'content,options,answer,difficulty,tags\n"=1+1","A. 1;B. 2",B,中等,"x,y"\n第二题,,,,\n');
    await f.host.invoke('import_questions_csv', { request: {
      file_path: file, exam_id: 'exam_1',
      field_mapping: { content: 'content', options: 'options', answer: 'answer', difficulty: 'difficulty', tags: 'tags' },
    } });
    return f;
  }

  it('writes UTF-8 BOM, display headers, formula-escaped cells and returns size/count', async () => {
    const f = await seeded();
    try {
      const out = path.join(f.dir, 'out.csv');
      const result = await f.host.invoke<CsvExportResult>('export_questions_csv', { request: {
        exam_id: 'exam_1', file_path: out, fields: ['content', 'options', 'answer', 'difficulty', 'tags'],
        encoding: 'utf8_bom',
      } });
      const bytes = fs.readFileSync(out);
      expect(result).toEqual({ exported_count: 2, file_path: out, file_size: bytes.length });
      expect([...bytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
      const lines = bytes.subarray(3).toString('utf8').split('\n');
      expect(lines[0]).toBe('题干内容,选项,答案,难度,标签');
      expect(lines.slice(1, 3).sort()).toEqual(['"\t=1+1",A. 1; B. 2,B,中等,"x,y"', '第二题,,,,'].sort());
    } finally {
      await f.dispose();
    }
  });

  it('GBK export round-trips through preview and fails cleanly on non-GBK characters', async () => {
    const f = await seeded();
    try {
      const out = path.join(f.dir, 'gbk.csv');
      await f.host.invoke('export_questions_csv', { request: {
        exam_id: 'exam_1', file_path: out, fields: ['content'], encoding: 'gbk' } });
      const preview = await f.host.invoke<CsvPreviewResult>('get_csv_preview', { filePath: out });
      expect(preview.encoding).toBe('GBK');
      expect(preview.headers).toEqual(['题干内容']);

      f.db.run("UPDATE questions SET content = '表情😀' WHERE content = '第二题'");
      const bad = path.join(f.dir, 'bad.csv');
      await expect(f.host.invoke('export_questions_csv', { request: {
        exam_id: 'exam_1', file_path: bad, fields: ['content'], encoding: 'gbk' } }))
        .rejects.toMatchObject({ error_type: 'Validation',
          message: 'GBK 编码失败：内容包含 GBK 不支持的字符，请改用 UTF-8 或 UTF-8 BOM 导出' });
      expect(fs.existsSync(bad)).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('default fields follow include_answers; validation precedes the database', async () => {
    const f = await seeded();
    try {
      const out = path.join(f.dir, 'answers.csv');
      await f.host.invoke('export_questions_csv', { request: { exam_id: 'exam_1', file_path: out, include_answers: true } });
      expect(fs.readFileSync(out, 'utf8').split('\n')[0])
        .toBe('题干内容,题目类型,选项,答案,解析,难度,标签,题号,用户答案,是否正确,答题次数,正确次数,学习状态');
      await expect(f.host.invoke('export_questions_csv', { request: {
        exam_id: 'exam_1', file_path: `${f.dir}/../x.csv` } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: "路径不允许包含 '..' 目录遍历" });
      await expect(f.host.invoke('export_questions_csv', { request: {
        exam_id: 'exam_1', file_path: out, fields: ['bogus'] } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: '不支持的导出字段: bogus' });
      await expect(f.host.invoke('export_questions_csv', { request: {
        exam_id: 'missing', file_path: path.join(f.dir, 'none.csv') } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: '没有可导出的题目' });
      expect(fs.existsSync(path.join(f.dir, 'none.csv'))).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});
