import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { InjectionBudgetManager, defaultBudgetConfig, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { goalGetWithConn, goalInsertWithConn, getSessionWithConn } from '../../chat/api.ts';
import { composeExecution, composeVariants, MissingCapabilityLog, SessionToolFaceBaselines } from '../src/execution-runtime.ts';
import type { PipelinePostCommitEffects } from '../src/persistence-port.ts';
import type { PipelineContext } from '../src/pipeline-context.ts';

let root: string, storage: StorageServiceImpl, db: DatabaseHandle;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'exec-wiring-'));
  storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const report = new MigrationCoordinator({ appDataDir: storage.locations.activeDir, auditDbPath: null }).migrateSingle('chat_v2');
  if (!report.success) throw new Error(JSON.stringify(report));
  db = storage.database('chat_v2');
  db.run(`INSERT INTO chat_v2_sessions (id, mode, title_locked, persist_status, created_at, updated_at)
    VALUES ('sess', 'chat', 0, 'active', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`);
  goalInsertWithConn(db, { sessionId: 'sess', goalId: 'g', objective: '复习', status: 'active', tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 1, updatedAtMs: 1 });
});
afterEach(() => { storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

function compose(overrides: Record<string, unknown> = {}) {
  const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const workspace = fs.mkdtempSync(path.join(root, 'ws-'));
  const memory = {
    isPrivacyMode: () => false, getRootFolderId: () => 'root', getAutoExtractFrequency: () => 'balanced',
    listCategorySummariesWithMembers: () => [{ category: '学习', content: '偏好图示', memberIds: ['note_pref'] }],
    getProfileSummary: () => null, recordInjectionPresence: vi.fn(), recordUsed: vi.fn(),
    loadProfile: () => ({ version: 1 }), renderLearnerProfile: () => '## 学习者画像', isProfileContentEmpty: () => false,
    extractAndStoreMemory: vi.fn(async () => 1), spawnPostWriteMaintenance: vi.fn(async () => undefined),
  };
  const services: Record<string, unknown> = {
    llm: {}, llmOcrModels: {}, llmStreamEvents: {}, llmModel2Streaming: {},
    llmRawPrompt: { callAgentChatTitleRawPrompt: vi.fn(async () => ({ assistant_message: '{"title":"复习计划","tags":["复习"]}' })) },
    llmUsage: { recordLlmUsageCacheExt: vi.fn() },
    memory, vfs: { database: {} },
    injectionBudget: { defaultConfig: defaultBudgetConfig, newItem: newInjectionItem,
      createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config) },
    runtimeRoots: { rootById: () => ({ path: workspace }), isDirectory: (target: string) => target === workspace,
      currentDir: () => '/cwd' },
    ...overrides,
  };
  const chatSession = { database: { getConnSafe: () => db },
    loadAgentsInstructions: vi.fn((rootPath: string | null) => `AGENTS@${rootPath}`),
    createParallelExecutionManager: () => ({}) };
  const ctx = { get: (name: string) => services[name], logger, settings: { get: () => null },
    backendEvents: { emit: vi.fn() }, chatSession } as never;
  const missing = new MissingCapabilityLog(logger);
  const deps = composeExecution({ ctx, owner: {} as never, toolFace: {} as never, missing,
    resolveCanonicalImages: async () => [], resolveSnapshot: (() => null) as never, compaction: null,
    memoryFlushRecovery: { scheduleRecovery() {} } as never });
  const variants = composeVariants(ctx, {} as never, deps, new SessionToolFaceBaselines(() => ({}) as never, logger),
    missing, (async () => null) as never);
  return { deps, variants, services, memory, chatSession, logger, workspace };
}

const execution = (fields: Partial<PipelineContext> = {}) => ({ sessionId: 'sess', options: {},
  userContent: '请给我制定一个线性代数复习计划', finalContent: '好的，这是一个为期两周的复习计划。'.repeat(3),
  toolResults: [], ...fields }) as unknown as PipelineContext;
const warned = (logger: { warn: ReturnType<typeof vi.fn> }, text: string) =>
  logger.warn.mock.calls.some(([message]) => String(message).includes(text));

describe('composeExecution wires the pipeline.rs owner capabilities', () => {
  it('session title/tags: metadata runtime persists through llmRawPrompt', async () => {
    const { deps, services, logger } = compose();
    expect(deps.sessionMetadata).not.toBeNull();
    const ex = execution();
    expect(await deps.sessionMetadata!.shouldGenerate('sess', ex.userContent, ex.finalContent)).toBe(true);
    await deps.sessionMetadata!.generate('sess', ex.userContent, ex.finalContent, { emitSummaryUpdated: vi.fn() } as never);
    expect((services.llmRawPrompt as { callAgentChatTitleRawPrompt: ReturnType<typeof vi.fn> }).callAgentChatTitleRawPrompt)
      .toHaveBeenCalledWith(expect.any(String), 'sess');
    expect(getSessionWithConn(db, 'sess')!.title).toBe('复习计划');
    expect(warned(logger, 'session title/tags are not generated')).toBe(false);
    expect(compose({ llmRawPrompt: undefined }).deps.sessionMetadata).toBeNull();
  });
  it('usage ledger: rounds go to llmUsage.recordLlmUsageCacheExt', () => {
    const { deps, services, logger } = compose();
    deps.recordUsage({ model: 'm', promptTokens: 1, completionTokens: 2, reasoningTokens: null, cachedTokens: null,
      cacheWriteTokens: null, sessionId: 'sess', success: true, errorMessage: null, protocol: null, tokenSource: 'api' });
    expect((services.llmUsage as { recordLlmUsageCacheExt: ReturnType<typeof vi.fn> }).recordLlmUsageCacheExt)
      .toHaveBeenCalledWith(expect.objectContaining({ callerType: 'chat_v2', model: 'm', sessionId: 'sess' }));
    expect(warned(logger, 'usage ledger')).toBe(false);
  });
  it('user profile, AGENTS.md and active goal reach the prompt sources', async () => {
    const { deps, chatSession, workspace } = compose();
    expect(await deps.prompt.userProfile(execution())).toBe('### 学习\n偏好图示');
    expect(deps.prompt.agentsInstructions(execution())).toBe(`AGENTS@${workspace}`);
    expect(chatSession.loadAgentsInstructions).toHaveBeenCalledWith(workspace);
    const fallback = compose({ runtimeRoots: { rootById: () => ({ path: workspace }), isDirectory: () => false, currentDir: () => '/cwd' } });
    expect(fallback.deps.prompt.agentsInstructions(execution())).toBe('AGENTS@/cwd');
    const absent = compose({ runtimeRoots: undefined });
    expect(absent.deps.prompt.agentsInstructions(execution())).toBe('AGENTS@null');
    expect(deps.prompt.activeGoal('sess')).toBe('目标：复习\n状态：active；已用 tokens：0');
  });
  it('learner profile renders through the memory owner; empty profiles are skipped', () => {
    const { deps, memory, logger } = compose();
    expect(deps.prompt.learnerProfile(execution())).toBe('## 学习者画像');
    const empty = compose({ memory: { ...memory, isProfileContentEmpty: () => true } });
    expect(empty.deps.prompt.learnerProfile(execution())).toBeNull();
    expect(warned(logger, 'owner capability unavailable: memory')).toBe(false);
  });
  it('injected profile members are marked present through memory.recordInjectionPresence', async () => {
    const { deps, memory } = compose();
    await deps.prompt.userProfile(execution({ sessionId: 'sess-presence' } as never));
    await vi.waitFor(() => expect(memory.recordInjectionPresence).toHaveBeenCalledWith(['note_pref']));
  });
  it('goal usage accumulates on the chat DB', () => {
    const { deps } = compose();
    deps.effects.accumulateGoalUsage('sess', { tryWindow: () => null } as never, 42, 3000);
    expect(goalGetWithConn(db, 'sess')).toMatchObject({ tokensUsed: 42, timeUsedSeconds: 3 });
  });
  it('auto memory extraction runs on single- and multi-variant post-commit paths', async () => {
    const { deps, variants, memory } = compose();
    const post = (deps.finalPersistence as unknown as { effects: PipelinePostCommitEffects }).effects;
    post.triggerAutoMemoryExtraction(execution());
    variants.triggerAutoMemoryExtraction(null, '多变体用户输入足够长了', '回答', []);
    await vi.waitFor(() => expect(memory.spawnPostWriteMaintenance).toHaveBeenCalledTimes(2));
    expect(memory.extractAndStoreMemory).toHaveBeenNthCalledWith(1, '请给我制定一个线性代数复习计划', expect.any(String));
    expect(memory.extractAndStoreMemory).toHaveBeenNthCalledWith(2, '多变体用户输入足够长了', '回答');
    post.triggerAutoMemoryExtraction(execution({ options: { autoMemoryExtraction: false } } as never));
    expect(memory.extractAndStoreMemory).toHaveBeenCalledTimes(2);
  });
});
