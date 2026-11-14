/**
 * V01-01：官方 desktop profile 下经 chat-pipeline 的真实工具运行时执行数据治理工具。执行上下文的
 * `services` 是 chat-pipeline 自己的 ctx，按属性读取未注入的 backup / sync 会抛
 * `cannot get property "backup" without inject`；单测传根 ctx 时看不到（data_governance_executor.rs:71-360）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
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
  root = await mkdtemp(join(tmpdir(), 'W30-governance-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
}, 120_000);
afterEach(() => { vi.restoreAllMocks(); });
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
    memoryEnabled: false, ragEnabled: false, webSearchEnabled: false, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: unreachable, admittedDispatcher: { dispatchWithAdmission: unreachable } as unknown as Init['admittedDispatcher'] };
}
let sequence = 0;
function run(name: string, args: JsonValue): Promise<ToolResultInfo> {
  const callId = `call-${name}-${sequence += 1}`;
  return host.ctx.chatPipeline.bindToolRuntime(authority, todo).execute({ id: callId, name, arguments: args }, init(callId));
}
const errorCode = (result: ToolResultInfo) => (JSON.parse(result.error!) as { code: string }).code;

it('V01-01 backup_status, sync_status and sync_run run under the chat-pipeline services context', async () => {
  const status = await run('builtin-backup_status', {});
  expect(status.success, status.error ?? '').toBe(true);
  expect(status.output).toMatchObject({ success: true, scope: 'local_backup_catalog', total: 0 });

  const sync = await run('builtin-sync_status', {});
  expect(sync.success, sync.error ?? '').toBe(true);
  expect(sync.output).toMatchObject({ success: true, cloud_configured: false });
  expect((sync.output as { warnings: string[] }).warnings)
    .toContain('Cloud sync is not configured in the backend SSOT; configure it in Settings.');

  const upload = await run('builtin-sync_run', { direction: 'upload' });
  expect(upload.success).toBe(false);
  expect(errorCode(upload)).toBe('CLOUD_CONFIG_NOT_CONFIGURED');
}, 60_000);

it('V01-01 sync_run maps only CloudConfigSsotError to cloud-config codes; other failures keep their message', async () => {
  const backup = host.ctx.get('backup')!;
  vi.spyOn(backup, 'syncCommandPorts').mockReturnValue({
    loadHydratedCloudConfig: async () => { throw new TypeError('sync ports exploded'); },
  } as unknown as ReturnType<typeof backup.syncCommandPorts>);
  const upload = await run('builtin-sync_run', { direction: 'upload' });
  expect(upload.success).toBe(false);
  expect(upload.error).toBe('sync ports exploded');
}, 60_000);
