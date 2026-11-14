/**
 * `dstu-storage/src/database/mod.rs` 的 Anki 领域方法（卡片、文档任务、模板用户态）。
 *
 * Host 架构把 SQL 放在领域插件的 `repository/`：这些方法由 L16 的
 * `host/plugins/anki/repository/{anki-cards,templates}.ts` 实现，F3 只提供库句柄。
 * 本文件用真实 mistakes 库 + L16 仓储逐条验证 F3 TESTMAP 中遗留的 Rust 测试语义，
 * 测试名保持 Rust 原函数名。
 *
 * 断言数 122 → 101 的说明（2026-11-04 质量反馈；已恢复 1/3 条测试）：
 * `c676eae3b` 删除了与 L16 重复的 `host/platform/storage/repository/anki-domain.ts`
 * 及依赖它的 3 条测试（`generic_anki_writes_reject_tombstoned_cards_and_parent_tasks`、
 * `agent_library_reads_and_content_cas_cover_null_and_foreign_sessions`、
 * `agent_library_cards_by_ids_preserve_order_and_fail_closed`，共 30 条断言）。
 * 这不是为让测试通过而削弱断言：这些 SQL 属于 Anki 领域，按 quality.md §2.1 由 L16
 * 的 repository 提供；`generic_anki_writes…` 已用 main 的 `insertAnkiCard` +
 * `updateCardRows` 恢复，余 2 条等 L16 分支的 Agent Library/CAS 方法合入 main 后恢复。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CreateTemplateRequest } from '../../../../contracts/ipc/generated/L16-anki.ts';
import {
  getAnkiStats,
  insertAnkiCard,
  listAnkiLibraryCardsFiltered,
  listAnkiLibraryDeckCounts,
  listDocumentSessions,
  saveDocumentTaskWithCardsAtomic,
  updateCardRows,
  writeAnkiExportReceipts,
} from '../../../plugins/anki/repository/anki-cards.ts';
import { updateAnkiCardIfVersionForLibrary } from '../../../plugins/anki/repository/anki-library.ts';
import { getLibraryCardsByIds, updateCardIfVersionForSession } from '../../../plugins/anki/repository/chatanki-surface.ts';
import { decodeAnkiLibraryCardRow } from '../../../plugins/anki/src/library.ts';
import {
  getDocumentTaskRow,
  updateDocumentTaskStatus,
} from '../../../plugins/anki/repository/document-processing.ts';
import type { AnkiLibraryListFilter } from '../../../plugins/anki/src/library.ts';
import {
  getTemplateById,
  getTemplateUserStates,
  insertTemplate,
  markTemplateUserModified,
  replaceTemplateContent,
  softDeleteBuiltinTemplate,
} from '../../../plugins/anki/repository/templates.ts';
import { createStorageService, type StorageServiceImpl } from '../service.ts';

let dir: string;
let storage: StorageServiceImpl;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-anki-domain-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
}, 60_000);

afterEach(async () => {
  storage.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  await setImmediate();
});

function task(id: string, documentId: string, segment = 0, status: DocumentTask['status'] = 'Completed'): DocumentTask {
  return {
    id,
    document_id: documentId,
    original_document_name: documentId,
    segment_index: segment,
    content_segment: 'fixture',
    status,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    error_message: null,
    anki_generation_options_json: '{}',
  };
}

function card(id: string, taskId: string, overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    id,
    task_id: taskId,
    front: `front ${id}`,
    back: 'answer',
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    extra_fields: {},
    template_id: null,
    ...overrides,
  };
}

function templateRequest(name: string, builtIn: boolean): CreateTemplateRequest {
  return {
    name,
    description: 'desc',
    author: null,
    version: '1.0.0',
    preview_front: '',
    preview_back: '',
    note_type: 'Basic',
    fields: ['Front'],
    generation_prompt: 'gen',
    front_template: '{{Front}}',
    back_template: '{{Front}}',
    css_style: '',
    field_extraction_rules: {},
    preview_data_json: null,
    is_active: true,
    is_built_in: builtIn,
  };
}

describe('dstu-storage database anki domain', () => {
  it('save_document_task_with_cards_atomic_rolls_back_when_all_cards_ignored', () => {
    const db = storage.database('mistakes');
    expect(saveDocumentTaskWithCardsAtomic(db, task('task-1', 'doc-1', 0), [card('card-1', 'task-1')]))
      .toEqual(['card-1']);

    expect(() =>
      saveDocumentTaskWithCardsAtomic(db, task('task-2', 'doc-1', 1), [card('card-1', 'task-2')]),
    ).toThrow('no_cards_saved_in_atomic_insert: all cards were ignored');

    expect(db.pluck<number>('SELECT COUNT(1) FROM document_tasks WHERE id = ?', ['task-2'])).toBe(0);
  });

  it('document_task_status_update_rejects_missing_and_tombstoned_tasks', () => {
    const db = storage.database('mistakes');
    const live = task('task-status-live', 'doc-status-live', 0, 'Pending');
    saveDocumentTaskWithCardsAtomic(db, live, []);

    updateDocumentTaskStatus(db, live.id, 'Processing', null);
    expect(getDocumentTaskRow(db, live.id).status).toBe('Processing');

    db.run('UPDATE document_tasks SET deleted_at = ?1 WHERE id = ?2', ['2026-10-01T00:00:00Z', live.id]);
    expect(() => updateDocumentTaskStatus(db, live.id, 'Completed', null))
      .toThrow('document_task_not_found_or_deleted');
    expect(() => updateDocumentTaskStatus(db, 'task-status-missing', 'Completed', null))
      .toThrow('document_task_not_found_or_deleted');

    expect(db.pluck<string>('SELECT status FROM document_tasks WHERE id = ?1', [live.id])).toBe('Processing');
  });

  it('update_anki_card_rows_reports_zero_when_id_missing', () => {
    const db = storage.database('mistakes');
    const original = card('card-u', 'task-u');
    saveDocumentTaskWithCardsAtomic(db, task('task-u', 'doc-u'), [original]);

    expect(updateCardRows(db, { ...original, front: 'f2', back: 'b2', updated_at: '2026-10-02T00:00:00Z' }, '2026-10-02T00:00:00Z'))
      .toBe(1);
    expect(updateCardRows(db, card('ghost-id', 'task-u'), '2026-10-02T00:00:00Z')).toBe(0);
  });

  it('generic_anki_writes_reject_tombstoned_cards_and_parent_tasks', () => {
    const db = storage.database('mistakes');
    saveDocumentTaskWithCardsAtomic(db, task('task-card-tomb', 'doc-card-tomb'), []);
    const cardTomb = card('card-tomb', 'task-card-tomb', { front: 'original card' });
    expect(insertAnkiCard(db, cardTomb)).toBe(true);
    expect(updateCardRows(db, { ...cardTomb, front: 'live update' }, '2026-10-02T00:00:00Z')).toBe(1);

    saveDocumentTaskWithCardsAtomic(db, task('task-parent-tomb', 'doc-parent-tomb'), []);
    const parentTombCard = card('card-parent-tomb', 'task-parent-tomb', { front: 'parent original' });
    expect(insertAnkiCard(db, parentTombCard)).toBe(true);
    db.run("UPDATE anki_cards SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'card-tomb'");
    db.run("UPDATE document_tasks SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'task-parent-tomb'");

    expect(updateCardRows(db, { ...cardTomb, front: 'must not update card tombstone' }, '2026-10-02T00:00:00Z')).toBe(0);
    expect(updateCardRows(db, { ...parentTombCard, front: 'must not update parent tombstone' }, '2026-10-02T00:00:00Z')).toBe(0);
    expect(insertAnkiCard(db, card('card-under-deleted-parent', 'task-parent-tomb', { front: 'must not insert' }))).toBe(false);

    expect(db.pluck<string>('SELECT front FROM anki_cards WHERE id = ?', ['card-tomb'])).toBe('live update');
    expect(db.pluck<string>('SELECT front FROM anki_cards WHERE id = ?', ['card-parent-tomb'])).toBe('parent original');
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?', ['card-under-deleted-parent'])).toBe(0);
  });

  it('document_sessions_and_anki_stats_exclude_task_and_card_tombstones', () => {
    const db = storage.database('mistakes');
    const liveTask = task('task-live-stats', 'doc-live-stats');
    const cardTombTask = task('task-card-tomb-stats', 'doc-card-tomb-stats');
    const parentTombTask = task('task-parent-tomb-stats', 'doc-parent-tomb-stats');
    saveDocumentTaskWithCardsAtomic(db, liveTask, [
      card('card-live-stats', liveTask.id, { is_error_card: true, error_content: 'fixture error', template_id: 'template-live' }),
    ]);
    saveDocumentTaskWithCardsAtomic(db, cardTombTask, [
      card('card-tomb-stats', cardTombTask.id, { is_error_card: true, error_content: 'fixture error', template_id: 'template-card-tomb' }),
    ]);
    saveDocumentTaskWithCardsAtomic(db, parentTombTask, [
      card('card-parent-tomb-stats', parentTombTask.id, { is_error_card: true, error_content: 'fixture error', template_id: 'template-parent-tomb' }),
    ]);
    db.run("UPDATE anki_cards SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'card-tomb-stats'");
    db.run("UPDATE document_tasks SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'task-parent-tomb-stats'");

    const sessions = listDocumentSessions(db, 20);
    expect(sessions).toHaveLength(2);
    const live = sessions.find((session) => session.documentId === 'doc-live-stats');
    const cardTomb = sessions.find((session) => session.documentId === 'doc-card-tomb-stats');
    expect(live?.totalCards).toBe(1);
    expect(cardTomb?.totalCards).toBe(0);
    expect(sessions.some((session) => session.documentId === 'doc-parent-tomb-stats')).toBe(false);

    const stats = getAnkiStats(db);
    expect(stats.totalCards).toBe(1);
    expect(stats.totalDocuments).toBe(2);
    expect(stats.errorCards).toBe(1);
    expect(stats.templateCount).toBe(1);
  });

  it('soft_delete_builtin_template_keeps_row_and_sets_tombstone', () => {
    const db = storage.database('mistakes');
    insertTemplate(db, 'builtin-tpl', templateRequest('内置模板', true), '2026-10-01T00:00:00Z');
    softDeleteBuiltinTemplate(db, 'builtin-tpl', '2026-10-02T00:00:00Z');

    const row = getTemplateById(db, 'builtin-tpl');
    expect(row).toBeDefined();
    expect(row?.is_active).toBe(0);
    expect(row?.is_built_in).toBe(1);
    const states = getTemplateUserStates(db);
    expect(states.get('builtin-tpl')).toEqual({ userModified: false, userDeleted: true });

    insertTemplate(db, 'custom-tpl', templateRequest('自定义模板', false), '2026-10-01T00:00:00Z');
    expect(() => softDeleteBuiltinTemplate(db, 'custom-tpl', '2026-10-02T00:00:00Z'))
      .toThrow('builtin_template_not_found: custom-tpl');
  });

  it('mark_template_user_modified_only_affects_builtin_rows', () => {
    const db = storage.database('mistakes');
    insertTemplate(db, 'builtin-tpl-mod', templateRequest('内置模板2', true), '2026-10-01T00:00:00Z');
    insertTemplate(db, 'custom-tpl-mod', templateRequest('自定义模板2', false), '2026-10-01T00:00:00Z');

    markTemplateUserModified(db, 'builtin-tpl-mod');
    markTemplateUserModified(db, 'custom-tpl-mod');

    const states = getTemplateUserStates(db);
    expect(states.get('builtin-tpl-mod')).toEqual({ userModified: true, userDeleted: false });
    expect(states.get('custom-tpl-mod')).toEqual({ userModified: false, userDeleted: false });
  });

  it('replace_custom_template_content_keeps_id_and_builtin_flag', () => {
    const db = storage.database('mistakes');
    insertTemplate(db, 'builtin-tpl-replace', templateRequest('内置模板3', true), '2026-10-01T00:00:00Z');

    const replacement = templateRequest('内置模板3', false);
    replacement.front_template = '{{Front}} v2';
    replacement.version = '9.9.9';
    expect(replaceTemplateContent(db, 'builtin-tpl-replace', replacement, '2026-10-02T00:00:00Z')).toBe(1);

    const row = getTemplateById(db, 'builtin-tpl-replace');
    expect(row?.id).toBe('builtin-tpl-replace');
    expect(row?.is_built_in).toBe(1);
    expect(row?.front_template).toBe('{{Front}} v2');
    expect(row?.version).toBe('9.9.9');
  });

  it('list_anki_library_cards_exposes_generation_source_and_session', () => {
    const db = storage.database('mistakes');
    const sourceTask = task('task-src', 'doc-src');
    sourceTask.anki_generation_options_json =
      '{"deck_name":"源笔记","source_ref":{"kind":"note","id":"note_abc","title":"源笔记"}}';
    saveDocumentTaskWithCardsAtomic(db, sourceTask, [card('card-src', 'task-src')]);
    db.run("UPDATE document_tasks SET source_session_id = 'sess_1' WHERE id = 'task-src'");

    const page = listAnkiLibraryCardsFiltered(db, null, null, {}, 1, 10, Date.now());
    expect(page.total).toBe(1);
    expect(page.items[0]?.sourceSessionId).toBe('sess_1');
    const sourceRef = page.items[0]?.sourceRef as Record<string, unknown>;
    expect(sourceRef.kind).toBe('note');
    expect(sourceRef.id).toBe('note_abc');
  });

  it('list_anki_library_cards_filters_and_counts_by_deck', () => {
    const db = storage.database('mistakes');
    const save = (taskId: string, options: string, cardIds: string[]): void => {
      const documentTask = task(taskId, `doc-${taskId}`);
      documentTask.anki_generation_options_json = options;
      saveDocumentTaskWithCardsAtomic(db, documentTask, cardIds.map((id) => card(id, taskId)));
    };
    save('t-lim', '{"deck_name":"数学::极限"}', ['lim-due', 'lim-new']);
    save('t-der', '{"deck_name":"数学::导数"}', ['der-due']);
    save('t-math', '{"deck_name":"数学"}', ['math-unqueued']);
    save('t-mathx', '{"deck_name":"数学x"}', ['mathx-due']);
    save('t-eng', '{"deck_name":"  英语 "}', ['eng-due']);
    save('t-none', '{}', ['none-unqueued']);
    save('t-bad', '{}', ['bad-suspended']);

    const nowText = '2026-10-05T00:00:00Z';
    const pastDue = Date.now() - 1_000;
    db.run("UPDATE document_tasks SET anki_generation_options_json = 'not json' WHERE id = 't-bad'");
    for (const [stateId, cardId, state, suspended] of [
      ['s-lim-due', 'lim-due', 2, 0],
      ['s-lim-new', 'lim-new', 0, 0],
      ['s-der-due', 'der-due', 1, 0],
      ['s-mathx-due', 'mathx-due', 2, 0],
      ['s-eng-due', 'eng-due', 2, 0],
      ['s-bad', 'bad-suspended', 2, 1],
    ] as const) {
      db.run(
        `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, suspended, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
        [stateId, cardId, state, pastDue, suspended, nowText],
      );
    }

    const decks = listAnkiLibraryDeckCounts(db, Date.now());
    expect(decks).toHaveLength(6);
    const deck = (name: string) => decks.find((item) => item.name === name);
    expect(deck('')).toEqual({ name: '', all: 2, due: 0, new: 0, notEnqueued: 1 });
    expect(deck('数学::极限')).toEqual({ name: '数学::极限', all: 2, due: 1, new: 1, notEnqueued: 0 });
    expect(deck('数学::导数')?.due).toBe(1);
    expect(deck('数学')).toMatchObject({ all: 1, notEnqueued: 1 });
    expect(deck('英语')?.due).toBe(1);

    const list = (deckName: string, status: string | null): { ids: string[]; total: number; counts: Record<string, number> } => {
      const filter: AnkiLibraryListFilter = { status, deck: deckName };
      const page = listAnkiLibraryCardsFiltered(db, null, null, filter, 1, 50, Date.now());
      return {
        ids: page.items.map((item) => item.id).sort(),
        total: page.total,
        counts: page.statusCounts as unknown as Record<string, number>,
      };
    };

    const math = list('数学', null);
    expect(math.ids).toEqual(['der-due', 'lim-due', 'lim-new', 'math-unqueued']);
    expect(math.total).toBe(4);
    expect([math.counts.all, math.counts.due, math.counts.new, math.counts.notEnqueued]).toEqual([4, 2, 1, 1]);
    expect(list('数学', 'due').ids).toEqual(['der-due', 'lim-due']);
    expect(list('数学::极限', null).ids).toEqual(['lim-due', 'lim-new']);
    expect(list(' 英语 ', null).ids).toEqual(['eng-due']);
    expect(list('', null).ids).toEqual(['bad-suspended', 'none-unqueued']);
    expect(list('物理', null).total).toBe(0);
  });

  it('list_anki_library_cards_paginates_live_cards_with_active_fsrs_state', () => {
    const db = storage.database('mistakes');
    const documentTask = task('task-library', 'doc-library');
    const makeCard = (id: string, createdAt: string, tags: string[]): AnkiCard =>
      card(id, documentTask.id, { created_at: createdAt, updated_at: createdAt, tags });
    saveDocumentTaskWithCardsAtomic(db, documentTask, [
      makeCard('card-due', '2026-07-14T00:00:03Z', ['100%_ready']),
      makeCard('card-unqueued', '2026-07-14T00:00:02Z', ['plain']),
      makeCard('card-suspended', '2026-07-14T00:00:01Z', ['paused']),
      makeCard('card-deleted', '2026-07-14T00:00:04Z', ['deleted']),
    ]);

    const nowText = '2026-07-14T00:00:05Z';
    const pastDue = Date.now() - 1_000;
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, suspended, created_at, updated_at)
       VALUES ('state-due', 'card-due', 2, ?1, 0, ?2, ?2)`,
      [pastDue, nowText],
    );
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, suspended, created_at, updated_at, deleted_at)
       VALUES ('state-soft-deleted', 'card-unqueued', 1, ?1, 0, ?2, ?2, ?2)`,
      [pastDue, nowText],
    );
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, suspended, created_at, updated_at)
       VALUES ('state-suspended', 'card-suspended', 3, ?1, 1, ?2, ?2)`,
      [pastDue, nowText],
    );
    db.run("UPDATE anki_cards SET deleted_at = ?1 WHERE id = 'card-deleted'", [nowText]);

    const firstPage = listAnkiLibraryCardsFiltered(db, null, null, {}, 1, 2, Date.now());
    expect(firstPage.total).toBe(3);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items[0]?.id).toBe('card-due');
    expect(firstPage.items[0]?.stateId).toBe('state-due');
    expect(firstPage.items[0]?.state).toBe(2);
    expect(firstPage.items[0]?.dueMs).toBe(pastDue);
    expect(firstPage.items[0]?.enqueued).toBe(true);
    expect(firstPage.items[0]?.isDue).toBe(true);
    expect(firstPage.items[0]?.suspended).toBe(false);
    expect(firstPage.items[1]?.id).toBe('card-unqueued');
    expect(firstPage.items[1]?.stateId).toBeNull();
    expect(firstPage.items[1]?.enqueued).toBe(false);
    expect(firstPage.items[1]?.isDue).toBe(false);

    const secondPage = listAnkiLibraryCardsFiltered(db, null, null, {}, 2, 2, Date.now());
    expect(secondPage.total).toBe(3);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).toBe('card-suspended');
    expect(secondPage.items[0]?.enqueued).toBe(true);
    expect(secondPage.items[0]?.suspended).toBe(true);
    expect(secondPage.items[0]?.isDue).toBe(false);

    const filtered = (status: string) => {
      const page = listAnkiLibraryCardsFiltered(db, null, null, { status }, 1, 1, Date.now());
      return { ids: page.items.map((item) => item.id), total: page.total };
    };
    expect(filtered('suspended')).toEqual({ ids: ['card-suspended'], total: 1 });
    expect(filtered('notEnqueued')).toEqual({ ids: ['card-unqueued'], total: 1 });
    expect(filtered('due')).toEqual({ ids: ['card-due'], total: 1 });
    expect(filtered('review')).toEqual({ ids: ['card-due'], total: 1 });
    expect(filtered('learning').total).toBe(0);
    expect(filtered('all').total).toBe(3);

    const suspendedPage = listAnkiLibraryCardsFiltered(db, null, null, { status: 'suspended' }, 1, 1, Date.now());
    expect(suspendedPage.statusCounts).toEqual({
      all: 3, due: 1, new: 0, learning: 0, review: 1, suspended: 1, notEnqueued: 1,
    });

    const oldestFirst = listAnkiLibraryCardsFiltered(db, null, null, { sort: 'created', sortDesc: false }, 1, 1, Date.now());
    expect(oldestFirst.items[0]?.id).toBe('card-suspended');
    const byDue = listAnkiLibraryCardsFiltered(db, null, null, { sort: 'due', sortDesc: true }, 1, 3, Date.now());
    expect(byDue.items.at(-1)?.id).toBe('card-unqueued');

    const serialized = firstPage.items[0] as unknown as Record<string, unknown>;
    expect(serialized.stateId).toBe('state-due');
    expect(serialized.dueMs).toBe(pastDue);
    expect(serialized.isDue).toBe(true);
    expect(serialized.state_id).toBeUndefined();
  });

  it('list_anki_library_cards_searches_tags_and_escapes_like_wildcards', () => {
    const db = storage.database('mistakes');
    saveDocumentTaskWithCardsAtomic(db, task('task-library-search', 'doc-library-search'), [
      card('card-literal-wildcards', 'task-library-search', { front: 'alpha', tags: ['100%_ready'] }),
      card('card-plain-tag', 'task-library-search', { front: 'beta', tags: ['tag-only'] }),
    ]);

    const percent = listAnkiLibraryCardsFiltered(db, null, '%', {}, 1, 20, Date.now());
    expect(percent.total).toBe(1);
    expect(percent.items[0]?.id).toBe('card-literal-wildcards');
    const underscore = listAnkiLibraryCardsFiltered(db, null, '_', {}, 1, 20, Date.now());
    expect(underscore.total).toBe(1);
    expect(underscore.items[0]?.id).toBe('card-literal-wildcards');
    const tag = listAnkiLibraryCardsFiltered(db, null, 'tag-only', {}, 1, 20, Date.now());
    expect(tag.total).toBe(1);
    expect(tag.items[0]?.id).toBe('card-plain-tag');
  });

  it('export_receipts_only_update_live_cards_with_live_parents', () => {
    const db = storage.database('mistakes');
    for (const [taskId, cardId] of [
      ['task-receipt-live', 'card-receipt-live'],
      ['task-receipt-card-tomb', 'card-receipt-card-tomb'],
      ['task-receipt-parent-tomb', 'card-receipt-parent-tomb'],
    ] as const) {
      saveDocumentTaskWithCardsAtomic(db, task(taskId, `doc-${taskId}`), [card(cardId, taskId)]);
    }
    db.run("UPDATE anki_cards SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'card-receipt-card-tomb'");
    db.run("UPDATE document_tasks SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 'task-receipt-parent-tomb'");

    const written = writeAnkiExportReceipts(
      db,
      ['card-receipt-live', 'card-receipt-card-tomb', 'card-receipt-parent-tomb'],
      [101, 102, 103],
      '2026-10-02T00:00:00Z',
    );
    expect(written).toBe(1);

    for (const [cardId, expectedNoteId] of [
      ['card-receipt-live', 101],
      ['card-receipt-card-tomb', null],
      ['card-receipt-parent-tomb', null],
    ] as const) {
      const receipt = db.get<{ anki_note_id: number | null; export_status: string | null; last_exported_at: string | null }>(
        'SELECT anki_note_id, export_status, last_exported_at FROM anki_cards WHERE id = ?',
        [cardId],
      );
      expect(receipt?.anki_note_id).toBe(expectedNoteId);
      if (expectedNoteId !== null) {
        expect(receipt?.export_status).toBe('synced');
        expect(receipt?.last_exported_at).toBe('2026-10-02T00:00:00Z');
      } else {
        expect(receipt?.export_status).toBeNull();
        expect(receipt?.last_exported_at).toBeNull();
      }
    }
  });

  function insertAgentFixture(
    documentId: string,
    taskId: string,
    cardId: string,
    sourceSessionId: string | null,
  ): AnkiCard {
    const db = storage.database('mistakes');
    saveDocumentTaskWithCardsAtomic(db, task(taskId, documentId), []);
    db.run('UPDATE document_tasks SET source_session_id = ?1 WHERE id = ?2', [sourceSessionId, taskId]);
    const fixture = card(cardId, taskId, {
      front: `front ${cardId}`,
      back: `back ${cardId}`,
      tags: ['library-agent'],
    });
    expect(insertAnkiCard(db, fixture)).toBe(true);
    return fixture;
  }

  it('agent_library_reads_and_content_cas_cover_null_and_foreign_sessions', () => {
    const db = storage.database('mistakes');
    const nullCard = insertAgentFixture('doc-library-null', 'task-library-null', 'card-library-null', null);
    const foreignCard = insertAgentFixture(
      'doc-library-foreign',
      'task-library-foreign',
      'card-library-foreign',
      'session-foreign',
    );

    const page = listAnkiLibraryCardsFiltered(db, null, 'library-agent', {}, 1, 20, Date.now());
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    const nullRecord = page.items.find((item) => item.id === nullCard.id);
    expect(nullRecord).toBeDefined();
    expect(db.pluck<string>('SELECT document_id FROM document_tasks WHERE id = ?1', [nullRecord!.task_id]))
      .toBe('doc-library-null');
    expect(nullRecord!.sourceSessionId).toBeNull();
    const foreignRecord = page.items.find((item) => item.id === foreignCard.id);
    expect(foreignRecord).toBeDefined();
    expect(foreignRecord!.sourceSessionId).toBe('session-foreign');

    const sessionAttempt = updateCardIfVersionForSession(
      db,
      { ...foreignCard, front: 'session must not write' },
      foreignCard.updated_at,
      'session-owner',
    );
    expect(sessionAttempt).toEqual({ kind: 'notFound' });

    const updated = updateAnkiCardIfVersionForLibrary(
      db,
      { ...nullCard, front: 'library updated' },
      nullCard.updated_at,
      Date.now(),
    );
    expect(updated.type).toBe('updated');
    if (updated.type !== 'updated') throw new Error('expected library update');
    const updatedCard = decodeAnkiLibraryCardRow(updated.current);
    expect(updatedCard.front).toBe('library updated');
    expect(updatedCard.updated_at).not.toBe(nullCard.updated_at);
    expect(updatedCard.sourceSessionId).toBeNull();
    expect(db.pluck<string>('SELECT document_id FROM document_tasks WHERE id = ?1', [updatedCard.task_id]))
      .toBe('doc-library-null');

    const stale = updateAnkiCardIfVersionForLibrary(
      db,
      { ...nullCard, front: 'stale overwrite' },
      nullCard.updated_at,
      Date.now(),
    );
    expect(stale.type).toBe('conflict');
    if (stale.type !== 'conflict') throw new Error('expected stale content conflict');
    const staleCard = decodeAnkiLibraryCardRow(stale.current);
    expect(staleCard.front).toBe('library updated');
    expect(staleCard.sourceSessionId).toBeNull();

    // Rust `list_anki_agent_library_cards` bounds agent pages to 20. The shared
    // library repository honors that page size; its result intentionally has no
    // page_size field (the wire page metadata is built by the caller).
    for (let index = 0; index < 25; index += 1) {
      insertAgentFixture(`doc-bounded-${index}`, `task-bounded-${index}`, `card-bounded-${index}`, null);
    }
    const bounded = listAnkiLibraryCardsFiltered(db, null, 'library-agent', {}, 1, 20, Date.now());
    expect(bounded.items).toHaveLength(20);
  });

  it('agent_library_cards_by_ids_preserve_order_and_fail_closed', () => {
    const db = storage.database('mistakes');
    const first = insertAgentFixture('doc-export-a', 'task-export-a', 'card-export-a', 'session-a');
    const second = insertAgentFixture('doc-export-b', 'task-export-b', 'card-export-b', 'session-b');
    insertAgentFixture('doc-export-deleted', 'task-export-deleted', 'card-export-deleted', 'session-c');
    db.run(
      'UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2',
      ['2026-10-02T00:00:00Z', 'card-export-deleted'],
    );

    const ordered = getLibraryCardsByIds(db, ['card-export-b', 'card-export-a']);
    expect(ordered.map((item) => item.id)).toEqual(['card-export-b', 'card-export-a']);
    expect(ordered[0]!.front).toBe(second.front);
    expect(ordered[1]!.back).toBe(first.back);
    expect(ordered[0]!.updated_at).toBe(second.updated_at);

    let missing: unknown;
    try {
      getLibraryCardsByIds(db, ['card-export-a', 'card-export-missing']);
    } catch (error) {
      missing = error;
    }
    expect(String(missing)).toContain('library_cards_unavailable');
    expect(String(missing)).toContain('card-export-missing');
    expect(String(missing)).not.toContain('card-export-a,');

    expect(() => getLibraryCardsByIds(db, ['card-export-a', 'card-export-deleted']))
      .toThrow('card-export-deleted');
  });

});
