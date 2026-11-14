/**
 * commands.rs:248-285 `modify_temp_session` (no Rust test exists): production-entry
 * contract tests through `ctx.appCommandState`, against the real migrated mistakes
 * schema (`temp_sessions`, V20260130__init.sql:67-74).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import integration from '../index.ts';
import type { StreamContext } from '../api.ts';

let dir: string;
let storage: StorageServiceImpl;
let db: DatabaseHandle;
let host: TestHost;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'l22-temp-session-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  db = storage.database('mistakes');
  host = await createTestHost({ plugins: [integration], provide: { storage } });
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM temp_sessions');
  host.ctx.appCommandState.withTempSessions((sessions) => sessions.clear());
});

/** commands.rs:5955-5976 make_ctx. */
function makeCtx(tempId: string, createdAt: string): StreamContext {
  return {
    temp_id: tempId, question_images: [], analysis_images: [], user_question: '', ocr_text: '',
    ocr_note: null, tags: [], mistake_type: '', chat_category: '', chat_metadata: null,
    chat_history: [], initial_doc_attachments: null, pinned_images: null, created_at: createdAt,
    exam_sheet: null, stream_state: 'in_progress', bridge_context: null, last_error: null,
  };
}

function insertRaw(tempId: string, sessionData: string, createdAt = '2026-09-24T00:00:00+00:00'): void {
  db.run(
    `INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error)
     VALUES (?1, ?2, 'in_progress', ?3, ?3, NULL)`,
    [tempId, sessionData, createdAt],
  );
}

function row(tempId: string): Record<string, unknown> | undefined {
  return db.get('SELECT * FROM temp_sessions WHERE temp_id = ?1', [tempId]);
}

async function appErrorOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CommandError);
  return (error as CommandError).value;
}

const modify = (tempId: string, mutate: (s: StreamContext) => void) =>
  host.ctx.appCommandState.modifyTempSession(tempId, mutate);

