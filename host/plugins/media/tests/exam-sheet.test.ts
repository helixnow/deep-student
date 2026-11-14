import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-impl: 用 L11 真实仓储验证整卷会话的 VFS 读写
import { ExamRepo } from '../../vfs-repos/repository/exams.ts';
// boundary-allow cross-plugin-impl: 同上；正式题目投影走真实 questions 仓储
import { QuestionRepo } from '../../vfs-repos/repository/questions.ts';
import { ExamSheetSessionCore, ExamSheetSessionError } from '../src/exam-sheet-service.ts';
import { encodePngRgba } from './helpers/png.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { ExamSheetSessionService } from '../api.ts';
import { applyExamNameUpdate, type ExamNameState } from '../src/exam-sheet.ts';

it('card_only_updates_keep_the_existing_name', () => {
  const state: ExamNameState = { summary: '高数期中', preview: '高数期中' };
  expect(applyExamNameUpdate(state, null)).toBe(false);
  expect(state.summary).toBe('高数期中');
  expect(state.preview).toBe('高数期中');
});

it('explicit_names_rename_and_blank_names_clear', () => {
  const state: ExamNameState = { summary: '旧名', preview: '旧名' };
  expect(applyExamNameUpdate(state, ' 新名 ')).toBe(true);
  expect(state.summary).toBe('新名');
  expect(state.preview).toBe('新名');
  expect(applyExamNameUpdate(state, '新名')).toBe(false);
  expect(applyExamNameUpdate(state, '  ')).toBe(true);
  expect(state.summary).toBeNull();
  expect(state.preview).toBeNull();
});

it('rename uses Rust trim semantics for NEL and BOM', () => {
  const state: ExamNameState = { summary: '旧名', preview: '旧名' };
  expect(applyExamNameUpdate(state, '\u0085新名\u0085')).toBe(true);
  expect(state.summary).toBe('新名');
  expect(applyExamNameUpdate(state, '\uFEFF新名\uFEFF')).toBe(true);
  expect(state.summary).toBe('\uFEFF新名\uFEFF');
});

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let exams: ExamRepo;
let questions: QuestionRepo;
let service: ExamSheetSessionCore;
let imagesDir: string;
let examCounter = 0;

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-exam-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);

afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-exam-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  exams = new ExamRepo();
  questions = new QuestionRepo();
  imagesDir = path.join(root, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  service = new ExamSheetSessionCore({
    db: () => conn,
    exams: () => exams,
    questions: () => questions,
    nativeImage: () => nativeImage,
    encodePng: async input => encodePngRgba(input.width, input.height, input.rgba),
    imagesDir: () => imagesDir,
    log: { warn: () => {}, info: () => {} },
  });
});

afterEach(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 20x20 page where R=x*10 and G=y*10, so crop coordinates are observable. */
function pageImage(width = 20, height = 20): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = x * 10;
      rgba[offset + 1] = y * 10;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 255;
    }
  }
  return encodePngRgba(width, height, rgba);
}

function writePage(name = 'page.png'): string {
  fs.writeFileSync(path.join(imagesDir, name), pageImage());
  return `images/${name}`;
}

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    card_id: 'card_1',
    page_index: 0,
    question_label: 'Q1',
    bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    ocr_text: '原题干',
    tags: ['base'],
    status: 'new',
    attempt_count: 0,
    correct_count: 0,
    source_type: 'ocr_image',
    ...overrides,
  };
}

function previewOf(
  tempId: string,
  cards: Record<string, unknown>[],
  imagePath = 'images/page.png',
): Record<string, unknown> {
  return {
    temp_id: tempId,
    exam_name: '高数期中',
    pages: [{
      page_index: 0,
      original_image_path: imagePath,
      cards,
      ocr_completed: true,
      parse_completed: true,
    }],
    session_id: null,
  };
}

function createExam(
  preview: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  examName: string | null = '高数期中',
): string {
  examCounter += 1;
  const tempId = `tmp_exam_${examCounter}`;
  return exams.createExamSheet(conn, {
    examName,
    tempId,
    metadataJson: metadata as never,
    previewJson: preview as never,
    status: 'completed',
    folderId: null,
  }).id;
}

