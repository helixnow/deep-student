import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {} from '../../plugins/chat/api.ts';
import type {} from '../../plugins/notes/api.ts';
import type { AnkiCard } from '../../plugins/anki/api.ts';
import type {} from '../../plugins/browser/api.ts';
import type {} from '../../plugins/vfs-repos/api.ts';
import { openHost } from './__tests__/host.ts';
import { DATABASES, I64, ISO, JSON_TEXT, LARGE, MS, SQL_TIME, TAGS, UTC, buildSlot, cleanup, rawSnapshot, snapshot, tempDir } from './__fixtures__/fixtures.ts';

describe('public plugin services read independently seeded Rust SQL data', () => {
  let base: string;
  let real: Awaited<ReturnType<typeof openHost>>;
  let before: ReturnType<typeof rawSnapshot>[];
  // Five independently seeded databases and real plugin startup need a bounded CI setup budget, not a skipped assertion.
  beforeAll(async () => {
    base = tempDir();
    const active = buildSlot(base);
    writeFileSync(join(base, 'slots/state.json'), '{"active":"slotA","pending":null}');
    before = DATABASES.map(db => rawSnapshot(active, db));
    real = await openHost(base);
    const report = await real.storage.migrations.runAll();
    expect(report.success, JSON.stringify(report)).toBe(true);
  }, 60_000);
  afterAll(async () => { try { await real?.dispose(); } finally { if (base) cleanup(base); } });

  it('L04 sessions: UTC nanoseconds, metadata, NULL→absent, integer→boolean', () => {
    expect(real.host.ctx.chatSession.getSession('sess_old')).toEqual({
      id: 'sess_old', mode: 'general_chat', title: '旧会话📚', titleLocked: true, persistStatus: 'active',
      createdAt: UTC, updatedAt: UTC, metadata: JSON.parse(JSON_TEXT),
    });
  });
  it('L04 messages: timestamp precision, block order and SQL NULL→absent optional fields', () => {
    const message = real.host.ctx.chatSession.getMessage('msg_old');
    expect(message).toEqual({ id: 'msg_old', sessionId: 'sess_old', role: 'assistant', blockIds: ['blk_old'], timestamp: MS });
    expect(real.host.ctx.chatSession.getSessionMessages('sess_old')).toEqual([message]);
  });
  it('L04 blocks: Chinese/emoji, JSON null distinct from SQL NULL, millisecond integer', () => {
    expect(real.host.ctx.chatSession.getBlock('blk_old')).toEqual({
      id: 'blk_old', messageId: 'msg_old', type: 'content', status: 'success',
      content: '中文📚\n原文', toolInput: JSON.parse(JSON_TEXT), toolOutput: null, startedAt: MS,
    });
  });
  it('L10 notes: exact stored text timestamps, parsed tags, favorite and NULL', () => {
    expect(real.host.ctx.notes.repository.getNote('note_old')).toEqual({
      id: 'note_old', resourceId: 'res_old', title: '中文笔记📚', tags: ['中文', '📚'], isFavorite: true,
      createdAt: ISO, updatedAt: ISO, deletedAt: null, props: null,
    });
    expect(real.host.ctx.notes.repository.getNoteContent('note_old')).toBe('# 中文📚\n旧用户内容');
  });
  it('L11 resources: typed metadata and integer timestamps', () => {
    expect(real.host.ctx.vfsRepo.resources.getResource(real.storage.database('vfs'), 'res_old')).toEqual({
      id: 'res_old', hash: 'old-note-hash', type: 'note', sourceId: 'note_old', sourceTable: 'notes', storageMode: 'inline',
      data: '# 中文📚\n旧用户内容', metadata: JSON.parse(JSON_TEXT), refCount: 1, createdAt: MS, updatedAt: MS,
    });
  });
  it('L11 files/blobs: MAX_SAFE_INTEGER, original JSON string and NULL→absent', () => {
    const db = real.storage.database('vfs');
    expect(real.host.ctx.vfsRepo.files.getFile(db, 'file_old')).toEqual({
      id: 'file_old', sha256: 'old-file-hash', fileName: '旧文件📚.bin', blobHash: 'old-blob', size: LARGE, fileType: 'document',
      tags: ['中文', '📚'], isFavorite: true, bookmarks: [{ page: 1 }], status: 'active', createdAt: ISO, updatedAt: ISO, previewJson: JSON_TEXT,
      processingStatus: 'pending',
    });
    expect(real.host.ctx.vfsRepo.blobs.getBlob(db, 'old-blob')).toEqual({
      hash: 'old-blob', relativePath: 'aa/旧文件.bin', size: LARGE, refCount: 1, createdAt: MS,
    });
  });
  it('L11 folders: timestamps and bools', () => {
    expect(real.host.ctx.vfsRepo.folders.getFolder(real.storage.database('vfs'), 'fld_old')).toEqual({
      id: 'fld_old', title: '旧目录📚', isExpanded: true, isFavorite: false, sortOrder: 7, createdAt: MS, updatedAt: MS,
    });
  });
  it('L11 todos: preserve JSON whitespace and mixed TEXT time formats', () => {
    const db = real.storage.database('vfs');
    expect(real.host.ctx.vfsRepo.todos.getTodoList(db, 'tdl_old')).toEqual({
      id: 'tdl_old', title: '旧待办📚', sortOrder: 0, isDefault: false, isFavorite: true, createdAt: ISO, updatedAt: SQL_TIME,
    });
    expect(real.host.ctx.vfsRepo.todos.getTodoItem(db, 'ti_old')).toEqual({
      id: 'ti_old', todoListId: 'tdl_old', title: '复习📚', status: 'pending', priority: 'high', dueDate: '2026-10-02', dueTime: '09:30',
      tagsJson: TAGS, attachmentsJson: '[ "res_old" ]', repeatJson: JSON_TEXT, sortOrder: 0, createdAt: SQL_TIME, updatedAt: ISO,
      estimatedPomodoros: 0, completedPomodoros: 0,
    });
  });
  it('L11 translations: metadata survives typed public read', () => {
    expect(real.host.ctx.vfsRepo.translations.getTranslation(real.storage.database('vfs'), 'tr_old')).toEqual({
      id: 'tr_old', resourceId: 'res_tr_old', title: '翻译📚', srcLang: 'en', tgtLang: 'zh', isFavorite: true,
      createdAt: ISO, updatedAt: ISO, metadata: JSON.parse(JSON_TEXT), sourceText: 'old text', translatedText: '译文📚',
    });
  });
  it('L11 question bank: typed JSON, nullable correctness, options, and linked history', () => {
    const db = real.storage.database('vfs');
    expect(real.host.ctx.vfsRepo.questions.getQuestion(db, 'q_old')).toEqual({
      id: 'q_old', exam_id: 'exam_old', card_id: null, question_label: null, content: '中文题干📚',
      options: [{ key: 'A', content: '选项📚' }], answer: 'A', explanation: null, structured_data: JSON.parse(JSON_TEXT),
      question_type: 'single_choice', difficulty: 'medium', tags: ['中文', '📚'], status: 'new', user_answer: null, is_correct: null,
      attempt_count: 0, correct_count: 0, last_attempt_at: null, user_note: null, is_favorite: true, is_bookmarked: false,
      source_type: 'ocr', source_ref: null, images: [], parent_id: null, created_at: ISO, updated_at: SQL_TIME,
      ai_feedback: null, ai_score: null, ai_graded_at: null, group_id: null, group_position: null, group_label: null,
      materials: [], answer_origin: null, source_refs: [], answer_source_refs: [], source_key: null,
    });
    expect(real.host.ctx.vfsRepo.questions.getHistory(db, 'q_old')).toEqual([{
      id: 'qh_old', question_id: 'q_old', field_name: 'answer', old_value: null, new_value: 'A', operator: 'user', reason: '校对📚', created_at: ISO,
    }]);
  });
  it('L11 review plans: non-integer REAL, dates, nullable values and bool mapping', () => {
    expect(real.host.ctx.vfsRepo.reviewPlans.getPlan(real.storage.database('vfs'), 'rp_old')).toEqual({
      id: 'rp_old', question_id: 'q_old', exam_id: 'exam_old', ease_factor: 2.625, interval_days: 7, repetitions: 2,
      next_review_date: '2026-11-05', last_review_date: null, status: 'new', total_reviews: 0, total_correct: 0,
      consecutive_failures: 0, is_difficult: true, created_at: SQL_TIME, updated_at: ISO,
    });
  });
  it('L16 templates: exact JSON text, parsed fields and nanosecond UTC dates', () => {
    expect(real.host.ctx.anki.getCustomTemplateById('tpl_old')).toEqual({
      id: 'tpl_old', name: '旧模板📚', description: '', author: null, version: '1.0.0', preview_front: '正面', preview_back: '背面', note_type: 'Basic',
      fields: ['Front', 'Back'], generation_prompt: '生成中文📚', front_template: '{{Front}}', back_template: '{{Back}}', css_style: '.card { color: red; }',
      field_extraction_rules: {}, created_at: UTC, updated_at: UTC, is_active: true, is_built_in: false, preview_data_json: JSON_TEXT,
    });
  });
  it('L16 public card command reads the old task/card relation', async () => {
    const cards = await real.host.invoke<AnkiCard[]>('get_task_cards', { taskId: 'task_old' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({ id: 'card_old', task_id: 'task_old', front: '问题📚', back: '答案中文', tags: ['中文', '📚'],
      images: [], is_error_card: false, extra_fields: { 备注: '中文📚' }, created_at: ISO, updated_at: ISO,
      text: null, error_content: null, template_id: null });
  });
  it('L04 session state: raw JSON fields and text time retain Rust representation', () => {
    expect(real.host.ctx.chatSession.loadSessionState('sess_old')).toEqual({
      sessionId: 'sess_old', updatedAt: ISO, inputValue: '草稿📚', features: { rag: true },
    });
  });
  it('F4 settings: JSON string remains byte-for-byte unchanged', () => {
    expect(real.host.ctx.settings.get('x3.raw_json')).toBe(JSON_TEXT);
    expect(real.host.ctx.settings.listByPrefix('x3.')).toEqual([{ key: 'x3.raw_json', value: JSON_TEXT, updatedAt: SQL_TIME }]);
  });
  it('F3 safe integer reads preserve a legacy i64 beyond JS Number precision', () => {
    const row = real.storage.database('mistakes').one({ sql: 'SELECT id, metadata FROM chat_messages', options: { safeIntegers: true } });
    expect(row).toEqual({ id: I64, metadata: JSON_TEXT });
  });
  it('public read services have not rewritten any seeded column or JSON string', () => {
    for (const [i, db] of DATABASES.entries()) expect(snapshot(real.storage.database(db), db), db).toEqual(before[i]);
  });
});
