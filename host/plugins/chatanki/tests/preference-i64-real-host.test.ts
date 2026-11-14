import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { CHATANKI_PREFERENCE_MEMORY_SETTING_KEY as KEY, persistPreferenceObservation } from '../src/preference-memory.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let sequence = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-preference-i64-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      vfs: {}, llm: {}, // neither operation is part of these persistence paths
    },
  });
  const timestamp = '2026-07-13T00:00:00Z';
  host.ctx.anki.documents.insertDocumentTask({
    id: 'task-pref-i64', document_id: 'doc-pref-i64', original_document_name: 'pref.md',
    segment_index: 0, content_segment: 'segment', status: 'Completed',
    created_at: timestamp, updated_at: timestamp, error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource('doc-pref-i64', 'session-pref-i64');
}, 60_000);

beforeEach(() => { host.ctx.anki.settings.saveSetting(KEY, '{"entries":[]}'); });

afterAll(async () => {
  if (host !== undefined) await host.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

// Numeric tokens are literal strings so fixture construction cannot round them.
const rawStore = (first: string, last: string) =>
  '{"entries":[{"kind":"template_preference","statement":"existing preference","subject":null,'
  + '"confidence":0.5,"evidence_count":1,"last_evidence":"e",'
  + `"first_seen_ms":${first},"last_seen_ms":${last}}]}`;

function timestampTokens(raw: string): { first_seen_ms: string; last_seen_ms: string } {
  // Independent native JSON source oracle, not Number(value) or the codec under test.
  // A quoted integer would retain quotes in context.source and fail the expectations.
  const parsed = JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) =>
    key === 'first_seen_ms' || key === 'last_seen_ms' ? context?.source : value) as {
      entries: Array<{ first_seen_ms: string; last_seen_ms: string }>;
    };
  expect(parsed.entries).toHaveLength(1);
  return parsed.entries[0]!;
}

async function editCard(): Promise<string[]> {
  sequence += 1;
  const timestamp = '2026-07-13T00:00:00Z';
  const card: AnkiCard = {
    id: `card-pref-i64-${sequence}`, task_id: 'task-pref-i64', front: `original question ${sequence}`,
    back: 'answer', text: null, tags: [], images: [], is_error_card: false, error_content: null,
    created_at: timestamp, updated_at: timestamp, extra_fields: {}, template_id: null,
  };
  expect(host.ctx.anki.cards.insertCard(card)).toBe(true);
  const warnings: string[] = [];
  const context: ToolExecutionContext = {
    sessionId: 'session-pref-i64', messageId: 'message-pref-i64', blockId: 'block-pref-i64',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: (message) => warnings.push(message),
  };
  const result = await host.ctx.chatankiTools.execute({
    id: `call-pref-i64-${sequence}`, name: 'chatanki_update_card', arguments: {
      cardId: card.id, expectedVersion: card.updated_at, patch: { front: `edited question ${sequence}` },
    },
  }, context);
  expect(result.success, result.error).toBe(true);
  expect(host.ctx.anki.cards.getCardForSession(card.id, context.sessionId)?.card.front).toBe(`edited question ${sequence}`);
  return warnings;
}

it.each([
  ['9007199254740992', '9007199254740993'],
  ['9223372036854774784', '9223372036854774785'],
  ['-9223372036854775808', '9223372036854775807'],
])('preserves exact persisted i64 tokens %s / %s through a real card edit', async (first, last) => {
  host.ctx.anki.settings.saveSetting(KEY, rawStore(first, last));
  expect(await editCard()).toEqual([]);
  expect(timestampTokens(host.ctx.anki.settings.getSetting(KEY)!))
    .toMatchObject({ first_seen_ms: first, last_seen_ms: last });
});

it.each([9007199254740993n, -9223372036854775808n, 9223372036854775807n])(
  'writes an internal bigint nowMs %s as a numeric literal through real providers', (nowMs) => {
    const result = persistPreferenceObservation(host.ctx.anki.settings, host.ctx.anki.preferenceMemory, {
      extraRequirements: '请用中文回答', edits: [], deletions: [], generatedCount: 0, templateUsed: null,
    }, nowMs);
    expect(result.added).toHaveLength(1);
    expect(timestampTokens(host.ctx.anki.settings.getSetting(KEY)!))
      .toMatchObject({ first_seen_ms: nowMs.toString(), last_seen_ms: nowMs.toString() });
  },
);

it('keeps exact i64s in serde positional structs and a unit-enum map representation', async () => {
  host.ctx.anki.settings.saveSetting(KEY,
    '[[[{"template_preference":null},"existing preference",null,0.5,1,"e",9007199254740993,9223372036854775807]]]');
  expect(await editCard()).toEqual([]);
  const raw = host.ctx.anki.settings.getSetting(KEY)!;
  expect(timestampTokens(raw)).toMatchObject({
    first_seen_ms: '9007199254740993', last_seen_ms: '9223372036854775807',
  });
  expect(JSON.parse(raw).entries[0].kind).toBe('template_preference');
});

it.each([1_000, 2 ** 63 - 1024])('keeps legacy integer-number nowMs %s exact without a safe-only cap', (nowMs) => {
  persistPreferenceObservation(host.ctx.anki.settings, host.ctx.anki.preferenceMemory, {
    extraRequirements: '请用中文回答', edits: [], deletions: [], generatedCount: 0, templateUsed: null,
  }, nowMs);
  const raw = host.ctx.anki.settings.getSetting(KEY)!;
  expect(timestampTokens(raw)).toMatchObject({
    first_seen_ms: BigInt(nowMs).toString(), last_seen_ms: BigInt(nowMs).toString(),
  });
  if (nowMs === 1_000) expect(JSON.parse(raw).entries[0].first_seen_ms).toBe(1_000);
});

it.each(['9223372036854775808', '-9223372036854775809', '1.0', '"9007199254740993"'])(
  'rejects invalid i64 token %s without overwriting the stored value or failing the card edit', async (first) => {
    const raw = rawStore(first, '1');
    host.ctx.anki.settings.saveSetting(KEY, raw);
    const warnings = await editCard();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('parse local preference store:');
    expect(warnings[0]).toContain('expected i64');
    expect(host.ctx.anki.settings.getSetting(KEY)).toBe(raw);
  },
);

it('rejects a duplicate timestamp field as serde does, preserving the original store', async () => {
  const raw = rawStore('1', '2').replace('"first_seen_ms":1', '"first_seen_ms":1,"first_seen_ms":2');
  host.ctx.anki.settings.saveSetting(KEY, raw);
  const warnings = await editCard();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('duplicate field `first_seen_ms`');
  expect(host.ctx.anki.settings.getSetting(KEY)).toBe(raw);
});
