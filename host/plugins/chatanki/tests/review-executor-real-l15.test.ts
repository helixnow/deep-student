/**
 * D3 production chain: `chatankiTools.execute` → hydrate `ctx.get('review')`
 * (published L15 `review@1`, which now delegates `setSuspendedForSession` /
 * `undoLastReviewForSession`) → real FSRS CAS on the migrated mistakes DB.
 * Card ownership and setup also use the published L16 repositories; the tool
 * context injects neither cards nor reviewStates. Only test observations are supplied.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { toWireJson } from '../../../kernel/json.ts';
import native from '../../../platform/native/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

const SESSION = 'session-d3-real-cas';
// Rust `local_version` is a full i64. 2^63-1024 is exactly representable as a
// JS number, so the tool argument is exact; SQL state is bound/read as an
// exact integer (BigInt in, TEXT out) so a ±1 slip cannot hide behind rounding.
const LARGE = 2 ** 63 - 1024;
const LARGE_SQL = 9223372036854774784n;
const LARGE_TEXT = '9223372036854774784';
const LARGE_PLUS_ONE_TEXT = '9223372036854774785';

function makeCard(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

type Storage = ReturnType<typeof createStorageService>;
type Run = (name: string, args: Record<string, unknown>) => Promise<ToolResultInfo>;

// One migrated storage + host per file (migrations dominate the runtime);
// every test seeds its own card so CAS state never leaks between tests.
let dir = '';
let storage: Storage;
let host: TestHost;
let seq = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-l15-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir },
    plugins: [native, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: os.tmpdir() } },
      settings: { get: () => null, save: () => undefined, getSetting: () => null, saveSetting: () => undefined },
      llm: {},
      storage,
    },
  });
}, 60_000); // full storage migration; the 10s default hook timeout trips under CI load

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function seedCard(): { card: string; run: Run; version: () => string | undefined } {
  seq += 1;
  const card = `card-d3-real-cas-${seq}`;
  const taskId = `task-d3-${seq}`;
  const documentId = `doc-d3-${seq}`;
  const db = storage.database('mistakes');
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'test.md',
    segment_index: 0, content_segment: 'segment', status: 'Completed',
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, SESSION);
  expect(host.ctx.anki.cards.insertCardsForDocument(documentId, SESSION, [makeCard(card, taskId)]))
    .toHaveLength(1);
  expect(host.ctx.review.enqueueCardsForSession([card], SESSION, null).enqueued).toBe(1);
  db.run('UPDATE fsrs_card_states SET local_version = ?1 WHERE anki_card_id = ?2', [LARGE_SQL, card]);
  const context: ToolExecutionContext = {
    sessionId: SESSION, messageId: 'message-d3', blockId: 'block-d3',
    runId: 'run-d3', emitEvent: () => undefined,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
  };
  return {
    card,
    run: (name, args) => host.ctx.chatankiTools.execute({ id: `call-${name}`, name, arguments: args }, context),
    version: () => db.pluck<string>(
      'SELECT CAST(local_version AS TEXT) FROM fsrs_card_states WHERE anki_card_id = ?1', [card]),
  };
}

it('real L15 CAS accepts the large i64 review version unchanged', async () => {
  const { card: CARD, run, version } = seedCard();
  expect(version()).toBe(LARGE_TEXT);
  const result = await run('chatanki_set_suspended', { cardId: CARD, expectedReviewVersion: LARGE, suspended: true });
  expect(result.success, result.error).toBe(true);
  const output = result.output as Record<string, unknown>;
  expect(output.status).toBe('ok');
  expect(output.mutationApplied).toBe(true);
  expect((output.reviewState as Record<string, unknown>).reviewVersion).toBe(LARGE_SQL + 1n);
  expect(version()).toBe(LARGE_PLUS_ONE_TEXT);
  // Only the outer wire conversion may round. The internal snapshot stays exact.
  const wire = JSON.parse(JSON.stringify(toWireJson(result))) as {
    output: { reviewState: { reviewVersion: number } };
  };
  expect(wire.output.reviewState.reviewVersion).toBe(Number(LARGE_SQL + 1n));
  expect((output.reviewState as Record<string, unknown>).reviewVersion).toBe(LARGE_SQL + 1n);
});

it('real L15 CAS reports a conflict when the same large token is stale', async () => {
  const { card: CARD, run, version } = seedCard();
  const first = await run('chatanki_set_suspended', { cardId: CARD, expectedReviewVersion: LARGE, suspended: true });
  expect(first.success, first.error).toBe(true);
  expect(version()).toBe(LARGE_PLUS_ONE_TEXT);
  const stale = await run('chatanki_set_suspended', { cardId: CARD, expectedReviewVersion: LARGE, suspended: false });
  expect(stale.success).toBe(true);
  const output = stale.output as Record<string, unknown>;
  expect(output.status).toBe('conflict');
  expect(output.error).toBe('review_state_conflict');
  expect(output.mutationApplied).toBe(false);
  expect((output.current as Record<string, unknown>).reviewVersion).toBe(LARGE_SQL + 1n);
  // Conflict must not write.
  expect(version()).toBe(LARGE_PLUS_ONE_TEXT);
});

it('real L15 undo CAS accepts the large i64 review version unchanged', async () => {
  const { card: CARD, run, version } = seedCard();
  storage.database('mistakes').run(
    'UPDATE fsrs_card_states SET local_version = 0 WHERE anki_card_id = ?1', [CARD]);
  const enqueued = host.ctx.review.getReviewStatesForSession([CARD], SESSION)[0]!;
  // Rate through the published fsrs_rate command so undo sees a genuine log.
  const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
    cardStateId: enqueued.cardStateId, rating: 3, durationMs: 500,
  });
  storage.database('mistakes').run(
    'UPDATE fsrs_card_states SET local_version = ?1 WHERE anki_card_id = ?2', [LARGE_SQL, CARD]);
  const result = await run('chatanki_undo_last_review', {
    cardId: CARD, expectedReviewVersion: LARGE, expectedLogId: rated.logId,
  });
  expect(result.success, result.error).toBe(true);
  const output = result.output as Record<string, unknown>;
  expect(output.status).toBe('ok');
  expect(output.mutationApplied).toBe(true);
  expect((output.reviewState as Record<string, unknown>).reviewVersion).toBe(LARGE_SQL + 1n);
  expect(version()).toBe(LARGE_PLUS_ONE_TEXT);
});

it('a value outside i64 is still rejected before the real CAS', async () => {
  const { card: CARD, run, version } = seedCard();
  const result = await run('chatanki_set_suspended', { cardId: CARD, expectedReviewVersion: 2 ** 63, suspended: true });
  expect(result.success).toBe(false);
  // arbitrary_precision: Number::deserialize_i64 parses the literal, so overflow is `invalid number`.
  expect(result.error).toBe('Invalid chatanki_set_suspended arguments: invalid number');
  expect(version()).toBe(LARGE_TEXT);
});
