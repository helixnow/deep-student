import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11 真实的作文仓储（Rust VfsEssayRepo 的移植）
import { EssayRepo } from '../../vfs-repos/repository/essays.ts';
import review from '../index.ts';
import {
  ESSAY_TOOL_NAMES, extractOverallScore, extractResultText, f32Json, normalizeResponseLanguage, truncateEssayChars,
} from '../src/essay-tool-executor.ts';

type Storage = ReturnType<typeof createStorageService>;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function vfsStorage(): Storage {
  const root = mkdtempSync(join(tmpdir(), 'essay-tool-tests-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  const dir = 'resources/app/migrations/vfs';
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  cleanups.push(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return storage;
}

const MODES: Wire.GradingMode[] = [{
  id: 'practice', name: '日常练习', description: '默认', system_prompt: 'p', total_max_score: 100, is_builtin: true,
  score_dimensions: [{ name: '内容', max_score: 60, description: null }, { name: '语言', max_score: 40, description: null }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}, {
  id: 'ielts', name: 'IELTS', description: 'Task 2', system_prompt: 'p', total_max_score: 9, is_builtin: true,
  score_dimensions: [{ name: 'TR', max_score: 9, description: null }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}];

const CUSTOM_MODES: Wire.GradingMode[] = [{
  id: 'my_rubric', name: 'Mine', description: '', system_prompt: 'p', total_max_score: 10, is_builtin: false,
  score_dimensions: [{ name: 'C', max_score: 10, description: null }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}];

interface GradingScript { requests: Wire.GradingRequest[]; next: 'ok' | 'fail' | 'pending' }

async function installReview(withVfs = true) {
  const storage = vfsStorage();
  const conn = storage.database('vfs');
  const repo = new EssayRepo();
  const script: GradingScript = { requests: [], next: 'ok' };
  const grading = {
    async stream(request: Wire.GradingRequest): Promise<Wire.GradingResponse | null> {
      script.requests.push(request);
      if (script.next === 'pending') return new Promise(() => undefined);
      if (script.next === 'fail') throw Object.assign(new Error('raw'), { value: { error_type: 'LLM', message: '模型调用失败', details: null } });
      const essay = repo.createEssay(conn, {
        content: request.input_text, sessionId: request.session_id, roundNumber: request.round_number,
        gradingResult: { result: `## 第${request.round_number}轮批改\n结构清晰`, overall_score: 85.3 },
        score: 85, dimensionScores: [{ name: '内容', score: 50 }],
      });
      return { round_id: essay.id, session_id: request.session_id, round_number: request.round_number,
        grading_result: '', overall_score: Math.fround(85.3), dimension_scores_json: null, created_at: essay.createdAt };
    },
    getModes: async () => MODES,
    getMode: async (id: string) => MODES.find(mode => mode.id === (id.trim() === 'ielts_task2' ? 'ielts' : id.trim())) ?? null,
    listCustomModes: async () => CUSTOM_MODES,
  };
  const registered: AgentToolExecutor[] = [];
  const host = await createTestHost({
    plugins: [review],
    provide: {
      storage,
      ...(withVfs ? { vfsRepo: { essays: repo } } : {}),
      essayGrading: grading,
      agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => {
        registered.push(...executors);
        return { dispose: () => undefined };
      } },
    },
  });
  cleanups.push(() => host.dispose());
  const executor = registered.find(entry => entry.name() === 'EssayGradingExecutor') as ToolExecutor | undefined;
  if (executor === undefined) throw new Error('EssayGradingExecutor was not registered');
  return { host, conn, repo, executor, script };
}

async function call(executor: ToolExecutor, name: string, args: unknown) {
  const recorded = { errors: [] as string[], saved: [] as ToolResultInfo[] };
  const ctx = {
    session_id: 's', message_id: 'm', block_id: 'b', tool_call_id: 'call_e',
    tryWindow: () => ({ window: 'main', webview: 'main' }), runId: () => 'call_e', isCancelled: () => false,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: (result: ToolResultInfo) => { recorded.saved.push(result); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: 'call_e', name, arguments: args }, ctx);
  return { result, recorded, output: result.output as Record<string, any> };
}

const settle = () => new Promise(resolve => { setImmediate(resolve); });

describe('EssayGradingExecutor definition', () => {
  it('matches the core tool set, the frontend schema set and per-tool sensitivity', async () => {
    const extensionTools = new Set<string>([
      'essay_delete_session', 'essay_create_custom_mode', 'essay_update_custom_mode', 'essay_delete_custom_mode',
    ]);
    expect([...ESSAY_TOOL_NAMES].filter(name => !extensionTools.has(name)))
      .toEqual(['essay_grade', 'essay_grade_status', 'essay_grade_wait', 'essay_list_modes', 'essay_list_sessions',
        'essay_list_results', 'essay_get_result']);
    const skill = readFileSync('src/features/chat/skills/builtin-tools/essay-grading.ts', 'utf8');
    const schemas = [...skill.slice(skill.indexOf('embeddedTools')).matchAll(/name: 'builtin-([a-z_]+)'/g)].map(m => m[1]);
    expect(schemas.sort()).toEqual([...ESSAY_TOOL_NAMES].sort());
    const { executor } = await installReview();
    expect(executor.sensitivityLevel!('builtin-essay_grade')).toBe('medium');
    for (const name of ESSAY_TOOL_NAMES.filter(name => !extensionTools.has(name) && name !== 'essay_grade')) {
      expect(executor.sensitivityLevel!(name)).toBe('low');
    }
    expect(executor.sensitivityLevel!('essay_create_custom_mode')).toBe('medium');
    expect(executor.sensitivityLevel!('essay_update_custom_mode')).toBe('medium');
    expect(executor.sensitivityLevel!('essay_delete_session')).toBe('high');
    expect(executor.sensitivityLevel!('essay_delete_custom_mode')).toBe('high');
    expect(executor.canHandle('essay_delete_session')).toBe(true);
  });

  it('essay_delete_session soft-deletes the session', async () => {
    const { executor, repo, conn } = await installReview();
    const session = repo.createSession(conn, { title: '待删除', essayType: null, gradeLevel: null, customPrompt: null });
    const deleted = await call(executor, 'essay_delete_session', { session_id: session.id });
    expect(deleted.result.success).toBe(true);
    expect(deleted.output).toMatchObject({ success: true, session_id: session.id, reversibility: 'soft_delete' });
    expect(repo.getSession(conn, session.id)).toBeNull();
  });

  it('ports the Rust helpers', () => {
    expect(['en-US', ' en ', 'English', 'zh-CN', 'zh-Hans', 'fr-FR', ''].map(normalizeResponseLanguage))
      .toEqual(['en-US', 'en-US', 'en-US', 'zh-CN', 'zh-CN', null, null]);
    expect(normalizeResponseLanguage(null)).toBeNull();
    expect(truncateEssayChars('短文本', 100)).toBe('短文本');
    expect(truncateEssayChars('很'.repeat(300), 100)).toBe(`${'很'.repeat(100)}…（已截断，完整内容请用 essay_get_result 查询）`);
    expect(extractResultText({ result: '## 批改结果\n总体不错', overall_score: 42.5 })).toBe('## 批改结果\n总体不错');
    expect(extractResultText(null)).toBe('');
    expect(extractOverallScore({ overall_score: 85.3 }, 10)).toBe(85.3);
    expect(extractOverallScore({}, 72)).toBe(72);
    expect(extractOverallScore(null, null)).toBeNull();
    expect(f32Json(Math.fround(0.1))).toBe(0.1);
  });
});

describe('EssayGradingExecutor through the review plugin', () => {
  it('grades in the background, waits for completion and reads sessions, rounds and results', async () => {
    const { executor, script } = await installReview();
    const started = await call(executor, 'builtin-essay_grade', {
      text: '  春天来了，万物复苏。  ', mode_id: 'ielts_task2', response_language: 'English', essay_type: '记叙文',
    });
    expect(started.output).toMatchObject({ status: 'started', round_number: 1, message: '批改任务已在后台启动' });
    expect(started.output.task_id).toMatch(/^essaytask_[0-9a-f]{32}$/);
    expect(script.requests[0]).toMatchObject({
      session_id: started.output.session_id, stream_session_id: `agent_${started.output.task_id}`, round_number: 1,
      input_text: '春天来了，万物复苏。', mode_id: 'ielts', essay_type: '记叙文', grade_level: '', response_language: 'en-US',
      previous_result: null, previous_input: null, image_base64_list: null,
    });
    await settle();
    const waited = await call(executor, 'essay_grade_wait', { task_id: started.output.task_id });
    expect(waited.output).toMatchObject({
      task_id: started.output.task_id, status: 'completed', session_id: started.output.session_id, round_number: 1,
      overall_score: 85.3, grading_result: '## 第1轮批改\n结构清晰', dimension_scores: [{ name: '内容', score: 50 }],
    });
    expect(typeof waited.output.finished_at_ms).toBe('number');

    const second = await call(executor, 'essay_grade', { text: '春天来了，万物复苏，鸟儿歌唱。', session_id: started.output.session_id });
    expect(second.output.round_number).toBe(2);
    expect(script.requests[1]).toMatchObject({ previous_result: '## 第1轮批改\n结构清晰', previous_input: '春天来了，万物复苏。' });
    await settle();

    const sessions = await call(executor, 'essay_list_sessions', { page_size: 50 });
    expect(sessions.output).toMatchObject({ count: 1, total: 1, page: 1, pageSize: 20, hasMore: false });
    expect(sessions.output.sessions[0]).toMatchObject({ session_id: started.output.session_id, title: '作文批改：春天来了，万物复苏。',
      essay_type: '记叙文', grade_level: '' });
    const results = await call(executor, 'essay_list_results', { session_id: started.output.session_id });
    expect(results.output).toMatchObject({ count: 2, total: 2, hasMore: false });
    const latest = await call(executor, 'essay_get_result', { session_id: started.output.session_id });
    expect(latest.output).toMatchObject({ round_number: 2, input_text: '春天来了，万物复苏，鸟儿歌唱。', inputTextTruncated: false,
      grading_result: '## 第2轮批改\n结构清晰', overall_score: 85.3, dimension_scores: [{ name: '内容', score: 50 }] });
    const byDb = await call(executor, 'essay_grade_status', { session_id: started.output.session_id, round_number: 1 });
    expect(byDb.output).toMatchObject({ status: 'completed', round_number: 1, source: 'vfs_db', overall_score: 85.3 });
    const missing = await call(executor, 'essay_grade_status', { session_id: started.output.session_id, round_number: 9 });
    expect(missing.output).toMatchObject({ status: 'not_found', round_number: 9 });
    const modes = await call(executor, 'essay_list_modes', {});
    expect(modes.output).toMatchObject({ count: 2, modes: [{ id: 'practice', total_max_score: 100, is_builtin: true,
      dimensions: [{ name: '内容', max_score: 60 }, { name: '语言', max_score: 40 }] }, { id: 'ielts' }] });
  });

  it('canonicalizes mode ids with the llm resolver (built-in aliases and custom modes) like resolve_grading_mode', async () => {
    const { executor, script } = await installReview();
    const alias = await call(executor, 'essay_grade', { text: '内容', mode_id: ' cet46 ' });
    expect(alias.result.success).toBe(true);
    expect(script.requests.at(-1)?.mode_id).toBe('cet');
    await settle();
    const custom = await call(executor, 'essay_grade', { text: '内容', mode_id: 'my_rubric' });
    expect(custom.result.success).toBe(true);
    expect(script.requests.at(-1)?.mode_id).toBe('my_rubric');
  });

  it('rejects unknown modes before creating a session and reports pipeline failures as tool errors', async () => {
    const { executor, conn, script } = await installReview();
    const unknown = await call(executor, 'essay_grade', { text: '内容', mode_id: ' toefl_x ' });
    expect(unknown.result.success).toBe(false);
    expect(JSON.parse(unknown.result.error!)).toMatchObject({ error_type: 'Validation', details: {
      code: 'ESSAY_MODE_NOT_FOUND', field: 'mode_id', mode_id: ' toefl_x ', canonical_mode_id: 'toefl_x',
      messageKey: 'chat.tools.essay.errors.modeNotFound', messageParams: { modeId: 'toefl_x' } } });
    expect(conn.pluck('SELECT COUNT(*) FROM essay_sessions')).toBe(0);
    expect(script.requests).toEqual([]);

    script.next = 'fail';
    const failing = await call(executor, 'essay_grade', { text: '内容' });
    await settle();
    const failed = await call(executor, 'essay_grade_wait', { task_id: failing.output.task_id });
    expect(failed.result).toMatchObject({ success: false, error: '批改任务失败：模型调用失败' });

    script.next = 'pending';
    const pending = await call(executor, 'essay_grade', { text: '内容' });
    const timeout = await call(executor, 'essay_grade_wait', { task_id: pending.output.task_id, timeout_ms: 0 });
    expect(timeout.output).toMatchObject({ status: 'timeout', message: '等待 0ms 后批改仍未完成。可再次调用 essay_grade_wait 继续等待，或用 essay_grade_status 查询。' });

    const errors: [string, unknown, string][] = [
      ['essay_grade', { text: '   ' }, "Missing 'text' parameter（作文正文不能为空）"],
      ['essay_grade', { text: '字'.repeat(50_001) }, '作文长度超限：50001 字符（上限 50000 字符）'],
      ['essay_grade', { text: '内容', session_id: 'missing' }, '批改会话不存在: missing（请先用 essay_list_sessions 查询）'],
      ['essay_grade_status', {}, '必须提供 task_id 或 session_id 之一'],
      ['essay_grade_wait', { task_id: 'gone' }, '任务不在运行注册表中，且未提供 session_id。请传 task_id（本次会话内有效）或 session_id + round_number。'],
      ['essay_get_result', { session_id: 'missing' }, '轮次不存在: session=missing, round=0（用 essay_list_results 查看可用轮次）'],
      ['essay_list_results', {}, "Missing 'session_id' parameter"],
      ['essay_unknown', {}, 'Unknown essay tool: essay_unknown'],
    ];
    for (const [name, args, error] of errors) {
      const { result, recorded } = await call(executor, name, args);
      expect({ name, success: result.success, error: result.error }).toEqual({ name, success: false, error });
      expect(recorded.errors).toEqual([error]);
    }
  });

  it('fails closed without the VFS repository', async () => {
    const { executor } = await installReview(false);
    const { result } = await call(executor, 'essay_list_sessions', {});
    expect(result).toMatchObject({ success: false, error: 'VFS database not available' });
  });
});
