/**
 * Canonical authoring tools of qbank_executor.rs: `normalize_authoring_document` (916),
 * `create_empty_exam` (1094), `execute_generate_variant` (4542),
 * `execute_generate_questions` (4843) and `execute_batch_import` (5011).
 */
import { nanoid } from 'nanoid';
import { CommandError } from '../../../../kernel/api.ts';
import type { ExecutionContext } from '../../../chat/api.ts';
import type { ApiConfig } from '../../../llm/api.ts';
import { with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import type { QuestionDocument } from '../../api.ts';
import { findChatImportExam } from '../../repository/authoring.ts';
import { questionDocument } from '../../repository/authoring-decode.ts';
import { createTask } from '../../repository/generation-tasks.ts';
import * as authoring from '../authoring-service.ts';
import { documentNeedsReview, validateDocument } from '../document.ts';
import { spawnGenerationTask, type DecodedGenerationRequest } from '../generation-command.ts';
import * as questions from '../question-service.ts';
import { asBool, asStr, asU64, errorText, qbankFailure, requiredNonEmptyString, type Args } from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';
import { decodeToolPreview, previewCards } from './qbank-tool-preview.ts';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `ExecutionContext::question_authoring_config` (set by the chat pipeline for the current turn). */
function authoringConfig(ctx: ExecutionContext): ApiConfig | null {
  return (ctx as ExecutionContext & { question_authoring_config?: ApiConfig | null }).question_authoring_config ?? null;
}

/** `ExecutionContext::question_authoring_route`. */
function authoringRoute(ctx: ExecutionContext): Record<string, unknown> | null {
  const config = authoringConfig(ctx);
  if (config === null) return null;
  return { model_config_id: config.id, name: config.name, model: config.model,
    provider_type: config.providerType ?? null, is_multimodal: config.isMultimodal,
    max_output_tokens: config.maxOutputTokens ?? null, max_tokens_limit: config.maxTokensLimit ?? null,
    context_window: config.contextWindow ?? null };
}

/** serde_json `Map::remove` under `preserve_order` is `swap_remove`: the last entry takes the removed slot. */
function swapRemove(object: JsonObject, key: string): JsonObject {
  const keys = Object.keys(object);
  const index = keys.indexOf(key);
  if (index < 0) return object;
  const last = keys[keys.length - 1];
  const order = keys.slice(0, -1);
  if (index < order.length) order[index] = last!;
  const out: JsonObject = {};
  for (const name of order) out[name] = object[name];
  return out;
}

/** qbank_executor.rs:900 `parse_json_argument`. */
function parseJsonArgument(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return structuredClone(value);
  try { return JSON.parse(value) as unknown; }
  catch (error) {
    throw qbankFailure('INVALID_ARGS', `${field} 是字符串但不是有效 JSON: ${errorText(error)}`,
      '传入 JSON 对象/数组，而不是被二次编码的字符串');
  }
}

/** Rust `AppError` `Display` (its message) for validation failures raised as `CommandError`. */
function displayError(error: unknown): string {
  if (error instanceof CommandError && isObject(error.value) && typeof error.value.message === 'string') {
    return error.value.message;
  }
  return errorText(error);
}

function trimmedNonEmpty(value: unknown): string | null {
  const text = asStr(value);
  if (text === null) return null;
  const trimmed = rustTrim(text);
  return trimmed === '' ? null : trimmed;
}

function coverageValid(entry: unknown): boolean {
  const item = isObject(entry) ? entry : {};
  const sourceId = asStr(item.source_id);
  if (sourceId === null || rustTrim(sourceId) === '') return false;
  if (item.status !== 'processed' && item.status !== 'uncertain' && item.status !== 'unprocessed') return false;
  const page = item.page;
  return page === undefined || page === null || (asU64(page) !== null && (page as number) > 0);
}

function decodeDocument(root: JsonObject, hint: string): QuestionDocument {
  try { return questionDocument(root, ''); }
  catch (error) { throw qbankFailure('INVALID_ARGS', `题目文档契约无效: ${errorText(error)}`, hint); }
}

/** qbank_executor.rs:916 `normalize_authoring_document`. */
export function normalizeAuthoringDocument(args: Args): JsonObject {
  let source: unknown;
  if (Object.hasOwn(args, 'document')) {
    source = parseJsonArgument(args.document, 'document');
  } else if (Object.hasOwn(args, 'questions') || Object.hasOwn(args, 'materials') || Object.hasOwn(args, 'groups')) {
    source = structuredClone(args);
  } else {
    throw qbankFailure('INVALID_ARGS', '缺少题目文档', '传入 v2 document，或至少提供 questions 数组');
  }
  if (!isObject(source)) {
    throw qbankFailure('INVALID_ARGS', '题目文档必须是 JSON 对象', '使用 {schema_version,mode,materials,groups,questions,...} 根对象');
  }
  const root = source;
  const mode = asStr(root.mode) ?? 'generate';
  if (mode !== 'extract' && mode !== 'generate') {
    throw qbankFailure('INVALID_ARGS', `不支持的 mode: ${mode}`, 'mode 只能是 extract 或 generate');
  }
  if (!Object.hasOwn(root, 'questions')) {
    throw qbankFailure('INVALID_ARGS', '缺少 questions 数组', '至少提供一道可作答题目');
  }
  const questionsValue = parseJsonArgument(root.questions, 'questions');
  if (!Array.isArray(questionsValue)) {
    throw qbankFailure('INVALID_ARGS', 'questions 必须是数组', '修正后重试；本批次未写入任何题目');
  }
  if (questionsValue.length === 0) throw qbankFailure('INVALID_ARGS', 'questions 不能为空', '至少传入一道题目');
  if (questionsValue.length > 200) {
    throw qbankFailure('INVALID_ARGS', `questions 单次最多 200 道，收到 ${questionsValue.length}`,
      '按题组/章节分批，且每批保留完整材料');
  }
  const normalized = questionsValue.map((value: unknown, index) => {
    if (!isObject(value)) {
      throw qbankFailure('INVALID_ARGS', `questions[${index}] 必须是对象`, '修正后重试；本批次未写入任何题目');
    }
    let question: JsonObject = value;
    question.local_id = trimmedNonEmpty(question.local_id) ?? `q${index + 1}`;
    if (!Object.hasOwn(question, 'original_label')) {
      const labelValue = Object.hasOwn(question, 'question_label') ? question.question_label : question.questionLabel;
      question.original_label = asStr(labelValue) ?? String(index + 1);
    }
    if (!Object.hasOwn(question, 'question_type')) {
      const inferred = Array.isArray(question.options) && question.options.length > 0 ? 'single_choice' : 'other';
      question.question_type = Object.hasOwn(question, 'questionType') ? question.questionType : inferred;
    }
    question = swapRemove(question, 'questionType');
    question = swapRemove(question, 'questionLabel');
    question = swapRemove(question, 'question_label');
    if (!Object.hasOwn(question, 'tags')) question.tags = [];
    if (!Object.hasOwn(question, 'section_path')) question.section_path = [];
    if (!Object.hasOwn(question, 'answer_origin')) {
      const answer = asStr(question.answer);
      const hasAnswer = answer !== null && rustTrim(answer) !== '';
      question.answer_origin = mode === 'generate' && hasAnswer ? 'generated' : hasAnswer ? 'source' : 'missing';
    }
    return question;
  });

  root.schema_version = 2;
  root.mode = mode;
  root.questions = normalized;
  for (const field of ['materials', 'groups', 'unmatched_answers', 'coverage', 'issues']) {
    if (!Object.hasOwn(root, field)) root[field] = [];
  }
  const coverage = Array.isArray(root.coverage) ? root.coverage : [];
  coverage.forEach((entry: unknown, index) => {
    if (!coverageValid(entry)) {
      throw qbankFailure('INVALID_COVERAGE', `coverage[${index}] 必须为 {source_id,page,status}，不是试卷简介或题量统计`,
        '逐页填写真实覆盖范围，例如 {source_id:来源ID,page:1,status:processed}；未知页号用 null。对话命题无逐页来源时用 coverage:[]。题干与材料无需重写。');
    }
  });
  const document = decodeDocument(root,
    'source_refs 必须使用 {source_id,page,bbox?}；材料与题组必须在同一文档中完整定义；本批次尚未写入');
  try { validateDocument(document); }
  catch (error) {
    throw qbankFailure('INVALID_DOCUMENT', displayError(error),
      '按错误指出的 local_id 修正完整文档。不能通过删除必要共享材料或只重试子题绕过校验；本批次尚未写入。');
  }
  return root;
}

const VARIANT_PROMPTS: Record<string, string> = {
  harder: '请基于以下原题生成一道**更难**的变式题。保持相同的知识点和题型，但增加难度（如增加步骤、引入更复杂的条件）。',
  easier: '请基于以下原题生成一道**更简单**的变式题。保持相同的知识点和题型，但降低难度（如简化条件、减少步骤）。',
  different_context: '请基于以下原题生成一道**不同情境**的变式题。保持相同的知识点和解题方法，但更换题目背景（如换个应用场景）。',
};
const SIMILAR_PROMPT = '请基于以下原题生成一道**相似难度**的变式题。保持相同的知识点、题型和难度，但改变具体数值或细节。';
const VARIANT_HINT = 'AI 将基于原题生成变式题。生成后可使用 qbank_batch_import 将新题目导入题目集。';

function variantInstruction(prompt: string, content: string, answer: string | null | undefined): string {
  return `${prompt}\n\n**原题**：\n${content}\n\n**原题答案**：${answer ?? '未提供'}\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析`;
}

/** qbank_executor.rs:4542 `execute_generate_variant`. */
export function executeGenerateVariant(env: QbankToolEnv): unknown {
  const { args } = env;
  const sessionId = asStr(args.session_id);
  if (sessionId === null) throw new Error("Missing 'session_id' parameter");
  const cardId = asStr(args.card_id);
  if (cardId === null) throw new Error("Missing 'card_id' parameter");
  const variantType = asStr(args.variant_type) ?? 'similar';
  const prompt = Object.hasOwn(VARIANT_PROMPTS, variantType) ? VARIANT_PROMPTS[variantType]! : SIMILAR_PROMPT;

  const service = env.service();
  if (service !== null) {
    let question = null;
    try { question = questions.getQuestionByCardId(service, sessionId, cardId); } catch { question = null; }
    if (question !== null) {
      return {
        action: 'generate_variant',
        original_question: {
          card_id: question.card_id ?? question.id, label: question.question_label, content: question.content,
          question_type: question.question_type, answer: question.answer, explanation: question.explanation,
          difficulty: question.difficulty, tags: question.tags, images: question.images,
        },
        variant_type: variantType, prompt,
        instruction: variantInstruction(prompt, question.content, question.answer),
        session_id: sessionId, hint: VARIANT_HINT, source: 'questions_table',
      };
    }
  }

  const { db, repos } = env.vfs();
  let exam;
  try { exam = repos.exams.getExamSheet(db, sessionId); }
  catch (error) { throw new Error(`Failed to get exam sheet: ${errorText(error)}`); }
  if (exam === null) throw new Error('Exam sheet not found');
  let preview;
  try { preview = decodeToolPreview(exam.previewJson); }
  catch (error) { throw new Error(`Failed to parse preview: ${errorText(error)}`); }
  const card = previewCards(preview).find(item => item.card_id === cardId);
  if (card === undefined) throw new Error('Question not found');
  return {
    action: 'generate_variant',
    original_question: {
      card_id: card.card_id, label: card.question_label, content: card.ocr_text,
      question_type: card.question_type ?? null, answer: card.answer ?? null, explanation: card.explanation ?? null,
      difficulty: card.difficulty ?? null, tags: card.tags,
    },
    variant_type: variantType, prompt,
    instruction: variantInstruction(prompt, card.ocr_text, card.answer),
    session_id: sessionId, hint: VARIANT_HINT, source: 'preview_json', degraded: true,
  };
}

/** serde `Vec<QuestionGenerationSpec>`; any malformed entry discards the whole list (`.ok().unwrap_or_default()`). */
function decodeSpecs(value: unknown): DecodedGenerationRequest['specs'] {
  if (!Array.isArray(value)) return [];
  const specs: DecodedGenerationRequest['specs'] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.question_type !== 'string') return [];
    let count = 1;
    if (Object.hasOwn(item, 'count')) {
      const raw = asU64(item.count);
      if (raw === null || raw > 0xffff_ffff) return [];
      count = raw;
    }
    const difficulty = item.difficulty ?? null;
    if (difficulty !== null && typeof difficulty !== 'string') return [];
    specs.push({ question_type: item.question_type, count, difficulty });
  }
  return specs;
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** qbank_executor.rs:4843 `execute_generate_questions`. */
export function executeGenerateQuestions(env: QbankToolEnv): unknown {
  const { args, ctx } = env;
  const examId = requiredNonEmptyString(args, 'exam_id');
  const background = asBool(args.background) ?? false;
  const trusted = authoringConfig(ctx);
  if (trusted === null) {
    throw qbankFailure('MODEL_CONTEXT_UNAVAILABLE', '当前工具调用缺少可信的对话模型上下文',
      '重新发送本轮请求；不要指定其他模型或创建新的出题槽');
  }
  if (!background) {
    return {
      action: 'author_with_current_model', committed: false, exam_id: examId, model: trusted.name,
      model_config_id: trusted.id, model_route: authoringRoute(ctx),
      instructions: '直接使用当前对话模型组织 QuestionDocument v2，然后调用 qbank_batch_import：questions 为独立可作答题目；共享文章/条件/图放 materials；groups 用 material_ids 与 question_ids 关联。为每道生成题给出 answer 与 answer_origin=generated，不得伪称来自原资料。',
      contract: { schema_version: 2, mode: 'generate', materials: [], groups: [], questions: [], coverage: [], issues: [] },
      hint: '不要再调用 qbank_generate_questions 等后台模型；后台委托仅在用户明确要求大批量异步任务时使用 background=true。',
    };
  }

  const generation = env.deps.generation();
  if (generation === null) throw new Error('LLM Manager not available');
  const { db } = env.vfs();
  const request: DecodedGenerationRequest = {
    exam_id: examId,
    stream_session_id: `chat_${nanoid(10)}`,
    model_config_id: trusted.id,
    max_questions: Math.min(Math.max(asU64(args.max_questions) ?? 10, 1), 50),
    specs: decodeSpecs(args.specs),
    difficulty: asStr(args.difficulty),
    topic_hint: asStr(args.topic_hint),
    based_on_existing: asBool(args.based_on_existing) ?? false,
    language: asStr(args.language),
    reference_file_ids: stringItems(args.reference_file_ids),
    reference_files_base64: [],
    knowledge_points: stringItems(args.knowledge_points),
  };
  if (ctx.tryWindow() === null) throw new Error('后台出题需要窗口上下文（app handle 不可用）');
  const taskId = `task_${nanoid(10)}`;
  const streamEvent = `qbank_generation_stream_${request.stream_session_id}`;
  try { createTask(db, taskId, examId, JSON.stringify(request), streamEvent); }
  catch (error) { throw new Error(`创建出题任务失败: ${errorText(error)}`); }
  spawnGenerationTask(generation, taskId, request, trusted);
  return {
    action: 'generate_questions_background', taskId, examId, status: 'queued', committed: false,
    model_route: authoringRoute(ctx),
    hint: '用户明确要求的大批量后台任务已用本轮实际对话模型提交；完成后用 qbank_get_generation_task 查询，再按回执确认。',
  };
}

