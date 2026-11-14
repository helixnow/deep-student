import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import { installWorkspaceCardReadScope, type WorkspaceCardReadScopeGuard } from '../../agent-workspace/api.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

const DOC = 'doc-scope-logs';
const WORKER = 'worker-scope-logs';
const COORDINATOR = 'coordinator-scope-logs';
const OTHER = 'other-coordinator-scope-logs';
const WORKSPACE = 'workspace-scope-logs';
const WARN = `[ChatAnkiToolExecutor] verify_document_ownership failed for document ${DOC}: no such column: source_session_id`;
const HIT = `[ChatAnkiToolExecutor] read-only coordinator scope hit: worker=${WORKER}, workspace=${WORKSPACE}, coordinator=${COORDINATOR}, document=${DOC}`;
const TOOLS = ['chatanki_get_cards', 'chatanki_status'] as const;
type Tool = typeof TOOLS[number];

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let db: DatabaseHandle;
let originalOne: DatabaseHandle['one'];
let disposeExporter: (() => void) | undefined;
const guards: WorkspaceCardReadScopeGuard[] = [];
const trace: unknown[][] = [];
const lifecycle: string[] = [];
const saved: unknown[] = [];
let brokenColumn = false;
let recoverAfterWarn = false;

function restoreColumn(): void {
  if (!brokenColumn) return;
  db.exec('ALTER TABLE document_tasks RENAME COLUMN scope_broken_source_session_id TO source_session_id');
  brokenColumn = false;
}

function breakColumn(): void {
  db.exec('ALTER TABLE document_tasks RENAME COLUMN source_session_id TO scope_broken_source_session_id');
  brokenColumn = true;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-scope-logs-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      vfs: {}, llm: {}, // unused; L04 chatSession and all card/review providers are real
    },
  });
  const timestamp = '2026-07-13T00:00:00Z';
  host.ctx.anki.documents.insertDocumentTask({
    id: 'task-scope-logs', document_id: DOC, original_document_name: 'scope.md',
    segment_index: 0, content_segment: 'segment', status: 'Completed',
    created_at: timestamp, updated_at: timestamp, error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(DOC, COORDINATOR);
  expect(host.ctx.anki.cards.insertCard({
    id: 'card-scope-logs', task_id: 'task-scope-logs', front: 'before', back: 'answer',
    text: null, tags: [], images: [], is_error_card: false, error_content: null,
    created_at: timestamp, updated_at: timestamp, extra_fields: {}, template_id: null,
  })).toBe(true);
  db = storage.database('mistakes');
  originalOne = db.one;
  // Call-through observation only: record actual ownership SQL parameters, then
  // execute the original method unchanged. No fake rows/errors or repo methods.
  db.one = ((...args: unknown[]) => {
    const query = args[0];
    const sql = typeof query === 'string' ? query
      : query !== null && typeof query === 'object' && 'sql' in query ? String(query.sql) : '';
    if (sql.includes('AS owned_task_count')) {
      const params = args[1];
      trace.push(['query', ...(Array.isArray(params) ? params : [params])]);
    }
    return Reflect.apply(originalOne, db, args);
  }) as DatabaseHandle['one'];
  disposeExporter = host.ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    const text = String(message.args[0]);
    if (text.startsWith('[ChatAnkiToolExecutor] verify_document_ownership failed')
      || text.startsWith('[ChatAnkiToolExecutor] read-only coordinator scope hit:')) {
      trace.push([message.type, text]);
      if (message.type === 'warn' && recoverAfterWarn) {
        // A real schema recovery between attempts, not a mocked successful query.
        recoverAfterWarn = false;
        restoreColumn();
      }
    }
  } });
}, 60_000);

beforeEach(() => {
  trace.length = 0;
  lifecycle.length = 0;
  saved.length = 0;
  recoverAfterWarn = false;
});

afterEach(() => {
  recoverAfterWarn = false;
  restoreColumn();
  for (const guard of guards.splice(0)) guard.release();
});

