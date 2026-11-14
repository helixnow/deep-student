import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { JsonReader } from '../../../platform/util/api.ts';
import type { DatabaseHandle, Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import { VfsRepositoryError } from '../api.ts';
import plugin from '../index.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-question-sync-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), notes: notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.questions;

const OLD = '2000-01-01T00:00:00Z';
const NOW = '2026-11-06T08:00:00.123456789+00:00';
const SQLITE_NOW = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function insertExam(id: string): void {
  db.run(`INSERT INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
    VALUES (?1,?1,'completed',?1,'{}','{}',?2,?2)`, [id, OLD]);
}
/** 原样插入一行（列值即落库文本），用于控制 serde 解码输入。 */
function insertQuestion(id: string, columns: Record<string, string | number | null> = {}): void {
  const values: Record<string, string | number | null> = {
    id, exam_id: 'exam', content: 'stem', question_type: 'essay', tags: '[]', status: 'new',
    created_at: OLD, updated_at: OLD, sync_status: 'synced', content_hash: 'stale', ai_score: 7,
    ...columns,
  };
  const keys = Object.keys(values);
  db.run(`INSERT INTO questions(${keys.join(',')}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(',')})`, keys.map(k => values[k] ?? null));
}
function questionRow(id: string, conn: SqlExecutor = db): Row {
  return conn.one('SELECT * FROM questions WHERE id=?1', [id]);
}
function rejectTrigger(column: string): void {
  db.exec(`CREATE TRIGGER reject_${column} BEFORE UPDATE OF ${column} ON questions
    BEGIN SELECT RAISE(ABORT, '${column} rejected'); END`);
}
function errorOf(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected the owner write to throw');
}
/** compute_content_hash 的字段顺序（question_sync_service.rs:471-517），按 serde 输出逐段拼接。 */
function rustHash(parts: string[]): string {
  const hasher = createHash('sha256');
  for (const part of parts) hasher.update(part, 'utf8');
  return hasher.digest('hex');
}

describe('question sync/AI owner writes (WP-021)', { timeout: 120_000 }, () => {
  beforeEach(() => insertExam('exam'));

  it('pipeline.rs:596-601 updateAiFeedback writes ai_feedback/ai_score/ai_graded_at/updated_at only', () => {
    insertQuestion('q1');
    insertQuestion('q2');
    const before = questionRow('q1');
    const other = questionRow('q2');
    expect(repo().updateAiFeedback(db, 'q1', '批改反馈', 85, NOW)).toBe(1);
    expect(questionRow('q1')).toEqual({ ...before, ai_feedback: '批改反馈', ai_score: 85, ai_graded_at: NOW, updated_at: NOW });
    expect(questionRow('q2')).toEqual(other);

    expect(repo().updateAiFeedback(db, 'q1', 'no score', null, NOW)).toBe(1);
    expect(questionRow('q1')).toMatchObject({ ai_feedback: 'no score', ai_score: null });

    db.run('UPDATE questions SET deleted_at=?1 WHERE id=?2', [OLD, 'q2']);
    const deleted = questionRow('q2');
    expect(repo().updateAiFeedback(db, 'q2', 'x', 1, NOW)).toBe(0);
    expect(questionRow('q2')).toEqual(deleted);
    expect(repo().updateAiFeedback(db, 'missing', 'x', 1, NOW)).toBe(0);
  });

  it('pipeline.rs:602-607 updateAiAnalysis keeps ai_score and writes feedback/graded/updated only', () => {
    insertQuestion('q1');
    const before = questionRow('q1');
    expect(repo().updateAiAnalysis(db, 'q1', '解析', NOW)).toBe(1);
    expect(questionRow('q1')).toEqual({ ...before, ai_feedback: '解析', ai_graded_at: NOW, updated_at: NOW });
    expect(questionRow('q1').ai_score).toBe(7);

    db.run('UPDATE questions SET deleted_at=?1 WHERE id=?2', [OLD, 'q1']);
    expect(repo().updateAiAnalysis(db, 'q1', 'x', NOW)).toBe(0);
    expect(repo().updateAiAnalysis(db, 'missing', 'x', NOW)).toBe(0);
  });

  it('mark_as_modified_with_conn only flips synced to modified on live rows', () => {
    insertQuestion('synced');
    insertQuestion('local', { sync_status: 'local_only' });
    insertQuestion('pending', { sync_status: 'pending_push' });
    insertQuestion('gone', { deleted_at: OLD });
    const before = Object.fromEntries(['synced', 'local', 'pending', 'gone'].map(id => [id, questionRow(id)]));

    expect(repo().markAsModified(db, 'synced')).toBeUndefined();
    const synced = questionRow('synced');
    // schema trg_questions_updated_at 在 updated_at 未变时补 datetime('now')，与 Rust 同库行为一致。
    expect(synced.updated_at).toMatch(SQLITE_NOW);
    expect(synced).toEqual({ ...before.synced, sync_status: 'modified', updated_at: synced.updated_at });

    for (const id of ['local', 'pending']) {
      repo().markAsModified(db, id);
      expect(questionRow(id)).toMatchObject({ ...before[id], updated_at: expect.stringMatching(SQLITE_NOW) });
    }
    repo().markAsModified(db, 'gone');
    expect(questionRow('gone')).toEqual(before.gone);
    expect(() => repo().markAsModified(db, 'missing')).not.toThrow();
  });

  it('update_content_hash_with_conn hashes the serde projection and writes content_hash only', () => {
    insertQuestion('q1', {
      content: '题干', answer: 'B', explanation: '因为', question_type: 'single_choice', difficulty: 'hard',
      options_json: '[{"content":"三","key":"A","extra":1},{"key":"B","content":"四"}]',
      tags: '["数学","代数"]',
      images_json: '[{"hash":"h","mime":"image/png","name":"a.png","id":"img","role":null},{"id":"i2","name":"b","mime":"m","hash":"h2","role":"stem"}]',
      structured_data: '{"z":1,"a":[true,null]}',
      user_answer: 'A', attempt_count: 3,
    });
    const before = questionRow('q1');
    const expected = rustHash([
      '题干',
      '[{"key":"A","content":"三"},{"key":"B","content":"四"}]',
      'B', '因为', 'single_choice', 'hard',
      '["数学","代数"]',
      '[{"id":"img","name":"a.png","mime":"image/png","hash":"h"},{"id":"i2","name":"b","mime":"m","hash":"h2","role":"stem"}]',
      '{"z":1,"a":[true,null]}',
    ]);
    expect(repo().updateContentHash(db, 'q1')).toBe(expected);
    const after = questionRow('q1');
    expect(after).toEqual({ ...before, content_hash: expected, updated_at: after.updated_at });
    expect(after.updated_at).toMatch(SQLITE_NOW);

    // 非内容字段不影响哈希；内容字段改变哈希（test_content_hash_consistency 的口径）。
    db.run("UPDATE questions SET user_answer='C',attempt_count=9,ai_feedback='f' WHERE id='q1'");
    expect(repo().updateContentHash(db, 'q1')).toBe(expected);
    db.run("UPDATE questions SET content='新题干' WHERE id='q1'");
    expect(repo().updateContentHash(db, 'q1')).not.toBe(expected);
  });

  it('update_content_hash_with_conn applies get_question_by_id defaults for unparsable JSON', () => {
    insertQuestion('q1', {
      content: 'c', options_json: 'not json', tags: '{"a":1}', images_json: '[{"id":1}]',
      structured_data: 'null', question_type: 'weird', difficulty: null, answer: null, explanation: null,
    });
    expect(repo().updateContentHash(db, 'q1')).toBe(rustHash(['c', 'other', '[]']));
    db.run("UPDATE questions SET structured_data='{broken', question_type=NULL, difficulty='unknown' WHERE id='q1'");
    expect(repo().updateContentHash(db, 'q1')).toBe(rustHash(['c', 'other', 'medium', '[]']));
  });

  it('update_content_hash_with_conn maps missing, deleted and unconvertible rows to question NotFound', () => {
    insertQuestion('gone', { deleted_at: OLD });
    insertQuestion('bad', { attempt_count: 'abc' });
    const bad = questionRow('bad');
    for (const id of ['missing', 'gone', 'bad']) {
      const error = errorOf(() => repo().updateContentHash(db, id));
      expect(error).toBeInstanceOf(VfsRepositoryError);
      expect(error).toMatchObject({ code: 'VFS_NOT_FOUND', message: `question not found: ${id}`, data: { resourceType: 'question', id } });
    }
    expect(questionRow('bad')).toEqual(bad);
    expect(questionRow('gone').content_hash).toBe('stale');
  });

  it.each([
    ['markAsModified', 'sync_status'],
    ['updateContentHash', 'content_hash'],
  ] as const)('%s wraps a failing UPDATE as VFS_STORAGE Database error and leaves the row intact', (method, column) => {
    insertQuestion('q1');
    const before = questionRow('q1');
    rejectTrigger(column);
    const error = errorOf(() => repo()[method](db, 'q1'));
    expect(error).toBeInstanceOf(VfsRepositoryError);
    expect(error).toMatchObject({ code: 'VFS_STORAGE', message: `Database error: ${column} rejected` });
    expect((error as Error).cause).toBeInstanceOf(StorageError);
    expect(questionRow('q1')).toEqual(before);
  });

  it.each([
    ['updateAiFeedback'],
    ['updateAiAnalysis'],
  ] as const)('%s propagates the raw SQLite error for the caller prefix and leaves the row intact', (method) => {
    insertQuestion('q1');
    const before = questionRow('q1');
    rejectTrigger('ai_feedback');
    const error = errorOf(() => method === 'updateAiFeedback'
      ? repo().updateAiFeedback(db, 'q1', 'f', 1, NOW)
      : repo().updateAiAnalysis(db, 'q1', 'f', NOW));
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).toBe('ai_feedback rejected');
    expect(questionRow('q1')).toEqual(before);
  });

  it('all four writes share the caller transaction: visible inside, isolated outside, gone on rollback', async () => {
    insertQuestion('q1');
    const before = questionRow('q1');
    const tx = await db.begin();
    let hash: string;
    try {
      expect(repo().updateAiFeedback(tx, 'q1', 'graded', 90, NOW)).toBe(1);
      expect(repo().updateAiAnalysis(tx, 'q1', 'analysed', NOW)).toBe(1);
      repo().markAsModified(tx, 'q1');
      hash = repo().updateContentHash(tx, 'q1');
      expect(questionRow('q1', tx)).toMatchObject({ ai_feedback: 'analysed', ai_score: 90, ai_graded_at: NOW, sync_status: 'modified', content_hash: hash });
      expect(questionRow('q1')).toEqual(before);
    } finally { await tx.rollback(); }
    expect(questionRow('q1')).toEqual(before);

    const committed = await db.begin();
    try {
      repo().markAsModified(committed, 'q1');
      expect(repo().updateContentHash(committed, 'q1')).toBe(hash);
      expect(questionRow('q1')).toEqual(before);
      await committed.commit();
    } catch (error) { await committed.rollback(); throw error; }
    expect(questionRow('q1')).toMatchObject({ sync_status: 'modified', content_hash: hash });
  });

  describe('WP-215 get_question_by_id typed Vec from original JSON (serde 1.0.228 / serde_json 1.0.149)', () => {
    let logs: Message[];
    // The SQLite/Host cases otherwise form one continuous microtask chain (>60s).
    // Let the worker receive its RPC acknowledgements within the original budget.
    afterEach(async () => { await setImmediate(); });
    beforeEach(() => {
      logs = [];
      host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    });
    // Expected segments are literal serde projections from question_repo.rs:248-268,
    // not values returned by a decoder or a second implementation of the production hash.
    const option = '{"key":"A","content":"甲"}';
    const image = '{"id":"i","name":"n","mime":"m","hash":"h"}';
    function check(columns: Record<string, string | null>, segments: string[]): void {
      insertQuestion('typed', columns);
      const before = questionRow('typed');
      const expected = rustHash(segments);
      expect(repo().updateContentHash(db, 'typed')).toBe(expected);
      expect(questionRow('typed')).toEqual({ ...before, content_hash: expected, updated_at: expect.stringMatching(SQLITE_NOW) });
      expect(logs).toEqual([]); // .ok()/unwrap_or_default: no diagnostic at any level
    }

    it.each([
      ['map reordered fields', '[{"content":"甲","key":"A"}]', `[${option}]`],
      ['struct seq', '[["A","甲"]]', `[${option}]`],
      ['mixed map and seq', `[["A","甲"],${option}]`, `[${option},${option}]`],
      ['empty strings', '[["",""]]', '[{"key":"","content":""}]'],
      ['empty Vec is Some, not None', '[]', '[]'],
      ['SQL NULL', null, null],
      ['JSON null', 'null', null],
      ['root map is not Vec', option, null],
      ['duplicate key', '[{"key":"B","key":"A","content":"甲"}]', null],
      ['duplicate escaped content', '[{"key":"A","content":"乙","con\\u0074ent":"甲"}]', null],
      ['missing key', '[{"content":"甲"}]', null],
      ['missing content', '[{"key":"A"}]', null],
      ['null required string', '[{"key":null,"content":"甲"}]', null],
      ['numeric required string', '[{"key":"A","content":1}]', null],
      ['seq missing required field', '[["A"]]', null],
      ['seq extra field', '[["A","甲",null]]', null],
      ['seq trailing comma', '[["A","甲",]]', null],
      ['one bad element discards whole Vec', `[${option},{"key":"B"}]`, null],
      ['known string lone surrogate', '[{"key":"A","content":"\\ud800"}]', null],
      ['malformed JSON', '[{broken', null],
      ['valid Vec followed by input', `[${option}] false`, null],
    ] as const)('update_content_hash_with_conn options: %s', (_name, stored, serde) => {
      check({ options_json: stored }, ['stem', ...(serde === null ? [] : [serde]), 'essay', '[]']);
    });

    it.each([
      ['map default role', `[${image}]`, `[${image}]`],
      ['map null role', '[{"role":null,"hash":"h","mime":"m","name":"n","id":"i"}]', `[${image}]`],
      ['map string role', '[{"role":"stem","hash":"h","mime":"m","name":"n","id":"i"}]', '[{"id":"i","name":"n","mime":"m","hash":"h","role":"stem"}]'],
      ['seq default role', '[["i","n","m","h"]]', `[${image}]`],
      ['seq null role', '[["i","n","m","h",null]]', `[${image}]`],
      ['seq empty string role stays Some', '[["i","n","m","h",""]]', '[{"id":"i","name":"n","mime":"m","hash":"h","role":""}]'],
      ['mixed map and seq', `[${image},["i","n","m","h"]]`, `[${image},${image}]`],
      ['empty Vec', '[]', null],
      ['SQL NULL', null, null],
      ['JSON null', 'null', null],
      ['root map is not Vec', image, null],
      ['duplicate role after null', '[{"id":"i","name":"n","mime":"m","hash":"h","role":null,"role":"stem"}]', null],
      ['duplicate role null twice', '[{"id":"i","name":"n","mime":"m","hash":"h","role":null,"role":null}]', null],
      ['invalid role type', '[{"id":"i","name":"n","mime":"m","hash":"h","role":false}]', null],
      ['seq missing required hash', '[["i","n","m"]]', null],
      ['seq extra field', '[["i","n","m","h",null,0]]', null],
      ['seq invalid role type', '[["i","n","m","h",[]]]', null],
      ['seq trailing comma before default', '[["i","n","m","h",]]', null],
      ['seq trailing comma after role', '[["i","n","m","h",null,]]', null],
      ['one bad element discards whole Vec', `[${image},null]`, null],
      ['known string lone surrogate', '[{"id":"i","name":"n","mime":"m","hash":"\\udc00"}]', null],
      ['malformed JSON', '[{broken', null],
      ['trailing input', `[${image}] {}`, null],
    ] as const)('update_content_hash_with_conn images: %s', (_name, stored, serde) => {
      check({ images_json: stored }, ['stem', 'essay', '[]', ...(serde === null ? [] : [serde])]);
    });

    it.each([
      ['id', 'i', '{"name":"n","mime":"m","hash":"h"}'],
      ['name', 'n', '{"id":"i","mime":"m","hash":"h"}'],
      ['mime', 'm', '{"id":"i","name":"n","hash":"h"}'],
      ['hash', 'h', '{"id":"i","name":"n","mime":"m"}'],
    ])('update_content_hash_with_conn images required/duplicate field %s rejects the entire Vec', (field, value, missing) => {
      for (const [i, raw] of [
        missing,
        image.replace(`"${field}":"${value}"`, `"${field}":null`),
        image.replace('{', `{"${field}":"duplicate",`),
      ].entries()) {
        insertQuestion(`bad-${i}`, { images_json: `[${image},${raw}]` });
        expect(repo().updateContentHash(db, `bad-${i}`)).toBe(rustHash(['stem', 'essay', '[]']));
        expect(questionRow(`bad-${i}`).content_hash).toBe(rustHash(['stem', 'essay', '[]']));
      }
      expect(logs).toEqual([]);
    });

    it.each([
      ['valid strings preserve order/duplicates/escapes', ' ["数学","","数学","\\u00e9\\n","\\ud83d\\ude00"] ', '["数学","","数学","é\\n","😀"]'],
      ['SQL NULL', null, '[]'],
      ['JSON null', 'null', '[]'],
      ['root map', '{}', '[]'],
      ['root string', '"tag"', '[]'],
      ['whole Vec fails on number', '["valid",1]', '[]'],
      ['whole Vec fails on null', '["valid",null]', '[]'],
      ['whole Vec fails on nested array', '["valid",[]]', '[]'],
      ['lone surrogate rejected', '["valid","\\ud800"]', '[]'],
      ['malformed JSON', '["valid",]', '[]'],
      ['trailing input', '["valid"] true', '[]'],
    ] as const)('update_content_hash_with_conn tags Vec<String>: %s', (_name, stored, serde) => {
      check({ tags: stored }, ['stem', 'essay', serde]);
    });

    it.each([
      ['duplicate unknown keys/nested known names', '"extra":{"key":1,"key":2},"extra":null', true],
      ['IgnoredAny accepts unpaired surrogate and huge number', '"extra":["\\ud800",{"\\udc00":1e400}]', true],
      ['IgnoredAny has no typed recursion limit', `"extra":${'['.repeat(140)}0${']'.repeat(140)}`, true],
      ['IgnoredAny rejects invalid escape', '"extra":"\\uZZZZ"', false],
      ['IgnoredAny rejects bad number', '"extra":1e+', false],
      ['IgnoredAny rejects broken nested list', '"extra":[1,]', false],
    ] as const)('update_content_hash_with_conn unknown fields: %s', (_name, extra, accepted) => {
      check({ options_json: `[{${extra},"key":"A","content":"甲"}]`, images_json: `[{${extra},"id":"i","name":"n","mime":"m","hash":"h"}]` },
        ['stem', ...(accepted ? [`[${option}]`] : []), 'essay', '[]', ...(accepted ? [`[${image}]`] : [])]);
    });

    it('typed failures stay silent before structured_data WARN, and UPDATE failure follows that WARN', () => {
      insertQuestion('typed', { options_json: '[{"key":"A","key":"B","content":"c"}]', tags: '[null]', images_json: '[["i"]]', structured_data: '{broken' });
      const before = questionRow('typed');
      rejectTrigger('content_hash');
      expect(errorOf(() => repo().updateContentHash(db, 'typed'))).toMatchObject({ code: 'VFS_STORAGE', message: 'Database error: content_hash rejected' });
      expect(logs.map(m => [m.type, m.args.map(String).join(' ')])).toEqual([
        ['warn', '[QuestionSyncService] Failed to parse structured_data: key must be a string at line 1 column 2'],
      ]);
      expect(questionRow('typed')).toEqual(before);
    });

    it('non-serde reader exceptions propagate without updating the hash or logging a JSON fallback', () => {
      insertQuestion('typed', { options_json: `[${option}]` });
      const before = questionRow('typed');
      const fault = new RangeError('reader runtime failure');
      const spy = vi.spyOn(JsonReader.prototype, 'readString').mockImplementationOnce(() => { throw fault; });
      try { expect(errorOf(() => repo().updateContentHash(db, 'typed'))).toBe(fault); }
      finally { spy.mockRestore(); }
      expect(questionRow('typed')).toEqual(before);
      expect(logs).toEqual([]);
    });
  });

  describe('WP-178 structured_data keeps serde_json Value (arbitrary_precision + preserve_order) in the hash', () => {
    let logs: Message[];
    beforeEach(() => {
      logs = [];
      host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    });
    const warns = () => logs.filter(m => m.type === 'warn').map(m => m.args.map(String).join(' '));
    const hashWith = (structured: string) => rustHash(['stem', 'essay', '[]', structured]);

    it.each([
      ['adjacent 2^53 integers', '[9007199254740992,9007199254740993]', '[9007199254740992,9007199254740993]'],
      ['u64::MAX and beyond-u64 integer stay literal', '[18446744073709551615,18446744073709551616,-9223372036854775809]', '[18446744073709551615,18446744073709551616,-9223372036854775809]'],
      ['1.0 / 1.50 / -0.0 keep float spelling, -0 becomes 0', '[1.0,1.50,-0.0,-0]', '[1.0,1.50,-0.0,0]'],
      ['exponents lowercased with explicit sign, beyond f64 kept', '[1e5,1E5,2.5E-3,1e+2,1e400]', '[1e+5,1e+5,2.5e-3,1e+2,1e+400]'],
      ['nested numbers inside objects/arrays', '{"a":{"b":[0.1,{"c":12345678901234567890}]}}', '{"a":{"b":[0.1,{"c":12345678901234567890}]}}'],
      ['integer-like keys keep insertion order, duplicate key last-wins at first slot', '{"b":1,"10":2,"2":3,"b":4}', '{"b":4,"10":2,"2":3}'],
      ['whitespace removed, string escapes re-serialized', ' { "s" : "\\u00e9\\n\\"\\/" , "t" : [ ] } ', '{"s":"é\\n\\"/","t":[]}'],
    ])('update_content_hash_with_conn serializes %s like serde_json::to_string', (_name, stored, serde) => {
      insertQuestion('q1', { structured_data: stored });
      expect(repo().updateContentHash(db, 'q1')).toBe(hashWith(serde));
      expect(questionRow('q1').content_hash).toBe(hashWith(serde));
      expect(warns()).toEqual([]);
    });

    it('adjacent 2^53 integers produce different hashes', () => {
      insertQuestion('a', { structured_data: '{"n":9007199254740992}' });
      insertQuestion('b', { structured_data: '{"n":9007199254740993}' });
      expect(repo().updateContentHash(db, 'a')).not.toBe(repo().updateContentHash(db, 'b'));
    });

    it('SQL NULL and JSON null both map to None and are left out of the hash', () => {
      insertQuestion('sql', { structured_data: null });
      insertQuestion('json', { structured_data: ' null ' });
      expect(repo().updateContentHash(db, 'sql')).toBe(rustHash(['stem', 'essay', '[]']));
      expect(repo().updateContentHash(db, 'json')).toBe(rustHash(['stem', 'essay', '[]']));
      expect(warns()).toEqual([]);
    });

    it.each([
      ['{broken', 'key must be a string at line 1 column 2'],
      ['[1,]', 'trailing comma at line 1 column 4'],
      ['{"a":1} x', 'trailing characters at line 1 column 9'],
      ['"\\ud800"', 'unexpected end of hex escape at line 1 column 8'],
      ['"\\udc00"', 'lone leading surrogate in hex escape at line 1 column 7'],
      [`${'['.repeat(129)}${']'.repeat(129)}`, 'recursion limit exceeded at line 1 column 128'],
    ])('invalid structured_data %j warns the serde_json Display and hashes without it', (stored, display) => {
      insertQuestion('q1', { structured_data: stored });
      expect(repo().updateContentHash(db, 'q1')).toBe(rustHash(['stem', 'essay', '[]']));
      expect(warns()).toEqual([`[QuestionSyncService] Failed to parse structured_data: ${display}`]);
    });

    it('warn follows the Rust read order: before a later column NotFound, never after an earlier one', () => {
      insertQuestion('late', { structured_data: '{broken', attempt_count: 'abc' });
      insertQuestion('early', { structured_data: '{broken', is_favorite: 'x' });
      const late = questionRow('late');
      for (const id of ['late', 'early']) {
        expect(errorOf(() => repo().updateContentHash(db, id))).toMatchObject({ code: 'VFS_NOT_FOUND', message: `question not found: ${id}` });
      }
      expect(warns()).toEqual(['[QuestionSyncService] Failed to parse structured_data: key must be a string at line 1 column 2']);
      expect(questionRow('late')).toEqual(late);
    });
  });

  it('a later failure in the caller sync transaction undoes the AI cache, sync mark and hash', () => {
    insertQuestion('q1');
    const before = questionRow('q1');
    expect(() => db.transaction(tx => {
      repo().updateAiAnalysis(tx, 'q1', 'analysed', NOW);
      repo().markAsModified(tx, 'q1');
      repo().updateContentHash(tx, 'q1');
      throw new Error('mastery write failed');
    })).toThrow('mastery write failed');
    expect(questionRow('q1')).toEqual(before);
  });
});
