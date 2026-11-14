/**
 * Question read/write tools of qbank_executor.rs (lines 1613–2806, 3040–3207, 3336–3420).
 * Business logic stays in `question-service.ts`; these bodies only parse arguments,
 * map errors and shape the tool payloads exactly like Rust.
 */
import { f64Atom } from '../../../../platform/serde-compat/index.ts';
import { charCount, takeChars } from '../../../../platform/util/portable.ts';
import type {
  CreateQuestionParams, Question, QuestionFilters, QuestionSearchFilters, UpdateQuestionParams,
} from '../../api.ts';
import * as questions from '../question-service.ts';
import type { QuestionServiceHost } from '../question-service.ts';
import {
  asBool, asStr, boundedOptionalText, boundedText, cardIdOf, errorText, expectedQbankRevision, isChoiceType,
  materialsValue, normalizeQuestionImageIds, optionalString, pageBounds, parseDifficulty, parseQuestionImages,
  parseQuestionOptions, parseRepoQuestionType, parseSortBy, parseStatus, parseStringArray,
  parseStructuredDataArg, qbankConflictError, qbankFailure, questionToBoundedValue,
  questionTypeRequiresStructuredData, readBoundedU32, readNonNegativeU32, readStrictU32,
  requiredNonEmptyString, requiredStr, sourceRefsValue, tryParseDifficulty, tryParseStatus, validateTrueFalseAnswer,
  type Args, type ImageFileResolver,
} from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';
import { decodeToolPreview, loadPreview, previewCards, type PreviewDocument } from './qbank-tool-preview.ts';

function imageResolver(env: QbankToolEnv): ImageFileResolver | null {
  const repos = env.deps.repos();
  if (repos === null) return null;
  const db = env.deps.db();
  return {
    resolveFileId: rawId => repos.attachments.resolveFileId(db, rawId),
    getById: fileId => repos.attachments.getById(db, fileId),
  };
}

function statsPayload(stats: { total_count: number; mastered_count: number; review_count: number;
  in_progress_count: number; new_count: number; correct_rate: number }): Record<string, unknown> {
  return {
    total: stats.total_count, mastered: stats.mastered_count, review: stats.review_count,
    in_progress: stats.in_progress_count, new: stats.new_count, correct_rate: f64Atom(stats.correct_rate),
  };
}

/** qbank_executor.rs:1645 `execute_list`. */
export function executeList(env: QbankToolEnv): unknown {
  const { args } = env;
  const limit = readBoundedU32(args, 'limit', 20, 1, 20);
  const offset = readNonNegativeU32(args, 'offset', 0);
  const search = asStr(args.search);
  const includeStats = asBool(args.include_stats) ?? true;
  const { db, repos } = env.vfs();
  let total: number;
  try { total = repos.exams.countExamSheets(db, search); }
  catch (error) { throw new Error(`Failed to count exam sheets: ${errorText(error)}`); }
  let exams;
  try { exams = repos.exams.listExamSheets(db, search, limit, offset); }
  catch (error) { throw new Error(`Failed to list exam sheets: ${errorText(error)}`); }
  const service = env.service();
  const banks = exams.map(exam => {
    const bank: Record<string, unknown> = {
      session_id: exam.id, name: exam.examName ?? '未命名题目集', status: exam.status,
      created_at: exam.createdAt, updated_at: exam.updatedAt, is_favorite: exam.isFavorite,
    };
    if (!includeStats) return bank;
    let statsSet = false;
    if (service !== null) {
      let stats = null;
      try { stats = questions.getStats(service, exam.id); } catch { stats = null; }
      if (stats === null) {
        try { stats = questions.refreshStats(service, exam.id); } catch { stats = null; }
      }
      if (stats !== null) {
        bank.stats = statsPayload(stats);
        statsSet = true;
      }
    }
    if (!statsSet) {
      let document: PreviewDocument | null = null;
      try { document = decodeToolPreview(exam.previewJson); } catch { document = null; }
      if (document !== null) {
        const counts = { total: 0, mastered: 0, review: 0, in_progress: 0, new: 0 };
        let attempts = 0;
        let correct = 0;
        for (const card of previewCards(document)) {
          counts.total += 1;
          counts[card.status] += 1;
          attempts += card.attempt_count;
          correct += card.correct_count;
        }
        bank.stats = { ...counts, correct_rate: f64Atom(attempts > 0 ? correct / attempts : 0),
          source: 'preview_json', degraded: true };
      }
    }
    return bank;
  });
  const hasMore = offset + banks.length < total;
  return { total, question_banks: banks, limit, offset, has_more: hasMore, truncated: hasMore };
}

