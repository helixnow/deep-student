import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { EssayGradingService } from '../../llm/api.ts';
import type { InsightCommandService } from '../../memory/api.ts';
import review from '../index.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODE: Wire.GradingMode = {
  id: 'mode_test', name: 'mode', description: '', system_prompt: '', score_dimensions: [],
  total_max_score: 100, is_builtin: false, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const SESSION: Wire.VfsEssaySession = {
  id: 'session_1', title: 't', essay_type: 'type', grade_level: 'g', custom_prompt: null,
  total_rounds: 0, is_favorite: false, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const ROUND: Wire.GradingRoundResponse = {
  id: 'round_1', session_id: 'session_1', round_number: 1, input_text: 'essay',
  grading_result: 'ok', overall_score: 88, dimension_scores_json: null,
  created_at: '2026-01-01T00:00:00Z',
};
const REVISION: Wire.InsightRevision = {
  id: 'revision_1', insight_id: 'insight_1', resource_id: null, situation: '',
  stuck_point: '', turning_point: '', rule: '', validity_conditions: '',
  hypothetical_queries: [], edit_note: null, created_at: '2026-01-01T00:00:00Z',
};
const CARD: Wire.InsightCard = {
  id: 'insight_1', title: 'card', ownership: 'self_reported', verification_state: 'unverified',
  status: 'active', recall_count: 0, shown_count: 0, useful_count: 0, last_recalled_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: null, current_revision: REVISION,
};

interface EssayCalls {
  stream: unknown[];
  createSession: unknown[];
  getSession: unknown[];
  updateSession: unknown[];
  deleteSession: unknown[];
  listSessions: unknown[];
  toggleFavorite: unknown[];
  getRounds: unknown[];
  getRound: unknown[];
  getLatestRoundNumber: unknown[];
  getModes: unknown[];
  getMode: unknown[];
  createCustomMode: unknown[];
  updateCustomMode: unknown[];
  deleteCustomMode: unknown[];
  listCustomModes: unknown[];
  saveBuiltinOverride: unknown[];
  resetBuiltinMode: unknown[];
  hasBuiltinOverride: unknown[];
  getModels: unknown[];
}

function essayDouble(): { service: EssayGradingService; calls: EssayCalls } {
  const calls: EssayCalls = {
    stream: [], createSession: [], getSession: [], updateSession: [], deleteSession: [],
    listSessions: [], toggleFavorite: [], getRounds: [], getRound: [], getLatestRoundNumber: [],
    getModes: [], getMode: [], createCustomMode: [], updateCustomMode: [], deleteCustomMode: [],
    listCustomModes: [], saveBuiltinOverride: [], resetBuiltinMode: [], hasBuiltinOverride: [],
    getModels: [],
  };
  const service: EssayGradingService = {
    async stream(request, emit) {
      calls.stream.push(request);
      emit('essay_grading_stream_s', { type: 'data', chunk: 'x', char_count: 1 });
      return null;
    },
    async createSession(...args) { calls.createSession.push(args); return SESSION; },
    async getSession(...args) { calls.getSession.push(args); return null; },
    async updateSession(...args) { calls.updateSession.push(args); },
    async deleteSession(...args) { calls.deleteSession.push(args); return 2; },
    async listSessions(...args) { calls.listSessions.push(args); return []; },
    async toggleFavorite(...args) { calls.toggleFavorite.push(args); return true; },
    async getRounds(...args) { calls.getRounds.push(args); return [ROUND]; },
    async getRound(...args) { calls.getRound.push(args); return ROUND; },
    async getLatestRoundNumber(...args) { calls.getLatestRoundNumber.push(args); return 3; },
    async getModes(...args) { calls.getModes.push(args); return [MODE]; },
    async getMode(...args) { calls.getMode.push(args); return MODE; },
    async createCustomMode(...args) { calls.createCustomMode.push(args); return MODE; },
    async updateCustomMode(...args) { calls.updateCustomMode.push(args); return MODE; },
    async deleteCustomMode(...args) { calls.deleteCustomMode.push(args); },
    async listCustomModes(...args) { calls.listCustomModes.push(args); return [MODE]; },
    async saveBuiltinOverride(...args) { calls.saveBuiltinOverride.push(args); return MODE; },
    async resetBuiltinMode(...args) { calls.resetBuiltinMode.push(args); return MODE; },
    async hasBuiltinOverride(...args) { calls.hasBuiltinOverride.push(args); return false; },
    async getModels(...args) {
      calls.getModels.push(args);
      return [{ id: 'm1', name: 'model', model: 'gpt', is_default: true }];
    },
  };
  return { service, calls };
}

interface InsightCalls {
  createDraft: unknown[]; confirm: unknown[]; correct: unknown[]; delete: unknown[]; getInsight: unknown[];
  listInsights: unknown[]; listRevisions: unknown[]; listEvidence: unknown[]; listRelations: unknown[];
  listEvents: unknown[]; recordFeedback: unknown[]; addRelation: unknown[]; runJobs: unknown[];
}

function insightDouble(): { service: InsightCommandService; calls: InsightCalls } {
  const calls: InsightCalls = {
    createDraft: [], confirm: [], correct: [], delete: [], getInsight: [], listInsights: [],
    listRevisions: [], listEvidence: [], listRelations: [], listEvents: [], recordFeedback: [],
    addRelation: [], runJobs: [],
  };
  const service: InsightCommandService = {
    async createDraft(...args) { calls.createDraft.push(args); return CARD; },
    async confirm(...args) { calls.confirm.push(args); return CARD; },
    async correct(...args) { calls.correct.push(args); return CARD; },
    async delete(...args) { calls.delete.push(args); },
    async getInsight(...args) { calls.getInsight.push(args); return CARD; },
    async listInsights(...args) { calls.listInsights.push(args); return [CARD]; },
    async listRevisions(...args) { calls.listRevisions.push(args); return []; },
    async listEvidence(...args) { calls.listEvidence.push(args); return []; },
    async listRelations(...args) { calls.listRelations.push(args); return []; },
    async listEvents(...args) { calls.listEvents.push(args); return []; },
    async recordFeedback(...args) { calls.recordFeedback.push(args); },
    async addRelation(...args) { calls.addRelation.push(args); return 'rel_1'; },
    async runJobs(...args) { calls.runJobs.push(args); return 4; },
  };
  return { service, calls };
}

async function setup(essayOverrides: Partial<EssayGradingService> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-foreign-commands-'));
  dirs.push(dir);
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const essay = essayDouble();
  Object.assign(essay.service, essayOverrides);
  const insight = insightDouble();
  const host = await createTestHost({
    plugins: [review],
    provide: { storage, essayGrading: essay.service, insight: insight.service },
  });
  hosts.push(host);
  return { host, essay, insight };
}

it('essay_grading commands delegate arguments and return shapes', async () => {
  const { host, essay } = await setup();
  const request = {
    session_id: 'session_1', stream_session_id: 'stream_1', round_number: 1,
    input_text: 'essay', essay_type: 'argument', grade_level: 'high',
  };
  await expect(host.invoke('essay_grading_stream', { request })).resolves.toBeNull();
  expect(essay.calls.stream).toEqual([request]);

  await host.invoke('essay_grading_create_session', {
    title: 't', essayType: 'type', gradeLevel: 'g', customPrompt: null,
  });
  expect(essay.calls.createSession).toEqual([['t', 'type', 'g', null]]);

  await host.invoke('essay_grading_get_session', { sessionId: 'session_1' });
  expect(essay.calls.getSession).toEqual([['session_1']]);

  const session = { id: 'session_1', title: 'new' };
  await expect(host.invoke('essay_grading_update_session', { session })).resolves.toBeNull();
  expect(essay.calls.updateSession).toEqual([[session]]);

  await expect(host.invoke('essay_grading_delete_session', { sessionId: 'session_1' })).resolves.toBe(2);
  expect(essay.calls.deleteSession).toEqual([['session_1']]);

  await expect(host.invoke('essay_grading_toggle_favorite', { sessionId: 'session_1' })).resolves.toBe(true);
  expect(essay.calls.toggleFavorite).toEqual([['session_1']]);

  await expect(host.invoke('essay_grading_get_rounds', { sessionId: 'session_1' })).resolves.toEqual([ROUND]);
  expect(essay.calls.getRounds).toEqual([['session_1']]);
  await expect(host.invoke('essay_grading_get_round', { sessionId: 'session_1', roundNumber: 2 }))
    .resolves.toEqual(ROUND);
  expect(essay.calls.getRound).toEqual([['session_1', 2]]);
  await expect(host.invoke('essay_grading_get_latest_round_number', { sessionId: 'session_1' })).resolves.toBe(3);
  expect(essay.calls.getLatestRoundNumber).toEqual([['session_1']]);

  await expect(host.invoke('essay_grading_get_modes')).resolves.toEqual([MODE]);
  expect(essay.calls.getModes).toEqual([[]]);
  await expect(host.invoke('essay_grading_get_mode', { modeId: 'mode_test' })).resolves.toEqual(MODE);
  expect(essay.calls.getMode).toEqual([['mode_test']]);

  const createInput = { name: 'n', description: 'd', system_prompt: 'p', score_dimensions: [], total_max_score: 100 };
  await host.invoke('essay_grading_create_custom_mode', { input: createInput });
  expect(essay.calls.createCustomMode).toEqual([[createInput]]);
  const updateInput = { id: 'mode_test', name: 'n2' };
  await host.invoke('essay_grading_update_custom_mode', { input: updateInput });
  expect(essay.calls.updateCustomMode).toEqual([[updateInput]]);
  await expect(host.invoke('essay_grading_delete_custom_mode', { modeId: 'mode_test' })).resolves.toBeNull();
  expect(essay.calls.deleteCustomMode).toEqual([['mode_test']]);
  await expect(host.invoke('essay_grading_list_custom_modes')).resolves.toEqual([MODE]);
  expect(essay.calls.listCustomModes).toEqual([[]]);

  const override = {
    builtin_id: 'builtin', name: 'n', description: 'd', system_prompt: 'p',
    score_dimensions: [], total_max_score: 100,
  };
  await host.invoke('essay_grading_save_builtin_override', { input: override });
  expect(essay.calls.saveBuiltinOverride).toEqual([[override]]);
  await host.invoke('essay_grading_reset_builtin_mode', { builtinId: 'builtin' });
  expect(essay.calls.resetBuiltinMode).toEqual([['builtin']]);
  await expect(host.invoke('essay_grading_has_builtin_override', { builtinId: 'builtin' })).resolves.toBe(false);
  expect(essay.calls.hasBuiltinOverride).toEqual([['builtin']]);
  await host.invoke('essay_grading_get_models');
  expect(essay.calls.getModels).toEqual([[]]);
});

it('essay_grading replies spell Rust f32 scores on the wire (overall_score 52.0, total_max_score 100.0, max_score 30.0)', async () => {
  const dims: Wire.ScoreDimension[] = [
    { name: '内容', max_score: 30, description: null },
    { name: '表达', max_score: Math.fround(33.3), description: '' },
  ];
  const mode: Wire.GradingMode = { ...MODE, score_dimensions: dims, total_max_score: 100 };
  const response: Wire.GradingResponse = {
    round_id: 'round_1', session_id: 'session_1', round_number: 1, grading_result: 'ok',
    overall_score: 52, dimension_scores_json: null, created_at: '2026-01-01T00:00:00Z',
  };
  const unscored: Wire.GradingRoundResponse = { ...ROUND, id: 'round_2', overall_score: null };
  const { host } = await setup({
    async stream() { return response; },
    async getRounds() { return [ROUND, unscored]; },
    async getRound(_sessionId, roundNumber) { return roundNumber === 1 ? ROUND : null; },
    async getModes() { return [mode]; },
    async getMode(modeId) { return modeId === 'mode_test' ? mode : null; },
    async createCustomMode() { return mode; },
    async updateCustomMode() { return mode; },
    async listCustomModes() { return [mode]; },
    async saveBuiltinOverride() { return mode; },
    async resetBuiltinMode() { return mode; },
  });
  let seq = 0;
  async function wire(cmd: string, args: Record<string, unknown> = {}): Promise<string | undefined> {
    const outcome = await host.runtime.dispatchInvoke({
      id: `essay-f32-${++seq}`, cmd, args, source: { window: 'main', webview: 'main' },
    });
    if (outcome.kind !== 'ok') throw new Error(`${cmd} failed: ${JSON.stringify(outcome)}`);
    return outcome.json;
  }
  const modeJson = '"score_dimensions":[{"name":"内容","max_score":30.0,"description":null},'
    + '{"name":"表达","max_score":33.3,"description":""}],"total_max_score":100.0,';

  const request = {
    session_id: 'session_1', stream_session_id: 'stream_1', round_number: 1,
    input_text: 'essay', essay_type: 'argument', grade_level: 'high',
  };
  expect(await wire('essay_grading_stream', { request })).toContain('"overall_score":52.0,');
  const rounds = await wire('essay_grading_get_rounds', { sessionId: 'session_1' });
  expect(rounds).toContain('"id":"round_1","session_id":"session_1","round_number":1,"input_text":"essay","grading_result":"ok","overall_score":88.0,');
  expect(rounds).toContain('"id":"round_2","session_id":"session_1","round_number":1,"input_text":"essay","grading_result":"ok","overall_score":null,');
  expect(await wire('essay_grading_get_round', { sessionId: 'session_1', roundNumber: 1 })).toContain('"overall_score":88.0,');
  await expect(host.invoke('essay_grading_get_round', { sessionId: 'session_1', roundNumber: 9 })).resolves.toBeNull();

  expect(await wire('essay_grading_get_modes')).toContain(modeJson);
  expect(await wire('essay_grading_get_mode', { modeId: 'mode_test' })).toContain(modeJson);
  await expect(host.invoke('essay_grading_get_mode', { modeId: 'missing' })).resolves.toBeNull();
  const createInput = { name: 'n', description: 'd', system_prompt: 'p', score_dimensions: [], total_max_score: 100 };
  expect(await wire('essay_grading_create_custom_mode', { input: createInput })).toContain(modeJson);
  expect(await wire('essay_grading_update_custom_mode', { input: { id: 'mode_test' } })).toContain(modeJson);
  expect(await wire('essay_grading_list_custom_modes')).toContain(modeJson);
  const override = {
    builtin_id: 'builtin', name: 'n', description: 'd', system_prompt: 'p', score_dimensions: [], total_max_score: 100,
  };
  expect(await wire('essay_grading_save_builtin_override', { input: override })).toContain(modeJson);
  expect(await wire('essay_grading_reset_builtin_mode', { builtinId: 'builtin' })).toContain(modeJson);

  await expect(host.invoke('essay_grading_get_mode', { modeId: 'mode_test' })).resolves.toEqual({
    ...mode, score_dimensions: [dims[0], { ...dims[1], max_score: 33.3 }],
  });
  expect(mode.total_max_score).toBe(100);
  expect(dims.map(dim => dim.max_score)).toEqual([30, Math.fround(33.3)]);
});

// essay_grading/events.rs:41 `Window::emit`：Tauri 2 默认 Emitter::emit 是全局广播，不限定到发起窗口（V03-05 同类）。
it('essay_grading_stream broadcasts emitted events like Rust Window::emit', async () => {
  const { host } = await setup();
  await host.invoke('essay_grading_stream', {
    request: {
      session_id: 's1', stream_session_id: 's', round_number: 1,
      input_text: 'essay', essay_type: 'argument', grade_level: 'high',
    },
  }, { window: 'main', webview: 'main' });
  expect(host.eventsNamed('essay_grading_stream_s')).toEqual([
    { type: 'data', chunk: 'x', char_count: 1 },
  ]);
  expect(host.events.at(-1)!.target).toEqual({ kind: 'Any' });
});

it('essay_grading_list_sessions forwards null options to the logic layer defaults', async () => {
  const { host, essay } = await setup();
  await host.invoke('essay_grading_list_sessions', {});
  expect(essay.calls.listSessions).toEqual([[null, null, null]]);
  await host.invoke('essay_grading_list_sessions', { offset: 10, limit: 5, query: ' essay ' });
  expect(essay.calls.listSessions).toEqual([[null, null, null], [10, 5, ' essay ']]);
});

it('insight commands delegate arguments and handler defaults', async () => {
  const { host, insight } = await setup();
  const draft = {
    title: 't', situation: 's', stuck_point: 'p', turning_point: 'tp', rule: 'r',
    validity_conditions: 'v', ownership: 'self_reported', evidence: [],
  };
  await expect(host.invoke('insight_create_draft', { input: draft })).resolves.toEqual(CARD);
  expect(insight.calls.createDraft).toEqual([[draft]]);

  const edits = { title: 'new' };
  await host.invoke('insight_confirm', { insightId: 'insight_1', edits });
  expect(insight.calls.confirm).toEqual([['insight_1', edits]]);
  await host.invoke('insight_confirm', { insightId: 'insight_1' });
  expect(insight.calls.confirm).toEqual([['insight_1', edits], ['insight_1', null]]);

  await host.invoke('insight_correct', { insightId: 'insight_1', input: edits });
  expect(insight.calls.correct).toEqual([['insight_1', edits]]);
  await expect(host.invoke('insight_delete', { insightId: 'insight_1' })).resolves.toBeNull();
  expect(insight.calls.delete).toEqual([['insight_1']]);
  await expect(host.invoke('insight_get', { insightId: 'insight_1' })).resolves.toEqual(CARD);
  expect(insight.calls.getInsight).toEqual([['insight_1']]);

  await host.invoke('insight_list', {});
  expect(insight.calls.listInsights).toEqual([[null, 100, 0]]);
  await host.invoke('insight_list', { status: 'confirmed', limit: 10, offset: 20 });
  expect(insight.calls.listInsights).toEqual([[null, 100, 0], ['confirmed', 10, 20]]);

  await host.invoke('insight_list_revisions', { insightId: 'insight_1' });
  expect(insight.calls.listRevisions).toEqual([['insight_1']]);
  await host.invoke('insight_list_evidence', { insightId: 'insight_1' });
  expect(insight.calls.listEvidence).toEqual([['insight_1']]);
  await host.invoke('insight_list_relations', { insightId: 'insight_1' });
  expect(insight.calls.listRelations).toEqual([['insight_1']]);
  await host.invoke('insight_list_events', { insightId: 'insight_1' });
  expect(insight.calls.listEvents).toEqual([['insight_1', 50]]);
  await host.invoke('insight_list_events', { insightId: 'insight_1', limit: 7 });
  expect(insight.calls.listEvents).toEqual([['insight_1', 50], ['insight_1', 7]]);

  await expect(host.invoke('insight_record_feedback', {
    insightId: 'insight_1', feedback: 'useful',
  })).resolves.toBeNull();
  expect(insight.calls.recordFeedback).toEqual([['insight_1', 'useful', null]]);
  await host.invoke('insight_record_feedback', {
    insightId: 'insight_1', feedback: 'useful', sessionId: 'session_1',
  });
  expect(insight.calls.recordFeedback).toEqual([
    ['insight_1', 'useful', null], ['insight_1', 'useful', 'session_1'],
  ]);

  await expect(host.invoke('insight_add_relation', {
    fromId: 'a', toId: 'b', relationType: 'same_method',
  })).resolves.toBe('rel_1');
  expect(insight.calls.addRelation).toEqual([['a', 'b', 'same_method', null, null]]);

  await expect(host.invoke('insight_run_jobs', {})).resolves.toBe(4);
  expect(insight.calls.runJobs).toEqual([[5]]);
  await host.invoke('insight_run_jobs', { batchSize: 12 });
  expect(insight.calls.runJobs).toEqual([[5], [12]]);
});

it('foreign command layers fail with the Rust VFS error when services are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-foreign-missing-'));
  dirs.push(dir);
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const host = await createTestHost({ plugins: [review], provide: { storage } });
  hosts.push(host);
  for (const [cmd, args] of [
    ['essay_grading_get_modes', {}],
    ['essay_grading_get_session', { sessionId: 's' }],
    ['insight_get', { insightId: 'i' }],
    ['insight_list', {}],
  ] as const) {
    await expect(host.invoke(cmd, args)).rejects.toMatchObject({
      error_type: 'Database', message: 'VFS 数据库未初始化',
    });
  }
});
