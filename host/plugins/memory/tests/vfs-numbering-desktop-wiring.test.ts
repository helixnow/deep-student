/** memory research executors against the official desktop profile: citation numbering comes from the
 * vfs owner service (`ctx.get('vfs').buildNumberedSources`) and the chat-pipeline reply ledger, not from a
 * module import of vfs (Rust `build_numbered_sources`, builtin_retrieval_executor.rs).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { insertInsightCardFixture } from '../repository/insight-cards.ts';
import type { AcademicSearchExecutorDeps } from '../src/academic-search-executor.ts';

vi.mock('@/utils/platform', () => ({ getPlatform: () => 'macos' }));

let root = '';
let host: TestHost | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-memory-vfs-wiring-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  // Match connection.boot: the official desktop composition includes Workshop, whose
  // builtin-only installer must be scoped by the kernel before profile loading.
  // Do not weaken Workshop's required capability or publish an installer globally.
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(root, 'app/plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function executor(name: string): ToolExecutor {
  const found = host!.ctx.agentTools.toolExecutors().find(entry => entry.name() === name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found as ToolExecutor;
}

function context(sessionId: string, messageId: string): ExecutionContext {
  const noop = () => undefined;
  return {
    session_id: sessionId, message_id: messageId, block_id: `blk_${messageId}`, variant_id: null,
    cancellation_token: null, isCancelled: () => false,
    emitter: { emitStart: noop, emitEnd: noop, emitError: noop },
    emitToolCallStart: noop, emitToolCallEnd: noop, emitToolCallError: noop, saveToolBlock: noop,
  } as unknown as ExecutionContext;
}

describe('memory citation numbering through the desktop profile', () => {
  it('insight_recall numbers sources with the vfs service function on the chat-pipeline reply ledger', async () => {
    const vfs = host!.ctx.get('vfs')!;
    const numberSources = vi.spyOn(vfs, 'buildNumberedSources');
    const db = host!.ctx.storage.database('vfs');
    for (const [id, title] of [['ic_wire_a', '换元识别'], ['ic_wire_b', '分部积分识别']] as const) {
      insertInsightCardFixture(db, { id, title, situation: `${title}：被积函数次数太高`, stuckPoint: '展开不现实',
        turningPoint: `${id} 转折`, rule: `${id} 规则`, validityConditions: `${id} 条件`, createdAt: '2026-07-10T00:00:00+00:00' });
    }
    const recall = executor('InsightRecallExecutor');
    const call = (args: Record<string, unknown>, id: string) =>
      recall.execute({ id, name: 'builtin-insight_recall', arguments: args }, context('sess_wire', 'msg_wire'));

    const first = await call({ insight_id: 'ic_wire_a' }, 'call_a');
    expect(first.success).toBe(true);
    expect((first.output as { sources: Record<string, unknown>[] }).sources[0])
      .toMatchObject({ citationTag: '[灵感-1]', title: '[灵感] 换元识别', source_type: 'insight' });
    const second = await call({ insight_id: 'ic_wire_b' }, 'call_b');
    expect((second.output as { sources: Record<string, unknown>[] }).sources[0]).toMatchObject({ citationTag: '[灵感-2]' });
    expect(numberSources).toHaveBeenCalledTimes(2);
    expect(host!.ctx.chatPipeline.citationLedgerForReply('sess_wire', 'msg_wire', null)
      .assign('insight', 'title:[灵感] 换元识别').type_index).toBe(1);
    numberSources.mockRestore();
  });

  it('academic search resolves the same vfs service function', () => {
    const academic = executor('AcademicSearchExecutor') as unknown as { deps: AcademicSearchExecutorDeps };
    expect(academic.deps.numberSources()).toBe(host!.ctx.get('vfs')!.buildNumberedSources);
  });
});