/** qbank_executor.rs:1768 `execute_list_questions`. */
export function executeListQuestions(env: QbankToolEnv): unknown {
  const { args } = env;
  const sessionId = requiredStr(args, 'session_id');
  const statusFilter = asStr(args.status);
  const difficultyFilter = asStr(args.difficulty);
  const tagsFilter = Array.isArray(args.tags)
    ? args.tags.filter((tag): tag is string => typeof tag === 'string') : null;
  const page = readBoundedU32(args, 'page', 1, 1, 0xffff_ffff);
  const pageSize = readBoundedU32(args, 'page_size', 20, 1, 20);
  const service = env.service();
  if (service !== null) {
    const status = statusFilter === null ? null : tryParseStatus(statusFilter);
    const difficulty = difficultyFilter === null ? null : tryParseDifficulty(difficultyFilter);
    const filters: QuestionFilters = {
      status: status === null ? null : [status],
      difficulty: difficulty === null ? null : [difficulty],
      tags: tagsFilter,
    };
    try {
      const result = questions.listQuestions(service, sessionId, filters, page, pageSize);
      return {
        total: result.total,
        page,
        page_size: pageSize,
        questions: result.questions.map(question => ({
          card_id: cardIdOf(question), label: question.question_label,
          content_preview: takeChars(question.content, 100), status: question.status,
          difficulty: question.difficulty, tags: question.tags, attempt_count: question.attempt_count,
          correct_count: question.correct_count, has_images: question.images.length > 0,
        })),
        has_more: result.has_more,
        truncated: result.has_more,
        source: 'questions_table',
      };
    } catch (error) {
      env.deps.log.warn(`[QBankExecutor] QuestionBankService failed, falling back to preview: ${errorText(error)}`);
    }
  }
  const { document } = loadPreview(env, sessionId);
  let cards = previewCards(document);
  if (statusFilter !== null) cards = cards.filter(card => card.status === statusFilter);
  if (difficultyFilter !== null) cards = cards.filter(card => (card.difficulty ?? '') === difficultyFilter);
  if (tagsFilter !== null) cards = cards.filter(card => tagsFilter.some(tag => card.tags.includes(tag)));
  const total = cards.length;
  const start = (page - 1) * pageSize;
  const items = cards.slice(start, start + pageSize).map(card => ({
    card_id: card.card_id, label: card.question_label, content_preview: takeChars(card.ocr_text, 100),
    status: card.status, difficulty: card.difficulty ?? null, tags: card.tags,
    attempt_count: card.attempt_count, correct_count: card.correct_count,
  }));
  const hasMore = start + items.length < total;
  return { total, page, page_size: pageSize, questions: items, has_more: hasMore, truncated: hasMore,
    source: 'preview_json' };
}

/**
 * BG-4 `qbank_list_mistakes`: mistake-book entries (`status = 'review'`) with
 * per-question mistake counts and per-bank aggregates from
 * `question_repo::list_mistakes`. `group_id` is the question-bank/group ID
 * (`exam_id` in the repository) and `keyword` maps onto the repository search.
 */
export function executeListMistakes(env: QbankToolEnv): unknown {
  const { args } = env;
  const groupId = asStr(args.group_id) ?? asStr(args.session_id);
  const keyword = asStr(args.keyword) ?? asStr(args.search);
  const limit = readBoundedU32(args, 'limit', 20, 1, 100);
  const offset = readNonNegativeU32(args, 'offset', 0);
  const page = Math.floor(offset / limit) + 1;
  const service = env.requireService();
  let result;
  try {
    result = questions.listMistakes(service, {
      exam_id: groupId === null || groupId.trim() === '' ? null : groupId.trim(),
      search: keyword === null || keyword.trim() === '' ? null : keyword.trim(),
      sort: 'errors',
    }, page, limit);
  } catch (error) {
    throw qbankFailure('QBANK_MISTAKES_FAILED', `读取错题本失败: ${errorText(error)}`,
      '确认题库分组存在后重试');
  }
  const skip = offset - (page - 1) * limit;
  const items = result.items.slice(skip, skip + limit).map(question => {
    const mistakeCount = Math.max(0, question.attempt_count - question.correct_count);
    return {
      question_id: question.id,
      card_id: cardIdOf(question),
      group_id: question.exam_id,
      exam_name: question.exam_name ?? null,
      label: question.question_label,
      content_preview: takeChars(question.content, 120),
      question_type: question.question_type,
      difficulty: question.difficulty,
      status: question.status,
      tags: question.tags,
      attempt_count: question.attempt_count,
      correct_count: question.correct_count,
      mistake_count: mistakeCount,
      last_attempt_at: question.last_attempt_at,
      is_favorite: question.is_favorite,
      is_bookmarked: question.is_bookmarked,
      updated_at: question.updated_at,
    };
  });
  return {
    items,
    total: result.total,
    limit,
    offset,
    has_more: offset + items.length < result.total,
    truncated: offset + items.length < result.total,
    exam_stats: result.exams.map(exam => ({
      group_id: exam.exam_id, exam_name: exam.exam_name ?? null, mistake_count: exam.count,
    })),
    sort: 'errors',
  };
}