describe('commands.rs::modify_temp_session', () => {
  it('cache hit: mutates the cached session and persists it (commands.rs:257-266, 280-282)', async () => {
    host.ctx.appCommandState.withTempSessions((s) => { s.set('m1', makeCtx('m1', '2026-09-24T00:00:00.5Z')); });
    const updated = await modify('m1', (s) => { s.pinned_images = ['aGk=']; });
    expect(updated.pinned_images).toEqual(['aGk=']);
    expect(host.ctx.appCommandState.withTempSessions((s) => s.get('m1')?.pinned_images)).toEqual(['aGk=']);
    const persisted = row('m1')!;
    expect(persisted.session_data).toBe(
      '{"temp_id":"m1","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],'
      + '"mistake_type":"","chat_category":"","chat_history":[],"pinned_images":["aGk="],'
      + '"created_at":"2026-09-24T00:00:00.500Z","stream_state":"in_progress"}',
    );
    // upsert_temp_session: created_at column = to_rfc3339() (+00:00), last_error NULL.
    expect(persisted.created_at).toBe('2026-09-24T00:00:00.500+00:00');
    expect(persisted.stream_state).toBe('in_progress');
    expect(persisted.last_error).toBeNull();
    // Returned value is a clone, not the cached instance.
    updated.pinned_images = ['changed'];
    expect(host.ctx.appCommandState.withTempSessions((s) => s.get('m1')?.pinned_images)).toEqual(['aGk=']);
  });

  it('cache miss: loads the DB record, mutates, caches and persists (commands.rs:268-279)', async () => {
    // Legacy record: `mistake_id` alias, unknown field, explicit nulls, non-UTC offset.
    insertRaw('legacy', JSON.stringify({
      mistake_id: 'legacy', question_images: ['q'], analysis_images: [], user_question: 'u', ocr_text: 'o',
      ocr_note: null, tags: ['t'], mistake_type: 'm', chat_category: 'c', extra_field: { a: 1 },
      chat_history: [{ role: 'user', content: 'hi', timestamp: '2026-09-24T08:00:00+08:00', thinking_content: null,
        overrides: { b: 2, a: 1 } }],
      created_at: '2026-09-24T08:00:00.123456+08:00', stream_state: 'completed', last_error: 'e',
    }), '2026-09-24T00:00:00.123456+00:00');
    const before = row('legacy')!;
    await modify('legacy', (s) => { s.pinned_images = ['p1', 'p2']; });
    expect(host.ctx.appCommandState.withTempSessions((s) => s.get('legacy')?.pinned_images)).toEqual(['p1', 'p2']);
    const after = row('legacy')!;
    expect(after.session_data).toBe(
      '{"temp_id":"legacy","question_images":["q"],"analysis_images":[],"user_question":"u","ocr_text":"o",'
      + '"tags":["t"],"mistake_type":"m","chat_category":"c",'
      + '"chat_history":[{"role":"user","content":"hi","timestamp":"2026-09-24T00:00:00Z","overrides":{"b":2,"a":1}}],'
      + '"pinned_images":["p1","p2"],"created_at":"2026-09-24T00:00:00.123456Z","stream_state":"completed","last_error":"e"}',
    );
    // ON CONFLICT keeps created_at; updates stream_state / updated_at / last_error.
    expect(after.created_at).toBe(before.created_at);
    expect(after.stream_state).toBe('completed');
    expect(after.last_error).toBe('e');
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  it('Value fields keep serde arbitrary_precision numbers and preserve_order duplicate-key semantics', async () => {
    // exam_sheet is an exact serde_json::Value: legal numbers beyond f64, raw integer
    // spellings, and duplicate keys must survive re-serialization (`objectLastWins`,
    // first key position). Rust reads/writes these through serde_json with
    // arbitrary_precision + preserve_order (commands.rs:248-285, mod.rs:4208-4209).
    insertRaw('value', '{"temp_id":"value","question_images":[],"analysis_images":[],"user_question":"",'
      + '"ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],'
      + '"exam_sheet":{"2":1e999,"10":2,"2":3,'
      + '"nested":[1e999,1e-999,-0.0,18446744073709551616]},"created_at":"2026-09-24T00:00:00Z",'
      + '"stream_state":"in_progress"}');
    await modify('value', (s) => { s.pinned_images = ['v']; });
    expect(String(row('value')!.session_data)).toBe(
      '{"temp_id":"value","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"",'
      + '"tags":[],"mistake_type":"","chat_category":"","chat_history":[],"pinned_images":["v"],'
      + '"created_at":"2026-09-24T00:00:00Z","exam_sheet":{"2":3,"10":2,'
      + '"nested":[1e+999,1e-999,-0.0,18446744073709551616]},"stream_state":"in_progress"}',
    );
  });

  it('unpin (pinned_images = None) drops the field from session_data (skip_serializing_if)', async () => {
    host.ctx.appCommandState.withTempSessions((s) => {
      s.set('u1', { ...makeCtx('u1', '2026-09-24T00:00:00Z'), pinned_images: ['x'] });
    });
    await modify('u1', (s) => { s.pinned_images = null; });
    expect(String(row('u1')!.session_data)).not.toContain('pinned_images');
  });

  it('missing record → NotFound "临时会话不存在" (commands.rs:273)', async () => {
    expect(await appErrorOf(modify('nope', () => undefined)))
      .toEqual({ error_type: 'NotFound', message: '临时会话不存在', details: null });
    expect(row('nope')).toBeUndefined();
  });

  it('undecodable record → Database "读取临时会话失败: …" with anyhow outer context (commands.rs:272)', async () => {
    insertRaw('bad', '{"temp_id":"bad"}');
    let called = false;
    expect(await appErrorOf(modify('bad', () => { called = true; })))
      .toEqual({ error_type: 'Database', message: '读取临时会话失败: Failed to deserialize stream context', details: null });
    expect(called).toBe(false);
    expect(host.ctx.appCommandState.withTempSessions((s) => s.has('bad'))).toBe(false);
  });

  it('duplicate temp_id / mistake_id alias is a serde error', async () => {
    const base = JSON.stringify(makeCtx('dup', '2026-09-24T00:00:00Z')).slice(1);
    insertRaw('dup', `{"mistake_id":"dup",${base}`);
    expect(await appErrorOf(modify('dup', () => undefined)))
      .toEqual({ error_type: 'Database', message: '读取临时会话失败: Failed to deserialize stream context', details: null });
  });

  it('persist failure → Database "持久化临时会话失败: …"; the cached mutation stays (commands.rs:166-171)', async () => {
    host.ctx.appCommandState.withTempSessions((s) => { s.set('p1', makeCtx('p1', '2026-09-24T00:00:00Z')); });
    db.exec('ALTER TABLE temp_sessions RENAME TO temp_sessions_hidden');
    try {
      expect(await appErrorOf(modify('p1', (s) => { s.pinned_images = ['z']; })))
        .toEqual({ error_type: 'Database', message: '持久化临时会话失败: no such table: temp_sessions', details: null });
      expect(host.ctx.appCommandState.withTempSessions((s) => s.get('p1')?.pinned_images)).toEqual(['z']);
    } finally {
      db.exec('ALTER TABLE temp_sessions_hidden RENAME TO temp_sessions');
    }
  });

  it('DB load respects the memory cap and still persists an evicted session (commands.rs:274-282)', async () => {
    host.ctx.appCommandState.withTempSessions((s) => {
      for (let i = 0; i < 8; i += 1) s.set(`n${i}`, makeCtx(`n${i}`, `2026-09-24T01:00:0${i}Z`));
    });
    insertRaw('old', JSON.stringify(makeCtx('old', '2026-09-24T00:00:00Z')));
    const updated = await modify('old', (s) => { s.pinned_images = ['k']; });
    expect(updated.pinned_images).toEqual(['k']);
    expect(host.ctx.appCommandState.withTempSessions((s) => [s.size, s.has('old')])).toEqual([8, false]);
    expect(String(row('old')!.session_data)).toContain('"pinned_images":["k"]');
  });
});
