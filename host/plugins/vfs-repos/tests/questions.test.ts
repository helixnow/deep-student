import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import { escapeFts5Query, sanitizeSearchKeyword } from '../repository/questions.ts';
import { runConcurrent } from './support/concurrency.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-question-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.questions;
function insertExam(id: string, resourceId: string | null = null, name = id, deleted: string | null = null) {
  db.run(`INSERT INTO exam_sheets(id,resource_id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at,deleted_at)
    VALUES (?1,?2,?3,'completed',?1,'{}','{}',?4,?4,?5)`, [id, resourceId, name, '2026-10-23T00:00:00Z', deleted]);
}
function seedGroup(examId: string) {
  const now = '2026-10-23T00:00:00Z';
  db.run("INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at) VALUES ('g1',?1,'阅读一',0,?2,?2)", [examId, now]);
  db.run("INSERT INTO qbank_materials(id,exam_id,content,images_json,source_refs_json,local_version,created_at,updated_at) VALUES ('m1',?1,'共享文章正文','[]','[]',3,?2,?2)", [examId, now]);
  db.run("INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at) VALUES ('gm1',?1,'g1','m1',0,?2,?2)", [examId, now]);
}
function grouped(examId: string, content: string, position = 0) {
  const q = repo().createQuestion(db, { exam_id: examId, content, question_type: 'short_answer' });
  db.run("UPDATE questions SET group_id='g1',group_position=?1 WHERE id=?2", [position, q.id]);
  return q;
}
function createOccQuestion(id: string) {
  db.run(`INSERT INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
    VALUES (?1,'OCC test','completed',?2,'{}','{}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`,
  [`exam-${id}`, `temp-${id}`]);
  const question = repo().createQuestion(db, { exam_id: `exam-${id}`, content: 'original' });
  db.run("UPDATE questions SET updated_at='2020-01-01T00:00:00Z' WHERE id=?1", [question.id]);
  return repo().getQuestion(db, question.id)!;
}