/** qbank_executor.rs:1930 `execute_get_question`. */
export function executeGetQuestion(env: QbankToolEnv): unknown {
  const sessionId = requiredStr(env.args, 'session_id');
  const cardId = requiredStr(env.args, 'card_id');
  const service = env.service();
  if (service !== null) {
    let question: Question | null = null;
    try { question = questions.getQuestionByCardId(service, sessionId, cardId); } catch { question = null; }
    if (question !== null) {
      let submissions: ReturnType<typeof questions.getSubmissions> = [];
      try { submissions = questions.getSubmissions(service, question.id, 5); } catch { submissions = []; }
      return {
        question_id: question.id, card_id: cardIdOf(question), label: question.question_label,
        content: question.content, question_type: question.question_type,
        structured_data: question.structured_data, answer: question.answer, explanation: question.explanation,
        difficulty: question.difficulty, status: question.status, tags: question.tags,
        user_answer: question.user_answer, is_correct: question.is_correct,
        attempt_count: question.attempt_count, correct_count: question.correct_count,
        last_attempt_at: question.last_attempt_at, user_note: question.user_note,
        is_favorite: question.is_favorite, is_bookmarked: question.is_bookmarked, images: question.images,
        group_id: question.group_id, group_position: question.group_position, group_label: question.group_label,
        materials: materialsValue(question.materials), answer_origin: question.answer_origin,
        source_refs: sourceRefsValue(question.source_refs),
        answer_source_refs: sourceRefsValue(question.answer_source_refs), source_key: question.source_key,
        updated_at: question.updated_at, updatedAt: question.updated_at, occ_supported: true,
        recent_submissions: submissions.map(submission => ({
          answer: submission.user_answer, is_correct: submission.is_correct,
          method: submission.grading_method, at: submission.submitted_at,
        })),
        source: 'questions_table',
      };
    }
  }
  const { document, updatedAt } = loadPreview(env, sessionId);
  const card = previewCards(document).find(item => item.card_id === cardId);
  if (card === undefined) throw new Error('Question not found');
  return {
    card_id: card.card_id, label: card.question_label, content: card.ocr_text,
    question_type: card.question_type ?? null, answer: card.answer ?? null, explanation: card.explanation ?? null,
    difficulty: card.difficulty ?? null, status: card.status, tags: card.tags,
    user_answer: card.user_answer ?? null, is_correct: card.is_correct ?? null,
    attempt_count: card.attempt_count, correct_count: card.correct_count,
    last_attempt_at: card.last_attempt_at ?? null, user_note: card.user_note ?? null,
    updated_at: updatedAt, updatedAt, occ_supported: false, source: 'preview_json',
  };
}

