/**
 * V01-03: executor.rs:333 clones the main_db handle the pipeline already holds, and the maintenance
 * check runs only when a tool takes a connection (get_conn_safe). A backup snapshot barrier must not
 * fail tools that never touch mistakes.db.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { BackendEventsSink, ChatV2Emitter, type ChatExecutionContext, type ToolExecutor } from '../../chat/api.ts';
import { bindToolExecutorRegistry, type ToolExecutorBinding } from '../src/tool-executor-binding.ts';
import type { ToolContextInit } from '../src/tool-round.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
const policy = { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false };
const SESSION = 'sess_binding_maintenance';
let base: string;
let host: Host;
let binding: ToolExecutorBinding;
let sequence = 0;
const handles: { main: unknown; anki: unknown }[] = [];

const probe: ToolExecutor = {
  name: () => 'MaintenanceProbeExecutor',
  canHandle: name => name === 'probe_plain' || name === 'probe_main_db',
  async execute(call, context) {
    const ctx = context as ChatExecutionContext;
    const result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, durationMs: 0 };
    if (call.name === 'probe_plain') return { ...result, output: { ok: true }, success: true };
    try {
      const db = ctx.main_db;
      handles.push({ main: db, anki: ctx.anki_db });
      return { ...result, output: db?.get<{ one: number }>('SELECT 1 AS one') ?? null, success: true };
    } catch (error) {
      return { ...result, output: null, success: false, error: (error as Error).message };
    }
  },
};

function init(): ToolContextInit {
  const id = ++sequence;
  return {
    sessionId: SESSION, messageId: `msg_${id}`, blockId: `blk_${id}`, toolCallId: `call_${id}`,
    emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), SESSION, false),
    canvasNoteId: null, ragTopK: null, ragEnableReranking: null, variantId: null, skillStateVersion: null, roundId: null,
    executionAllowedTools: null, skillPackageRoots: null, questionAuthoringConfig: null, shellGuardApproved: false,
    memoryEnabled: true, ragEnabled: true, webSearchEnabled: true, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: async () => { throw new Error('no child dispatch in this test'); },
    admittedDispatcher: null as unknown as ToolContextInit['admittedDispatcher'],
  };
}
const run = (name: string) => {
  const context = init();
  return binding.execute({ id: context.toolCallId, name, arguments: {} }, context);
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'w02-binding-maint-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'xdg-data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'xdg-config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'xdg-cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  expect((await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH })).degraded).toEqual([]);
  const stamp = '2026-11-07T00:00:00Z';
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
  binding = bindToolExecutorRegistry(host.ctx, host.ctx.chatSession.createExecutorRegistry([probe], policy), host.ctx.mcp.registry);
}, 240_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  try { await host?.dispose(); } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

it('V01-03: while mistakes.db is in maintenance a tool that never reads main_db still runs', async () => {
  const lease = await host.ctx.storage.enterMaintenance(['mistakes']);
  try {
    const result = await run('probe_plain');
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ success: true, output: { ok: true } });
  } finally { lease.release(); }
});

it('V01-03: a tool that reads main_db during maintenance gets the maintenance error from its own call, and works after release', async () => {
  const lease = await host.ctx.storage.enterMaintenance(['mistakes']);
  try {
    expect(await run('probe_main_db')).toMatchObject({ success: false, error: 'Database mistakes is in maintenance mode' });
    expect(handles).toHaveLength(1);
    const held = handles[0]!.main as DatabaseHandle;
    expect([held.name, held.path]).toEqual(['mistakes', host.ctx.storage.pathOf('mistakes')]);
    expect(handles[0]!.anki === held).toBe(true);
  } finally { lease.release(); }
  handles.length = 0;
  expect(await run('probe_main_db')).toMatchObject({ success: true, output: { one: 1 } });
  expect(handles).toHaveLength(1);
  expect(handles[0]!.main).toBe(host.ctx.storage.database('mistakes'));
  expect(handles[0]!.anki).toBe(handles[0]!.main);
});
