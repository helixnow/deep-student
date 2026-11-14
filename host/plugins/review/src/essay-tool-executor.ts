/**
 * `essay_*` agent tools — Rust `src-tauri/src/chat_v2/tools/essay_grading_executor.rs`.
 *
 * `essay_grade` starts the grading pipeline in the background and returns a task id;
 * `essay_grade_wait` / `essay_grade_status` read the in-process task registry and fall back
 * to the persisted rounds. Session and round reads go straight to the VFS essay repository
 * (Rust `VfsEssayRepo`); the pipeline and grading modes come from the `essayGrading` service.
 */
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { AppError, strip_tool_namespace } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { charCount, rustTrim, takeChars } from '../../../platform/util/portable.ts';
import type { EssayRepository, VfsEssay } from '../../vfs-repos/api.ts';
import { EssayGradingError, f32Json, resolveGradingMode, type GradingMode } from '../../llm/api.ts';
import {
  argsObject, asI64, asStr, asU64, runToolWithEvents, toolErrorText, type ToolLog,
} from './tool-execution.ts';

/** essay_grading_executor.rs:52 — 与 pipeline MAX_INPUT_CHARS 一致。 */
const MAX_ESSAY_CHARS = 50_000;
const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
/** Must stay below the 120 s registry timeout. */
const MAX_WAIT_TIMEOUT_MS = 100_000;
const MAX_RESULT_CHARS_IN_TOOL_OUTPUT = 2_000;
const POLL_INTERVAL_MS = 1_000;

export const ESSAY_TOOL_NAMES = [
  'essay_grade', 'essay_grade_status', 'essay_grade_wait', 'essay_list_modes', 'essay_list_sessions',
  'essay_list_results', 'essay_get_result', 'essay_delete_session', 'essay_create_custom_mode',
  'essay_update_custom_mode', 'essay_delete_custom_mode',
] as const;

export interface EssayToolGrading {
  stream(request: Wire.GradingRequest, emit: (event: string, payload: unknown) => void,
    signal: AbortSignal): Promise<Wire.GradingResponse | null>;
  getModes(): Promise<Wire.GradingMode[]>;
  /** `CustomModeManager::list_modes` (custom modes and built-in overrides). */
  listCustomModes(): Promise<Wire.GradingMode[]>;
  createCustomMode(input: Wire.CreateModeInput): Promise<Wire.GradingMode>;
  updateCustomMode(input: Wire.UpdateModeInput): Promise<Wire.GradingMode>;
  deleteCustomMode(modeId: string): Promise<void>;
}

export interface EssayToolDeps {
  /** `ctx.vfs_db` + `VfsEssayRepo`; `null` ⇔ "VFS database not available". */
  essays(): { conn: SqlExecutor; repo: EssayRepository } | null;
  /** `null` ⇔ `ctx.llm_manager == None`. */
  grading(): EssayToolGrading | null;
  /** Window event emitter used by the grading stream (`GradingEventEmitter`). */
  emit(event: string, payload: unknown): void;
  /** `tokio::spawn`. */
  spawn(task: () => Promise<void>): void;
  sleep?(ms: number): Promise<void>;
  log: ToolLog;
}

interface EssayTaskState {
  session_id: string;
  round_number: number;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  round_id: string | null;
  overall_score: number | null;
  error: string | null;
  started_at_ms: number;
  finished_at_ms: number | null;
}

type Args = Record<string, unknown>;

/** essay_grading_executor.rs:89 `truncate_chars`. */
export function truncateEssayChars(value: string, maxChars: number): string {
  if (charCount(value) <= maxChars) return value;
  return `${takeChars(value, maxChars)}…（已截断，完整内容请用 essay_get_result 查询）`;
}

/** essay_grading_executor.rs:109 `normalize_response_language`. */
export function normalizeResponseLanguage(raw: string | null): string | null {
  if (raw === null) return null;
  const lang = rustTrim(raw).replace(/[A-Z]/g, ch => ch.toLowerCase());
  if (lang.startsWith('zh') || lang === 'chinese') return 'zh-CN';
  if (lang.startsWith('en')) return 'en-US';
  return null;
}

