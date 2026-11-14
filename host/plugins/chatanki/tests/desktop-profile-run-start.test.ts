/**
 * Smoke #28 (06-agent-tools.spec.ts:262): under the official desktop profile — the plugin tree the Electron
 * Host boots — `chatanki_run` and `chatanki_start` are claimed, so the tool loop offers them, and a call
 * dispatched through the same runtime the tool loop uses ends like Rust's `execute_run` / `execute_start`.
 *
 * Rust: chatanki_executor.rs:575-634 / :686-727 (args), :6760-6899 (argument-error terminal).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../../chat-pipeline/api.ts';

const unreachable = (): never => { throw new Error('authority/todo owners are outside this dispatch'); };
const authority: ToolRuntimeAuthorityOwner = { getSessionAuthorityState: unreachable, createPendingPlan: unreachable,
  setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable };
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

const SESSION = 'sess_desktop_run_start';
const MESSAGE = 'msg_desktop_run_start';

let root = '';
let host: TestHost;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chatanki-desktop-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  const db = host.ctx.storage.database('chat_v2');
  db.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', '2026-11-07T00:00:00+00:00', '2026-11-07T00:00:00+00:00')`, [SESSION]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', '[]', 1)`, [MESSAGE, SESSION]);
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type Emitted = [kind: string, type: string, block: string | null, payload: unknown];

function dispatchInit(blockId: string, emitted: Emitted[]) {
  const record = (kind: string) => (type: string, ...rest: unknown[]) => {
    emitted.push([kind, type, typeof rest[0] === 'string' ? rest[0] : null, rest[1] ?? null]);
  };
  const emitter = {
    tryWindow: () => null,
    emitStart: (type: string, _message: string, block: string | null, payload: unknown) => { emitted.push(['start', type, block, payload]); },
    emitStartWithMeta: (type: string, _message: string, block: string | null, payload: unknown) => { emitted.push(['start', type, block, payload]); },
    emitChunk: record('chunk'), emitEnd: record('end'), emitEndWithMeta: record('end'),
    emitError: record('error'), emitErrorWithMeta: record('error'),
  };
  return {
    sessionId: SESSION, messageId: MESSAGE, blockId, emitter: emitter as never, toolCallId: `call_${blockId}`,
    canvasNoteId: null, ragTopK: null, ragEnableReranking: null, variantId: null, skillStateVersion: null, roundId: null,
    executionAllowedTools: null, skillPackageRoots: null, questionAuthoringConfig: null, shellGuardApproved: false,
    memoryEnabled: true, ragEnabled: true, webSearchEnabled: true, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: unreachable, admittedDispatcher: unreachable as never,
  };
}

function savedBlock(blockId: string) {
  return host.ctx.storage.database('chat_v2')
    .get<{ status: string; tool_name: string | null; error: string | null }>(
      'SELECT status, tool_name, error FROM chat_v2_blocks WHERE id = ?1', [blockId]) ?? null;
}

it('the desktop profile claims chatanki_run and chatanki_start, so the tool loop offers them', () => {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  const names = ['chatanki_run', 'chatanki_start'].flatMap((tool) => [tool, `builtin-${tool}`]);
  expect(names.filter((name) => !runtime.advertisement!.advertises(name))).toEqual([]);
  expect(names.map((name) => runtime.concurrencyClass(name))).toEqual(names.map(() => 'serial'));
});

it.each(['chatanki_run', 'chatanki_start'])('%s with `{}` (the smoke hallucination probe) ends in Rust\'s argument-error terminal', async (tool) => {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  const blockId = `blk_${tool}_empty`;
  const emitted: Emitted[] = [];
  const result = await runtime.execute({ id: `call_${tool}`, name: `builtin-${tool}`, arguments: {} } as never, dispatchInit(blockId, emitted));
  const error = `Invalid ${tool} arguments: missing field \`goal\``;
  expect([result.success, result.error, result.output]).toEqual([false, error, null]);
  expect(emitted.filter(([kind]) => kind !== 'start')).toEqual([['error', 'tool_call', blockId, error]]);
  expect(savedBlock(blockId)).toEqual({ status: 'error', tool_name: `builtin-${tool}`, error });
});

/** Chunk payloads in the order `run_chatanki_pipeline_background` emits them (:7462–8892). */
function chunkStage(payload: string): string {
  const chunk = JSON.parse(payload) as { ankiConnect?: unknown; cards?: unknown; documentId?: string; progress?: { stage?: string; messageKey?: string } };
  if (chunk.cards !== undefined) return 'terminal';
  if (chunk.ankiConnect !== undefined) return `connect:${chunk.progress?.stage}`;
  if (chunk.progress?.messageKey === 'blocks.ankiCards.progress.messages.taskCreated') return 'taskCreated';
  return `${chunk.documentId === undefined ? 'stage' : 'poll'}:${chunk.progress?.stage}`;
}

