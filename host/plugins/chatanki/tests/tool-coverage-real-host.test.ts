/**
 * Production roster coverage: every Rust chatanki/template/fsrs tool name is
 * claimed by the assembled L04 registry with Rust's executor name, sensitivity
 * and concurrency, and registry dispatch output survives L04's JSON boundary.
 *
 * Rust: chatanki_executor.rs:1732-1762 (is_chatanki_tool), :1946-1969
 * (sensitivity_level), :1994 (name); template_executor.rs:1668-1682;
 * fsrs_settings_executor.rs:192-210.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ChatExecutionContext, ChatV2EventEmitter, ToolExecutor, ToolExecutorRegistry } from '../../chat/api.ts';
import review from '../../review/index.ts';
import type { ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

const nativeJson = JSON as typeof JSON & { isRawJSON(value: unknown): boolean };

type Sensitivity = 'low' | 'medium' | 'high';
type Row = readonly [tool: string, executor: string, sensitivity: Sensitivity, concurrency: 'serial' | 'read_only'];

const CHATANKI = 'ChatAnkiToolExecutor';
const TEMPLATE = 'TemplateDesignerExecutor';
const FSRS = 'FsrsSettingsExecutor';

const RUST_ROSTER: readonly Row[] = [
  ['chatanki_run', CHATANKI, 'low', 'serial'],
  ['chatanki_import_apkg', CHATANKI, 'medium', 'serial'],
  ['chatanki_start', CHATANKI, 'low', 'serial'],
  ['chatanki_status', CHATANKI, 'low', 'serial'],
  ['chatanki_wait', CHATANKI, 'low', 'serial'],
  ['chatanki_get_cards', CHATANKI, 'low', 'serial'],
  ['chatanki_update_card', CHATANKI, 'low', 'serial'],
  ['chatanki_batch_update_cards', CHATANKI, 'medium', 'serial'],
  ['chatanki_delete_card', CHATANKI, 'low', 'serial'],
  ['chatanki_delete_cards', CHATANKI, 'medium', 'serial'],
  ['chatanki_add_cards', CHATANKI, 'low', 'serial'],
  ['chatanki_enqueue_review', CHATANKI, 'low', 'serial'],
  ['chatanki_review_stats', CHATANKI, 'low', 'serial'],
  ['chatanki_undo_last_review', CHATANKI, 'high', 'serial'],
  ['chatanki_set_suspended', CHATANKI, 'medium', 'serial'],
  ['chatanki_list_library_cards', CHATANKI, 'low', 'serial'],
  ['chatanki_update_library_card', CHATANKI, 'high', 'serial'],
  ['chatanki_enqueue_library_review', CHATANKI, 'medium', 'serial'],
  ['chatanki_set_library_suspended', CHATANKI, 'medium', 'serial'],
  ['chatanki_undo_library_last_review', CHATANKI, 'high', 'serial'],
  ['chatanki_delete_library_card', CHATANKI, 'high', 'serial'],
  ['chatanki_retemplate', CHATANKI, 'low', 'serial'],
  ['chatanki_transform', CHATANKI, 'medium', 'serial'],
  ['chatanki_control', CHATANKI, 'low', 'serial'],
  ['chatanki_export', CHATANKI, 'medium', 'serial'],
  ['chatanki_sync', CHATANKI, 'medium', 'serial'],
  ['chatanki_list_templates', CHATANKI, 'low', 'serial'],
  ['chatanki_analyze', CHATANKI, 'low', 'serial'],
  ['chatanki_check_anki_connect', CHATANKI, 'low', 'serial'],
  ['template_list', TEMPLATE, 'low', 'serial'],
  ['template_get', TEMPLATE, 'low', 'serial'],
  ['template_validate', TEMPLATE, 'low', 'serial'],
  ['template_preview', TEMPLATE, 'low', 'serial'],
  ['template_create', TEMPLATE, 'medium', 'serial'],
  ['template_fork', TEMPLATE, 'medium', 'serial'],
  ['template_update', TEMPLATE, 'medium', 'serial'],
  ['template_set_default', TEMPLATE, 'medium', 'serial'],
  ['template_delete', TEMPLATE, 'high', 'serial'],
  ['fsrs_get_scheduler_config', FSRS, 'low', 'read_only'],
  ['fsrs_update_scheduler_config', FSRS, 'medium', 'serial'],
];

const SESSION = 'session-coverage';
const CREATED = '2026-11-07T00:00:00Z';
let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let registry: ToolExecutorRegistry;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-coverage-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({ db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false }),
      llm: {}, vfs: {},
      // chatanki_run needs L02 raw prompt (route planner/VLM) besides the L16 generation control.
      llmRawPrompt: {
        callAnkiRoutedRawPrompt: async () => { throw new Error('not called'); },
        callModel2RawPrompt: async () => { throw new Error('not called'); },
      },
    },
  });
  registry = host.ctx.chatSession.createExecutorRegistry(
    host.ctx.agentTools.toolExecutors() as readonly ToolExecutor[],
    { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false },
  );
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

interface Recorded { ends: string[]; saved: string[]; errors: string[]; savedErrors: Array<string | null | undefined> }

function recorder(): Recorded {
  return { ends: [], saved: [], errors: [], savedErrors: [] };
}

function executionContext(blockId: string, recorded: Recorded): ChatExecutionContext {
  const noop = () => undefined;
  const emitter = {
    emitStart: noop, emitChunk: noop, emitEnd: noop, emitError: noop, emitStartWithMeta: noop,
    emitErrorWithMeta: (type: string, _block: string, error: string) => { recorded.errors.push(`${type}:${error}`); },
    emitEndWithMeta: (_type: string, _block: string, payload: unknown) => { recorded.ends.push(JSON.stringify(payload)); },
  } as unknown as ChatV2EventEmitter;
  const context = host.ctx.chatSession.createExecutionContext({
    sessionId: SESSION, messageId: 'message-coverage', blockId, emitter, services: host.ctx, toolRegistry: {} as never,
  });
  // saveToolBlockRaw JSON.stringify's toolOutput; record the same text.
  context.saveToolBlock = (result: ToolResultInfo) => {
    recorded.saved.push(JSON.stringify(result.output));
    recorded.savedErrors.push(result.error);
  };
  return context;
}

function seedEnqueuedCard(id: string): void {
  const taskId = `task-${id}`;
  const documentId = `doc-${id}`;
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'coverage.md', segment_index: 0,
    content_segment: 'material', status: 'Completed', created_at: CREATED, updated_at: CREATED,
    error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, SESSION);
  expect(host.ctx.anki.cards.insertCard({
    id, task_id: taskId, front: `front ${id}`, back: 'answer', text: null, tags: [], images: [],
    is_error_card: false, error_content: null, created_at: CREATED, updated_at: CREATED,
    extra_fields: {}, template_id: null,
  })).toBe(true);
  host.ctx.review.enqueueCards([id]);
}

it('claims every Rust roster tool, bare and builtin-prefixed, with Rust executor/sensitivity/concurrency', () => {
  expect(RUST_ROSTER).toHaveLength(40);
  const actual = RUST_ROSTER.map(([tool]) => {
    const prefixed = `builtin-${tool}`;
    const claimed = registry.hasSpecificExecutor(prefixed);
    expect(registry.hasSpecificExecutor(tool), tool).toBe(claimed);
    return claimed
      ? [tool, registry.getExecutor(prefixed)!.name(), registry.getSensitivity(prefixed), registry.getConcurrencyClass(prefixed)]
      : [tool, null, null, null];
  });
  expect(actual).toEqual(RUST_ROSTER.map((row) => [...row]));
  expect(registry.getSensitivityForCall('builtin-chatanki_transform', {
    documentId: 'doc', transform: { script: { language: 'javascript', code: 'return cards;' } },
  })).toBe('high');
  expect(registry.getSensitivityForCall('builtin-chatanki_transform', {
    documentId: 'doc', transform: { ops: [{ op: 'tag_add', tags: ['x'] }] },
  })).toBe('medium');
});

// serde_json::from_value texts for the first failing field in Rust struct order
// (chatanki_executor.rs:635-1680, chatanki_transform.rs:114). enqueue_review and
// list_templates decode `{}`, so they get a type error instead; under the app
// graph's arbitrary_precision a number shows as `number` and a bad usize literal
// is `invalid number`.
const ARGUMENT_ERRORS: ReadonlyArray<readonly [tool: string, args: Record<string, unknown>, serde: string]> = [
  ['chatanki_status', {}, 'missing field `documentId`'],
  // rename_all camelCase + alias "documentId": the snake key is unknown and ignored.
  ['chatanki_status', { document_id: 'doc-snake' }, 'missing field `documentId`'],
  ['chatanki_status', { documentId: 1 }, 'invalid type: number, expected a string'],
  ['chatanki_get_cards', {}, 'missing field `documentId`'],
  ['chatanki_update_card', {}, 'missing field `cardId`'],
  ['chatanki_delete_card', {}, 'missing field `cardId`'],
  ['chatanki_delete_cards', {}, 'missing field `cards`'],
  ['chatanki_add_cards', {}, 'missing field `documentId`'],
  ['chatanki_enqueue_review', { documentId: 1 }, 'invalid type: number, expected a string'],
  ['chatanki_undo_last_review', {}, 'missing field `cardId`'],
  ['chatanki_set_suspended', {}, 'missing field `cardId`'],
  ['chatanki_retemplate', {}, 'missing field `targetTemplateId`'],
  ['chatanki_transform', {}, 'missing field `documentId`'],
  ['chatanki_export', {}, 'missing field `format`'],
  ['chatanki_list_templates', { page: -1 }, 'invalid number'],
];

it.each(ARGUMENT_ERRORS)('%s rejects bad arguments as finish_chatanki_failure: Rust text, tool_call error, saved block', async (tool, args, serde) => {
  const error = `Invalid ${tool} arguments: ${serde}`;
  const recorded = recorder();
  const result = await registry.execute(
    { id: `call-args-${tool}`, name: `builtin-${tool}`, arguments: args },
    executionContext(`block-args-${tool}`, recorded),
  );
  expect([result.success, result.error, result.output ?? null]).toEqual([false, error, null]);
  expect(recorded.errors).toEqual([`tool_call:${error}`]);
  expect(recorded.ends).toEqual([]);
  expect(recorded.savedErrors).toEqual([error]);
});

it('chatanki_import_apkg serde errors go through finish_chatanki_app_failure with apkg_invalid_input', async () => {
  const message = 'Invalid chatanki_import_apkg arguments: invalid type: number, expected a string';
  const error = `[apkg_invalid_input] ${message}`;
  const recorded = recorder();
  const result = await registry.execute(
    { id: 'call-args-apkg', name: 'builtin-chatanki_import_apkg', arguments: { resourceId: 1 } },
    executionContext('block-args-apkg', recorded),
  );
  expect([result.success, result.error]).toEqual([false, error]);
  expect(result.output).toEqual({
    error: { error_type: 'Validation', message, details: { errorCode: 'apkg_invalid_input' } },
  });
  expect(recorded.errors).toEqual([`tool_call:${error}`]);
  expect(recorded.savedErrors).toEqual([error]);
  expect(recorded.saved).toEqual([JSON.stringify(result.output)]);
});

it('chatanki_import_apkg normalize() errors carry no "Invalid ... arguments" prefix (Rust :2009-2015)', async () => {
  const message = 'exactly one of resourceId or path is required';
  const result = await registry.execute(
    { id: 'call-args-apkg-none', name: 'builtin-chatanki_import_apkg', arguments: {} },
    executionContext('block-args-apkg-none', recorder()),
  );
  expect([result.success, result.error]).toEqual([false, `[apkg_invalid_input] ${message}`]);
  expect(result.output).toEqual({
    error: { error_type: 'Validation', message, details: { errorCode: 'apkg_invalid_input' } },
  });
});

it('registry dispatch carries L15 bigint review versions as exact JSON numbers (output, tool_call end, saved block)', async () => {
  seedEnqueuedCard('coverage-exact');
  const exact = 9007199254740993n;
  storage.database('mistakes').run('UPDATE fsrs_card_states SET local_version = ?1 WHERE anki_card_id = ?2', [exact, 'coverage-exact']);
  const recorded = recorder();
  const result = await registry.execute(
    { id: 'call-library-list', name: 'builtin-chatanki_list_library_cards', arguments: {} },
    executionContext('block-library-list', recorded),
  );
  expect(result.success).toBe(true);
  const card = (result.output as { cards: Array<Record<string, unknown>> }).cards.find((entry) => entry.id === 'coverage-exact')!;
  const reviewVersion = (card.reviewState as { reviewVersion: unknown }).reviewVersion;
  expect(nativeJson.isRawJSON(reviewVersion)).toBe(true);
  const text = `"reviewVersion":${exact}`;
  expect(JSON.stringify(result.output)).toContain(text);
  expect(recorded.saved).toHaveLength(1);
  expect(recorded.saved[0]).toContain(text);
  expect(recorded.ends).toHaveLength(1);
  expect(recorded.ends[0]).toContain(text);

  const mutation = await registry.execute(
    { id: 'call-set-suspended', name: 'builtin-chatanki_set_library_suspended',
      arguments: { cardId: 'coverage-exact', expectedReviewVersion: 0, suspended: true } },
    executionContext('block-set-suspended', recorder()),
  );
  expect(mutation.success).toBe(true);
  expect(JSON.stringify(mutation.output)).toContain(`"status":"conflict"`);
  expect(JSON.stringify(mutation.output)).toContain(text);
});

it('importer AppErrors reach finish_chatanki_app_failure instead of the join-error text', async () => {
  const missing = path.join(dir, 'missing.apkg');
  const recorded = recorder();
  const result = await registry.execute(
    { id: 'call-apkg', name: 'builtin-chatanki_import_apkg', arguments: { path: missing } },
    executionContext('block-apkg', recorded),
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe(`[apkg_not_found] APKG file was not found: ${missing}`);
  expect(result.output).toEqual({
    error: { error_type: 'NotFound', message: `APKG file was not found: ${missing}`, details: { errorCode: 'apkg_not_found' } },
  });
  expect(recorded.saved).toEqual([JSON.stringify(result.output)]);
});

it('resourceId imports check ownership against the real L04 session snapshots before any VFS read', async () => {
  const importDeck = () => registry.execute(
    { id: 'call-apkg-res', name: 'builtin-chatanki_import_apkg', arguments: { resourceId: 'file_deck' } },
    executionContext('block-apkg-res', recorder()),
  );
  const denied = await importDeck();
  expect(denied.error).toBe('[apkg_not_found] APKG resource is not available in the current chat session: '
    + 'Preferred resource not found in current session context: file_deck');

  const chatDb = storage.database('chat_v2');
  chatDb.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [SESSION, CREATED]);
  chatDb.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, meta_json)
    VALUES ('message-apkg-user', ?1, 'user', '[]', 1, ?2)`, [SESSION, JSON.stringify({
    contextSnapshot: { userRefs: [{ resourceId: 'file_deck', hash: 'hash-deck', typeId: 'file' }], retrievalRefs: [] },
  })]);
  // This host has no VFS plugin: past ownership, Rust's `vfs_db = None` branch answers.
  const owned = await importDeck();
  expect(owned.error).toBe('[apkg_database] VFS database not available');
  expect(owned.output).toEqual({
    error: { error_type: 'Database', message: 'VFS database not available', details: { errorCode: 'apkg_database' } },
  });
});
