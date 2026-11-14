import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { InjectionBudgetManager, defaultBudgetConfig, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { goalGetWithConn, goalInsertWithConn, getSessionTagsWithConn, getSessionWithConn,
  type GoalRecord } from '../../chat/api.ts';
import type { LearnerProfile } from '../../memory/api.ts';
import {
  accumulateGoalUsage, createSessionMetadataRuntime, formatActiveGoalSummary, llmWroteFactMemory,
  loadActiveGoalSummary, loadLearnerProfileBlock, loadProjectAgentsInstructions, loadUserProfile,
  recordRoundUsage, triggerAutoMemoryExtractionForTurn, type AgentsInstructionsPorts, type AutoExtractMemoryPort,
} from '../src/execution-capabilities.ts';
import { computeContentHash } from '../src/summary.ts';

const log = () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() });

let root: string, storage: StorageServiceImpl, db: DatabaseHandle;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'exec-capabilities-'));
  storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const report = new MigrationCoordinator({ appDataDir: storage.locations.activeDir, auditDbPath: null }).migrateSingle('chat_v2');
  if (!report.success) throw new Error(JSON.stringify(report));
  db = storage.database('chat_v2');
});
afterEach(() => { storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

function insertSession(id: string, fields: { titleLocked?: boolean; summaryHash?: string; groupId?: string } = {}) {
  db.run(`INSERT INTO chat_v2_sessions (id, mode, title, title_locked, summary_hash, group_id, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', '旧标题', ?2, ?3, ?4, 'active', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`,
  [id, fields.titleLocked ? 1 : 0, fields.summaryHash ?? null, fields.groupId ?? null]);
}
function goal(sessionId: string, status: string, tokenBudget: number | null, tokensUsed = 0): GoalRecord {
  return { sessionId, goalId: `goal_${sessionId}`, objective: '学完线性代数', status, tokenBudget, tokensUsed,
    timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 1, updatedAtMs: 1 };
}

describe('active goal summary (prompt.rs:114 + goal/mod.rs:43)', () => {
  it('formats budget and clamps the remaining tokens at zero', () => {
    expect(formatActiveGoalSummary(goal('s', 'active', 1000, 250))).toBe('目标：学完线性代数\n状态：active；已用 tokens：250；预算：1000，剩余：750');
    expect(formatActiveGoalSummary(goal('s', 'active', 100, 250))).toBe('目标：学完线性代数\n状态：active；已用 tokens：250；预算：100，剩余：0');
    expect(formatActiveGoalSummary(goal('s', 'active', null, 7))).toBe('目标：学完线性代数\n状态：active；已用 tokens：7');
  });
  it('injects only active goals from the chat DB', () => {
    goalInsertWithConn(db, goal('s_active', 'active', null, 3));
    goalInsertWithConn(db, goal('s_paused', 'paused', null));
    const l = log();
    expect(loadActiveGoalSummary(() => db, l, 's_active')).toBe('目标：学完线性代数\n状态：active；已用 tokens：3');
    expect(loadActiveGoalSummary(() => db, l, 's_paused')).toBeNull();
    expect(loadActiveGoalSummary(() => db, l, 's_none')).toBeNull();
    expect(loadActiveGoalSummary(() => { throw new Error('closed'); }, l, 's_active')).toBeNull();
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('load_active_goal_summary: failed to get conn (session=s_active): closed'));
  });
});

describe('accumulate_goal_usage (pipeline.rs:414)', () => {
  const windowed = { tryWindow: () => ({ label: 'main' }) as never };
  it('adds tokens and whole seconds to active / waiting_user goals and broadcasts goal_updated', () => {
    goalInsertWithConn(db, goal('s1', 'waiting_user', null));
    const events = { emit: vi.fn() };
    accumulateGoalUsage(() => db, events, log(), 's1', windowed, 120, 2999);
    expect(goalGetWithConn(db, 's1')).toMatchObject({ tokensUsed: 120, timeUsedSeconds: 2 });
    expect(events.emit).toHaveBeenCalledWith('chat_v2_session_s1',
      expect.objectContaining({ eventType: 'goal_updated', sessionId: 's1', goal: expect.objectContaining({ tokensUsed: 120 }) }));
  });
  it('skips zero deltas, inactive goals and the broadcast for windowless emitters', () => {
    goalInsertWithConn(db, goal('s2', 'active', null));
    goalInsertWithConn(db, goal('s3', 'complete', null));
    const events = { emit: vi.fn() };
    accumulateGoalUsage(() => db, events, log(), 's2', windowed, 0, 999);
    accumulateGoalUsage(() => db, events, log(), 's3', windowed, 50, 0);
    expect(goalGetWithConn(db, 's2')!.tokensUsed).toBe(0);
    expect(goalGetWithConn(db, 's3')!.tokensUsed).toBe(0);
    accumulateGoalUsage(() => db, events, log(), 's2', { tryWindow: () => null }, 10, 0);
    expect(goalGetWithConn(db, 's2')!.tokensUsed).toBe(10);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('AGENTS.md workspace root (prompt.rs:194/200)', () => {
  function ports(overrides: Partial<AgentsInstructionsPorts> = {}) {
    const load = vi.fn((rootPath: string | null) => `AGENTS@${rootPath}`);
    return { load, ports: { connection: () => db, log: log(), workspaceRoot: () => { throw new Error('unconfigured'); },
      loadAgentsInstructions: load, isDirectory: (target: string) => fs.existsSync(target) && fs.statSync(target).isDirectory(),
      cwd: () => '/cwd', ...overrides } satisfies AgentsInstructionsPorts };
  }
  it('prefers the group project root, then the workspace root, then cwd', () => {
    const project = fs.mkdtempSync(path.join(root, 'project-'));
    const workspace = fs.mkdtempSync(path.join(root, 'workspace-'));
    db.run(`INSERT INTO chat_v2_session_groups (id, name, sort_order, persist_status, created_at, updated_at, preferred_project_root_path)
      VALUES ('g1', 'G', 0, 'active', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', ?1)`, [`  ${project}  `]);
    insertSession('s_group', { groupId: 'g1' });
    insertSession('s_plain');
    expect(loadProjectAgentsInstructions(ports({ workspaceRoot: () => workspace }).ports, 's_group')).toBe(`AGENTS@${project}`);
    expect(loadProjectAgentsInstructions(ports({ workspaceRoot: () => workspace }).ports, 's_plain')).toBe(`AGENTS@${workspace}`);
    expect(loadProjectAgentsInstructions(ports().ports, 's_plain')).toBe('AGENTS@/cwd');
    expect(loadProjectAgentsInstructions(ports({ workspaceRoot: () => path.join(root, 'missing') }).ports, 's_plain'))
      .toBe('AGENTS@/cwd');
  });
});

describe('round usage ledger (tool_loop.rs:1618/1680)', () => {
  it('records CallerType::ChatV2 with protocol as adapter and no duration', () => {
    const usage = { recordLlmUsageCacheExt: vi.fn() };
    recordRoundUsage(usage, { model: 'deepseek-chat', promptTokens: 10, completionTokens: 5, reasoningTokens: null,
      cachedTokens: 2, cacheWriteTokens: null, sessionId: 'sess', success: false, errorMessage: 'boom',
      protocol: 'openai_chat_completions', tokenSource: 'api' });
    expect(usage.recordLlmUsageCacheExt).toHaveBeenCalledWith({ callerType: 'chat_v2', model: 'deepseek-chat',
      promptTokens: 10, completionTokens: 5, reasoningTokens: null, cachedTokens: 2, cacheWriteTokens: null,
      sessionId: 'sess', durationMs: null, success: false, errorMessage: 'boom',
      adapter: 'openai_chat_completions', tokenSource: 'api' });
  });
});

describe('session metadata (summary.rs:51/259/293)', () => {
  const user = '请帮我解释一下特征值和特征向量的几何意义';
  const assistant = '特征向量是在线性变换下方向不变的向量，特征值是其伸缩倍数。'.repeat(30);
  it('generates title + tags once, persists hash/tags and emits summary_updated', async () => {
    insertSession('s_meta');
    const callTitle = vi.fn(async () => ({ assistant_message: '```json\n{"title":"特征值几何意义","tags":["线性代数"," 特征值 ",""]}\n```' }));
    const runtime = createSessionMetadataRuntime({ connection: () => db, callTitle, log: log() });
    expect(await runtime.shouldGenerate('s_meta', user, assistant)).toBe(true);
    const emitter = { emitSummaryUpdated: vi.fn() };
    await runtime.generate('s_meta', user, assistant, emitter as never);
    expect(callTitle).toHaveBeenCalledWith(expect.stringContaining(user), 's_meta');
    const session = getSessionWithConn(db, 's_meta')!;
    const hash = computeContentHash(user, [...assistant].slice(0, 500).join(''));
    expect(session).toMatchObject({ title: '特征值几何意义', summaryHash: hash, tagsHash: hash });
    expect(getSessionTagsWithConn(db, 's_meta').sort()).toEqual(['特征值', '线性代数'].sort());
    expect(emitter.emitSummaryUpdated).toHaveBeenCalledWith('特征值几何意义', '');
    expect(await runtime.shouldGenerate('s_meta', user, assistant)).toBe(false);
  });
  it('falls back locally on LLM failure, never overwrites a locked title, and skips short turns', async () => {
    insertSession('s_fail');
    insertSession('s_locked', { titleLocked: true });
    const runtime = createSessionMetadataRuntime({ connection: () => db, log: log(),
      callTitle: async () => { throw new Error('offline'); } });
    await runtime.generate('s_fail', '  ！什么是  矩阵的秩？ ', assistant, { emitSummaryUpdated: vi.fn() } as never);
    expect(getSessionWithConn(db, 's_fail')!.title).toBe('什么是 矩阵的秩');
    expect(await runtime.shouldGenerate('s_locked', user, assistant)).toBe(false);
    expect(await runtime.shouldGenerate('s_fail', 'hi', 'ok')).toBe(false);
  });
  it('does not broadcast an automatic title after the user has renamed the session', async () => {
    insertSession('s_rename');
    const runtime = createSessionMetadataRuntime({ connection: () => db, log: log(),
      callTitle: async () => {
        db.run("UPDATE chat_v2_sessions SET title = '手动标题', title_locked = 1 WHERE id = 's_rename'");
        return { assistant_message: '{"title":"迟到的自动标题","tags":["线性代数"]}' };
      } });
    expect(await runtime.shouldGenerate('s_rename', user, assistant)).toBe(true);
    const emitter = { emitSummaryUpdated: vi.fn() };
    await runtime.generate('s_rename', user, assistant, emitter as never);
    expect(getSessionWithConn(db, 's_rename')).toMatchObject({ title: '手动标题', titleLocked: true });
    expect(getSessionWithConn(db, 's_rename')!.summaryHash).toBeUndefined();
    expect(getSessionTagsWithConn(db, 's_rename')).toEqual([]);
    expect(emitter.emitSummaryUpdated).not.toHaveBeenCalled();
  });
  it('times out the title call and uses the local fallback', async () => {
    insertSession('s_slow');
    const runtime = createSessionMetadataRuntime({ connection: () => db, log: log(), timeoutMs: 10,
      callTitle: () => new Promise(() => undefined) });
    await runtime.generate('s_slow', user, assistant, { emitSummaryUpdated: vi.fn() } as never);
    expect(getSessionWithConn(db, 's_slow')!.title).toBe([...user].slice(0, 20).join(''));
  });
});

describe('user profile injection (prompt.rs:236)', () => {
  const memory = (sections: { category: string; content: string; memberIds?: string[] }[], overrides: Record<string, unknown> = {}) => ({
    isPrivacyMode: () => false, getRootFolderId: () => 'root',
    listCategorySummariesWithMembers: () => sections.map(section => ({ memberIds: [], ...section })),
    getProfileSummary: () => 'legacy profile', recordInjectionPresence: () => undefined, ...overrides });
  it('joins category sections and keeps whole sections up to 2000 chars with a truncation note', () => {
    expect(loadUserProfile(memory([{ category: '学习', content: 'A' }, { category: '偏好', content: 'B' }]), log(), 's', null))
      .toBe('### 学习\nA\n\n### 偏好\nB');
    const big = 'x'.repeat(1500);
    expect(loadUserProfile(memory([{ category: 'a', content: big }, { category: 'b', content: big }, { category: 'c', content: 'y' }]), log(), 's', true))
      .toBe(`### a\n${big}\n\n（用户画像已截断 1/3 个分类，完整信息请使用 builtin-memory_search 工具检索）`);
    // Each kept section also counts its 2-char separator: 1000 + 2 + 999 > 2000.
    const first = { category: 'a', content: 'p'.repeat(994) }, second = { category: 'b', content: 'q'.repeat(993) };
    expect(loadUserProfile(memory([first, second]), log(), 's', null))
      .toBe(`### a\n${first.content}\n\n（用户画像已截断 1/2 个分类，完整信息请使用 builtin-memory_search 工具检索）`);
    const huge = 'z'.repeat(2500);
    expect(loadUserProfile(memory([{ category: 'h', content: huge }]), log(), 's', null)).toBe(`### h\n${huge}`);
  });
  it('falls back to the legacy summary and honours memory/privacy/root gates', () => {
    expect(loadUserProfile(memory([]), log(), 's', null)).toBe('legacy profile');
    expect(loadUserProfile(memory([], { getProfileSummary: () => null }), log(), 's', null)).toBeNull();
    expect(loadUserProfile(memory([{ category: 'a', content: 'b' }]), log(), 's', false)).toBeNull();
    expect(loadUserProfile(memory([{ category: 'a', content: 'b' }], { isPrivacyMode: () => true }), log(), 's', null)).toBeNull();
    expect(loadUserProfile(memory([{ category: 'a', content: 'b' }], { getRootFolderId: () => null }), log(), 's', null)).toBeNull();
    const l = log();
    expect(loadUserProfile(memory([], { listCategorySummariesWithMembers: () => { throw new Error('io'); } }), l, 's', null)).toBe('legacy profile');
    expect(l.warn).toHaveBeenCalledWith('[ChatV2::pipeline] Failed to load category summaries (session=s): io');
  });
  it('marks injected category members present, sorted/deduped, once per session per hour (prompt.rs:347)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 10, 7, 1, 0, 0));
      const recordInjectionPresence = vi.fn();
      const big = 'x'.repeat(1500);
      const sections = [{ category: 'a', content: big, memberIds: ['n3', 'n1', 'n3'] },
        { category: 'b', content: big, memberIds: ['n_truncated'] }];
      const port = memory(sections, { recordInjectionPresence });
      loadUserProfile(port, log(), 'presence-s1', null);
      loadUserProfile(port, log(), 'presence-s1', null);
      loadUserProfile(port, log(), 'presence-s2', null);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(recordInjectionPresence.mock.calls).toEqual([[['n1', 'n3']], [['n1', 'n3']]]);
      vi.setSystemTime(Date.UTC(2026, 10, 7, 2, 0, 0));
      loadUserProfile(port, log(), 'presence-s1', null);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(recordInjectionPresence).toHaveBeenCalledTimes(3);
      loadUserProfile(memory([{ category: 'a', content: 'b' }], { recordInjectionPresence }), log(), 'presence-s3', null);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(recordInjectionPresence).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a throwing record_injection_presence only warns; the profile is still injected', async () => {
    const l = log();
    const port = memory([{ category: 'a', content: 'b', memberIds: ['n1'] }],
      { recordInjectionPresence: () => { throw new Error('database is locked'); } });
    expect(loadUserProfile(port, l, 'presence-throws', null)).toBe('### a\nb');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(l.warn).toHaveBeenCalledWith('[ChatV2::pipeline] record_injection_presence failed (session=presence-throws): database is locked');
  });
});

describe('learner profile block (prompt_builder.rs:1037)', () => {
  const profile = { version: 1, updated_at: 't', weak_points: [], preferences: {}, goals: [], recent_status: 'ok' } as unknown as LearnerProfile;
  const budget = { defaultConfig: defaultBudgetConfig,
    createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
    newItem: newInjectionItem };
  const memoryPort = (text: string) => ({ isPrivacyMode: () => false, loadProfile: () => profile,
    renderLearnerProfile: () => text, isProfileContentEmpty: () => false });
  it('renders through a High-priority LearnerProfile budget item', () => {
    expect(loadLearnerProfileBlock(memoryPort('## 学习者画像'), budget, log(), null)).toBe('## 学习者画像');
    const long = '长'.repeat(10_000);
    const reference = new InjectionBudgetManager(defaultBudgetConfig());
    reference.addItem(newInjectionItem('LearnerProfile', long, 2 as never, 'learner_profile'));
    const expected = reference.allocate().selected_items[0]!.content;
    expect([...expected].length).toBeLessThan(10_000);
    expect(loadLearnerProfileBlock(memoryPort(long), budget, log(), null)).toBe(expected);
  });
  it('skips disabled memory, privacy mode, missing and empty profiles', () => {
    expect(loadLearnerProfileBlock(memoryPort('x'), budget, log(), false)).toBeNull();
    expect(loadLearnerProfileBlock({ ...memoryPort('x'), isPrivacyMode: () => true }, budget, log(), null)).toBeNull();
    expect(loadLearnerProfileBlock({ ...memoryPort('x'), loadProfile: () => null }, budget, log(), null)).toBeNull();
    expect(loadLearnerProfileBlock({ ...memoryPort('x'), isProfileContentEmpty: () => true }, budget, log(), null)).toBeNull();
  });
});

describe('auto memory extraction (persistence.rs:1584)', () => {
  const port = (overrides: Partial<AutoExtractMemoryPort> = {}) => ({
    getAutoExtractFrequency: () => 'balanced' as const, isPrivacyMode: () => false,
    extractAndStoreMemory: vi.fn(async () => 2), spawnPostWriteMaintenance: vi.fn(async () => undefined),
    recordUsed: vi.fn(), ...overrides });
  it('extracts and runs post-write maintenance when every gate passes', async () => {
    const memory = port();
    const l = log();
    await triggerAutoMemoryExtractionForTurn(memory, l, null, '我在学习线性代数的特征值', '好的', [], 'AutoMemory');
    expect(memory.extractAndStoreMemory).toHaveBeenCalledWith('我在学习线性代数的特征值', '好的');
    expect(memory.spawnPostWriteMaintenance).toHaveBeenCalledTimes(1);
    expect(l.info).toHaveBeenCalledWith('[AutoMemory] Auto-extracted 2 memories (frequency=balanced)');
  });
  it('honours session switch, off frequency, privacy and per-frequency length gates', () => {
    const run = (memory: ReturnType<typeof port>, enabled: boolean | null, user: string, assistant = '') =>
      triggerAutoMemoryExtractionForTurn(memory, log(), enabled, user, assistant, [], 'AutoMemory');
    expect(run(port(), false, '这是一段足够长的用户输入内容')).toBeNull();
    expect(run(port({ getAutoExtractFrequency: () => 'off' }), null, '这是一段足够长的用户输入内容')).toBeNull();
    expect(run(port({ isPrivacyMode: () => true }), null, '这是一段足够长的用户输入内容')).toBeNull();
    expect(run(port(), null, '九个字的用户输入啊', '短')).toBeNull();
    expect(run(port({ getAutoExtractFrequency: () => 'aggressive' }), null, '四个字呀')).not.toBeNull();
  });
  it('skips when the model already wrote fact memories this turn', () => {
    expect(llmWroteFactMemory([{ toolName: 'builtin-memory_write', input: {} }])).toBe(true);
    expect(llmWroteFactMemory([{ toolName: 'memory_write_smart', input: { memory_type: 'study' } }])).toBe(false);
    expect(llmWroteFactMemory([{ toolName: 'builtin-memory_write_batch', input: { default_memory_type: 'study',
      items: [{ memory_type: 'fact' }] } }])).toBe(true);
    expect(llmWroteFactMemory([{ toolName: 'memory_write_batch', input: { default_memory_type: 'study', items: [{}] } }])).toBe(false);
    expect(llmWroteFactMemory([{ toolName: 'memory_write_batch', input: {} }])).toBe(true);
    expect(llmWroteFactMemory([{ toolName: 'memory_search', input: {} }])).toBe(false);
    const memory = port();
    expect(triggerAutoMemoryExtractionForTurn(memory, log(), null, '这是一段足够长的用户输入内容', '',
      [{ toolName: 'builtin-memory_update_by_id', input: { memory_type: 'fact' } }], 'AutoMemory')).toBeNull();
  });
  it('records citation usage for cited [记忆-N] notes before the frequency/privacy gates (persistence.rs:1606)', async () => {
    const recordUsed = vi.fn();
    const results = [
      { toolName: 'builtin-memory_search', input: {}, success: true, output: { sources: [
        { citationTag: '[记忆-1]', noteId: 'note_a' },
        { citationTag: '[Memory-2:摘要]', noteId: null, sourceNoteIds: ['note_b', 'note_a', ''] },
        { citationTag: '[记忆-3]', note_id: 'note_uncited' },
        { citationTag: '[记忆-02]', note_id: 'note_c' },
      ] } },
      { toolName: 'builtin-memory_search', input: {}, success: false, output: { sources: [{ citationTag: '[记忆-1]', noteId: 'note_failed' }] } },
    ];
    expect(triggerAutoMemoryExtractionForTurn(port({ recordUsed, getAutoExtractFrequency: () => 'off' }), log(), null,
      '问题', '见 [记忆-1] 和 [MEMORY-2] 以及 [记忆-99999999999999999999]', results, 'AutoMemory')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(recordUsed).toHaveBeenCalledTimes(1);
    expect(recordUsed).toHaveBeenCalledWith(['note_a', 'note_b', 'note_c']);
  });
  it('records no usage when the session switch is off or nothing is cited', async () => {
    const recordUsed = vi.fn();
    const results = [{ toolName: 'memory_search', input: {}, success: true, output: { sources: [{ citationTag: '[记忆-1]', noteId: 'n' }] } }];
    triggerAutoMemoryExtractionForTurn(port({ recordUsed }), log(), false, 'q', '[记忆-1]', results, 'AutoMemory');
    triggerAutoMemoryExtractionForTurn(port({ recordUsed }), log(), null, 'q', '没有引用', results, 'AutoMemory');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(recordUsed).not.toHaveBeenCalled();
  });
  it('a throwing record_used only warns and does not block extraction', async () => {
    const l = log();
    const memory = port({ recordUsed: () => { throw new Error('database is locked'); } });
    const results = [{ toolName: 'memory_search', input: {}, success: true, output: { sources: [{ citationTag: '[记忆-1]', noteId: 'n' }] } }];
    await triggerAutoMemoryExtractionForTurn(memory, l, null, '这是一段足够长的用户输入内容', '见 [记忆-1]', results, 'AutoMemory');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(l.warn).toHaveBeenCalledWith('[AutoMemory] record_used failed: database is locked');
    expect(memory.extractAndStoreMemory).toHaveBeenCalledTimes(1);
  });
  it('treats extraction failures as non-fatal', async () => {
    const l = log();
    await triggerAutoMemoryExtractionForTurn(port({ extractAndStoreMemory: async () => { throw new Error('llm down'); } }),
      l, null, '这是一段足够长的用户输入内容', '', [], 'AutoMemory::MultiVariant');
    expect(l.warn).toHaveBeenCalledWith('[AutoMemory::MultiVariant] Auto-extraction failed (non-fatal): llm down');
  });
});
