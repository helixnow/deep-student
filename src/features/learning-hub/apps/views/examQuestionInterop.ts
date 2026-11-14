/**
 * QBank Question & Mistake Cross-Plugin Interop Bridge (C7 §2.4).
 *
 * - Builds canonical `QbankSemanticAnchor` (`ds-anchor://v1/qbank/<examId>?q=<questionId>...`)
 * - Packages past-exam questions & mistakes into `DS_EXCERPT_MIME` (`ExcerptDragPayload`)
 *   with stem summary, question type, historical accuracy / mistake count, and error-cause tags
 * - Provides compact Mineral drag ghost pills (`font-mono tabular-nums`) and monotonic reveal tokens
 */
import i18n from '@/i18n';
import type { Question, QuestionType } from '@/api/questionBankApi';
import { getErrorCauses, type ErrorCause } from '@/components/review/errorCauses';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  DS_EXCERPT_MIME,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
  type CustomSemanticAnchor,
  type ExcerptDragPayload,
  type QbankSemanticAnchor,
} from '@/ui-kernel/contracts/interop';

export { DS_EXCERPT_MIME };

export const QUESTION_PULSE_DURATION_MS = 1600;
export const QUESTION_STEM_SUMMARY_MAX_CODE_POINTS = 260;
const LABEL_MAX_CODE_POINTS = 120;

const QUESTION_TYPE_DEFAULTS: Record<QuestionType, string> = {
  single_choice: '单选',
  multiple_choice: '多选',
  indefinite_choice: '不定项',
  true_false: '判断',
  fill_blank: '填空',
  matching: '匹配',
  ordering: '排序',
  numeric: '数值',
  short_answer: '简答',
  essay: '论述',
  calculation: '计算',
  proof: '证明',
  other: '其他',
};

const ERROR_CAUSE_DEFAULTS: Record<ErrorCause, string> = {
  neverCorrect: '从未答对',
  repeatedErrors: '反复出错',
  highErrorRate: '高错误率',
  stale: '久未复习',
};

function truncateCodePoints(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  const cps = Array.from(cleaned);
  return cps.length > max ? cps.slice(0, max).join('') : cleaned;
}