describe('question_repo.rs', { timeout: 120_000 }, () => {
  it('escape_fts5_query_quotes_every_token', () => {
    expect(escapeFts5Query('hello')).toBe('"hello"');
    expect(escapeFts5Query('foo bar')).toBe('"foo" "bar"');
    expect(escapeFts5Query('C++ 是什么?')).toBe('"C++" "是什么?"');
    expect(escapeFts5Query('a.b')).toBe('"a.b"');
    expect(escapeFts5Query('NOT')).toBe('"NOT"');
    expect(escapeFts5Query('say "hi"')).toBe('"say" """hi"""');
  });
  it('sanitize_search_keyword_trims_and_limits', () => {
    expect(sanitizeSearchKeyword('  abc  ')).toBe('abc');
    expect(sanitizeSearchKeyword('   ')).toBeNull();
    expect([...sanitizeSearchKeyword('字'.repeat(250))!]).toHaveLength(200);
  });
  it('list_mistakes_spans_live_exams_with_names_counts_and_sorting', () => {
    insertExam('exam-a', null, '高数'); insertExam('exam-b', null, '英语'); insertExam('exam-gone', null, '已删', '2026-10-02T00:00:00Z');
    const make = (examId: string, content: string, status: string, attempts: number, correct: number, last: string) => {
      const q = repo().createQuestion(db, { exam_id: examId, content });
      db.run('UPDATE questions SET status=?1,attempt_count=?2,correct_count=?3,last_attempt_at=?4 WHERE id=?5', [status, attempts, correct, last, q.id]);
      return q.id;
    };
    const qa1 = make('exam-a', '极限定义', 'review', 3, 0, '2026-10-03T00:00:00Z');
    const qa2 = make('exam-a', '导数', 'review', 5, 1, '2026-10-01T00:00:00Z');
    make('exam-a', '已掌握', 'mastered', 2, 1, '2026-10-04T00:00:00Z');
    const deleted = make('exam-a', '删掉的错题', 'review', 1, 0, '2026-10-04T00:00:00Z');
    const qb1 = make('exam-b', '完形填空', 'review', 1, 0, '2026-10-04T00:00:00Z');
    make('exam-gone', '题目集已删', 'review', 1, 0, '2026-10-04T00:00:00Z');
    db.run("UPDATE questions SET deleted_at='2026-10-04T00:00:00Z' WHERE id=?1", [deleted]);
    db.run('UPDATE questions SET tags=?1 WHERE id=?2', ['["链式法则"]', qa2]);
    const recent = repo().listMistakes(db, {}, 1, 50);
    expect(recent.items.map(q => q.id)).toEqual([qb1, qa1, qa2]);
    expect(recent.total).toBe(3);
    expect(recent.items[0]!.exam_name).toBe('英语');
    expect(recent.exams).toEqual([{ exam_id: 'exam-a', exam_name: '高数', count: 2 }, { exam_id: 'exam-b', exam_name: '英语', count: 1 }]);
    expect(repo().listMistakes(db, { sort: 'errors' }, 1, 50).items.map(q => q.id)).toEqual([qa2, qa1, qb1]);
    const onlyA = repo().listMistakes(db, { exam_id: 'exam-a' }, 1, 50);
    expect(onlyA.items.map(q => q.id)).toEqual([qa1, qa2]);
    expect(onlyA.exams).toHaveLength(2);
    expect(repo().listMistakes(db, { search: '链式' }, 1, 50).items.map(q => q.id)).toEqual([qa2]);
    expect(repo().listMistakes(db, {}, 1, 2).has_more).toBe(true);
    const second = repo().listMistakes(db, {}, 2, 2);
    expect(second.items.map(q => q.id)).toEqual([qa2]); expect(second.has_more).toBe(false);
  });
  it('get_question_by_card_id_accepts_question_id_fallback', () => {
    insertExam('exam-cardless'); insertExam('exam-other');
    const q = repo().createQuestion(db, { exam_id: 'exam-cardless', content: 'original' });
    expect(q.card_id).toBeNull();
    expect(repo().getQuestionByCardId(db, q.exam_id, q.id)?.id).toBe(q.id);
    db.run("UPDATE questions SET card_id='card-real' WHERE id=?1", [q.id]);
    expect(repo().getQuestionByCardId(db, q.exam_id, 'card-real')?.id).toBe(q.id);
    repo().createQuestion(db, { exam_id: 'exam-other', content: 'original' });
    expect(repo().getQuestionByCardId(db, 'exam-other', q.id)).toBeNull();
    db.run("UPDATE questions SET deleted_at='2021-01-01T00:00:00Z' WHERE id=?1", [q.id]);
    expect(repo().getQuestionByCardId(db, q.exam_id, q.id)).toBeNull();
  });
  it('update_question_occ_is_atomic_and_rejects_stale_writes', () => {
    const question = createOccQuestion('atomic');
    const baseline = question.updated_at;
    const first = repo().updateQuestion(db, question.id, {
      content: 'newer content', expected_updated_at: baseline,
    });
    expect(first.content).toBe('newer content');
    expect(first.updated_at).not.toBe(baseline);
    let stale: unknown;
    try {
      repo().updateQuestion(db, question.id, { content: 'stale overwrite', expected_updated_at: baseline });
    } catch (error) { stale = error; }
    expect(String(stale)).toContain('QBANK_CONFLICT');
    expect(String(stale)).toContain(`actual_updated_at=${first.updated_at}`);
    const persisted = repo().getQuestion(db, question.id)!;
    expect(persisted.content).toBe('newer content');
    expect(persisted.updated_at).toBe(first.updated_at);
  });
  it('concurrent_question_updates_allow_exactly_one_occ_winner', async () => {
    // Two independent connections released by one gate, matching the Rust
    // Barrier test (question_repo.rs:3818-3871).
    const question = createOccQuestion('concurrent');
    const expected = question.updated_at;
    const outcomes = await runConcurrent<string>([
      {
        mode: 'question' as const,
        dbPath: db.path,
        questionId: question.id,
        expected,
        content: 'writer-a',
      },
      {
        mode: 'question' as const,
        dbPath: db.path,
        questionId: question.id,
        expected,
        content: 'writer-b',
      },
    ]);

    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.ok && outcome.message.includes('QBANK_CONFLICT'))).toHaveLength(1);
    const winner = outcomes.find(outcome => outcome.ok);
    expect(winner?.ok).toBe(true);
    const persisted = repo().getQuestion(db, question.id)!;
    expect(['writer-a', 'writer-b']).toContain(persisted.content);
    if (winner?.ok) expect(persisted.content).toBe(winner.value);
  });
  it('list_and_single_reads_hydrate_group_materials_without_duplicating_membership', () => {
    insertExam('exam-hydrate'); seedGroup('exam-hydrate');
    grouped('exam-hydrate', '子题一');
    const q = grouped('exam-hydrate', '子题二', 1);
    const list = repo().listQuestions(db, 'exam-hydrate', {}, 1, 50);
    expect(list.questions).toHaveLength(2);
    const hydrated = list.questions.find(item => item.id === q.id)!;
    expect(hydrated.group_id).toBe('g1'); expect(hydrated.group_label).toBe('阅读一');
    expect(hydrated.materials).toHaveLength(1);
    expect(hydrated.materials[0]).toMatchObject({ id: 'm1', version: 3, content: '共享文章正文' });
    const single = repo().getQuestion(db, q.id)!;
    expect(single.materials).toHaveLength(1); expect(single.group_position).toBe(1);
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('qbank_groups')").map(c => c.name)).not.toContain('question_ids');
  });
  it('canonical_read_returns_all_questions_beyond_repo_page_cap', () => {
    insertExam('exam-canonical');
    for (let i = 0; i < 105; i++) {
      db.run("INSERT INTO questions(id,exam_id,content,question_type,tags,created_at,updated_at) VALUES (?1,'exam-canonical',?2,'short_answer','[]',?3,?3)", [`q-canonical-${String(i).padStart(3, '0')}`, `题目 ${i}`, '2026-10-23T00:00:00Z']);
    }
    expect(repo().canonicalQuestions(db, 'exam-canonical')).toHaveLength(105);
    const text = repo().canonicalText(db, 'exam-canonical');
    expect(text).toContain('题目 0'); expect(text).toContain('题目 104');
  });
  it('count_by_type_excludes_soft_deleted_questions', () => {
    insertExam('exam-count');
    const q = repo().createQuestion(db, { exam_id: 'exam-count', content: '选择题', question_type: 'single_choice', options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }] });
    expect(repo().countByType(db, 'exam-count').single_choice).toBe(1);
    repo().deleteQuestion(db, q.id);
    expect(repo().countByType(db, 'exam-count').single_choice).toBeUndefined();
  });
  it('submission_freezes_question_and_material_snapshot_for_historical_review', () => {
    insertExam('exam-snapshot'); seedGroup('exam-snapshot');
    const q = grouped('exam-snapshot', '子题快照');
    const submissionId = repo().insertSubmission(db, q.id, '原文答案', true, 'auto', null);
    const snapshot = repo().getSubmissionSnapshot(db, submissionId)!;
    expect(snapshot.question_snapshot_json).toContain('子题快照');
    expect(snapshot.question_snapshot_json).toContain('"material_ids":["m1"]');
    expect(snapshot.material_snapshot_json).toContain('共享文章正文');
    db.run("UPDATE qbank_materials SET content='修订后的文章',local_version=4 WHERE id='m1'");
    expect(repo().getSubmissionSnapshot(db, submissionId)?.material_snapshot_json).toContain('共享文章正文');
  });
  it('question_mutation_marks_linked_resource_index_pending', () => {
    db.run("INSERT INTO resources(id,hash,type,storage_mode,ref_count,created_at,updated_at,index_state) VALUES ('res-index','hash-index','exam','managed',1,0,0,'indexed')");
    insertExam('exam-index', 'res-index');
    const q = repo().createQuestion(db, { exam_id: 'exam-index', content: '索引失效题目' });
    expect(db.pluck("SELECT index_state FROM resources WHERE id='res-index'")).toBe('pending');
    db.run("UPDATE resources SET index_state='indexed' WHERE id='res-index'");
    repo().deleteQuestion(db, q.id);
    expect(db.pluck("SELECT index_state FROM resources WHERE id='res-index'")).toBe('pending');
  });
  it('FTS filters bind before MATCH and LIKE fallback preserves its original uncapped pagination', () => {
    insertExam('exam-search'); insertExam('exam-other-search');
    const q = repo().createQuestion(db, { exam_id: 'exam-search', content: 'hello target', answer: 'yes', question_type: 'short_answer', difficulty: 'easy', tags: ['tag'] });
    repo().createQuestion(db, { exam_id: 'exam-other-search', content: 'hello target' });
    db.run('UPDATE questions SET is_favorite=1,is_bookmarked=1 WHERE id=?1', [q.id]);
    const filters = { status: ['new' as const], difficulty: ['easy' as const], question_type: ['short_answer' as const], tags: ['tag'], is_favorite: true, is_bookmarked: true };
    const result = repo().searchQuestions(db, 'hello', 'exam-search', filters, 0, 500);
    expect(result.total).toBe(1); expect(result.page).toBe(1); expect(result.page_size).toBe(100);
    expect(result.results[0]!.question.id).toBe(q.id);
    expect(result.results[0]!.highlight_content).toContain('<mark>hello</mark>');
    expect(repo().listQuestions(db, 'exam-search', { ...filters, search: 'hello' }, 1, 50).total).toBe(1);
    expect(repo().searchQuestions(db, '   ', null, {}, 0, 500)).toMatchObject({ total: 0, page: 0, page_size: 500, search_time_ms: 0 });
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%questions_fts%'")) db.exec(`DROP TRIGGER "${name}"`);
    db.exec('DROP TABLE questions_fts');
    const fallback = repo().searchQuestions(db, 'hello', 'exam-search', filters, 0, 500);
    expect(fallback.total).toBe(1); expect(fallback.page).toBe(0); expect(fallback.page_size).toBe(500);
    expect(fallback.results[0]).toMatchObject({ highlight_content: null, relevance_score: 0 });
    expect(repo().listQuestions(db, 'exam-search', { search: 'hello' }, 0, 500).page_size).toBe(100);
  });
  it('submission idempotency, history ordering, stats and OCC delete retain their separate behaviors', () => {
    insertExam('exam-ops');
    const q = repo().createQuestion(db, { exam_id: 'exam-ops', content: 'original' });
    const submission = repo().insertSubmission(db, q.id, 'first', null, 'manual', '  request  ');
    expect(repo().insertSubmission(db, q.id, 'second', true, 'auto', 'request')).toBe(submission);
    expect(repo().getSubmissionByClientRequest(db, q.id, 'request')?.user_answer).toBe('first');
    repo().updateSubmissionCorrect(db, submission, true, 'auto');
    expect(repo().getSubmissions(db, q.id, 100)[0]).toMatchObject({ id: submission, is_correct: true, grading_method: 'auto' });
    expect(repo().getSubmissionsWithSnapshots(db, q.id, 100)[0]![1].submission_id).toBe(submission);
    const history = repo().recordHistory(db, q.id, 'content', 'old', 'new', 'user', null);
    expect(repo().getHistory(db, q.id)).toEqual([history]);
    expect(repo().refreshStats(db, 'exam-ops')).toMatchObject({ total_count: 1, new_count: 1, total_attempts: 0, correct_rate: 0 });
    expect(repo().getStats(db, 'exam-ops')?.total_count).toBe(1);
    expect(repo().randomQuestionIds(db, 'exam-ops', {}, [], null, 10)).toEqual([q.id]);
    expect(repo().randomQuestionIds(db, 'exam-ops', {}, [q.id], null, 10)).toEqual([]);
    expect(repo().randomQuestions(db, 'exam-ops', {}, [], 10).map(x => x.id)).toEqual([q.id]);
    expect(() => repo().deleteQuestionIfVersion(db, q.id, 'stale')).toThrow('QBANK_CONFLICT: question_id=');
    repo().deleteQuestionIfVersion(db, q.id, q.updated_at);
    expect(repo().getQuestion(db, q.id)).toBeNull();
    expect(repo().deleteSubmissionsByExam(db, 'exam-ops')).toBe(1);
    expect(repo().refreshStats(db, 'exam-ops')).toMatchObject({ total_count: 0, total_attempts: 0, correct_rate: 0 });
  });
  it('batch creation rolls back all questions and index changes on a foreign-key failure', () => {
    insertExam('exam-batch');
    expect(() => repo().batchCreateQuestions(db, [{ exam_id: 'exam-batch', content: 'first' }, { exam_id: 'missing', content: 'second' }])).toThrow();
    expect(repo().countQuestions(db, 'exam-batch')).toBe(0);
    const created = repo().batchCreateQuestions(db, [{ exam_id: 'exam-batch', content: 'first' }, { exam_id: 'exam-batch', content: 'second' }]);
    expect(created).toHaveLength(2);
    expect(repo().getQuestionsByIds(db, created.map(q => q.id))).toHaveLength(2);
    expect(repo().batchDeleteQuestions(db, [...created.map(q => q.id), 'unknown'])).toBe(2);
    expect(repo().countQuestions(db, 'exam-batch')).toBe(0);
  });
});
