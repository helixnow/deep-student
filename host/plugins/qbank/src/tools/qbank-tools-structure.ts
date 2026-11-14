/**
 * Group/material structure, authoring drafts and generation-task tools of
 * qbank_executor.rs (lines 4991–5005, 5235–5394).
 */
import { getTask, taskView } from '../../repository/generation-tasks.ts';
import type { DeleteMode } from '../../repository/management.ts';
import * as authoring from '../authoring-service.ts';
import { documentNeedsReview } from '../document.ts';
import * as management from '../management-service.ts';
import { unitEnum } from '../../repository/serde-decode.ts';
import type { QbankGradingRequest } from '../../api.ts';
import * as questions from '../question-service.ts';
import { asI64, asStr, errorText, qbankFailure, requiredNonEmptyString } from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';

function run<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { throw new Error(errorText(error)); }
}

const decodeDeleteMode = unitEnum<DeleteMode>(['ungroup', 'delete_members']);

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${key} 必须为数组`);
  return value.map(item => {
    if (typeof item !== 'string') throw new Error(`${key} 必须为字符串数组`);
    return item;
  });
}

/** qbank_executor.rs:5235 `execute_structure`. */
export async function executeStructure(env: QbankToolEnv): Promise<unknown> {
  env.vfs();
  const { args, toolName: name } = env;
  if (name === 'qbank_list_structure') {
    const exam = requiredNonEmptyString(args, 'session_id');
    return run(() => management.getStructure(env.deps.managementHost(), exam));
  }
  return env.lock.run(() => {
    const raw = asI64(args.expected_version);
    if (raw === null || raw <= 0) throw new Error('必须提供 expected_version，先读取 qbank_list_structure');
    const version = raw;
    let result: unknown;
    switch (name) {
      case 'qbank_update_material': {
        const id = requiredNonEmptyString(args, 'material_id');
        const content = requiredNonEmptyString(args, 'content');
        result = run(() => authoring.updateMaterial(env.deps.authoringHost(), id, content, version));
        break;
      }
      case 'qbank_delete_material': {
        const id = requiredNonEmptyString(args, 'material_id');
        const exam = requiredNonEmptyString(args, 'session_id');
        result = run(() => management.deleteUnused(env.deps.managementHost(), exam,
          [{ material_id: id, expected_version: version }]));
        break;
      }
      case 'qbank_update_group': {
        const id = requiredNonEmptyString(args, 'group_id');
        const label = requiredNonEmptyString(args, 'label');
        const questionIds = stringList(args.question_ids, 'question_ids');
        const materialIds = stringList(args.material_ids, 'material_ids');
        result = run(() => management.updateGroupMembers(env.deps.managementHost(), id, label, questionIds,
          materialIds, version));
        break;
      }
      case 'qbank_delete_group': {
        const id = requiredNonEmptyString(args, 'group_id');
        let mode: DeleteMode;
        try { mode = decodeDeleteMode(args.mode ?? null, 'mode'); }
        catch { throw new Error('mode 必须为 ungroup 或 delete_members'); }
        result = run(() => management.deleteQuestionGroup(env.deps.managementHost(), id, mode, version));
        break;
      }
      default:
        throw new Error(`Unknown structure tool: ${name}`);
    }
    env.emitChanged(name, []);
    return result;
  });
}

/** qbank_executor.rs:5317 `execute_authoring_draft`. */
export async function executeAuthoringDraft(env: QbankToolEnv): Promise<unknown> {
  env.vfs();
  const { args, toolName: name } = env;
  if (name === 'qbank_list_authoring_drafts') {
    const exam = requiredNonEmptyString(args, 'session_id');
    return { drafts: run(() => authoring.listDrafts(env.deps.authoringHost(), exam)) };
  }
  const job = requiredNonEmptyString(args, 'job_id');
  if (name === 'qbank_get_authoring_draft') return run(() => authoring.getDraft(env.deps.authoringHost(), job));
  return env.lock.run(() => {
    const raw = asI64(args.expected_version);
    if (raw === null || raw <= 0) {
      throw qbankFailure('QBANK_OCC_REQUIRED', '必须提供草稿 expected_version', '先读取草稿原样传入 version');
    }
    const version = raw;
    if (name === 'qbank_review_authoring_draft') {
      const field = (key: string): unknown[] | null => {
        if (!Object.hasOwn(args, key)) return null;
        const value = args[key];
        if (!Array.isArray(value)) throw new Error(`${key} 必须为数组`);
        return structuredClone(value);
      };
      const coverage = field('coverage');
      const issues = field('issues');
      const unmatched = field('unmatched_answers');
      return run(() => authoring.reviewDraft(env.deps.authoringHost(), job, version, coverage, issues, unmatched));
    }
    const draft = run(() => authoring.getDraft(env.deps.authoringHost(), job));
    if ((documentNeedsReview(draft.document) || draft.status === 'partial') && args.acknowledge_review !== true) {
      throw qbankFailure('REVIEW_REQUIRED', '草稿包含待复核内容',
        '先向用户展示 coverage/issues/unmatched_answers，明确确认后 acknowledge_review=true 提交所选题目；无需重发题干');
    }
    const rawSelected = args.selected_local_ids;
    if (!Array.isArray(rawSelected)) throw new Error('必须明确提供 selected_local_ids');
    const selected = rawSelected.map(id => {
      if (typeof id !== 'string') throw new Error('selected_local_ids 必须为字符串数组');
      return id;
    });
    const receipt = run(() => authoring.commitDraft(env.deps.authoringHost(), job, selected, version));
    env.emitChanged('authoring_committed', receipt.question_ids);
    return receipt;
  });
}

/** qbank_executor.rs:4991 `execute_get_generation_task`. */
export function executeGetGenerationTask(env: QbankToolEnv): unknown {
  const taskId = requiredNonEmptyString(env.args, 'task_id');
  const { db } = env.vfs();
  let record;
  try { record = getTask(db, taskId); }
  catch (error) { throw new Error(`查询任务失败: ${errorText(error)}`); }
  if (record === null) throw new Error(`任务不存在: ${taskId}`);
  return taskView(record);
}

/** qbank_executor.rs:1388 `parse_qbank_grading_mode`. */
function parseGradingMode(args: Record<string, unknown>): 'grade' | 'analyze' {
  const mode = asStr(args.mode) ?? 'grade';
  if (mode === 'grade' || mode === 'analyze') return mode;
  throw qbankFailure('INVALID_ARGS', `不支持的 AI 评判模式: ${mode}`, 'mode 只能是 grade 或 analyze');
}

function trimmedArg(value: unknown): string | null {
  const text = asStr(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** qbank_executor.rs:3209 `execute_ai_grade`. */
export async function executeAiGrade(env: QbankToolEnv): Promise<unknown> {
  const { args, ctx } = env;
  env.vfs();
  const grading = env.deps.aiGrading();
  if (grading === null) throw new Error('LLM manager not available');
  const mode = parseGradingMode(args);
  const submissionId = trimmedArg(args.submission_id);
  if (submissionId === null && mode === 'grade') {
    throw qbankFailure('INVALID_ARGS', 'grade 模式缺少 submission_id',
      '先调用 qbank_submit_answer 并传入其返回的 submission_id；只想生成解析请用 mode=analyze');
  }
  let questionId = trimmedArg(args.question_id);
  if (questionId === null) {
    const sessionId = asStr(args.session_id);
    if (sessionId === null) {
      throw qbankFailure('INVALID_ARGS', '缺少 question_id，且未提供 session_id', '传 question_id，或同时传 session_id 与 card_id');
    }
    const cardId = asStr(args.card_id);
    if (cardId === null) {
      throw qbankFailure('INVALID_ARGS', '缺少 question_id，且未提供 card_id', '传 question_id，或同时传 session_id 与 card_id');
    }
    const question = run(() => questions.getQuestionByCardId(env.requireService(), sessionId, cardId));
    if (question === null) {
      throw qbankFailure('NOT_FOUND', `题目不存在: ${sessionId}/${cardId}`, '重新调用 qbank_get_question 获取有效题目');
    }
    questionId = question.id;
  }
  const streamSessionId = `agent-${ctx.session_id}-${env.call.id}`;
  const request: QbankGradingRequest = {
    question_id: questionId, submission_id: submissionId, stream_session_id: streamSessionId, mode,
    model_config_id: trimmedArg(args.model_config_id),
  };
  const signal = ctx.cancellation_token;
  const onAbort = () => { void grading.cancelStream(`qbank_grading_stream_${streamSessionId}`); };
  if (signal !== null) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let response;
  try { response = await grading.run(request); }
  catch (error) { throw new Error(errorText(error)); }
  finally { signal?.removeEventListener('abort', onAbort); }
  if (response === null) return { cancelled: true, messageKey: 'agentTools.qbank.aiGradeCancelled' };
  env.emitChanged('ai_grade', [questionId]);
  const value: Record<string, unknown> = { ...response };
  if (response.submission_id === null && !response.explanation_written) {
    value.explanation_hint = '题目已有解析，本次结果只存为 AI 解析（ai_feedback）；如需替换题目解析，用 qbank_update_question 写 explanation';
  }
  return value;
}