afterAll(async () => {
  disposeExporter?.();
  if (db !== undefined && originalOne !== undefined) db.one = originalOne;
  if (host !== undefined) await host.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

const query = (session: string) => ['query', DOC, session];
// L16 rechecks ownership while loading the get_cards snapshot after preflight;
// status reads all rows only after its preflight. Keep that existing difference.
const snapshotQueries = (tool: Tool) => tool === 'chatanki_get_cards' ? [query(COORDINATOR)] : [];

async function run(tool: Tool, session: string): Promise<ToolResultInfo> {
  const executor = host.ctx.agentTools.toolExecutors().find((candidate) => candidate.name() === 'ChatAnkiToolExecutor');
  expect(executor?.canHandle(tool)).toBe(true);
  if (executor?.execute === undefined) throw new Error('real registered executor missing');
  // L04 vocabulary forces the production adaptContext path: warn/info are the
  // Host's real logger methods, not callbacks supplied by the test.
  const result = await executor.execute({ id: `call-${tool}`, name: tool, arguments: { documentId: DOC } }, {
    session_id: session, message_id: 'message-scope-logs', block_id: 'block-scope-logs',
    variant_id: null,
    emitToolCallStart: () => lifecycle.push('start'),
    emitToolCallEnd: () => lifecycle.push('end'),
    emitToolCallError: () => lifecycle.push('error'),
    saveToolBlock: (value: unknown) => saved.push(value),
  }) as ToolResultInfo;
  expect(saved).toHaveLength(1);
  expect(lifecycle).toEqual(['start', result.success ? 'end' : 'error']);
  return result;
}

it.each(TOOLS)('%s caller-owned short-circuits without a scope-hit log', async (tool) => {
  guards.push(installWorkspaceCardReadScope(COORDINATOR, WORKSPACE, OTHER));
  const result = await run(tool, COORDINATOR);
  expect(result.success, result.error).toBe(true);
  expect(trace).toEqual([query(COORDINATOR), ...snapshotQueries(tool)]);
});

it.each(TOOLS)('%s scope hit logs exact ordered fields after both ownership attempts', async (tool) => {
  guards.push(installWorkspaceCardReadScope(WORKER, WORKSPACE, COORDINATOR));
  const result = await run(tool, WORKER);
  expect(result.success, result.error).toBe(true);
  expect(trace).toEqual([query(WORKER), query(COORDINATOR), ['info', HIT], ...snapshotQueries(tool)]);
});

it.each(TOOLS)('%s denied scope has two false ownership checks but no warn/info', async (tool) => {
  guards.push(installWorkspaceCardReadScope(WORKER, WORKSPACE, OTHER));
  const result = await run(tool, WORKER);
  expect(result.success).toBe(false);
  expect(result.error).toContain('statusNotFound');
  expect(trace).toEqual([query(WORKER), query(OTHER)]);
});

it.each(TOOLS)('%s without a scope rejects after one false check and no warn/info', async (tool) => {
  const result = await run(tool, WORKER);
  expect(result.success).toBe(false);
  expect(result.error).toContain('statusNotFound');
  expect(trace).toEqual([query(WORKER)]);
});

it.each(TOOLS)('%s database failure without a scope warns once without another query', async (tool) => {
  breakColumn();
  const result = await run(tool, WORKER);
  expect(result.success).toBe(false);
  expect(result.error).toContain('statusNotFound');
  expect(trace).toEqual([query(WORKER), ['warn', WARN]]);
});

it.each(TOOLS)('%s real database failure warns once per attempt then fails closed', async (tool) => {
  guards.push(installWorkspaceCardReadScope(WORKER, WORKSPACE, COORDINATOR));
  breakColumn();
  const result = await run(tool, WORKER);
  expect(result.success).toBe(false);
  expect(result.error).toContain('statusNotFound');
  expect(trace).toEqual([query(WORKER), ['warn', WARN], query(COORDINATOR), ['warn', WARN]]);
});

it.each(TOOLS)('%s first database failure warns and still tries the recovered coordinator branch', async (tool) => {
  guards.push(installWorkspaceCardReadScope(WORKER, WORKSPACE, COORDINATOR));
  breakColumn();
  recoverAfterWarn = true;
  const result = await run(tool, WORKER);
  expect(result.success, result.error).toBe(true);
  expect(trace).toEqual([
    query(WORKER), ['warn', WARN], query(COORDINATOR), ['info', HIT], ...snapshotQueries(tool),
  ]);
});
