/** Batch 3 targeted probes (registered L18 commands/events: success + error DTOs).
 * Actual media plugin applied in createTestHost; only external ports (settings/log,
 * VFS DB/repo) are supplied. No handler is recreated. NOT the 1,673-site scan.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestHost } from '../../../host/kernel/testing.ts';
import { createStorageService } from '../../../host/platform/storage/service.ts';
import media from '../../../host/plugins/media/index.ts';
import { MediaTranscriptRepo } from '../../../host/plugins/vfs-repos/repository/media-transcripts.ts';
import { TextbookRepo } from '../../../host/plugins/vfs-repos/repository/textbooks.ts';
import type { SqlParams } from '../../../host/platform/storage/api.ts';

type Storage = ReturnType<typeof createStorageService>;
type Conn = ReturnType<Storage['database']>;

const settings = () => {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
};
const log = { logger: () => ({ error() {}, warn() {}, info() {}, debug() {}, trace() {} }) };

async function fixture(migrate: Parameters<ReturnType<Storage['coordinator']>['migrateSingle']>[0][], extra: (storage: Storage) => Record<string, unknown> = () => ({})) {
  const root = fs.mkdtempSync('/tmp/opencode/x2-batch3-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    for (const id of migrate) {
      const report = storage.coordinator().migrateSingle(id);
      assert(report.success, JSON.stringify(report));
    }
    const host = await createTestHost({ app: { dataDir: root, platform: 'linux' }, plugins: [media],
      provide: { storage, settings: settings(), log, paths: { appDataDir: root },
        notes: { repository: {} }, vfsRepo: { mediaTranscripts: new MediaTranscriptRepo(), textbooks: new TextbookRepo() },
        ...extra(storage) } });
    return { host, storage, async dispose() { await host.dispose(); storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (e) { storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); throw e; }
}

/** Fill NOT NULL columns without defaults from the real migrated schema; `values` wins. */
function insert(conn: Conn, table: string, values: Record<string, unknown>) {
  const cols = conn.all<{ name: string; notnull: number; dflt_value: unknown; pk: number; type: string }>(`PRAGMA table_info(${table})`);
  assert(cols.length > 0, `real migration must create ${table}`);
  const row: Record<string, unknown> = {};
  for (const c of cols) if (c.notnull && c.dflt_value === null && !(c.pk && /INT/i.test(c.type))) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : `x2_${c.name}`;
  Object.assign(row, values);
  const keys = Object.keys(row);
  conn.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]) as SqlParams);
}

const vfsDb = (storage: Storage) => ({ vfsDatabase: { getConnSafe: () => storage.database('vfs') } });
const rejectionOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e; } };

test('X2-R23 media_checkpoints success DTO equals Rust MediaCheckpoint (camelCase, isCorrect null when unattempted)', async () => {
  const f = await fixture(['vfs'], vfsDb);
  try {
    const conn = f.storage.database('vfs');
    insert(conn, 'exam_sheets', { id: 'exam_x2', deleted_at: null });
    insert(conn, 'questions', { id: 'q_x2', exam_id: 'exam_x2', content: '题干', question_type: 'single_choice',
      options_json: null, answer: 'A', explanation: '见 [媒体@file_x2:01:05]', attempt_count: 0, is_correct: null, deleted_at: null });
    const result = await f.host.invoke('media_checkpoints', { resourceId: ' file_x2 ' });
    // ledger.rs:193-233: seconds parsed by media_source.rs:53-68 (mm:ss), is_correct only when attempted.
    assert.deepEqual(result, [{ questionId: 'q_x2', examId: 'exam_x2', seconds: 65, content: '题干', questionType: 'single_choice',
      optionsJson: null, answer: 'A', explanation: '见 [媒体@file_x2:01:05]', attemptCount: 0, isCorrect: null }]);
    assert.deepEqual(await f.host.invoke('media_checkpoints', { resourceId: '  ' }), []);
    console.log(`X2-R23: ${JSON.stringify(result)}`);
  } finally { await f.dispose(); }
});

test('X2-R24 media_checkpoints SQL failure: plain e.to_string() string like Rust (fixed on main 00d2606e6)', async () => {
  const f = await fixture([], vfsDb); // real VFS file, schema not migrated -> "no such table"
  try {
    const rejection = await rejectionOf(f.host.invoke('media_checkpoints', { resourceId: 'file_x2' }));
    // dstu-media ledger.rs:255-257 maps every rusqlite error to a plain string.
    assert.equal(rejection, 'no such table: questions', `observed: ${String(rejection)}`);
    console.log(`X2-R24: ${String(rejection)}`);
  } finally { await f.dispose(); }
});

test('X2-R25 media_study_ledger success DTO equals Rust zero ledger; SQL failure is a plain string like Rust', async () => {
  const ok = await fixture(['vfs', 'mistakes'], vfsDb);
  try {
    assert.deepEqual(await ok.host.invoke('media_study_ledger', { resourceIds: [] }), []);
    const result = await ok.host.invoke('media_study_ledger', { resourceIds: ['file_x2', ' file_x2 '], includeCardIds: true });
    // ledger.rs:28-47 + assemble :426-452 for an id with no cards/questions.
    assert.deepEqual(result, [{ resourceId: 'file_x2', cardCount: 0, cardsDue: 0, cardsNew: 0, cardIds: [], questionCount: 0,
      questionsAttempted: 0, attemptTotal: 0, correctTotal: 0, questionsWrong: 0, examIds: [] }]);
    console.log(`X2-R25 ok: ${JSON.stringify(result)}`);
  } finally { await ok.dispose(); }
  const bad = await fixture([], vfsDb);
  try {
    const rejection = await rejectionOf(bad.host.invoke('media_study_ledger', { resourceIds: ['file_x2'] }));
    // ledger.rs:466-468: Rust returns e.to_string().
    assert.equal(rejection, 'no such table: document_tasks', `observed: ${String(rejection)}`);
    console.log(`X2-R25 err: ${String(rejection)}`);
  } finally { await bad.dispose(); }
});

test('X2-R26 textbooks_relink missing textbook -> Rust AppError::not_found text', async () => {
  const f = await fixture(['vfs'], vfsDb);
  try {
    const rejection = await rejectionOf(f.host.invoke('textbooks_relink', { id: 'tb_missing', newPath: '/tmp/opencode/none.pdf' }));
    // cmd/textbooks.rs:712-714
    assert.deepEqual(rejection, { error_type: 'NotFound', message: '教材不存在: tb_missing', details: null });
  } finally { await f.dispose(); }
});

test('X2-R27 bilistream 5xx emits media_bilibili_playback_error with Rust payload keys', async () => {
  const f = await fixture([]);
  try {
    const reply = await f.host.protocol('bilistream', 'bilistream://localhost/file_x2?qn=80&e=3&a=1');
    assert(reply.status >= 500, `status ${reply.status}`);
    const events = f.host.eventsNamed('media_bilibili_playback_error') as Record<string, unknown>[];
    assert.equal(events.length, 1);
    const event = events[0]!;
    // bilibili_stream.rs:835 json!({fileId, qn, epoch, attempt, message})
    assert.deepEqual(Object.keys(event).sort(), ['attempt', 'epoch', 'fileId', 'message', 'qn']);
    assert.deepEqual({ ...event, message: undefined }, { fileId: 'file_x2', qn: 80, epoch: 3, attempt: 1, message: undefined });
    assert.equal(typeof event.message, 'string');
    console.log(`X2-R27: status=${reply.status} event=${JSON.stringify(event)}`);
  } finally { await f.dispose(); }
});