it('a valid chatanki_start starts the real L16 pipeline; with no Anki model assigned it ends in generationFailed', async () => {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  // A fresh library has no templates; like Rust (:5750), chatanki_list_templates imports the builtins first.
  const listed = await runtime.execute({ id: 'call_list', name: 'builtin-chatanki_list_templates', arguments: {} } as never,
    dispatchInit('blk_list_templates', []));
  expect(listed.success).toBe(true);

  const blockId = 'blk_start_valid';
  const emitted: Emitted[] = [];
  const result = await runtime.execute({ id: 'call_start', name: 'builtin-chatanki_start',
    arguments: { goal: '光合作用', content: '光合作用分为光反应和暗反应两个阶段。', templateMode: 'all' } } as never, dispatchInit(blockId, emitted));
  expect(result.success).toBe(true);
  const output = result.output as { ankiBlockId: string; documentId: string };
  expect(output).toEqual({ status: 'started', ankiBlockId: expect.stringMatching(/^blk_/), documentId: expect.any(String),
    message: 'ChatAnki pipeline started (background)' });
  await (host.ctx.get('chatankiTools') as unknown as { backgroundSettled(): Promise<void> }).backgroundSettled();

  const anki = output.ankiBlockId;
  expect(emitted.slice(0, 3).map(([kind, type, block]) => [kind, type, block]))
    .toEqual([['start', 'tool_call', blockId], ['start', 'anki_cards', anki], ['end', 'tool_call', blockId]]);
  expect(emitted.at(-1)).toEqual(['error', 'anki_cards', anki, 'blocks.ankiCards.errors.generationFailed']);
  const stages = emitted.slice(3, -1).map(([kind, type, block, payload]) => {
    expect([kind, type, block]).toEqual(['chunk', 'anki_cards', anki]);
    return chunkStage(payload as string);
  });
  // The number of 900ms polls that still see the task running depends on timing; the order does not.
  const polls = stages.slice(3, -2);
  expect([...stages.slice(0, 3), ...stages.slice(-2)])
    .toEqual(['connect:routing', 'stage:generating', 'taskCreated', 'poll:completed', 'terminal']);
  expect(polls.filter((stage) => stage !== 'poll:generating')).toEqual([]);

  const tasks = (host.ctx.get('anki') as unknown as { documents: { getTasksForDocument(id: string): Array<{ status: string; error_message: string | null }> } })
    .documents.getTasksForDocument(output.documentId);
  expect(tasks.map((task) => [task.status, task.error_message]))
    .toEqual([['Failed', 'Anki制卡模型在模型分配中未配置 (anki_card_model_config_id is None)']]);
  expect(savedBlock(blockId)).toEqual({ status: 'success', tool_name: 'builtin-chatanki_start', error: null });
  // :7088 the preview block keeps `strip_tool_namespace(&call.name)`.
  expect(savedBlock(anki)).toEqual({ status: 'error', tool_name: 'chatanki_start', error: 'blocks.ankiCards.errors.generationFailed' });
}, 60_000);