/** qbank_executor.rs:1094 `create_empty_exam`. */
function createEmptyExam(env: QbankToolEnv, name: string | null, folderId: string | null): string {
  const { db, repos } = env.vfs();
  try {
    return repos.exams.createExamSheet(db, {
      examName: name ?? '导入的题目集', tempId: `chat_${nanoid(12)}`,
      metadataJson: { created_by: 'chat_qbank_authoring' }, previewJson: { pages: [{ page_index: 0, cards: [] }] },
      status: 'pending', folderId,
    }).id;
  } catch (error) {
    throw new Error(`创建题目集失败: ${errorText(error)}`);
  }
}

/** qbank_executor.rs:5011 `execute_batch_import`. */
export function executeBatchImport(env: QbankToolEnv): Promise<unknown> {
  return env.lock.run(() => batchImport(env));
}

function batchImport(env: QbankToolEnv): unknown {
  const { args, ctx } = env;
  const documentValue = normalizeAuthoringDocument(args);
  const { db, repos } = env.vfs();
  const sessionId = trimmedNonEmpty(args.session_id);
  const name = trimmedNonEmpty(args.name);
  const requestKey = trimmedNonEmpty(args.idempotency_key)
    ?? `chat-${ctx.session_id}-${env.deps.crypto().sha256HexSync(JSON.stringify(documentValue))}`;
  let previousExam: string | null = null;
  if (sessionId === null) {
    try { previousExam = findChatImportExam(db, requestKey, ctx.session_id); }
    catch (error) { throw new Error(errorText(error)); }
  }

  let examId: string;
  const existingId = sessionId ?? previousExam;
  if (existingId !== null) {
    let exam;
    try { exam = repos.exams.getExamSheet(db, existingId); }
    catch (error) { throw new Error(`读取题目集失败: ${errorText(error)}`); }
    if (exam === null) {
      throw qbankFailure('NOT_FOUND', `题目集不存在: ${existingId}`, '先 qbank_list 取得有效题目集 ID');
    }
    examId = existingId;
  } else {
    examId = createEmptyExam(env, name, asStr(args.folder_id));
  }

  const topParentCard = trimmedNonEmpty(args.parent_card_id);
  const rawQuestions = documentValue.questions as JsonObject[];
  const parentCards = new Set<string>();
  if (topParentCard !== null) parentCards.add(topParentCard);
  for (const question of rawQuestions) {
    const parent = trimmedNonEmpty(question.parent_card_id);
    if (parent !== null) parentCards.add(parent);
  }
  const resolvedParents = new Map<string, string>();
  if (parentCards.size > 0) {
    const service = env.service();
    if (service === null) throw qbankFailure('UNAVAILABLE', '题目服务不可用，无法校验变式父题', '稍后重试；本批次未写入任何题目');
    for (const cardId of parentCards) {
      let parent;
      try { parent = questions.getQuestionByCardId(service, examId, cardId); }
      catch (error) { throw new Error(`读取变式父题失败: ${errorText(error)}`); }
      if (parent === null) {
        throw qbankFailure('NOT_FOUND', `变式父题不存在于目标题目集: ${cardId}`, '先用 qbank_get_question 确认父题；本批次未写入任何题目');
      }
      resolvedParents.set(cardId, parent.id);
    }
  }
  for (const question of rawQuestions) {
    const card = asStr(question.parent_card_id) ?? topParentCard;
    const parentId = card === null ? undefined : resolvedParents.get(card);
    if (parentId !== undefined) question.parent_id = parentId;
  }

  const document = decodeDocument(documentValue, '按 QuestionDocument v2 字段修正；本批次未写入任何题目');
  try { validateDocument(document); }
  catch (error) { throw new Error(displayError(error)); }

  const route = authoringRoute(ctx);
  const metadata = {
    idempotency_key: requestKey, chat_session_id: ctx.session_id, source_format: 'chat_qbank_batch_import',
    sources: [], pages: [], model_route: route,
  };
  const host = env.deps.authoringHost();
  let jobId: string;
  try { jobId = authoring.saveDraft(host, examId, document, metadata); }
  catch (error) { throw new Error(`保存题目草稿失败: ${errorText(error)}`); }
  let draft;
  try { draft = authoring.getDraft(host, jobId); }
  catch (error) { throw new Error(`读取题目草稿失败: ${errorText(error)}`); }

  if (documentNeedsReview(draft.document) || draft.status === 'partial') {
    env.emitChanged('batch_import_draft', [examId]);
    return {
      success: true, committed: false, status: 'needs_review', session_id: examId, draft_job_id: jobId,
      draft_version: draft.version, question_count: draft.document.questions.length, needs_review: true,
      coverage: draft.document.coverage, unmatched_answers: draft.document.unmatched_answers,
      issues: draft.document.issues, next_tool: 'qbank_get_authoring_draft', model_route: route,
      hint: '草稿已保存，勿重新生成题目。用 qbank_get_authoring_draft(job_id) 读取原内容；需要更正覆盖/复核字段时用 qbank_review_authoring_draft，用户确认后用 qbank_commit_authoring_draft(job_id,expected_version,selected_local_ids,acknowledge_review=true) 提交。也可在题目集待确认草稿中操作。',
    };
  }

  const selected = draft.document.questions.map(question => question.local_id);
  let receipt;
  try { receipt = authoring.commitDraft(host, jobId, selected, draft.version); }
  catch (error) { throw new Error(`提交题目草稿失败: ${errorText(error)}`); }
  env.emitChanged('batch_import', receipt.question_ids);

  const replay = draft.status === 'committed';
  const importedCount = replay ? 0 : receipt.imported_count;
  const payload: Record<string, unknown> = { ...receipt };
  payload.imported_count = importedCount;
  payload.success = true;
  payload.status = 'committed';
  payload.session_id = receipt.exam_id;
  payload.name = name ?? '题目集';
  payload.draft_job_id = jobId;
  payload.draft_version = replay ? draft.version : draft.version + 1;
  payload.new_card_ids = replay ? [] : receipt.question_ids;
  payload.model_route = route;
  payload.idempotent_replay = replay || receipt.imported_count === 0;
  return with_localized_message(payload as JsonValue, 'chat.tools.qbank.questions_imported', { count: importedCount },
    `已提交 ${importedCount} 道题目；题目集共 ${receipt.total_questions} 道`,
    `Committed ${importedCount} questions; the bank now has ${receipt.total_questions}.`);
}