it('get_exam_sheet_session_detail_archives_assets_enriches_bbox_and_clears_mistake_links', async () => {
  writePage();
  const cropDir = path.join(imagesDir, 'crops');
  fs.mkdirSync(cropDir, { recursive: true });
  fs.writeFileSync(path.join(cropDir, 'old.png'), pageImage(4, 4));
  const examId = createExam(previewOf('tmp_exam_0', [card({
    cropped_image_path: 'images/crops/old.png',
    linked_mistake_ids: ['mistake_1'],
  })]), { source_type: 'ocr_image' });
  exams.updateLinkedMistakes(conn, examId, ['mistake_2']);

  const detail = await service.getExamSheetSessionDetail(examId);

  expect(detail.preview.session_id).toBe(examId);
  expect(detail.summary.linked_mistake_ids).toBeUndefined();
  const first = detail.preview.pages[0]!.cards[0]!;
  expect(first.linked_mistake_ids).toBeUndefined();
  expect(first.resolved_bbox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  expect(first.cropped_image_path).toBe(`images/exam_sheet_archive/${examId}/old.png`);
  expect(detail.preview.pages[0]!.original_image_path)
    .toBe(`images/exam_sheet_archive/${examId}/page.png`);
  expect(fs.existsSync(path.join(imagesDir, 'exam_sheet_archive', examId, 'page.png'))).toBe(true);

  const stored = exams.getExamSheet(conn, examId)!;
  expect((stored.previewJson as Record<string, unknown>).session_id).toBe(examId);
  expect((stored.previewJson as Record<string, unknown>).pages).toMatchObject([
    { original_image_path: `images/exam_sheet_archive/${examId}/page.png` },
  ]);

  await expect(service.getExamSheetSessionDetail('exam_missing'))
    .rejects.toMatchObject({ appError: { error_type: 'NotFound', message: '未找到指定的整卷会话' } });
});

it('save_to_vfs_writes_preview_and_metadata_json_as_rust_serde_text', async () => {
  writePage();
  const examId = createExam(previewOf('tmp_exam_0', [card()]), {
    source_type: 'ocr_image', page_count: 1,
    stats: { total_count: 1, mastered_count: 0, review_count: 0, in_progress_count: 0, new_count: 1, correct_rate: 0 },
  });

  await service.getExamSheetSessionDetail(examId);

  const row = conn.get<{ preview_json: string; metadata_json: string }>(
    'SELECT preview_json, metadata_json FROM exam_sheets WHERE id = ?1', [examId],
  )!;
  expect(row.preview_json).toBe(
    '{"temp_id":"tmp_exam_0","exam_name":"高数期中","pages":[{"page_index":0,'
    + `"original_image_path":"images/exam_sheet_archive/${examId}/page.png","cards":[{"card_id":"card_1",`
    + '"page_index":0,"question_label":"Q1","bbox":{"x":0.0,"y":0.0,"width":0.5,"height":0.5},'
    + '"ocr_text":"原题干","tags":["base"],'
    + '"status":"new","attempt_count":0,"correct_count":0,"source_type":"ocr_image"}],'
    + `"ocr_completed":true,"parse_completed":true}],"session_id":"${examId}"}`,
  );
  expect(row.metadata_json).toBe(
    '{"page_count":1,"source_type":"ocr_image","stats":{"total_count":1,"mastered_count":0,'
    + '"review_count":0,"in_progress_count":0,"new_count":1,"correct_rate":0.0}}',
  );
});

it('formal_question_projection_reuses_legacy_geometry_and_rejects_card_edits', async () => {
  writePage();
  const examId = createExam(previewOf('tmp_exam_0', [card({
    cropped_image_path: 'images/crops/old.png',
  })]), { question_document_version: 2, source_type: 'ocr_image' });
  questions.createQuestion(conn, {
    exam_id: examId,
    card_id: 'card_1',
    content: '正式题干',
    tags: ['formal'],
    source_type: 'ocr',
    question_type: 'single_choice',
    answer: 'A',
  });

  const detail = await service.getExamSheetSessionDetail(examId);
  const projected = detail.preview.pages[0]!.cards[0]!;
  expect(projected.ocr_text).toBe('正式题干');
  expect(projected.question_label).toBe('1');
  expect(projected.tags).toEqual(['formal']);
  expect(projected.question_type).toBe('single_choice');
  expect(projected.answer).toBe('A');
  expect(projected.bbox).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });

  await expect(service.updateExamSheetCards({
    session_id: examId,
    cards: [{ card_id: 'card_1', question_label: '改名' }],
  })).rejects.toMatchObject({
    appError: {
      error_type: 'Validation',
      message: '该题目集使用正式题目实体，请通过题目编辑/删除接口操作，不能单独修改兼容预览',
    },
  });

  const renamed = await service.renameExamSheetSession({ session_id: examId, exam_name: ' 新名称 ' });
  expect(renamed.exam_name).toBe('新名称');
});