/** essay_grading_executor.rs:120 `read_bounded_u32`. */
function readBoundedU32(args: Args, key: string, defaultValue: number, min: number, max: number): number {
  const raw = asI64(args[key]) ?? defaultValue;
  return Math.min(max, Math.max(min, raw < min ? min : raw));
}

export { f32Json };

function modeFromWire(mode: Wire.GradingMode): GradingMode {
  return {
    id: mode.id, name: mode.name, description: mode.description, systemPrompt: mode.system_prompt,
    scoreDimensions: mode.score_dimensions.map(dim => ({ name: dim.name, maxScore: dim.max_score, description: dim.description ?? null })),
    totalMaxScore: mode.total_max_score, isBuiltin: mode.is_builtin, createdAt: mode.created_at, updatedAt: mode.updated_at,
  };
}

function resultObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredTextArg(args: Args, key: string, maxChars: number): string {
  const value = asStr(args[key]);
  const trimmed = value === null ? '' : rustTrim(value);
  if (trimmed === '') throw new Error(`Missing '${key}' parameter（${key} 不能为空）`);
  if (charCount(trimmed) > maxChars) throw new Error(`${key} 最多 ${maxChars} 个字符`);
  return trimmed;
}

function optionalTextArg(args: Args, key: string, maxChars: number): string | null {
  if (!Object.hasOwn(args, key)) return null;
  const value = args[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  const trimmed = rustTrim(value);
  if (charCount(trimmed) > maxChars) throw new Error(`${key} 最多 ${maxChars} 个字符`);
  return trimmed;
}

function scoreValue(value: unknown, field: string, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing '${field}' parameter（${field} 不能为空）`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000) {
    throw new Error(`${field} 必须是 0 到 1000 之间的正数`);
  }
  return value;
}

/** Parses `dimensions` into the wire shape, preserving order. */
function dimensionsArg(args: Args): Wire.ScoreDimension[] | null {
  const raw = args.dimensions;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('dimensions 必须是非空数组');
  if (raw.length > 20) throw new Error('dimensions 最多 20 项');
  const names = new Set<string>();
  return raw.map((entry, index) => {
    const item = resultObject(entry);
    if (item === null) throw new Error(`dimensions[${index}] 必须是对象`);
    const name = requiredTextArg(item, 'name', 100);
    if (names.has(name)) throw new Error(`dimensions 名称重复: ${name}`);
    names.add(name);
    const maxScore = scoreValue(item['max_score'] ?? item['maxScore'],
      `dimensions[${index}].max_score`, true)!;
    const description = optionalTextArg(item, 'description', 1_000);
    return { name, max_score: maxScore, description };
  });
}

function modeSummary(mode: Wire.GradingMode): Record<string, unknown> {
  return {
    id: mode.id, name: mode.name, description: mode.description,
    total_max_score: f32Json(mode.total_max_score), is_builtin: mode.is_builtin,
    dimensions: mode.score_dimensions.map(dimension => ({
      name: dimension.name, max_score: f32Json(dimension.max_score), description: dimension.description,
    })),
    created_at: mode.created_at, updated_at: mode.updated_at,
  };
}

/** essay_grading_executor.rs:130 `extract_result_text`. */
export function extractResultText(gradingResult: unknown): string {
  const result = resultObject(gradingResult)?.result;
  return typeof result === 'string' ? result : '';
}

/** essay_grading_executor.rs:139 `extract_overall_score`. */
export function extractOverallScore(gradingResult: unknown, score: number | null | undefined): number | null {
  const overall = resultObject(gradingResult)?.overall_score;
  if (typeof overall === 'number') return f32Json(overall);
  return score === null || score === undefined ? null : f32Json(score);
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export class EssayGradingExecutor implements ToolExecutor {
  private readonly deps: EssayToolDeps;
  /** essay_grading_executor.rs:84 `ESSAY_TASKS` (task_id → state). */
  private readonly tasks = new Map<string, EssayTaskState>();

  constructor(deps: EssayToolDeps) { this.deps = deps; }

  name(): string { return 'EssayGradingExecutor'; }

  canHandle(toolName: string): boolean {
    return (ESSAY_TOOL_NAMES as readonly string[]).includes(strip_tool_namespace(toolName));
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    const bare = strip_tool_namespace(toolName);
    if (bare === 'essay_grade' || bare === 'essay_create_custom_mode' || bare === 'essay_update_custom_mode') {
      return 'medium';
    }
    if (bare === 'essay_delete_session' || bare === 'essay_delete_custom_mode') return 'high';
    return 'low';
  }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const toolName = strip_tool_namespace(call.name);
    return runToolWithEvents(this.name(), toolName, call, ctx, this.deps.log, async () => {
      const args = argsObject(call.arguments);
      switch (toolName) {
        case 'essay_grade': return this.grade(args, ctx);
        case 'essay_grade_status': return this.gradeStatus(args);
        case 'essay_grade_wait': return this.gradeWait(args, ctx);
        case 'essay_list_modes': return this.listModes();
        case 'essay_list_sessions': return this.listSessions(args);
        case 'essay_list_results': return this.listResults(args);
        case 'essay_get_result': return this.getResult(args);
        case 'essay_delete_session': return this.deleteSession(args);
        case 'essay_create_custom_mode': return this.createCustomMode(args);
        case 'essay_update_custom_mode': return this.updateCustomMode(args);
        case 'essay_delete_custom_mode': return this.deleteCustomMode(args);
        default: throw new Error(`Unknown essay tool: ${toolName}`);
      }
    });
  }

  private essays(): { conn: SqlExecutor; repo: EssayRepository } {
    const essays = this.deps.essays();
    if (essays === null) throw new Error('VFS database not available');
    return essays;
  }

  /** `get_round` with the repository contract: no round below 1 exists. */
  private round(essays: { conn: SqlExecutor; repo: EssayRepository }, sessionId: string, round: number): VfsEssay | null {
    return round < 1 ? null : essays.repo.getRound(essays.conn, sessionId, round);
  }

  /** essay_grading_executor.rs:201 `canonicalize_requested_mode_id`. */
  private async canonicalModeId(grading: EssayToolGrading, requested: string | null): Promise<string | null> {
    if (requested === null) return null;
    const customModes = (await grading.listCustomModes()).map(modeFromWire);
    try {
      return resolveGradingMode(requested, customModes).id;
    } catch (error) {
      if (!(error instanceof EssayGradingError)) throw error;
      throw new Error(JSON.stringify(AppError.with_details(error.errorType, error.message, error.details)));
    }
  }

  private async grade(args: Args, ctx: ExecutionContext): Promise<unknown> {
    const rawText = asStr(args.text);
    const text = rawText === null ? '' : rustTrim(rawText);
    if (text === '') throw new Error("Missing 'text' parameter（作文正文不能为空）");
    const chars = charCount(text);
    if (chars > MAX_ESSAY_CHARS) throw new Error(`作文长度超限：${chars} 字符（上限 ${MAX_ESSAY_CHARS} 字符）`);
    const essays = this.essays();
    const grading = this.deps.grading();
    if (grading === null) throw new Error('LLM Manager not available');
    const modeId = await this.canonicalModeId(grading, asStr(args.mode_id));
    const topic = asStr(args.topic);
    const essayType = asStr(args.essay_type) ?? '';
    const gradeLevel = asStr(args.grade_level) ?? '';
    const customPrompt = asStr(args.custom_prompt);
    const rawModel = asStr(args.model_config_id);
    const modelConfigId = rawModel === null || rustTrim(rawModel) === '' ? null : rustTrim(rawModel);
    const responseLanguage = normalizeResponseLanguage(asStr(args.response_language));
    const sessionArg = asStr(args.session_id);

    let sessionId: string;
    let roundNumber: number;
    let previousResult: string | null = null;
    let previousInput: string | null = null;
    if (sessionArg !== null) {
      let session;
      try { session = essays.repo.getSession(essays.conn, sessionArg); }
      catch (error) { throw new Error(`获取批改会话失败: ${toolErrorText(error)}`); }
      if (session === null) throw new Error(`批改会话不存在: ${sessionArg}（请先用 essay_list_sessions 查询）`);
      let latest: number;
      try { latest = essays.repo.getLatestRoundNumber(essays.conn, session.id); }
      catch (error) { throw new Error(`获取最新轮次失败: ${toolErrorText(error)}`); }
      try {
        const previous = this.round(essays, session.id, latest);
        if (previous !== null) {
          const previousText = extractResultText(previous.gradingResult);
          previousResult = previousText === '' ? null : previousText;
          try { previousInput = essays.repo.getEssayContent(essays.conn, previous.id); }
          catch { previousInput = null; }
        }
      } catch {
        previousResult = null;
        previousInput = null;
      }
      sessionId = session.id;
      roundNumber = latest + 1;
    } else {
      const rawTitle = asStr(args.title);
      const title = rawTitle !== null && rustTrim(rawTitle) !== '' ? rustTrim(rawTitle) : `作文批改：${takeChars(text, 20)}`;
      let session;
      try {
        session = essays.repo.createSession(essays.conn, {
          title, essayType: essayType === '' ? null : essayType, gradeLevel: gradeLevel === '' ? null : gradeLevel,
          customPrompt,
        });
      } catch (error) { throw new Error(`创建批改会话失败: ${toolErrorText(error)}`); }
      sessionId = session.id;
      roundNumber = 1;
    }

    const taskId = `essaytask_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
    this.tasks.set(taskId, {
      session_id: sessionId, round_number: roundNumber, status: 'running', round_id: null, overall_score: null,
      error: null, started_at_ms: Date.now(), finished_at_ms: null,
    });
    const request: Wire.GradingRequest = {
      session_id: sessionId, stream_session_id: `agent_${taskId}`, round_number: roundNumber, input_text: text,
      topic, mode_id: modeId, model_config_id: modelConfigId, essay_type: essayType, grade_level: gradeLevel,
      custom_prompt: customPrompt, previous_result: previousResult, previous_input: previousInput,
      image_base64_list: null, topic_image_base64_list: null, response_language: responseLanguage,
    };
    const windowed = ctx.tryWindow() !== null;
    const emit = (event: string, payload: unknown): void => { if (windowed) this.deps.emit(event, payload); };
    this.deps.spawn(async () => {
      let outcome: { response: Wire.GradingResponse | null } | { error: string };
      try { outcome = { response: await grading.stream(request, emit, new AbortController().signal) }; }
      catch (error) { outcome = { error: essayErrorText(error) }; }
      const state = this.tasks.get(taskId);
      if (state === undefined) return;
      state.finished_at_ms = Date.now();
      if ('error' in outcome) {
        state.status = 'error';
        state.error = outcome.error;
        this.deps.log.error(`[EssayGradingExecutor] 后台批改失败: ${outcome.error}`);
      } else if (outcome.response === null) {
        state.status = 'cancelled';
      } else {
        state.status = 'completed';
        state.round_id = outcome.response.round_id;
        state.overall_score = outcome.response.overall_score === null ? null : f32Json(outcome.response.overall_score);
      }
    });
    return {
      status: 'started',
      task_id: taskId,
      session_id: sessionId,
      round_number: roundNumber,
      message: '批改任务已在后台启动',
      hint: '下一轮调用 essay_grade_wait（传 task_id）等待批改完成；完成后可将批改指出的错误点整理为题目，用 qbank_batch_import 入错题本，再用 review_schedule 安排间隔复习。',
    };
  }

  /** essay_grading_executor.rs:447 `resolve_task_state`. */
  private resolveTaskState(taskId: string | null, sessionId: string | null, roundNumber: number | null): Record<string, unknown> {
    if (taskId !== null) {
      const state = this.tasks.get(taskId);
      if (state !== undefined) {
        const payload: Record<string, unknown> = {
          task_id: taskId, status: state.status, session_id: state.session_id, round_number: state.round_number,
          started_at_ms: state.started_at_ms,
        };
        if (state.round_id !== null) payload.round_id = state.round_id;
        if (state.overall_score !== null) payload.overall_score = state.overall_score;
        if (state.error !== null) payload.error = state.error;
        if (state.finished_at_ms !== null) payload.finished_at_ms = state.finished_at_ms;
        return payload;
      }
    }
    if (sessionId === null) {
      throw new Error('任务不在运行注册表中，且未提供 session_id。请传 task_id（本次会话内有效）或 session_id + round_number。');
    }
    const essays = this.essays();
    let round = roundNumber;
    if (round === null) {
      try { round = essays.repo.getLatestRoundNumber(essays.conn, sessionId); }
      catch (error) { throw new Error(`获取最新轮次失败: ${toolErrorText(error)}`); }
    }
    let essay: VfsEssay | null;
    try { essay = this.round(essays, sessionId, round); }
    catch (error) { throw new Error(`查询批改轮次失败: ${toolErrorText(error)}`); }
    if (essay !== null) {
      return {
        status: 'completed', session_id: sessionId, round_number: round, round_id: essay.id,
        overall_score: extractOverallScore(essay.gradingResult, essay.score), source: 'vfs_db',
      };
    }
    return {
      status: 'not_found', session_id: sessionId, round_number: round,
      message: '该轮次尚未落库（可能仍在批改中或已失败）。若刚发起批改，请稍后再查询。',
    };
  }

  private gradeStatus(args: Args): unknown {
    const taskId = asStr(args.task_id);
    const sessionId = asStr(args.session_id);
    const roundNumber = i32Arg(args.round_number);
    if (taskId === null && sessionId === null) throw new Error('必须提供 task_id 或 session_id 之一');
    return this.resolveTaskState(taskId, sessionId, roundNumber);
  }

  private async gradeWait(args: Args, ctx: ExecutionContext): Promise<unknown> {
    const taskId = asStr(args.task_id);
    const sessionId = asStr(args.session_id);
    if (taskId === null && sessionId === null) throw new Error('必须提供 task_id 或 session_id 之一');
    const roundNumber = i32Arg(args.round_number);
    const timeoutMs = Math.min(asU64(args.timeout_ms) ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const sleep = this.deps.sleep ?? defaultSleep;
    for (;;) {
      if (ctx.isCancelled()) throw new Error('Tool execution cancelled');
      const state = this.resolveTaskState(taskId, sessionId, roundNumber);
      const status = typeof state.status === 'string' ? state.status : 'unknown';
      if (status === 'completed') {
        const payload = { ...state };
        const sid = typeof state.session_id === 'string' ? state.session_id : '';
        const round = typeof state.round_number === 'number' ? state.round_number : 0;
        const essays = this.deps.essays();
        if (essays !== null) {
          let essay: VfsEssay | null = null;
          try { essay = this.round(essays, sid, round); } catch { essay = null; }
          if (essay !== null) {
            payload.grading_result = truncateEssayChars(extractResultText(essay.gradingResult), MAX_RESULT_CHARS_IN_TOOL_OUTPUT);
            if (essay.dimensionScores !== undefined && essay.dimensionScores !== null) {
              payload.dimension_scores = essay.dimensionScores;
            }
          }
        }
        payload.hint = '批改完成。建议后续链路：1) 从批改结果中提取错误点/薄弱项，用 qbank_batch_import 转为错题入题库；2) 对入库题目调用 review_schedule 安排间隔复习。';
        return payload;
      }
      if (status === 'error' || status === 'cancelled') {
        const detail = typeof state.error === 'string' ? state.error : '';
        throw new Error(`批改任务${status === 'error' ? '失败' : '已取消'}${detail === '' ? '。' : `：${detail}`}`);
      }
      if (Date.now() >= deadline) {
        return {
          ...state, status: 'timeout',
          message: `等待 ${timeoutMs}ms 后批改仍未完成。可再次调用 essay_grade_wait 继续等待，或用 essay_grade_status 查询。`,
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async listModes(): Promise<unknown> {
    const grading = this.deps.grading();
    if (grading === null) throw new Error('Essay grading service not available');
    const modes = await grading.getModes();
    const items = modes.map(mode => ({
      id: mode.id, name: mode.name, description: mode.description, total_max_score: mode.total_max_score,
      is_builtin: mode.is_builtin,
      dimensions: mode.score_dimensions.map(dimension => ({ name: dimension.name, max_score: dimension.max_score })),
    }));
    return { modes: items, count: items.length, hint: '调用 essay_grade 时通过 mode_id 指定批阅模式；不传则使用默认通用模式。' };
  }

  private listSessions(args: Args): unknown {
    const essays = this.essays();
    const page = readBoundedU32(args, 'page', 1, 1, 0xffff_ffff);
    const pageSize = readBoundedU32(args, 'page_size', 20, 1, 20);
    const offset = Math.min((page - 1) * pageSize, 0xffff_ffff);
    let sessions;
    try { sessions = essays.repo.listSessions(essays.conn, pageSize, offset); }
    catch (error) { throw new Error(`查询批改会话失败: ${toolErrorText(error)}`); }
    let total: number;
    try { total = essays.repo.countSessions(essays.conn); }
    catch (error) { throw new Error(`统计批改会话失败: ${toolErrorText(error)}`); }
    const items = sessions.map(session => ({
      session_id: session.id, title: session.title, essay_type: session.essay_type, grade_level: session.grade_level,
      total_rounds: session.total_rounds, latest_score: session.latest_score ?? null, created_at: session.created_at,
      updated_at: session.updated_at,
    }));
    return { sessions: items, count: items.length, total, page, pageSize, hasMore: offset + items.length < total };
  }

  private listResults(args: Args): unknown {
    const sessionId = asStr(args.session_id);
    if (sessionId === null) throw new Error("Missing 'session_id' parameter");
    const essays = this.essays();
    const page = readBoundedU32(args, 'page', 1, 1, 0xffff_ffff);
    const pageSize = readBoundedU32(args, 'page_size', 20, 1, 20);
    const offset = Math.min((page - 1) * pageSize, 0xffff_ffff);
    let rounds;
    try { rounds = essays.repo.listRoundsBySession(essays.conn, sessionId, pageSize, offset); }
    catch (error) { throw new Error(`查询批改轮次失败: ${toolErrorText(error)}`); }
    let total: number;
    try { total = essays.repo.countRoundsBySession(essays.conn, sessionId); }
    catch (error) { throw new Error(`统计批改轮次失败: ${toolErrorText(error)}`); }
    const items = rounds.map(essay => ({
      round_id: essay.id, round_number: essay.roundNumber,
      overall_score: extractOverallScore(essay.gradingResult, essay.score),
      result_preview: truncateEssayChars(extractResultText(essay.gradingResult), 200), created_at: essay.createdAt,
    }));
    return {
      session_id: sessionId, rounds: items, count: items.length, total, page, pageSize,
      hasMore: offset + items.length < total, hint: '用 essay_get_result 获取某轮的完整批改内容。',
    };
  }

  private getResult(args: Args): unknown {
    const sessionId = asStr(args.session_id);
    if (sessionId === null) throw new Error("Missing 'session_id' parameter");
    const essays = this.essays();
    let roundNumber = i32Arg(args.round_number);
    if (roundNumber === null) {
      try { roundNumber = essays.repo.getLatestRoundNumber(essays.conn, sessionId); }
      catch (error) { throw new Error(`获取最新轮次失败: ${toolErrorText(error)}`); }
    }
    let essay: VfsEssay | null;
    try { essay = this.round(essays, sessionId, roundNumber); }
    catch (error) { throw new Error(`查询批改轮次失败: ${toolErrorText(error)}`); }
    if (essay === null) {
      throw new Error(`轮次不存在: session=${sessionId}, round=${roundNumber}（用 essay_list_results 查看可用轮次）`);
    }
    let inputText: string;
    try { inputText = essays.repo.getEssayContent(essays.conn, essay.id) ?? ''; }
    catch (error) { throw new Error(`读取作文原文失败: ${toolErrorText(error)}`); }
    const resultText = extractResultText(essay.gradingResult);
    return {
      session_id: sessionId,
      round_id: essay.id,
      round_number: essay.roundNumber,
      input_text: truncateEssayChars(inputText, MAX_RESULT_CHARS_IN_TOOL_OUTPUT),
      inputTextTruncated: charCount(inputText) > MAX_RESULT_CHARS_IN_TOOL_OUTPUT,
      grading_result: truncateEssayChars(resultText, MAX_RESULT_CHARS_IN_TOOL_OUTPUT),
      gradingResultTruncated: charCount(resultText) > MAX_RESULT_CHARS_IN_TOOL_OUTPUT,
      overall_score: extractOverallScore(essay.gradingResult, essay.score),
      dimension_scores: essay.dimensionScores ?? null,
      created_at: essay.createdAt,
      hint: '可将批改指出的错误点用 qbank_batch_import 入错题本，再用 review_schedule 安排复习。',
    };
  }

  /** BG-4 `essay_delete_session`: soft-deletes the session and its folder item. */
  private deleteSession(args: Args): unknown {
    const sessionId = requiredTextArg(args, 'session_id', 200);
    const essays = this.essays();
    try { essays.repo.deleteSessionWithFolderItem(essays.conn, sessionId); }
    catch (error) { throw new Error(`删除批改会话失败: ${toolErrorText(error)}`); }
    return {
      success: true, session_id: sessionId, reversibility: 'soft_delete',
      message: `已删除批改会话 ${sessionId}`,
    };
  }

  /** BG-4 `essay_create_custom_mode`: creates a user grading mode. */
  private async createCustomMode(args: Args): Promise<unknown> {
    const grading = this.deps.grading();
    if (grading === null) throw new Error('Essay grading service not available');
    const name = requiredTextArg(args, 'name', 200);
    const description = optionalTextArg(args, 'description', 1_000) ?? '';
    const promptTemplate = requiredTextArg(args, 'prompt_template', 20_000);
    const dimensions = dimensionsArg(args);
    if (dimensions === null) throw new Error("Missing 'dimensions' parameter（dimensions 不能为空）");
    const maxScore = scoreValue(args.max_score, 'max_score', true)!;
    let mode: Wire.GradingMode;
    try {
      mode = await grading.createCustomMode({
        name, description, system_prompt: promptTemplate,
        score_dimensions: dimensions, total_max_score: maxScore,
      });
    } catch (error) {
      throw new Error(`创建自定义批阅模式失败: ${toolErrorText(error)}`);
    }
    return { success: true, mode: modeSummary(mode), message: `已创建自定义批阅模式「${mode.name}」` };
  }

  /** BG-4 `essay_update_custom_mode`: partial update of a user grading mode. */
  private async updateCustomMode(args: Args): Promise<unknown> {
    const grading = this.deps.grading();
    if (grading === null) throw new Error('Essay grading service not available');
    const id = requiredTextArg(args, 'id', 200);
    const update: Wire.UpdateModeInput = { id };
    let changed = false;
    if (Object.hasOwn(args, 'name')) { update.name = requiredTextArg(args, 'name', 200); changed = true; }
    if (Object.hasOwn(args, 'description')) {
      update.description = optionalTextArg(args, 'description', 1_000) ?? '';
      changed = true;
    }
    if (Object.hasOwn(args, 'prompt_template')) {
      update.system_prompt = requiredTextArg(args, 'prompt_template', 20_000);
      changed = true;
    }
    if (Object.hasOwn(args, 'dimensions')) {
      const dimensions = dimensionsArg(args);
      if (dimensions === null) throw new Error('dimensions 必须是非空数组');
      update.score_dimensions = dimensions;
      changed = true;
    }
    if (Object.hasOwn(args, 'max_score')) {
      update.total_max_score = scoreValue(args.max_score, 'max_score', true)!;
      changed = true;
    }
    if (!changed) throw new Error('至少提供 name/description/prompt_template/dimensions/max_score 之一');
    let mode: Wire.GradingMode;
    try { mode = await grading.updateCustomMode(update); }
    catch (error) { throw new Error(`更新自定义批阅模式失败: ${toolErrorText(error)}`); }
    return { success: true, mode: modeSummary(mode), message: `已更新自定义批阅模式「${mode.name}」` };
  }

  /** BG-4 `essay_delete_custom_mode`: removes a user grading mode. */
  private async deleteCustomMode(args: Args): Promise<unknown> {
    const grading = this.deps.grading();
    if (grading === null) throw new Error('Essay grading service not available');
    const id = requiredTextArg(args, 'id', 200);
    try { await grading.deleteCustomMode(id); }
    catch (error) { throw new Error(`删除自定义批阅模式失败: ${toolErrorText(error)}`); }
    return { success: true, id, message: `已删除自定义批阅模式 ${id}` };
  }
}

/** `v.as_i64().map(|v| v as i32)`. */
function i32Arg(value: unknown): number | null {
  const raw = asI64(value);
  return raw === null ? null : raw | 0;
}

/** `AppError` `Display` is its message; the pipeline throws `CommandError(AppError)` values. */
function essayErrorText(error: unknown): string {
  const value = error !== null && typeof error === 'object' && 'value' in error ? (error as { value: unknown }).value : null;
  if (value !== null && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return toolErrorText(error);
}
