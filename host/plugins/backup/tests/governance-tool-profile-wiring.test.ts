/** data_governance_executor.rs:71-360 under the official desktop profile: the executor runs with the chat-pipeline
 * services context (which injects neither `backup` nor `sync`), exactly like a real chat tool call.
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
import { BackendEventsSink, ChatV2Emitter, type ToolResultInfo } from '../../chat/api.ts';
import type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../../chat-pipeline/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

const SESSION = 'sess-governance-profile';
const unreachable = (): never => { throw new Error('authority/todo owners are outside the governance tool path'); };
const authority: ToolRuntimeAuthorityOwner = { getSessionAuthorityState: unreachable, createPendingPlan: unreachable,
  setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable };
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

let root = '';
let host: TestHost;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-governance-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
}, 120_000);
afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type Runtime = ReturnType<TestHost['ctx']['chatPipeline']['bindToolRuntime']>;
type Init = Parameters<Runtime['execute']>[1];
function init(callId: string): Init {
  return { sessionId: SESSION, messageId: 'msg-governance-profile', blockId: `blk-${callId}`,
    emitter: new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), SESSION, false), toolCallId: callId,
    canvasNoteId: null, ragTopK: null, ragEnableReranking: null, variantId: null, skillStateVersion: null, roundId: null,
    executionAllowedTools: null, skillPackageRoots: null, questionAuthoringConfig: null, shellGuardApproved: false,
    memoryEnabled: true, ragEnabled: true, webSearchEnabled: true, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: unreachable, admittedDispatcher: { dispatchWithAdmission: unreachable } as unknown as Init['admittedDispatcher'] };
}
function run(name: string, args: JsonValue): Promise<ToolResultInfo> {
  return host.ctx.chatPipeline.bindToolRuntime(authority, todo).execute({ id: `call-${name}`, name, arguments: args }, init(`call-${name}`));
}

it('backup_status and sync_status run under the chat-pipeline services context', async () => {
  const status = await run('builtin-backup_status', {});
  expect(status.success, status.error ?? '').toBe(true);
  expect(status.output).toMatchObject({ success: true, scope: 'local_backup_catalog', total: 0, backups: [] });
  const sync = await run('builtin-sync_status', {});
  expect(sync.success, sync.error ?? '').toBe(true);
  expect(sync.output).toMatchObject({ success: true, observation_scope: 'local_change_logs_only', cloud_probed: false, cloud_configured: false });
});

it('sync_run without a cloud configuration fails closed as not configured, not as unreadable storage', async () => {
  const result = await run('builtin-sync_run', { direction: 'upload' });
  expect(result.success).toBe(false);
  expect(JSON.parse(result.error!)).toMatchObject({ code: 'CLOUD_CONFIG_NOT_CONFIGURED', retryable: false });
});

it('without the sync plugin sync_status reports a structured failure instead of a context error', async () => {
  await host.runtime.unload('dstu.sync');
  const result = await run('builtin-sync_status', {});
  expect(result.success).toBe(false);
  expect(JSON.parse(result.error!)).toMatchObject({ code: 'SYNC_SERVICE_UNAVAILABLE', message: 'The sync service is not initialized.', retryable: true });
  expect((await run('builtin-backup_status', {})).success).toBe(true);
});