it('update_exam_sheet_cards_crops_bbox_updates_fields_and_aggregates_metadata', async () => {
  writePage();
  const initialCrop = path.join(imagesDir, 'crops', 'card_1.png');
  fs.mkdirSync(path.dirname(initialCrop), { recursive: true });
  fs.writeFileSync(initialCrop, pageImage(4, 4));
  const examId = createExam(previewOf('tmp_exam_0', [card({
    cropped_image_path: 'images/crops/card_1.png',
  })]));

  const outcome = await service.updateExamSheetCards({
    session_id: examId,
    cards: [{
      card_id: 'card_1',
      question_label: ' 第二题 ',
      ocr_text: ' 新题干 ',
      tags: [' b ', 'a', 'a', '  '],
      resolved_bbox: { x: 0, y: 0, width: 10, height: 5 },
    }],
  });

  const detail = outcome.detail;
  expect(outcome.updated_mistake_ids).toEqual([]);
  const updated = detail.preview.pages[0]!.cards[0]!;
  expect(updated.question_label).toBe('第二题');
  expect(updated.ocr_text).toBe('新题干');
  expect(updated.tags).toEqual(['b', 'a', 'a']);
  expect(updated.bbox).toEqual({ x: 0, y: 0, width: 0.5, height: 0.25 });
  expect(updated.resolved_bbox).toEqual({ x: 0, y: 0, width: 10, height: 5 });
  expect(detail.summary.exam_name).toBe('高数期中');
  expect(detail.summary.metadata).toMatchObject({
    source_type: 'ocr_image',
    page_count: 1,
    card_count: 1,
    tags: ['a', 'b'],
  });

  const cropPath = path.join(root, updated.cropped_image_path!);
  expect(fs.existsSync(cropPath)).toBe(true);
  const decoded = await nativeImage.decodeRgba(fs.readFileSync(cropPath));
  expect(decoded.width).toBe(10);
  expect(decoded.height).toBe(5);
  expect(Array.from(decoded.rgba.slice(0, 4))).toEqual([0, 0, 0, 255]);
  expect(Array.from(decoded.rgba.slice((4 * 10 + 9) * 4, (4 * 10 + 10) * 4)))
    .toEqual([90, 40, 0, 255]);

  await expect(service.updateExamSheetCards({ session_id: examId }))
    .rejects.toMatchObject({ appError: { error_type: 'Validation', message: '没有需要更新的内容' } });
});

it('crop_encode_failure_keeps_save_error_context', async () => {
  writePage();
  const examId = createExam(previewOf('tmp_exam_0', [card({
    cropped_image_path: 'images/crops/card_1.png',
  })]));
  const failing = new ExamSheetSessionCore({
    db: () => conn,
    exams: () => exams,
    questions: () => questions,
    nativeImage: () => nativeImage,
    encodePng: async () => { throw new Error('encoder exploded'); },
    imagesDir: () => imagesDir,
    log: { warn: () => {}, info: () => {} },
  });

  await expect(failing.updateExamSheetCards({
    session_id: examId,
    cards: [{
      card_id: 'card_1',
      resolved_bbox: { x: 0, y: 0, width: 10, height: 5 },
    }],
  })).rejects.toMatchObject({
    appError: {
      error_type: 'FileSystem',
      message: '保存裁剪题目失败: encoder exploded',
    },
  });
});

it('create_and_delete_cards_crop_archive_files_and_recompute_metadata', async () => {
  writePage();
  const freeCrop = path.join(imagesDir, 'crops', 'free.png');
  fs.mkdirSync(path.dirname(freeCrop), { recursive: true });
  fs.writeFileSync(freeCrop, pageImage(4, 4));
  const examId = createExam(previewOf('tmp_exam_0', [
    card({ card_id: 'card_1', resolved_bbox: { x: 0, y: 0, width: 4, height: 4 } }),
    card({ card_id: 'card_2', bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      cropped_image_path: 'images/crops/free.png' }),
  ]));

  await expect(service.updateExamSheetCards({
    session_id: examId,
    delete_card_ids: ['card_1'],
  })).resolves.toMatchObject({ updated_mistake_ids: [] });

  const afterDelete = await service.getExamSheetSessionDetail(examId);
  expect(afterDelete.preview.pages[0]!.cards.map(item => item.card_id)).toEqual(['card_2']);

  const outcome = await service.updateExamSheetCards({
    session_id: examId,
    create_cards: [{
      page_index: 0,
      bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      question_label: ' 新题 ',
      ocr_text: '新题题干',
      tags: ['z', 'a', 'a'],
    }],
    delete_card_ids: ['card_2'],
  });

  const cards = outcome.detail.preview.pages[0]!.cards;
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    question_label: '新题',
    ocr_text: '新题题干',
    tags: ['a', 'z'],
    page_index: 0,
    status: 'new',
    source_type: 'ocr_image',
  });
  expect(cards[0]!.card_id.startsWith('tmp_exam_')).toBe(true);
  expect(cards[0]!.resolved_bbox).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  expect(fs.existsSync(path.join(root, cards[0]!.cropped_image_path!))).toBe(true);
  expect(fs.existsSync(path.join(imagesDir, 'exam_sheet_archive', examId, 'free.png'))).toBe(false);
  expect(fs.existsSync(freeCrop)).toBe(true);
  expect(outcome.detail.summary.metadata).toMatchObject({
    page_count: 1,
    card_count: 1,
    tags: ['a', 'z'],
  });

  await expect(service.updateExamSheetCards({
    session_id: examId,
    create_cards: [{ page_index: 3, bbox: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
  })).rejects.toMatchObject({
    appError: { error_type: 'Validation', message: '新增题目失败：未找到第 4 页' },
  });
});