export function summarizeQuestionStem(
  rawStem: string | undefined,
  maxCodePoints = QUESTION_STEM_SUMMARY_MAX_CODE_POINTS,
): string {
  if (typeof rawStem !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const collapsed = rawStem.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const cps = Array.from(collapsed);
  if (cps.length <= maxCodePoints) return collapsed;
  return `${cps.slice(0, Math.max(1, maxCodePoints - 1)).join('')}…`;
}

export interface BuildQuestionSemanticAnchorParams {
  resourceId: string;
  aliasResourceId?: string;
  questionId?: string;
  examTitle?: string;
  questionLabel?: string;
}

export function buildQuestionSemanticAnchor(
  params: BuildQuestionSemanticAnchorParams,
): QbankSemanticAnchor {
  const resourceId = params.resourceId.trim();
  const alias = params.aliasResourceId?.trim();
  const questionId = params.questionId?.trim();
  const examTitle = truncateCodePoints(params.examTitle, 80);
  const qLabel = truncateCodePoints(params.questionLabel, 32);
  const rawLabel =
    examTitle && qLabel && examTitle !== qLabel
      ? `${examTitle} · ${qLabel}`
      : examTitle || qLabel;
  const label = truncateCodePoints(rawLabel, LABEL_MAX_CODE_POINTS);

  return {
    kind: 'qbank',
    resourceId,
    ...(alias && alias !== resourceId ? { aliasResourceId: alias } : {}),
    ...(questionId ? { questionId } : {}),
    ...(label ? { label } : {}),
  };
}

export interface QuestionExcerptMeta {
  resourceId: string;
  questionId: string;
  questionLabel: string;
  questionType: QuestionType;
  questionTypeLabel: string;
  stemSummary: string;
  attemptCount: number;
  correctCount: number;
  mistakeCount: number;
  /** Integer percentage in [0, 100] when attemptCount > 0, otherwise null. */
  accuracyPercent: number | null;
  /** Tabular numeric string (e.g. "67%" or "--"). */
  accuracyText: string;
  /** Tabular numeric mistake counter string (e.g. "2"). */
  mistakeCountText: string;
  isMistake: boolean;
  errorCauses: ErrorCause[];
  errorCauseLabels: string[];
  tags: string[];
}

export function deriveQuestionExcerptMeta(params: {
  resourceId: string;
  question: Question;
  questionIndex?: number;
}): QuestionExcerptMeta {
  const { question } = params;
  const resourceId = params.resourceId.trim();
  const questionId = question.id.trim();
  const fallbackNumber =
    typeof params.questionIndex === 'number' && Number.isFinite(params.questionIndex)
      ? `Q${Math.max(1, Math.floor(params.questionIndex) + 1)}`
      : questionId;
  const questionLabel = question.questionLabel?.trim() || fallbackNumber;
  const questionType: QuestionType = question.questionType || 'other';
  const questionTypeLabel = i18n.t(`exam_sheet:questionTypes.${questionType}`, {
    defaultValue: QUESTION_TYPE_DEFAULTS[questionType] ?? '其他',
  });

  const attemptCount = Math.max(0, Math.floor(question.attemptCount ?? 0));
  const correctCount = Math.min(attemptCount, Math.max(0, Math.floor(question.correctCount ?? 0)));
  const rawMistakes = Math.max(0, attemptCount - correctCount);
  const mistakeCount =
    rawMistakes > 0
      ? rawMistakes
      : question.isCorrect === false || question.status === 'review'
        ? 1
        : 0;
  const accuracyPercent =
    attemptCount > 0 ? Math.round((correctCount / attemptCount) * 100) : null;
  const accuracyText = accuracyPercent !== null ? `${accuracyPercent}%` : '--';
  const mistakeCountText = String(mistakeCount);

  const isMistake =
    question.status === 'review' || question.isCorrect === false || mistakeCount > 0;
  const errorCauses = isMistake ? getErrorCauses(question) : [];
  const errorCauseLabels = errorCauses.map((cause) =>
    i18n.t(`exam_sheet:interop.errorCause.${cause}`, {
      defaultValue: ERROR_CAUSE_DEFAULTS[cause],
    }),
  );

  const tags = (question.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const stemSummary = summarizeQuestionStem(question.content || question.ocrText || '');

  return {
    resourceId,
    questionId,
    questionLabel,
    questionType,
    questionTypeLabel,
    stemSummary,
    attemptCount,
    correctCount,
    mistakeCount,
    accuracyPercent,
    accuracyText,
    mistakeCountText,
    isMistake,
    errorCauses,
    errorCauseLabels,
    tags,
  };
}

export interface BuildQuestionExcerptParams {
  resourceId: string;
  aliasResourceId?: string;
  examTitle?: string;
  question: Question;
  questionIndex?: number;
  imageDataUrl?: string;
  createdAt?: number;
}

export type QuestionExcerptPayload = ExcerptDragPayload & {
  meta: QuestionExcerptMeta;
};

export function formatQuestionExcerptText(meta: QuestionExcerptMeta): string {
  const statsParts: string[] = [];
  if (meta.attemptCount > 0) {
    statsParts.push(
      i18n.t('exam_sheet:interop.accuracyRate', {
        rate: meta.accuracyText,
        defaultValue: `正确率 ${meta.accuracyText}`,
      }),
    );
    statsParts.push(
      i18n.t('exam_sheet:interop.attemptSummary', {
        mistakes: meta.mistakeCountText,
        attempts: String(meta.attemptCount),
        defaultValue: `错 ${meta.mistakeCountText}/${meta.attemptCount} 次`,
      }),
    );
  } else if (meta.isMistake) {
    statsParts.push(
      i18n.t('exam_sheet:interop.mistakeCount', {
        count: meta.mistakeCountText,
        defaultValue: `错 ${meta.mistakeCountText} 次`,
      }),
    );
  } else {
    statsParts.push(
      i18n.t('exam_sheet:interop.unattempted', {
        defaultValue: '尚未作答',
      }),
    );
  }

  if (meta.errorCauseLabels.length > 0) {
    const causePrefix = i18n.t('exam_sheet:interop.errorCausePrefix', {
      defaultValue: '错因：',
    });
    statsParts.push(`${causePrefix}${meta.errorCauseLabels.join('、')}`);
  }

  const headerLine = `[${meta.questionTypeLabel} · ${meta.questionLabel}] ${statsParts.join(' · ')}`;
  const lines = [headerLine];

  if (meta.tags.length > 0) {
    const tagsPrefix = i18n.t('exam_sheet:interop.tagsPrefix', {
      defaultValue: '考点：',
    });
    lines.push(`${tagsPrefix}${meta.tags.join('、')}`);
  }

  if (meta.stemSummary) {
    lines.push(meta.stemSummary);
  }

  return lines.join('\n');
}

/**
 * Packages a QBank question or mistake into a `DS_EXCERPT_MIME` drag payload
 * (with canonical `QbankSemanticAnchor` + structured `meta` metrics).
 */
export function buildQuestionExcerptPayload(
  params: BuildQuestionExcerptParams,
): QuestionExcerptPayload {
  const meta = deriveQuestionExcerptMeta({
    resourceId: params.resourceId,
    question: params.question,
    questionIndex: params.questionIndex,
  });

  const anchor = buildQuestionSemanticAnchor({
    resourceId: params.resourceId,
    aliasResourceId: params.aliasResourceId,
    questionId: meta.questionId,
    examTitle: params.examTitle,
    questionLabel: meta.questionLabel,
  });

  const anchorUri = serializeSemanticAnchor(anchor);
  // 标题胶囊使用摘要；拖拽正文保留完整题干与选项，不能截断 LaTeX 环境。
  const stem = (params.question.content || params.question.ocrText || '').replace(/\r\n?/g, '\n').trim();
  const options = (params.question.options ?? []).map((option) => `${option.key}. ${option.content}`).join('\n');
  const text = [formatQuestionExcerptText({ ...meta, stemSummary: '' }), stem, options].filter(Boolean).join('\n');
  const rawTitle = params.examTitle?.trim()
    ? `${params.examTitle.trim()} · ${meta.questionLabel}`
    : `${meta.questionTypeLabel} · ${meta.questionLabel}`;
  const sourceTitle = truncateCodePoints(rawTitle, LABEL_MAX_CODE_POINTS);

  const sanitized = sanitizeExcerptDragPayload({
    excerptKind: params.imageDataUrl ? 'region-image' : 'text',
    text,
    ...(params.imageDataUrl ? { imageDataUrl: params.imageDataUrl } : {}),
    anchor,
    anchorUri,
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
  });

  if (!sanitized) {
    throw new RangeError('Invalid QuestionExcerptPayload');
  }

  return {
    ...sanitized,
    meta,
  };
}

/** Resolves target questionId from either a `qbank` anchor or a custom `exam` anchor. */
export function extractQuestionIdFromAnchor(
  anchor: QbankSemanticAnchor | CustomSemanticAnchor,
): string | null {
  if (anchor.kind === 'qbank') {
    const qid = anchor.questionId?.trim();
    return qid || null;
  }
  if (anchor.namespace !== 'exam' && anchor.namespace !== 'qbank') {
    return null;
  }
  const paramId = anchor.params?.questionId?.trim() || anchor.params?.q?.trim();
  if (paramId) return paramId;
  const loc = anchor.locator.trim();
  return loc && loc !== '*' ? loc : null;
}

export function buildQuestionDragGhostLabel(meta: QuestionExcerptMeta): string {
  const statBadge =
    meta.attemptCount > 0
      ? `${meta.accuracyText} · -${meta.mistakeCountText}`
      : meta.isMistake
        ? `-${meta.mistakeCountText}`
        : meta.questionTypeLabel;
  const snippet = Array.from(meta.stemSummary).slice(0, 14).join('');
  return snippet
    ? `${meta.questionLabel} · ${statBadge} · ${snippet}`
    : `${meta.questionLabel} · ${statBadge}`;
}

/**
 * Compact Mineral drag ghost pill with tabular numbers; removed on next macrotask.
 */
export function setCompactQuestionDragImage(
  dataTransfer: DataTransfer | null | undefined,
  meta: QuestionExcerptMeta,
): void {
  if (
    !dataTransfer ||
    typeof dataTransfer.setDragImage !== 'function' ||
    typeof document === 'undefined'
  ) {
    return;
  }
  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.className = 'font-mono tabular-nums';
  ghost.textContent = buildQuestionDragGhostLabel(meta);
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    maxWidth: '240px',
    padding: '3px 10px',
    borderRadius: '999px',
    border: '1px solid hsl(var(--border) / 0.35)',
    background: 'hsl(var(--card))',
    color: 'hsl(var(--foreground))',
    font: '500 11px/1.4 var(--font-mono, ui-monospace, monospace)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ghost);
  try {
    dataTransfer.setDragImage(ghost, 12, 12);
  } catch {
    // Fallback to browser default snapshot when custom drag image is unsupported.
  }
  window.setTimeout(() => ghost.remove(), 0);
}

/**
 * Initiates a `DS_EXCERPT_MIME` drag session for a QBank question or mistake.
 */
export function startQuestionExcerptDrag(
  event: Pick<DragEvent, 'dataTransfer'>,
  params: BuildQuestionExcerptParams,
): QuestionExcerptPayload | null {
  let payload: QuestionExcerptPayload;
  try {
    payload = buildQuestionExcerptPayload(params);
  } catch {
    return null;
  }
  const started = getAppKernel().dnd.startExcerptDrag(event, payload);
  if (!started) return null;
  setCompactQuestionDragImage(event.dataTransfer, payload.meta);
  return payload;
}

export interface QuestionRevealSequencer {
  next(): number;
  isCurrent(token: number): boolean;
  cancel(): void;
}

export function createQuestionRevealSequencer(): QuestionRevealSequencer {
  let seq = 0;
  return {
    next: () => {
      seq += 1;
      return seq;
    },
    isCurrent: (token) => token === seq,
    cancel: () => {
      seq += 1;
    },
  };
}
