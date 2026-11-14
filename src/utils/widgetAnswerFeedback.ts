/**
 * 交互式题卡答案反馈校验协议（Widget Answer Feedback v1）。
 *
 * 安全与业务边界：
 * 1. 严格限制 JSON 深度（<= 16）、节点总数（<= 8000）、单字段长度与总 UTF-8 字节上限（<= 32768 字节），超限直接拒绝（Fail-closed），绝不截断放行；
 * 2. 作答身份绑定（attemptId / requestId）与单调递增时间戳（updatedAt / timestamp）校验，拒绝跨题串台、乱序旧包与从已判定状态倒退回 pending；
 * 3. 严格区分权威客观题判分（authoritative: true，仅限 grading === 'host' 且状态为 correct/incorrect/partial）与非权威 AI 参考批改（authoritative: false，仅限 pending/review）。
 */

export const WIDGET_FEEDBACK_SCHEMA_VERSION = 1 as const;
export const MAX_FEEDBACK_ID_LENGTH = 128;
export const MAX_FEEDBACK_EXPLANATION_LENGTH = 16000;
export const MAX_FEEDBACK_STRING_LENGTH = 32768;
export const MAX_FEEDBACK_JSON_DEPTH = 16;
export const MAX_FEEDBACK_JSON_NODES = 8000;
export const MAX_FEEDBACK_UTF8_BYTES = 32768;

export type WidgetFeedbackStatus =
  | 'pending'
  | 'correct'
  | 'incorrect'
  | 'partial'
  | 'review';

export type WidgetFeedbackGradingSource = 'host' | 'ai' | 'self';

export interface WidgetAnswerFeedbackEnvelope {
  version: 1;
  attemptId: string;
  requestId: string;
  status: WidgetFeedbackStatus;
  answer: unknown;
  correctAnswer?: unknown;
  explanation?: string;
  grading: WidgetFeedbackGradingSource;
  authoritative: boolean;
  updatedAt: number;
  timestamp: number;
}

export type WidgetFeedbackValidationErrorCode =
  | 'INVALID_OBJECT'
  | 'UNKNOWN_PROPERTY'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_ATTEMPT_ID'
  | 'INVALID_STATUS'
  | 'INVALID_GRADING_SOURCE'
  | 'INVALID_AUTHORITY_FLAG'
  | 'AUTHORITY_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'MISSING_ANSWER'
  | 'INVALID_EXPLANATION'
  | 'JSON_LIMIT_EXCEEDED'
  | 'UTF8_SIZE_EXCEEDED'
  | 'ATTEMPT_ID_MISMATCH'
  | 'STALE_TIMESTAMP'
  | 'STATUS_REGRESSION';

export interface WidgetFeedbackValidationResult {
  ok: boolean;
  errorCode?: WidgetFeedbackValidationErrorCode;
  envelope: WidgetAnswerFeedbackEnvelope | null;
}

export interface HostQuizQuestion {
  stem: string;
  type?: 'single' | 'multiple' | 'boolean' | 'freeform';
  options?: string[];
  answer?: unknown;
  explanation?: string;
  answerSource?: 'host' | 'ai';
}

const ALLOWED_ENVELOPE_KEYS = new Set([
  'version',
  'attemptId',
  'requestId',
  'status',
  'answer',
  'correctAnswer',
  'explanation',
  'grading',
  'authoritative',
  'updatedAt',
  'timestamp',
]);

const VALID_STATUSES = new Set<WidgetFeedbackStatus>([
  'pending',
  'correct',
  'incorrect',
  'partial',
  'review',
]);

const AUTHORITATIVE_STATUSES = new Set<WidgetFeedbackStatus>([
  'correct',
  'incorrect',
  'partial',
]);

const VALID_GRADING_SOURCES = new Set<WidgetFeedbackGradingSource>([
  'host',
  'ai',
  'self',
]);

function inspectBoundedJsonPayload(rootValue: unknown): boolean {
  let nodes = 0;
  const stack: Array<[unknown, number]> = [[rootValue, 0]];
  const activeAncestors = new Set<object>();

  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (depth < 0) {
      activeAncestors.delete(value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_FEEDBACK_JSON_NODES || depth > MAX_FEEDBACK_JSON_DEPTH) {
      return false;
    }
    if (value === null || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_FEEDBACK_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return false;
      }
      continue;
    }
    if (!value || typeof value !== 'object') {
      return false;
    }
    const isArray = Array.isArray(value);
    const isPlainObject =
      !isArray && Object.prototype.toString.call(value) === '[object Object]';
    if (!isArray && !isPlainObject) {
      return false;
    }
    if (activeAncestors.has(value)) {
      return false;
    }
    const children = Object.values(value);
    if (children.length + stack.length > MAX_FEEDBACK_JSON_NODES) {
      return false;
    }
    activeAncestors.add(value);
    stack.push([value, -1]);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], depth + 1]);
    }
  }
  return true;
}

