import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-json-export-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  const paths = createPaths({ dataDir: dir, platform: 'linux', env: {
    HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
  } });
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, anki, review, chatanki],
    provide: {
      // The production sink uses paths.os.temp; isolate artifacts from other lanes.
      paths: { ...paths, os: { ...paths.os, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {}, // export does not invoke the LLM provider
    },
  });
}, 60_000);

afterAll(async () => {
  if (host !== undefined) await host.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

it('test_chatanki_export_library_json_writes_full_cards_and_fails_closed through real public providers', async () => {
  // Rust :15558-15642. Explicit library selection permits these foreign-session cards.
  const timestamp = '2026-07-13T00:00:00Z';
  for (const suffix of ['foreign', 'other']) {
    host.ctx.anki.documents.insertDocumentTask({
      id: `task-${suffix}`, document_id: `doc-${suffix}`, original_document_name: 'export.md',
      segment_index: 0, content_segment: 'segment', status: 'Completed',
      created_at: timestamp, updated_at: timestamp,
      error_message: null, anki_generation_options_json: '{}',
    });
    host.ctx.anki.documents.setDocumentSessionSource(`doc-${suffix}`, `session-${suffix}`);
  }
  const makeCard = (id: string, task: string, front: string, back: string): AnkiCard => ({
    id, task_id: task, front, back, text: null, tags: [], images: [],
    is_error_card: false, error_content: null, created_at: timestamp, updated_at: timestamp,
    extra_fields: {}, template_id: 'design-swiss',
  });
  const first = makeCard('card-lib-b', 'task-other', 'front-b', 'back-b');
  first.extra_fields.hint = 'keep-me';
  const second = makeCard('card-lib-a', 'task-foreign', 'front-a', 'back-a');
  const deleted = makeCard('card-lib-deleted', 'task-foreign', 'gone', 'gone');
  expect(host.ctx.anki.cards.insertCard(first)).toBe(true); // Rust :15568
  expect(host.ctx.anki.cards.insertCard(second)).toBe(true); // :15569
  expect(host.ctx.anki.cards.insertCard(deleted)).toBe(true); // :15570
  // Exact fixture setup from Rust :15573-15576, not a copied production writer.
  storage.database('mistakes').run('UPDATE anki_cards SET deleted_at = 1 WHERE id = ?1', [deleted.id]);
  const context: ToolExecutionContext = {
    sessionId: 'session-caller', messageId: 'message-export', blockId: 'block-export',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
  };
  const ok = await host.ctx.chatankiTools.execute({
    id: 'call-export-lib', name: 'chatanki_export', arguments: {
      libraryCardIds: [second.id, first.id], format: 'json',
    },
  }, context);
  expect(ok.success, ok.error).toBe(true); // :15594
  const output = ok.output as Record<string, unknown>;
  expect(output.status).toBe('ok'); // :15595
  expect(output.format).toBe('json'); // :15596
  expect(output.cardsCount).toBe(2); // :15597
  expect(output.libraryCardIds).toEqual([second.id, first.id]); // :15598-15601
  expect(Object.hasOwn(output, 'documentId')).toBe(false); // :15602
  expect(Object.hasOwn(output, 'cards')).toBe(false); // :15603
  expect(output.path).toBeTypeOf('string');
  const exportPath = output.path as string;
  const content = fs.readFileSync(exportPath, 'utf8');
  const exported = JSON.parse(content) as AnkiCard[];
  expect(exported.map((card) => card.id)).toEqual([second.id, first.id]); // :15608-15614
  expect(exported[0]!.front).toBe('front-a'); // :15615
  expect(exported[1]!.extra_fields.hint).toBe('keep-me'); // :15616-15619
  expect(exported[1]!.template_id).toBe('design-swiss'); // :15620
  // Stronger than the old provider-seam test: compare actual complete owner rows.
  expect(exported).toEqual(host.ctx.anki.cards.getLibraryCardsByIds([second.id, first.id]));
  const exportDir = path.dirname(exportPath);
  const filesBeforeFailure = fs.readdirSync(exportDir).sort();
  const missing = await host.ctx.chatankiTools.execute({
    id: 'call-export-missing', name: 'chatanki_export', arguments: {
      libraryCardIds: [second.id, deleted.id], format: 'json',
    },
  }, context);
  expect(missing.success).toBe(false); // :15637
  expect(missing.error).toContain('library_cards_unavailable'); // :15638-15642
  expect(fs.readdirSync(exportDir).sort()).toEqual(filesBeforeFailure);
  expect(fs.readFileSync(exportPath, 'utf8')).toBe(content);
});

it('test_chatanki_export_document_keeps_atomic_ownership through real public providers', async () => {
  // Rust chatanki_executor.rs:15646-15700: the document selector must not inherit
  // the broader explicit-library selection policy tested above.
  const timestamp = '2026-07-13T00:00:00Z';
  host.ctx.anki.documents.insertDocumentTask({
    id: 'task-owned-export', document_id: 'doc-owned', original_document_name: 'owned.md',
    segment_index: 0, content_segment: 'segment', status: 'Completed',
    created_at: timestamp, updated_at: timestamp,
    error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource('doc-owned', 'session-owner');
  const card: AnkiCard = {
    id: 'card-owned-export', task_id: 'task-owned-export', front: 'owned-front', back: 'owned-back',
    text: null, tags: [], images: [], is_error_card: false, error_content: null,
    created_at: timestamp, updated_at: timestamp, extra_fields: {}, template_id: 'design-swiss',
  };
  expect(host.ctx.anki.cards.insertCard(card)).toBe(true); // Rust :15650
  const context: ToolExecutionContext = {
    sessionId: 'session-other', messageId: 'message-owned-export', blockId: 'block-owned-export',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
  };
  const call = {
    id: 'call-export-foreign', name: 'chatanki_export',
    arguments: { documentId: 'doc-owned', format: 'json' },
  };
  const foreign = await host.ctx.chatankiTools.execute(call, context);
  expect(foreign.success).toBe(false); // :15669
  expect(foreign.error).toContain('statusNotFound'); // :15670-15674
  const owned = await host.ctx.chatankiTools.execute({ ...call, id: 'call-export-owned' }, {
    ...context, sessionId: 'session-owner',
  });
  expect(owned.success, owned.error).toBe(true); // :15691
  const output = owned.output as Record<string, unknown>;
  expect(output.documentId).toBe('doc-owned'); // :15692
  expect(Object.hasOwn(output, 'hiddenOverLimitCount')).toBe(true); // :15693
  expect(output.path).toBeTypeOf('string');
  const exported = JSON.parse(fs.readFileSync(output.path as string, 'utf8')) as AnkiCard[];
  expect(exported).toHaveLength(1); // :15698
  expect(exported[0]!.id).toBe(card.id); // :15699
  expect(exported[0]!.front).toBe('owned-front'); // :15700
});
