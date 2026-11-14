/** execution-runtime capabilities against the official desktop profile (real owner services, no stubs):
 * pipeline.rs session title (summary.rs:51), tool_loop.rs:1618 llm_usage_logs rows, prompt.rs:236 user profile,
 * prompt_builder.rs:1037 learner profile, prompt.rs:178 insight existence hints.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { composeExecution, MissingCapabilityLog } from '../src/execution-runtime.ts';
import type { ExecutionDependencies } from '../src/execute.ts';
import type { PipelineContext } from '../src/pipeline-context.ts';
import type { PipelinePostCommitEffects } from '../src/persistence-port.ts';

vi.mock('@/utils/platform', () => ({ getPlatform: () => 'macos' }));

const titleRequests: Record<string, unknown>[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  titleRequests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'cmpl-title', model: 'title-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"title":"线代复习计划","tags":["线性代数","复习"]}' },
      finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }));
});

let root = '';
let host: TestHost | undefined;
const warn = vi.fn();
let deps: ExecutionDependencies;

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  root = await mkdtemp(join(tmpdir(), 'dstu-exec-prod-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  await host.ctx.llm.saveApiConfigurations([{ id: 'cfg-title', name: 'title', apiKey: '', authMode: 'none',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'title-model',
    apiProtocol: 'openai_chat_completions', modelAdapter: 'general', enabled: true, isMultimodal: false,
    isReasoning: false, isEmbedding: false, isReranker: false }]);
  await host.ctx.llm.saveModelAssignments({ chat_title_model_config_id: 'cfg-title' });
  deps = composeExecution({ ctx: host.ctx, owner: {} as never, toolFace: {} as never,
    missing: new MissingCapabilityLog({ warn }), resolveCanonicalImages: async () => [],
    resolveSnapshot: (() => null) as never, compaction: null, memoryFlushRecovery: { scheduleRecovery() {} } as never });
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  server.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function session(id: string): string {
  host!.ctx.chatSession.createSession({ id, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  return id;
}
const execution = (sessionId: string, userContent: string) => ({ sessionId, userMessageId: `${sessionId}-user`,
  options: {}, userContent, finalContent: '', toolResults: [] }) as unknown as PipelineContext;
const notedMissing = (capability: string) => warn.mock.calls.some(([message]) => String(message).includes(capability));

describe('execution-runtime against the official desktop profile', () => {
  it('composes tool rounds and workspace injection from published owners', () => {
    expect(deps.toolRounds).not.toBeNull();
    expect(deps.workspace).not.toBeNull();
    expect(notedMissing('chatToolRuntime')).toBe(false);
  });

  it('session title/tags are generated through llmRawPrompt and persisted on chat_v2_sessions', async () => {
    const id = session('prod-title');
    expect(deps.sessionMetadata).not.toBeNull();
    const user = '请帮我制定一个两周的线性代数复习计划，重点是矩阵和特征值';
    const assistant = '好的，下面是一个两周的线性代数复习计划，第一周复习矩阵运算与行列式。';
    expect(await deps.sessionMetadata!.shouldGenerate(id, user, assistant)).toBe(true);
    const emitSummaryUpdated = vi.fn();
    await deps.sessionMetadata!.generate(id, user, assistant, { emitSummaryUpdated } as never);
    expect(titleRequests.at(-1)?.model).toBe('title-model');
    expect(host!.ctx.chatSession.getSession(id)?.title).toBe('线代复习计划');
    expect(emitSummaryUpdated).toHaveBeenCalledWith('线代复习计划', '');
    expect(notedMissing('callAgentChatTitleRawPrompt')).toBe(false);
  });

  it('round usage lands in llm_usage_logs as a chat_v2 row (tool_loop.rs:1618 record_llm_usage_cache_ext)', async () => {
    deps.recordUsage({ model: 'usage-model', promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2,
      cacheWriteTokens: null, sessionId: 'prod-usage', success: true, errorMessage: null,
      protocol: 'openai_chat_completions', tokenSource: 'api' });
    expect(notedMissing('llmUsage')).toBe(false);
    const usageDb = host!.ctx.storage.database('llm_usage');
    const row = await vi.waitFor(() => {
      const found = usageDb.get<Record<string, unknown>>(
        `SELECT caller_type, session_id, model, adapter, prompt_tokens, completion_tokens, total_tokens,
          reasoning_tokens, cached_tokens, cache_write_tokens, token_source, duration_ms, status, error_message
         FROM llm_usage_logs WHERE session_id = ?`, ['prod-usage']);
      if (found === undefined) throw new Error('usage row not flushed yet');
      return found;
    }, { timeout: 15_000, interval: 250 });
    expect(row).toEqual({ caller_type: 'chat_v2', session_id: 'prod-usage', model: 'usage-model',
      adapter: 'openai_chat_completions', prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, reasoning_tokens: 3,
      cached_tokens: 2, cache_write_tokens: null, token_source: 'api', duration_ms: null, status: 'success',
      error_message: null });
  }, 20_000);

  // The memory owner's runtime object implements more than the additive `MemoryService` type publishes.
  interface MemoryOwnerSeed {
    getOrCreateRootFolder(): unknown;
    write(folder: string | null, title: string, content: string, mode: 'create'): unknown;
    refreshProfileSummary(): unknown;
    applyProfileUpdate(update: Record<string, unknown>, options: { source: string; reason: string; limitPolicy: 'reject' }): unknown;
    loadProfile(): { weak_points: { knowledge_point: string }[] } | null;
  }
  const memoryOwner = () => host!.ctx.memory as unknown as MemoryOwnerSeed;

  it('user profile (memory category/profile summary) reaches the prompt source', async () => {
    const memory = memoryOwner();
    memory.getOrCreateRootFolder();
    memory.write(null, '学习偏好', '用户偏好用图示理解线性代数中的矩阵变换', 'create');
    memory.refreshProfileSummary();
    const profile = await deps.prompt.userProfile(execution('prod-profile', '讲讲矩阵变换'));
    expect(profile).toContain('用户偏好用图示理解线性代数中的矩阵变换');
    expect(notedMissing('memory category summaries / profile summary')).toBe(false);
  });

  it('seeds a non-empty learner profile through the memory owner', () => {
    memoryOwner().applyProfileUpdate({ weak_points_add: [{ subject: '线性代数', knowledge_point: '特征值分解',
      error_pattern: '常把特征向量方向弄反', evidence_count: 2 }], weak_points_remove: [], goals_add: [], goals_remove: [] },
    { source: 'test', reason: 'seed', limitPolicy: 'reject' });
    expect(memoryOwner().loadProfile()?.weak_points.map(point => point.knowledge_point)).toEqual(['特征值分解']);
  });

  it('learner profile (memory learner_profile) reaches the prompt source', () => {
    expect(deps.prompt.learnerProfile(execution('prod-learner', '复习特征值'))).toContain('特征值分解');
  });

  it('injected category members get the memory owner _last_injected tag (prompt.rs:350 record_injection_presence)', async () => {
    const memory = memoryOwner();
    const rootId = memory.getOrCreateRootFolder() as string;
    const member = memory.write(null, '矩阵图示', '用几何图示理解矩阵乘法', 'create') as { noteId: string };
    const vfs = host!.ctx.storage.database('vfs');
    vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
      VALUES ('res_cat_prod', 'hash_cat_prod', 'note', 'inline', '偏好几何直观', 0, 1, 1)`);
    vfs.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
      VALUES ('note_cat_prod', 'res_cat_prod', '__cat_学习偏好__', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [JSON.stringify(['_system', `_member:${member.noteId}`])]);
    vfs.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
      VALUES ('fi_cat_prod', ?, 'note', 'note_cat_prod', 0, 1)`, [rootId]);
    expect(await deps.prompt.userProfile(execution('prod-presence', '讲讲矩阵乘法'))).toContain('### 学习偏好\n偏好几何直观');
    const tags = await vi.waitFor(() => {
      const parsed = JSON.parse(vfs.get<{ tags: string }>('SELECT tags FROM notes WHERE id = ?', [member.noteId])!.tags) as string[];
      if (!parsed.some(tag => tag.startsWith('_last_injected:'))) throw new Error('presence not recorded yet');
      return parsed;
    }, { timeout: 5_000, interval: 50 });
    expect(tags.filter(tag => /^_last_injected:\d+$/.test(tag))).toHaveLength(1);
  });

  it('cited [记忆-N] notes from a committed turn get the memory owner _used tag (persistence.rs:1606 record_used)', async () => {
    const memory = memoryOwner();
    memory.getOrCreateRootFolder();
    const written = memory.write(null, '求逆技巧', '先用行列式判断是否可逆再求逆矩阵', 'create') as { noteId: string };
    const effects = (deps.finalPersistence as unknown as { effects: PipelinePostCommitEffects }).effects;
    effects.triggerAutoMemoryExtraction({ ...execution('prod-used', '矩阵求逆怎么做'),
      options: { memoryEnabled: true, autoMemoryExtraction: true },
      finalContent: '根据 [记忆-1]，先判断可逆性。',
      toolResults: [{ toolName: 'builtin-memory_search', input: {}, success: true,
        output: { sources: [{ citationTag: '[记忆-1]', noteId: written.noteId }] } }] } as unknown as PipelineContext);
    const tags = await vi.waitFor(() => {
      const row = host!.ctx.storage.database('vfs').get<{ tags: string }>('SELECT tags FROM notes WHERE id = ?', [written.noteId]);
      const parsed = JSON.parse(row!.tags) as string[];
      if (!parsed.some(tag => tag.startsWith('_used:'))) throw new Error('usage not recorded yet');
      return parsed;
    }, { timeout: 5_000, interval: 50 });
    expect(tags).toContain('_used:1');
    expect(notedMissing('memory citation usage (record_used)')).toBe(false);
  });

  it('insight existence hints come from the memory insightHints owner', async () => {
    const card = await host!.ctx.insight.createDraft({ title: '矩阵求逆前先检查行列式是否为零',
      situation: '做矩阵求逆练习时反复算错', stuck_point: '没注意到矩阵不可逆', turning_point: '先算行列式',
      rule: '求逆前先判定可逆性', validity_conditions: '方阵', ownership: 'self_reported' as never, evidence: [] });
    await host!.ctx.insight.confirm(card.id, null);
    const hints = deps.prompt.insightHints(execution('prod-insight', '矩阵求逆前先检查行列式'));
    expect(hints).toContain('矩阵求逆前先检查行列式是否为零');
    const events = host!.ctx.storage.database('vfs').all<{ event_type: string }>(
      'SELECT event_type FROM insight_events WHERE session_id = ?', ['prod-insight']);
    expect(events.map(event => event.event_type)).toContain('shown_existence');
  });

  it('no memory owner capability is reported missing after exercising every memory prompt/effect path', () => {
    expect(warn.mock.calls.map(([message]) => String(message))
      .filter(message => message.includes('owner capability unavailable: memory'))).toEqual([]);
  });
});