/**
 * 校验单调更新顺序与作答身份一致性：
 * - 同一次挂载只允许同一 attemptId 更新；
 * - 后续更新的 updatedAt 必须严格大于当前已生效的 updatedAt；
 * - 已进入非 pending 态后不允许倒退回 pending。
 */
export function acceptsWidgetFeedbackUpdate(
  current: Pick<
    WidgetAnswerFeedbackEnvelope,
    'attemptId' | 'updatedAt' | 'status'
  > | null,
  next: Pick<WidgetAnswerFeedbackEnvelope, 'attemptId' | 'updatedAt' | 'status'>,
): { ok: true } | { ok: false; errorCode: WidgetFeedbackValidationErrorCode } {
  if (!current) {
    return { ok: true };
  }
  if (next.attemptId !== current.attemptId) {
    return { ok: false, errorCode: 'ATTEMPT_ID_MISMATCH' };
  }
  if (next.updatedAt < current.updatedAt || (next.updatedAt === current.updatedAt &&
      !(current.status === 'pending' && next.status !== 'pending'))) {
    return { ok: false, errorCode: 'STALE_TIMESTAMP' };
  }
  if (current.status !== 'pending' && next.status === 'pending') {
    return { ok: false, errorCode: 'STATUS_REGRESSION' };
  }
  return { ok: true };
}

/**
 * 校验 v1 交互题卡反馈信封（支持作答身份绑定与可选的前序状态单调递增校验）。
 */
export function validateWidgetAnswerFeedbackEnvelope(
  raw: unknown,
  options?: {
    expectedAttemptId?: string;
    currentEnvelope?: Pick<
      WidgetAnswerFeedbackEnvelope,
      'attemptId' | 'updatedAt' | 'status'
    > | null;
  },
): WidgetFeedbackValidationResult {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errorCode: 'INVALID_OBJECT', envelope: null };
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((k) => !ALLOWED_ENVELOPE_KEYS.has(k))) {
      return { ok: false, errorCode: 'UNKNOWN_PROPERTY', envelope: null };
    }

    if (record.version !== WIDGET_FEEDBACK_SCHEMA_VERSION) {
      return { ok: false, errorCode: 'UNSUPPORTED_VERSION', envelope: null };
    }

    const rawAttemptId = record.attemptId ?? record.requestId;
    if (
      typeof rawAttemptId !== 'string' ||
      rawAttemptId.length === 0 ||
      rawAttemptId.length > MAX_FEEDBACK_ID_LENGTH
    ) {
      return { ok: false, errorCode: 'INVALID_ATTEMPT_ID', envelope: null };
    }
    if (
      record.attemptId !== undefined &&
      record.requestId !== undefined &&
      record.attemptId !== record.requestId
    ) {
      return { ok: false, errorCode: 'INVALID_ATTEMPT_ID', envelope: null };
    }

    if (
      options?.expectedAttemptId !== undefined &&
      rawAttemptId !== options.expectedAttemptId
    ) {
      return { ok: false, errorCode: 'ATTEMPT_ID_MISMATCH', envelope: null };
    }

    const status = record.status as WidgetFeedbackStatus;
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, errorCode: 'INVALID_STATUS', envelope: null };
    }

    const grading = record.grading as WidgetFeedbackGradingSource;
    if (!VALID_GRADING_SOURCES.has(grading)) {
      return { ok: false, errorCode: 'INVALID_GRADING_SOURCE', envelope: null };
    }

    if (typeof record.authoritative !== 'boolean') {
      return { ok: false, errorCode: 'INVALID_AUTHORITY_FLAG', envelope: null };
    }
    const authoritative = record.authoritative;

    // 区分权威客观题判分与非权威 AI 参考批改
    if (authoritative) {
      if (grading !== 'host' || !AUTHORITATIVE_STATUSES.has(status)) {
        return { ok: false, errorCode: 'AUTHORITY_MISMATCH', envelope: null };
      }
    } else if (AUTHORITATIVE_STATUSES.has(status)) {
      return { ok: false, errorCode: 'AUTHORITY_MISMATCH', envelope: null };
    }

    const rawUpdatedAt = record.updatedAt ?? record.timestamp;
    if (
      typeof rawUpdatedAt !== 'number' ||
      !Number.isSafeInteger(rawUpdatedAt) ||
      rawUpdatedAt < 0
    ) {
      return { ok: false, errorCode: 'INVALID_TIMESTAMP', envelope: null };
    }
    if (
      record.updatedAt !== undefined &&
      record.timestamp !== undefined &&
      record.updatedAt !== record.timestamp
    ) {
      return { ok: false, errorCode: 'INVALID_TIMESTAMP', envelope: null };
    }

    if (!Object.prototype.hasOwnProperty.call(record, 'answer')) {
      return { ok: false, errorCode: 'MISSING_ANSWER', envelope: null };
    }

    if (record.explanation !== undefined) {
      if (
        typeof record.explanation !== 'string' ||
        record.explanation.length > MAX_FEEDBACK_EXPLANATION_LENGTH
      ) {
        return { ok: false, errorCode: 'INVALID_EXPLANATION', envelope: null };
      }
    }

    // 校验 answer 与 correctAnswer 的节点数、深度与基本类型合法性
    const combinedRoots =
      record.correctAnswer !== undefined
        ? [record.answer, record.correctAnswer]
        : [record.answer];
    if (!inspectBoundedJsonPayload(combinedRoots)) {
      return { ok: false, errorCode: 'JSON_LIMIT_EXCEEDED', envelope: null };
    }

    const serialized = JSON.stringify(record);
    const byteLength = new TextEncoder().encode(serialized).length;
    if (byteLength > MAX_FEEDBACK_UTF8_BYTES) {
      return { ok: false, errorCode: 'UTF8_SIZE_EXCEEDED', envelope: null };
    }

    const cloned = JSON.parse(serialized) as Record<string, unknown>;
    const envelope: WidgetAnswerFeedbackEnvelope = {
      version: 1,
      attemptId: rawAttemptId,
      requestId: rawAttemptId,
      status,
      answer: cloned.answer,
      ...(cloned.correctAnswer !== undefined
        ? { correctAnswer: cloned.correctAnswer }
        : {}),
      ...(typeof cloned.explanation === 'string'
        ? { explanation: cloned.explanation }
        : {}),
      grading,
      authoritative,
      updatedAt: rawUpdatedAt,
      timestamp: rawUpdatedAt,
    };

    if (options?.currentEnvelope) {
      const transition = acceptsWidgetFeedbackUpdate(
        options.currentEnvelope,
        envelope,
      );
      if (transition.ok === false) {
        return {
          ok: false,
          errorCode: transition.errorCode,
          envelope: null,
        };
      }
    }

    return { ok: true, envelope };
  } catch {
    return { ok: false, errorCode: 'JSON_LIMIT_EXCEEDED', envelope: null };
  }
}