it('rename_exam_sheet_session_clears_name_when_exam_name_is_missing_or_blank', async () => {
  writePage();
  const examId = createExam(previewOf('tmp_exam_0', [card()]));

  const cleared = await service.renameExamSheetSession({ session_id: examId });
  expect(cleared.exam_name).toBeUndefined();
  const stored = exams.getExamSheet(conn, examId)!;
  expect(stored.examName).toBeUndefined();
  expect((stored.previewJson as Record<string, unknown>).exam_name).toBeNull();

  const named = await service.renameExamSheetSession({ session_id: examId, exam_name: ' 线性代数 ' });
  expect(named.exam_name).toBe('线性代数');
  const blank = await service.renameExamSheetSession({ session_id: examId, exam_name: '   ' });
  expect(blank.exam_name).toBeUndefined();
});

it('plugin_crops_through_the_native_image_encode_capability', async () => {
  writePage();
  fs.mkdirSync(path.join(imagesDir, 'crops'), { recursive: true });
  const examId = createExam(previewOf('tmp_exam_0', [card({
    cropped_image_path: 'images/crops/card_1.png',
  })]));
  const calls: Array<{ width: number; height: number; format: string }> = [];
  const imageService = {
    dimensions: (bytes: Uint8Array) => nativeImage.dimensions(bytes),
    decodeRgba: (bytes: Uint8Array) => nativeImage.decodeRgba(bytes),
    cropRgba: nativeImage.cropRgba,
    encode: async (
      input: { width: number; height: number; rgba: Uint8Array },
      options: { format: 'png' },
    ): Promise<Uint8Array> => {
      calls.push({ width: input.width, height: input.height, format: options.format });
      return encodePngRgba(input.width, input.height, input.rgba);
    },
  };
  const repos = { exams, questions } as unknown as VfsReposService;
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => {} },
      vfsDatabase: { getConnSafe: () => conn },
      vfsRepo: repos,
      nativeImage: imageService,
      paths: { appDataDir: root },
    },
  });
  try {
    const provided = host.ctx.examSheetSession as ExamSheetSessionService;
    const outcome = await provided.updateExamSheetCards({
      session_id: examId,
      cards: [{
        card_id: 'card_1',
        resolved_bbox: { x: 0, y: 0, width: 10, height: 5 },
      }],
    });
    expect(calls).toEqual([{ width: 10, height: 5, format: 'png' }]);
    const cropPath = outcome.detail.preview.pages[0]!.cards[0]!.cropped_image_path;
    expect(cropPath).toBeTruthy();
    expect(fs.existsSync(path.join(root, cropPath!))).toBe(true);
  } finally { await host.dispose(); }
});

it('plugin_provides_exam_sheet_session_service_from_native_image_and_vfs_repos', async () => {
  writePage();
  const examId = createExam(previewOf('tmp_exam_0', [card()]));
  const repos = { exams, questions } as unknown as VfsReposService;
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => {} },
      vfsDatabase: { getConnSafe: () => conn },
      vfsRepo: repos,
      nativeImage,
      paths: { appDataDir: root },
    },
  });
  try {
    const provided = host.ctx.examSheetSession as ExamSheetSessionService;
    const detail = await provided.getExamSheetSessionDetail(examId);
    expect(detail.summary.id).toBe(examId);
    expect(detail.preview.pages[0]!.cards[0]!.resolved_bbox)
      .toEqual({ x: 0, y: 0, width: 10, height: 10 });
  } finally {
    await host.dispose();
  }
});

it('service_errors_carry_app_error_values', async () => {
  await expect(service.updateExamSheetCards({
    session_id: 'exam_missing',
    cards: [{ card_id: 'card_1', question_label: 'x' }],
  })).rejects.toBeInstanceOf(ExamSheetSessionError);
});
