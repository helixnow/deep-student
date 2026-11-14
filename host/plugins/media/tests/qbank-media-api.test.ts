/**
 * The L18 capabilities the qbank tools (`qbank_executor.rs`) consume through
 * `media/api.ts` services: `docs.generateDocxFromSpec` (qbank_export docx),
 * `docs.sanitizeDocumentId` (qbank_import_document), and the exam-sheet preview
 * codec (qbank_export / qbank_generate_variant read `preview_json`).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { office } from '../../../platform/native/office/extract.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import { createOfficeWriter } from '../../../platform/native/office/writer.ts';
import {
  ExamSheetSessionError, type DocsService, type ExamSheetPreviewResult, type ExamSheetSessionService,
} from '../api.ts';
import media from '../index.ts';
import { ExamSheetSessionError as InternalExamSheetSessionError } from '../src/exam-sheet-service.ts';
import { unusedStorage } from './helpers/storage-double.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let docs: DocsService;
let examSheets: ExamSheetSessionService;

beforeAll(async () => {
  host = await createTestHost({
    plugins: [media],
    provide: {
      storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: process.cwd() },
      nativeOfficeWriter: createOfficeWriter(() => undefined),
      nativeOfficeText: officeText,
      nativeOffice: office,
    },
  });
  docs = host.ctx.get('docs') as DocsService;
  examSheets = host.ctx.get('examSheetSession') as ExamSheetSessionService;
});
afterAll(async () => { await host.dispose(); });

it('generateDocxFromSpec renders the qbank_export block spec into a readable .docx', async () => {
  const bytes = await docs.generateDocxFromSpec({
    title: '期中复习',
    blocks: [
      { type: 'heading', level: 2, text: '题目 1' },
      { type: 'paragraph', text: '1 + 1 = ?' },
      { type: 'paragraph', text: 'A. 2' },
      { type: 'paragraph', text: '答案：A', bold: true },
      { type: 'paragraph', text: '解析：基本加法', italic: true },
    ],
  });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(bytes.subarray(0, 2)).toString('latin1')).toBe('PK');
  const text = await docs.extractTextFromBytes('export.docx', bytes);
  for (const expected of ['期中复习', '题目 1', '1 + 1 = ?', 'A. 2', '答案：A', '解析：基本加法']) {
    expect(text).toContain(expected);
  }
});

it('generateDocxFromSpec treats missing blocks as empty, like `unwrap_or_default()` in Rust', async () => {
  const bytes = await docs.generateDocxFromSpec({ title: '空题目集' });
  expect(await docs.extractTextFromBytes('empty.docx', bytes)).toContain('空题目集');
});

it('sanitizeDocumentId follows DocumentProcessingExecutor::sanitize_id', () => {
  expect(docs.sanitizeDocumentId('  "res_abc-1"  ')).toBe('res_abc-1');
  expect(docs.sanitizeDocumentId('`file_x`')).toBe('file_x');
  expect(() => docs.sanitizeDocumentId('res abc')).toThrow('资源 ID 格式无效: res abc');
  expect(() => docs.sanitizeDocumentId('   ')).toThrow('资源 ID 格式无效:    ');
});

it('decodePreview / encodePreview round-trip ExamSheetPreviewResult with serde defaults', () => {
  const stored = {
    temp_id: 'tmp_1',
    exam_name: '单元测验',
    pages: [{
      page_index: 0,
      cards: [{
        card_id: 'card_1', page_index: 0, question_label: '1',
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        ocr_text: '题干', tags: ['代数'],
      }],
    }],
  };
  const decoded: ExamSheetPreviewResult = examSheets.decodePreview(stored);
  expect(decoded.temp_id).toBe('tmp_1');
  expect(decoded.pages[0]!.cards[0]!.card_id).toBe('card_1');
  const encoded = examSheets.encodePreview(decoded);
  expect(encoded).toMatchObject({ temp_id: 'tmp_1', exam_name: '单元测验' });
  expect(examSheets.encodePreview(examSheets.decodePreview(encoded))).toEqual(encoded);

  expect(examSheets.decodePreview({}).pages).toEqual([]);
  expect(() => examSheets.decodePreview({ pages: 3 })).toThrow('invalid type at preview.pages: expected array');
  expect(() => examSheets.decodePreview('not json object')).toThrow();
});

it('exports the ExamSheetSessionError class the service rejects with', () => {
  expect(ExamSheetSessionError).toBe(InternalExamSheetSessionError);
  const error = new ExamSheetSessionError(AppError.not_found('未找到指定的整卷会话'));
  expect(error).toBeInstanceOf(Error);
  expect(error.appError.message).toBe('未找到指定的整卷会话');
});