/**
 * 便捷读取函数：校验通过返回克隆后的安全信封，否则返回 null（Fail-closed）。
 */
export function readWidgetAnswerFeedback(
  raw: unknown,
): WidgetAnswerFeedbackEnvelope | null {
  const result = validateWidgetAnswerFeedbackEnvelope(raw);
  return result.ok ? result.envelope : null;
}

/**
 * 根据宿主客观题与用户作答构建反馈信封：
 * - 宿主权威客观题（answerSource !== 'ai' 且题型非主观 freeform）：返回 authoritative = true 的 correct / incorrect 判定；
 * - AI 参考题或主观题（freeform / answerSource === 'ai'）：返回 authoritative = false 且 status = 'pending' 或 'review' 的待核验信封。
 */
export function canonicalEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => canonicalEqual(value, right[index]));
  }
  const a = Object.keys(left);
  const b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
    canonicalEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function buildQuizWidgetAnswerFeedback(input: {
  attemptId: string;
  question: HostQuizQuestion;
  userAnswer: unknown;
  updatedAt?: number;
  reviewMode?: boolean;
}): WidgetAnswerFeedbackEnvelope | null {
  const { attemptId, question, userAnswer, updatedAt = Date.now(), reviewMode = false } = input;
  const isSubjectiveOrAi =
    question.type === 'freeform' ||
    question.answerSource === 'ai' ||
    question.answer === undefined ||
    question.answer === null;

  if (isSubjectiveOrAi) {
    const baseExplanation = question.explanation ? question.explanation : '';
    const explanation = baseExplanation
      ? `待核验；参考内容不计分。${baseExplanation}`
      : '待核验；参考内容不计分。';

    return readWidgetAnswerFeedback({
      version: 1,
      attemptId,
      status: reviewMode ? 'review' : 'pending',
      answer: userAnswer,
      ...(question.answer !== undefined && question.answer !== null
        ? { correctAnswer: question.answer }
        : {}),
      explanation,
      grading: question.answerSource === 'ai' ? 'ai' : 'self',
      authoritative: false,
      updatedAt,
    });
  }

  const isCorrect =
    canonicalEqual(userAnswer, question.answer);

  return readWidgetAnswerFeedback({
    version: 1,
    attemptId,
    status: isCorrect ? 'correct' : 'incorrect',
    answer: userAnswer,
    correctAnswer: question.answer,
    ...(question.explanation ? { explanation: question.explanation } : {}),
    grading: 'host',
    authoritative: true,
    updatedAt,
  });
}