/** qbank_executor.rs:2043 `execute_create_question`. */
export function executeCreateQuestion(env: QbankToolEnv): Promise<unknown> {
  return env.lock.run(() => {
    const { args } = env;
    const service = env.requireService();
    const examId = requiredNonEmptyString(args, 'session_id');
    const content = requiredNonEmptyString(args, 'content');
    if (charCount(content) > 50_000) throw qbankFailure('INVALID_ARGS', 'content 超过 50000 字符上限', '缩短题干后重试');
    const questionType = Object.hasOwn(args, 'question_type')
      ? parseRepoQuestionType(args.question_type, 'question_type') : 'other';
    const options = Object.hasOwn(args, 'options') ? parseQuestionOptions(args.options) : null;
    if (isChoiceType(questionType) && (options === null || options.length === 0)) {
      throw qbankFailure('INVALID_ARGS', '选择题必须提供非空 options', '把选项作为 {key,content} 数组传入');
    }
    const structuredData = parseStructuredDataArg(args, questionType, true);
    const answer = optionalString(args, 'answer', 50_000);
    if (questionType === 'true_false' && answer !== null) validateTrueFalseAnswer(answer);
    const tags = Object.hasOwn(args, 'tags') ? parseStringArray(args.tags, 'tags', 50, 100) : null;
    const images = Object.hasOwn(args, 'images') ? parseQuestionImages(args.images) : null;
    if (images !== null) normalizeQuestionImageIds(imageResolver(env), images);
    const difficulty = Object.hasOwn(args, 'difficulty') ? parseDifficulty(args.difficulty, 'difficulty') : null;
    let parentId = optionalString(args, 'parent_id', 200);
    if (parentId === null) {
      const parentCardId = optionalString(args, 'parent_card_id', 200);
      if (parentCardId !== null) {
        let parent: Question | null;
        try { parent = questions.getQuestionByCardId(service, examId, parentCardId); }
        catch (error) { throw new Error(errorText(error)); }
        if (parent === null) {
          throw qbankFailure('QBANK_QUESTION_NOT_FOUND', `找不到父题 card_id=${parentCardId}`, '重新读取题目后重试');
        }
        parentId = parent.id;
      }
    }
    const cardId = optionalString(args, 'card_id', 200) ?? `card_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const questionLabel = optionalString(args, 'question_label', 120);
    const explanation = optionalString(args, 'explanation', 100_000);
    const sourceRef = optionalString(args, 'source_ref', 1_000);
    const params: CreateQuestionParams = {
      exam_id: examId, card_id: cardId, question_label: questionLabel, content, options, answer, explanation,
      question_type: questionType, difficulty, tags, source_type: 'manual', source_ref: sourceRef, images,
      parent_id: parentId, structured_data: structuredData,
    };
    let created: Question;
    try { created = questions.createQuestion(service, params); }
    catch (error) { throw new Error(errorText(error)); }
    env.emitChanged('create_question', [created.id]);
    return {
      success: true,
      question: questionToBoundedValue(created),
      previous: null,
      reversible: false,
      reversibleWithApproval: true,
      undo: {
        tool: 'builtin-qbank_delete_questions',
        requiresApproval: true,
        question_ids: [created.id],
        expected_updated_at_by_id: { [created.id]: created.updated_at },
      },
    };
  });
}

/** qbank_executor.rs:2175 `parse_delete_versions`. */
export function parseDeleteVersions(args: Args): [string, string][] {
  if (!Object.hasOwn(args, 'question_ids')) {
    throw qbankFailure('INVALID_ARGS', '缺少 question_ids', '传入要删除的 questions 表题目 ID');
  }
  const questionIds = parseStringArray(args.question_ids, 'question_ids', 20, 200);
  if (questionIds.length === 0) throw qbankFailure('INVALID_ARGS', 'question_ids 不能为空', '传入至少一个题目 ID');
  const rawMap = args.expected_updated_at_by_id ?? args.expected_updated_at;
  if (rawMap !== null && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const versionMap = rawMap as Record<string, unknown>;
    return questionIds.map(questionId => {
      const raw = asStr(versionMap[questionId]);
      const version = raw === null ? '' : raw.trim();
      if (version === '') {
        throw qbankFailure('QBANK_OCC_REQUIRED', `缺少 ${questionId} 的 expected_updated_at`,
          '逐题调用 qbank_get_question 后传入精确版本映射');
      }
      return [questionId, version];
    });
  }
  if (questionIds.length === 1) {
    const raw = asStr(args.expected_updated_at);
    const version = raw === null ? '' : raw.trim();
    if (version !== '') return [[questionIds[0]!, version]];
  }
  throw qbankFailure('QBANK_OCC_REQUIRED', '批量删除必须提供 expected_updated_at_by_id',
    '逐题调用 qbank_get_question，并以 question_id 为键传入最新 updated_at');
}

function currentBounded(service: QuestionServiceHost, questionId: string): Record<string, unknown> | null {
  try {
    const current = questions.getQuestion(service, questionId);
    return current === null ? null : questionToBoundedValue(current);
  } catch {
    return null;
  }
}

/** qbank_executor.rs:2239 `execute_delete_questions`. */
export function executeDeleteQuestions(env: QbankToolEnv): Promise<unknown> {
  const expectedVersions = parseDeleteVersions(env.args);
  return env.lock.run(() => {
    const service = env.requireService();
    let previous: Question[];
    try { previous = questions.batchDeleteQuestionsIfVersions(service, expectedVersions); }
    catch (error) {
      const message = errorText(error);
      if (message.includes('QBANK_CONFLICT')) {
        const current = expectedVersions.map(([questionId]) => currentBounded(service, questionId))
          .filter(value => value !== null);
        throw qbankConflictError(message, '批次未发生任何删除；使用 current 重新确认全部题目版本后再请求用户确认', current);
      }
      throw new Error(message);
    }
    env.emitChanged('delete_questions', previous.map(question => question.id));
    const deleted = previous.map(question => ({
      question_id: question.id, card_id: question.card_id, session_id: question.exam_id,
      content_preview: takeChars(question.content, 120), previous_updated_at: question.updated_at,
    }));
    return {
      success: true, deleted_count: deleted.length, deleted, soft_deleted: true, reversible: false,
      recovery: { availableToAgent: false, reason: '当前未暴露题目恢复工具；不得宣称已提供撤销' },
    };
  });
}

/** qbank_executor.rs:1529 `resolve_question`. */
export function resolveQuestion(service: QuestionServiceHost, args: Args): Question {
  const raw = asStr(args.question_id);
  const questionId = raw === null ? '' : raw.trim();
  let question: Question | null;
  if (questionId !== '') {
    try { question = questions.getQuestion(service, questionId); }
    catch (error) { throw new Error(errorText(error)); }
  } else {
    const examId = requiredNonEmptyString(args, 'session_id');
    const cardId = requiredNonEmptyString(args, 'card_id');
    try { question = questions.getQuestionByCardId(service, examId, cardId); }
    catch (error) { throw new Error(errorText(error)); }
  }
  if (question === null) {
    throw qbankFailure('QBANK_QUESTION_NOT_FOUND', '找不到指定题目',
      '传 question_id，或同时传 session_id 与 card_id；先用 qbank_list_questions 确认题目存在');
  }
  return question;
}

function updateWithConflict(service: QuestionServiceHost, questionId: string, params: UpdateQuestionParams,
  recordHistory: boolean, hint: string): Question {
  try { return questions.updateQuestion(service, questionId, params, recordHistory); }
  catch (error) {
    const message = errorText(error);
    if (message.includes('QBANK_CONFLICT')) throw qbankConflictError(message, hint, currentBounded(service, questionId));
    throw new Error(message);
  }
}

/** qbank_executor.rs:2302 `execute_toggle_favorite`. */
export function executeToggleFavorite(env: QbankToolEnv): Promise<unknown> {
  const expectedUpdatedAt = expectedQbankRevision(env.args);
  return env.lock.run(() => {
    const service = env.requireService();
    const raw = asStr(env.args.question_id);
    const questionId = raw === null ? '' : raw.trim();
    let question: Question | null;
    if (questionId !== '') {
      try { question = questions.getQuestion(service, questionId); }
      catch (error) { throw new Error(errorText(error)); }
    } else {
      const examId = requiredNonEmptyString(env.args, 'session_id');
      const cardId = requiredNonEmptyString(env.args, 'card_id');
      try { question = questions.getQuestionByCardId(service, examId, cardId); }
      catch (error) { throw new Error(errorText(error)); }
    }
    if (question === null) throw qbankFailure('QBANK_QUESTION_NOT_FOUND', '找不到要收藏的题目', '重新读取题目后重试');
    const previousFavorite = question.is_favorite;
    const updated = updateWithConflict(service, question.id,
      { is_favorite: !previousFavorite, expected_updated_at: expectedUpdatedAt }, false,
      '使用 current.updated_at 重新规划收藏变更，禁止盲重试');
    env.emitChanged('toggle_favorite', [updated.id]);
    return {
      success: true, question: questionToBoundedValue(updated), previous: { is_favorite: previousFavorite },
      reversible: true,
      undo: { tool: 'builtin-qbank_toggle_favorite', question_id: updated.id, expected_updated_at: updated.updated_at },
    };
  });
}

/** qbank_executor.rs:2380 `execute_toggle_bookmark`. */
export function executeToggleBookmark(env: QbankToolEnv): Promise<unknown> {
  const expectedUpdatedAt = expectedQbankRevision(env.args);
  return env.lock.run(() => {
    const service = env.requireService();
    const question = resolveQuestion(service, env.args);
    const previousBookmarked = question.is_bookmarked;
    const updated = updateWithConflict(service, question.id,
      { is_bookmarked: !previousBookmarked, expected_updated_at: expectedUpdatedAt }, false,
      '使用 current.updated_at 重新规划书签变更，禁止盲重试');
    env.emitChanged('toggle_bookmark', [updated.id]);
    return {
      success: true, question: questionToBoundedValue(updated), previous: { is_bookmarked: previousBookmarked },
      reversible: true,
      undo: { tool: 'builtin-qbank_toggle_bookmark', question_id: updated.id, expected_updated_at: updated.updated_at },
    };
  });
}

/** qbank_executor.rs:2435 `execute_get_submissions`. */
export function executeGetSubmissions(env: QbankToolEnv): unknown {
  const service = env.requireService();
  const question = resolveQuestion(service, env.args);
  const limit = readStrictU32(env.args, 'limit', 10, 1, 20);
  let submissions;
  try { submissions = questions.getSubmissions(service, question.id, limit); }
  catch (error) { throw new Error(errorText(error)); }
  const items = submissions.map(submission => {
    const [userAnswer, truncated] = boundedText(submission.user_answer, 2_000);
    return {
      submission_id: submission.id, user_answer: userAnswer, user_answer_truncated: truncated,
      is_correct: submission.is_correct, grading_method: submission.grading_method,
      submitted_at: submission.submitted_at,
    };
  });
  return {
    question_id: question.id, card_id: question.card_id, session_id: question.exam_id, submissions: items,
    count: items.length, limit, has_more: items.length === limit, truncated: items.length === limit,
  };
}

/** qbank_executor.rs:2474 `execute_get_question_history`. */
export function executeGetQuestionHistory(env: QbankToolEnv): unknown {
  const service = env.requireService();
  const question = resolveQuestion(service, env.args);
  const limit = readStrictU32(env.args, 'limit', 10, 1, 20);
  let history;
  try { history = questions.getHistory(service, question.id, limit); }
  catch (error) { throw new Error(errorText(error)); }
  const items = history.map(entry => ({
    field_name: entry.field_name, old_value: boundedOptionalText(entry.old_value),
    new_value: boundedOptionalText(entry.new_value), operator: entry.operator, reason: entry.reason,
    changed_at: entry.created_at,
  }));
  return {
    question_id: question.id, card_id: question.card_id, session_id: question.exam_id, history: items,
    count: items.length, limit, has_more: items.length === limit, truncated: items.length === limit,
  };
}

/** qbank_executor.rs:2512 `execute_batch_update_questions`. */
export function executeBatchUpdateQuestions(env: QbankToolEnv): Promise<unknown> {
  const { args } = env;
  if (!Object.hasOwn(args, 'question_ids')) {
    throw qbankFailure('INVALID_ARGS', '缺少 question_ids', '传入要更新的 questions 表题目 ID（1-20 个）');
  }
  const questionIds = parseStringArray(args.question_ids, 'question_ids', 20, 200);
  if (questionIds.length === 0) throw qbankFailure('INVALID_ARGS', 'question_ids 不能为空', '传入至少一个题目 ID');
  const rawMap = args.expected_updated_at_by_id;
  if (rawMap === null || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    throw qbankFailure('QBANK_OCC_REQUIRED', '批量更新必须提供 expected_updated_at_by_id',
      '逐题调用 qbank_get_question，并以 question_id 为键传入最新 updated_at');
  }
  const updates = args.updates;
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    throw qbankFailure('INVALID_ARGS', '缺少 updates 对象', '在 updates 中提供 difficulty/status/tags 至少一项');
  }
  const updateFields = updates as Record<string, unknown>;
  const template: UpdateQuestionParams = {};
  const changedFields: string[] = [];
  if (Object.hasOwn(updateFields, 'difficulty')) {
    template.difficulty = parseDifficulty(updateFields.difficulty, 'updates.difficulty');
    changedFields.push('difficulty');
  }
  if (Object.hasOwn(updateFields, 'status')) {
    template.status = parseStatus(updateFields.status, 'updates.status');
    changedFields.push('status');
  }
  if (Object.hasOwn(updateFields, 'tags')) {
    template.tags = parseStringArray(updateFields.tags, 'updates.tags', 50, 100);
    changedFields.push('tags');
  }
  const unknown = Object.keys(updateFields).find(key => key !== 'difficulty' && key !== 'status' && key !== 'tags');
  if (unknown !== undefined) {
    throw qbankFailure('INVALID_ARGS', `updates 包含不支持的字段: ${unknown}`,
      '批量更新只支持 difficulty/status/tags；题干/答案等内容请逐题用 qbank_update_question');
  }
  if (changedFields.length === 0) {
    throw qbankFailure('INVALID_ARGS', 'updates 没有提供任何可更新字段', '在 updates 中提供 difficulty/status/tags 至少一项');
  }
  const versionMap = rawMap as Record<string, unknown>;
  const planned = questionIds.map(questionId => {
    const raw = asStr(versionMap[questionId]);
    const version = raw === null ? '' : raw.trim();
    if (version === '') {
      throw qbankFailure('QBANK_OCC_REQUIRED', `缺少 ${questionId} 的 expected_updated_at`,
        '逐题调用 qbank_get_question 后传入精确版本映射');
    }
    return [questionId, version] as const;
  });
  return env.lock.run(() => {
    const service = env.requireService();
    const results: Record<string, unknown>[] = [];
    const updatedIds: string[] = [];
    let conflictCount = 0;
    let failedCount = 0;
    for (const [questionId, version] of planned) {
      try {
        const updated = questions.updateQuestion(service, questionId,
          { ...structuredClone(template), expected_updated_at: version }, true);
        results.push({ question_id: questionId, outcome: 'updated', updated_at: updated.updated_at });
        updatedIds.push(questionId);
      } catch (error) {
        const message = errorText(error);
        if (message.includes('QBANK_CONFLICT')) {
          conflictCount += 1;
          results.push({ question_id: questionId, outcome: 'conflict', current: currentBounded(service, questionId) });
        } else {
          failedCount += 1;
          results.push({ question_id: questionId, outcome: 'failed', error: boundedText(message, 500)[0] });
        }
      }
    }
    if (updatedIds.length > 0) env.emitChanged('batch_update', updatedIds);
    return {
      success: conflictCount === 0 && failedCount === 0,
      changed_fields: changedFields,
      updated_count: updatedIds.length,
      conflict_count: conflictCount,
      failed_count: failedCount,
      results,
      atomic: false,
      reversible: false,
      note: '逐题独立提交：冲突/失败的题目未被修改，需按 results 中的 current 重新规划',
    };
  });
}

/** qbank_executor.rs:2672 `execute_list_source_images`. */
export function executeListSourceImages(env: QbankToolEnv): unknown {
  const sessionId = requiredNonEmptyString(env.args, 'session_id');
  const { db, repos } = env.vfs();
  let exam;
  try { exam = repos.exams.getExamSheet(db, sessionId); }
  catch (error) { throw new Error(`Failed to get exam sheet: ${errorText(error)}`); }
  if (exam === null) throw new Error('Exam sheet not found');
  const metadata = exam.metadataJson as Record<string, unknown> | null;
  const rawHashes = metadata !== null && typeof metadata === 'object' ? metadata.source_image_hashes : undefined;
  let sourceHashes: string[] = Array.isArray(rawHashes) && rawHashes.every(hash => typeof hash === 'string')
    ? [...rawHashes as string[]] : [];
  if (sourceHashes.length === 0) {
    const preview = exam.previewJson as Record<string, unknown> | null;
    const pages = preview !== null && typeof preview === 'object' ? preview.pages : undefined;
    if (Array.isArray(pages)) {
      sourceHashes = pages.map(page => (page !== null && typeof page === 'object'
        ? asStr((page as Record<string, unknown>).blob_hash) : null))
        .filter((hash): hash is string => hash !== null && hash !== '');
    }
  }
  const { page, pageSize, start, end } = pageBounds(env.args, sourceHashes.length);
  return {
    session_id: sessionId,
    images: sourceHashes.slice(start, end).map((hash, offset) => ({ page_index: start + offset, blob_hash: hash })),
    total: sourceHashes.length,
    page,
    page_size: pageSize,
    has_more: end < sourceHashes.length,
    truncated: end < sourceHashes.length,
    data_included: false,
    note: '仅返回元数据；图片正文请让用户在题库 UI 查看，Agent 不应请求 base64 数据',
  };
}

/** qbank_executor.rs:2726 `execute_search_questions`. */
export function executeSearchQuestions(env: QbankToolEnv): unknown {
  const { args } = env;
  const service = env.requireService();
  const keyword = requiredNonEmptyString(args, 'keyword');
  if (charCount(keyword) > 200) throw qbankFailure('INVALID_ARGS', 'keyword 超过 200 字符上限', '缩短关键词后重试');
  const page = readStrictU32(args, 'page', 1, 1, 0xffff_ffff);
  const pageSize = readStrictU32(args, 'page_size', 20, 1, 20);
  const filters: QuestionSearchFilters = {};
  if (Object.hasOwn(args, 'status')) filters.status = [parseStatus(args.status, 'status')];
  if (Object.hasOwn(args, 'difficulty')) filters.difficulty = [parseDifficulty(args.difficulty, 'difficulty')];
  if (Object.hasOwn(args, 'question_type')) filters.question_type = [parseRepoQuestionType(args.question_type, 'question_type')];
  if (Object.hasOwn(args, 'tags')) filters.tags = parseStringArray(args.tags, 'tags', 20, 100);
  if (Object.hasOwn(args, 'is_favorite')) {
    const favorite = asBool(args.is_favorite);
    if (favorite === null) throw qbankFailure('INVALID_ARGS', 'is_favorite 必须是布尔值', '修正参数后重试');
    filters.is_favorite = favorite;
  }
  if (Object.hasOwn(args, 'sort_by')) filters.sort_by = parseSortBy(args.sort_by);
  let result;
  try { result = questions.searchQuestions(service, keyword, asStr(args.session_id), filters, page, pageSize); }
  catch (error) { throw new Error(errorText(error)); }
  return {
    results: result.results.map(item => ({
      question: questionToBoundedValue(item.question),
      highlight_content: boundedOptionalText(item.highlight_content),
      highlight_answer: boundedOptionalText(item.highlight_answer),
      highlight_explanation: boundedOptionalText(item.highlight_explanation),
      relevance_score: f64Atom(item.relevance_score),
    })),
    total: result.total,
    page: result.page,
    page_size: result.page_size,
    has_more: result.has_more,
    search_time_ms: result.search_time_ms,
    truncated: result.has_more,
  };
}

/** qbank_executor.rs:3040 `execute_update_question`. */
export function executeUpdateQuestion(env: QbankToolEnv): Promise<unknown> {
  return env.lock.run(() => {
    const { args } = env;
    const sessionId = requiredNonEmptyString(args, 'session_id');
    const cardId = requiredNonEmptyString(args, 'card_id');
    const expectedUpdatedAt = expectedQbankRevision(args);
    const service = env.requireService();
    let question: Question | null;
    try { question = questions.getQuestionByCardId(service, sessionId, cardId); }
    catch (error) { throw new Error(errorText(error)); }
    if (question === null) {
      throw qbankFailure('QBANK_OCC_UNAVAILABLE', '题目不在支持 OCC 的 questions_table 中', '重新读取或先迁移题目数据后再更新');
    }
    const params: UpdateQuestionParams = { expected_updated_at: expectedUpdatedAt };
    const changedFields: string[] = [];
    const content = optionalString(args, 'content', 50_000);
    if (content !== null) {
      if (content.trim() === '') throw qbankFailure('INVALID_ARGS', 'content 不能为空', '传入非空题干');
      params.content = content;
      changedFields.push('content');
    }
    if (Object.hasOwn(args, 'options')) {
      params.options = parseQuestionOptions(args.options);
      changedFields.push('options');
    }
    if (Object.hasOwn(args, 'question_type')) {
      params.question_type = parseRepoQuestionType(args.question_type, 'question_type');
      changedFields.push('question_type');
    }
    const answer = optionalString(args, 'answer', 50_000);
    if (answer !== null) { params.answer = answer; changedFields.push('answer'); }
    const explanation = optionalString(args, 'explanation', 100_000);
    if (explanation !== null) { params.explanation = explanation; changedFields.push('explanation'); }
    if (Object.hasOwn(args, 'difficulty')) {
      params.difficulty = parseDifficulty(args.difficulty, 'difficulty');
      changedFields.push('difficulty');
    }
    if (Object.hasOwn(args, 'tags')) {
      params.tags = parseStringArray(args.tags, 'tags', 50, 100);
      changedFields.push('tags');
    }
    const userNote = optionalString(args, 'user_note', 50_000);
    if (userNote !== null) { params.user_note = userNote; changedFields.push('user_note'); }
    if (Object.hasOwn(args, 'status')) {
      params.status = parseStatus(args.status, 'status');
      changedFields.push('status');
    }
    if (Object.hasOwn(args, 'images')) {
      const images = parseQuestionImages(args.images);
      normalizeQuestionImageIds(imageResolver(env), images);
      params.images = images;
      changedFields.push('images');
    }
    if (args.structured_data !== undefined && args.structured_data !== null) changedFields.push('structured_data');
    if (changedFields.length === 0) {
      throw qbankFailure('INVALID_ARGS', '没有提供任何可更新字段', '传入 content/options/question_type/structured_data 或其他更新字段');
    }
    const finalType = (params.question_type ?? question.question_type) as Question['question_type'];
    const finalOptions = params.options ?? question.options;
    if (isChoiceType(finalType) && (finalOptions === null || finalOptions === undefined || finalOptions.length === 0)) {
      throw qbankFailure('INVALID_ARGS', '更新后的选择题必须保留非空 options', '同时传入至少一个 {key,content} 选项，或改为非选择题题型');
    }
    const switchingToStructuredType = params.question_type !== undefined && params.question_type !== null
      && questionTypeRequiresStructuredData(params.question_type as Question['question_type'])
      && params.question_type !== question.question_type;
    params.structured_data = parseStructuredDataArg(args, finalType, switchingToStructuredType);
    if (finalType === 'true_false' && params.answer != null) validateTrueFalseAnswer(params.answer);
    const updated = updateWithConflict(service, question.id, params, true,
      '题目已被其他写入更新；使用 current 重新规划后再改，勿盲目重试');
    env.emitChanged('update_question', [updated.id]);
    return {
      success: true,
      question: questionToBoundedValue(updated),
      previous: questionToBoundedValue(question),
      changed_fields: changedFields,
      source: 'questions_table',
      updatedAt: updated.updated_at,
      updated_at: updated.updated_at,
      reversible: false,
      reversibleWithOcc: true,
      undo: {
        tool: 'builtin-qbank_update_question',
        expected_updated_at: updated.updated_at,
        restore_from: 'previous',
        note: '使用 previous 中对应字段构造反向更新；可空字段无法统一自动清空时需人工确认',
      },
    };
  });
}

/** qbank_executor.rs:3336 `execute_get_stats`. */
export function executeGetStats(env: QbankToolEnv): unknown {
  const sessionId = requiredStr(env.args, 'session_id');
  const service = env.service();
  const payload = (stats: { total_count: number; new_count: number; in_progress_count: number; mastered_count: number;
    review_count: number; correct_rate: number; total_attempts: number; total_correct: number }) => ({
    total: stats.total_count, new: stats.new_count, in_progress: stats.in_progress_count,
    mastered: stats.mastered_count, review: stats.review_count, correct_rate: f64Atom(stats.correct_rate),
    total_attempts: stats.total_attempts, total_correct: stats.total_correct, source: 'questions_table',
  });
  if (service !== null) {
    let stats = null;
    try { stats = questions.getStats(service, sessionId); } catch { stats = null; }
    if (stats !== null) return payload(stats);
    try { return payload(questions.refreshStats(service, sessionId)); }
    catch (error) { env.deps.log.debug(`[QBankExecutor] refresh_stats failed: ${errorText(error)}`); }
  }
  const { document } = loadPreview(env, sessionId);
  const counts = { total: 0, new: 0, in_progress: 0, mastered: 0, review: 0 };
  let totalAttempts = 0;
  let totalCorrect = 0;
  for (const card of previewCards(document)) {
    counts.total += 1;
    counts[card.status] += 1;
    totalAttempts += card.attempt_count;
    totalCorrect += card.correct_count;
  }
  return {
    ...counts, correct_rate: totalAttempts > 0 ? f64Atom(totalCorrect / totalAttempts) : null,
    total_attempts: totalAttempts, total_correct: totalCorrect, source: 'preview_json', degraded: true,
  };
}

/** qbank_executor.rs:1613 `list_all_questions`. */
export function listAllQuestions(env: QbankToolEnv, service: QuestionServiceHost, sessionId: string,
  filters: QuestionFilters = {}): Question[] {
  const all: Question[] = [];
  for (let page = 1; ; page += 1) {
    let result;
    try { result = questions.listQuestions(service, sessionId, filters, page, 200); }
    catch (error) { throw new Error(`Failed to list questions: ${errorText(error)}`); }
    all.push(...result.questions);
    if (!result.has_more) break;
    if (page + 1 > 10_000) {
      env.deps.log.warn(`[QBankExecutor] list_all_questions exceeded page limit, session_id=${sessionId}`);
      break;
    }
  }
  return all;
}
