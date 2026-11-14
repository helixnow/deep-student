import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { DstuListOptions, previewTypeFromExtension, previewTypeFromFilename, dstuNodeTypePreviewType } from '../api.ts';
import { notesRepository, vfsRepositories } from '../repository/services.ts';
import plugin from '../index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import { normalizePropFilters } from '../src/dstu-search.ts';
import { isOperatorSearchableKey, malformedPropsTotal, parsePropsCell, snippet } from '../../notes/api.ts';
import indexPlugin from '../../vfs-index/index.ts';
// boundary-allow cross-plugin-impl: serialize actual persisted owner-repository results, not test literals
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: serialize actual persisted owner-repository results, not test literals
import reposPlugin from '../../vfs-repos/index.ts';

let root: string, storage: ReturnType<typeof createStorageService>, host: TestHost, db: DatabaseHandle;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-wire-types-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const result = await storage.migrations.runAll();
  expect(result.success, result.error ?? '').toBe(true);
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
  db = storage.database('vfs');
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
function assertKeys(value: unknown, keys: string[]) {
  const json = JSON.stringify(value);
  for (const key of keys) expect(json).toContain(`"${key}"`);
}
it('test_vfs_resource_type_serialization', () => {
  for (const type of ['note', 'textbook', 'translation'] as const) {
    const result = vfsRepositories().resources.createOrReuse(db, type, `type-${type}`, null, null, null);
    expect(JSON.stringify(vfsRepositories().resources.getResource(db, result.resourceId)!.type)).toBe(`"${type}"`);
  }
});
it('test_storage_mode_serialization', () => {
  const repo = vfsRepositories().resources;
  const inline = repo.createOrReuse(db, 'note', 'inline-wire', null, null, null);
  const external = repo.createOrReuseExternal(db, 'file', 'external-wire', 'blob-wire', null, null, null);
  expect(JSON.stringify(repo.getResource(db, inline.resourceId)!.storageMode)).toBe('"inline"');
  expect(JSON.stringify(repo.getResource(db, external.resourceId)!.storageMode)).toBe('"external"');
});
it('test_vfs_resource_camel_case', () => {
  const repo = vfsRepositories().resources;
  const result = repo.createOrReuse(db, 'note', 'wire-content', 'note_123', 'notes', null);
  const resource = repo.getResource(db, result.resourceId)!;
  assertKeys(resource, ['type', 'sourceId', 'sourceTable', 'storageMode', 'refCount', 'createdAt', 'updatedAt']);
});
it('test_vfs_create_resource_result_camel_case', () => {
  assertKeys(vfsRepositories().resources.createOrReuse(db, 'note', 'wire-result', null, null, null), ['resourceId', 'isNew']);
});
it('test_vfs_note_camel_case', () => {
  const note = notesRepository().createNote({ title: 'Test Note', content: 'wire-note', tags: ['tag1'] }, db);
  notesRepository().setFavorite(note.id, true, db);
  assertKeys(notesRepository().getNote(note.id, db), ['resourceId', 'isFavorite', 'createdAt', 'updatedAt']);
});
it('test_option_skip_serializing', () => {
  const repo = vfsRepositories().resources;
  const result = repo.createOrReuse(db, 'note', 'wire-option', null, null, null);
  const json = JSON.stringify(repo.getResource(db, result.resourceId));
  for (const field of ['sourceId', 'sourceTable', 'externalHash', 'metadata']) expect(json).not.toContain(`"${field}"`);
});
it('test_preview_type_serialization', () => {
  expect(JSON.stringify(dstuNodeTypePreviewType('note'))).toBe('"markdown"');
  expect(JSON.stringify(dstuNodeTypePreviewType('textbook'))).toBe('"pdf"');
  expect(JSON.stringify(dstuNodeTypePreviewType('folder'))).toBe('"none"');
  for (const [extension, expected] of [['docx', 'docx'], ['xlsx', 'xlsx'], ['pptx', 'pptx'], ['epub', 'epub'],
    ['txt', 'text'], ['mp3', 'audio'], ['mp4', 'video']]) {
    expect(JSON.stringify(previewTypeFromExtension(extension!))).toBe(`"${expected}"`);
  }
});
it('test_preview_type_from_extension', () => {
  const expected: Record<string, string[]> = { pdf: ['pdf', 'PDF'], docx: ['docx'], xlsx: ['xlsx'],
    text: ['xls', 'ods', 'xlsb', 'txt', 'md', 'json'], pptx: ['pptx'], epub: ['epub'], image: ['png', 'jpg'],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'], video: ['mp4', 'webm', 'mov', 'avi', 'mkv'], none: ['unknown'] };
  for (const [type, extensions] of Object.entries(expected)) for (const extension of extensions) {
    expect(previewTypeFromExtension(extension)).toBe(type);
  }
});
it('test_preview_type_from_filename', () => {
  for (const [file, type] of Object.entries({ 'document.pdf': 'pdf', 'report.docx': 'docx', 'data.xlsx': 'xlsx',
    'slides.pptx': 'pptx', 'book.epub': 'epub', 'image.png': 'image', 'readme.txt': 'text', 'config.json': 'text', no_extension: 'none' })) {
    expect(previewTypeFromFilename(file)).toBe(type);
  }
});
it('test_vfs_translation_serialization', () => {
  const repo = vfsRepositories().translations;
  const translation = repo.createTranslation(db, { source: 'Hello', translated: '你好', srcLang: 'en', tgtLang: 'zh', engine: 'deepl' });
  repo.setQualityRating(db, translation.id, 5);
  assertKeys(repo.getTranslation(db, translation.id), ['srcLang', 'tgtLang', 'qualityRating']);
});
it('test_vfs_essay_serialization', () => {
  const essay = vfsRepositories().essays.createEssay(db, { title: 'My Essay', content: 'wire-essay', essayType: 'argumentative', score: 85 });
  assertKeys(essay, ['resourceId', 'essayType']);
});
it('test_vfs_textbook_serialization', () => {
  const repo = vfsRepositories().textbooks;
  const blob = vfsRepositories().blobs.storeBlob(db, host.ctx.vfsDatabase.blobsDir(), Buffer.from('wire textbook'));
  const book = repo.createTextbookWithPreview(db, 'wire-textbook', 'textbook.pdf', 1024000, blob.hash, '/path/to/file', null, null, 100);
  repo.updateReadingProgress(db, book.id, 50);
  assertKeys(repo.getTextbook(db, book.id), ['blobHash', 'fileName', 'pageCount', 'lastPage']);
});

it('test_content_hash_consistency', async () => {
  const exam = await host.invoke('dstu_create', { path: '/', options: {
    type: 'exam', name: 'Hash consistency',
  } }) as { id: string };
  const repo = host.ctx.vfsRepo.questions;
  const question = repo.createQuestion(db, {
    exam_id: exam.id, question_label: 'Q1', content: 'What is 2+2?',
    options: [{ key: 'A', content: '3' }, { key: 'B', content: '4' }],
    answer: 'B', explanation: 'Basic arithmetic', question_type: 'single_choice',
    difficulty: 'easy', tags: ['math'], source_type: 'ocr',
  });
  const hash = () => db.pluck<string>('SELECT content_hash FROM questions WHERE id = ?1', [question.id]);
  repo.updateQuestion(db, question.id, {});
  const hash1 = hash();
  expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  repo.updateQuestion(db, question.id, {});
  expect(hash()).toBe(hash1);

  // Exercise the real owner operation that changes user_answer and attempt_count.
  const answered = repo.submitAnswer(db, question.id, 'A', false, false);
  expect(answered.user_answer).toBe('A');
  expect(answered.attempt_count).toBe(1);
  expect(hash()).toBe(hash1);

  repo.updateQuestion(db, question.id, { content: 'What is 3+3?' });
  expect(hash()).not.toBe(hash1);
});

it('invalid_keys_are_rejected_with_expected_category', async () => {
  const note = notesRepository().createNote({ title: 'Property categories', content: '', tags: [] }, db);
  const set = (key: string) => host.invoke('dstu_set_metadata', { path: note.id, metadata: { props: { [key]: 'value' } } });
  for (const key of ['', '   ']) await expect(set(key)).rejects.toBe("Invalid argument 'props': 属性名不能为空");
  for (const key of ['tags', 'TAGS', 'Tag', 'path', 'title', 'isFavorite', 'snippet', 'props']) {
    await expect(set(key)).rejects.toBe(`Invalid argument 'props': 属性名 "${key}" 为保留字`);
  }
  for (const key of ['bad\u0007key', 'tab\tkey']) {
    await expect(set(key)).rejects.toBe("Invalid argument 'props': 属性名不能包含控制字符");
  }
  await expect(set('k'.repeat(65))).rejects.toBe("Invalid argument 'props': 属性名过长（最多 64 个字符）");
  await expect(set('k'.repeat(64))).resolves.toBeNull();
});

it('normalize_drops_only_empty_keys', () => {
  // Exercise the actual normalization used before DSTU property-filtered search.
  const normalize = (key: string) => normalizePropFilters(DstuListOptions.from({ propFilters: [{ key, value: 'value' }] }));
  expect(normalize('  Status ')).toEqual([['status', 'value']]);
  expect(normalize('   ')).toEqual([]);
  expect(normalize('')).toEqual([]);
  expect(normalize('tags')).toEqual([['tags', 'value']]);
});

it('parse_props_cell_accepts_nonempty_object_and_preserves_json_types', () => {
  const repo = notesRepository();
  const note = repo.createNote({ title: 'Typed props', content: '', tags: [] }, db);
  db.run('UPDATE notes SET props = ?1 WHERE id = ?2', ['{"status":"done","priority":2,"pinned":true}', note.id]);
  const parsed = repo.getNote(note.id, db)!.props as Record<string, unknown>;
  expect(parsed.status).toBe('done');
  expect(parsed.priority).toBe(2);
  expect(parsed.pinned).toBe(true);
});
it('valid_operator_keys_pass_all_three_syntaxes', async () => {
  const note = notesRepository().createNote({ title: 'Operator keys', content: '', tags: [] }, db);
  for (const key of ['status', 'Status', '优先级', 'due_date', 'sprint-42', 'p0', '_internal', 'k']) {
    await expect(host.invoke('dstu_set_metadata', { path: note.id, metadata: { props: { [key]: 'value' } } })).resolves.toBeNull();
    expect(normalizePropFilters(DstuListOptions.from({ propFilters: [{ key, value: 'value' }] }))).toHaveLength(1);
    expect(isOperatorSearchableKey(key)).toBe(true);
  }
});
it('storable_keys_outside_operator_syntax_are_pinned', async () => {
  const note = notesRepository().createNote({ title: 'Nonoperator keys', content: '', tags: [] }, db);
  for (const key of ['my key', 'a:b', 'emoji🙂', '-lead', '得 分']) {
    await expect(host.invoke('dstu_set_metadata', { path: note.id, metadata: { props: { [key]: 'value' } } })).resolves.toBeNull();
    expect(isOperatorSearchableKey(key)).toBe(false);
  }
});
it('parse_props_cell_null_is_silent_and_uncounted', () => {
  const before = malformedPropsTotal(); expect(parsePropsCell('note_null', null)).toBeNull(); expect(malformedPropsTotal()).toBe(before);
});
it('parse_props_cell_counts_invalid_json', () => {
  const before = malformedPropsTotal(); expect(parsePropsCell('note_bad_json', 'not-json{')).toBeNull(); expect(malformedPropsTotal()).toBeGreaterThan(before);
});
it('parse_props_cell_counts_non_object', () => {
  const before = malformedPropsTotal(); expect(parsePropsCell('note_array', '[1,2]')).toBeNull(); expect(parsePropsCell('note_scalar', '"str"')).toBeNull();
  expect(malformedPropsTotal()).toBeGreaterThanOrEqual(before + 2);
});
it('parse_props_cell_counts_empty_object', () => {
  const before = malformedPropsTotal(); expect(parsePropsCell('note_empty_obj', '{}')).toBeNull(); expect(malformedPropsTotal()).toBeGreaterThan(before);
});
it('snippet_truncates_long_raw_on_char_boundary', () => {
  const cut = snippet('属'.repeat(130)); expect(cut.endsWith('…')).toBe(true); expect([...cut]).toHaveLength(121); expect(snippet('short')).toBe('short');
});
