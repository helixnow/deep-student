/**
 * Question-level Agent Visual Diff Store (C4 W10 Part B).
 *
 * Platform-layer Zustand store: depends strictly on `zustand` and `@/api/questionBankApi`
 * (zero upward imports to `components` or `features`).
 *
 * Captures `before` Question snapshots prior to Agent-triggered refreshes and reconciles
 * them against the refreshed list to surface field-level diffs (`questionText`, `options`,
 * `correctAnswer`, `explanation`, `difficulty`, `tags`), supporting single/batch accept
 * and lossless rollback via `qbank_update_question`.
 */
import { create } from 'zustand';
import {
  isFillBlankStructuredData,
  isMatchingStructuredData,
  isNumericStructuredData,
  isOrderingStructuredData,
  type Difficulty,
  type Question,
  type QuestionImage,
  type QuestionOption,
  type QuestionStructuredData,
  type QuestionType,
} from '@/api/questionBankApi';

export type QuestionDiffField =
  | 'questionText'
  | 'options'
  | 'correctAnswer'
  | 'explanation'
  | 'difficulty'
  | 'tags';

export interface QuestionFieldChange {
  field: QuestionDiffField;
  beforeText: string;
  afterText: string;
}

export interface QuestionDiffEntry {
  examId: string;
  questionId: string;
  runId?: string;
  before: Question;
  after?: Question;
  changes: QuestionFieldChange[];
  createdAt: number;
  orderRank?: number;
}

export interface QuestionRevertParams {
  question_label: string | null;
  content: string;
  options: QuestionOption[];
  answer: string;
  explanation: string;
  structured_data: QuestionStructuredData | null;
  question_type: QuestionType | null;
  difficulty: Difficulty | null;
  tags: string[];
  user_note: string;
  images: QuestionImage[];
}

interface StagedQuestionSnapshot {
  before: Question;
  runId?: string;
  stagedAt: number;
}

export interface QbankAgentDiffState {
  stagedByExamId: Record<string, Record<string, StagedQuestionSnapshot>>;
  entriesByExamId: Record<string, QuestionDiffEntry[]>;
  stageBeforeRefresh: (
    examId: string,
    questions: readonly Question[],
    entityIds?: readonly string[],
    runId?: string,
  ) => void;
  reconcileAfterRefresh: (
    examId: string,
    nextQuestions: readonly Question[],
  ) => QuestionDiffEntry[];
  acceptQuestionDiff: (examId: string, questionId: string) => void;
  acceptAllExamDiffs: (examId: string) => void;
  consumeRevertTarget: (examId: string, questionId: string) => Question | null;
  consumeRevertAllTargets: (examId: string) => Question[];
  restoreDiffEntries: (examId: string, entries: readonly QuestionDiffEntry[]) => void;
  clearExamDiffs: (examId: string) => void;
  resetAllDiffs: () => void;
}

const PURE_DELETE_ACTIONS = new Set([
  'delete',
  'deleted',
  'remove',
  'removed',
  'batch_delete',
  'qbank_delete_question',
  'qbank_batch_delete_questions',
]);

/**
 * Returns true when a domain event payload represents an Agent-initiated modification
 * (excluding pure deletion events).
 */
export function isQbankAgentModifyPayload(
  payload?: { source?: unknown; action?: unknown } | null,
): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.source !== 'agent' && payload.source !== 'ai') return false;
  const rawAction = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';
  return !PURE_DELETE_ACTIONS.has(rawAction);
}

function normalizeMultiline(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\r\n?/g, '\n').trim();
}

function formatStructuredOptionsFallback(
  structured: QuestionStructuredData | null | undefined,
): string {
  if (!structured) return '';
  if (isFillBlankStructuredData(structured)) {
    return structured.blanks
      .map((blank, index) => `[${index + 1}] ${blank.answers.join(' / ')}`)
      .join('\n');
  }
  if (isMatchingStructuredData(structured)) {
    const left = structured.left.map((item) => `${item.key}: ${item.content}`).join(' | ');
    const right = structured.right.map((item) => `${item.key}: ${item.content}`).join(' | ');
    const pairs = structured.pairs.map((pair) => `${pair.left}-${pair.right}`).join(', ');
    return [left, right, pairs].filter(Boolean).join('\n');
  }
  if (isOrderingStructuredData(structured)) {
    const items = structured.items.map((item) => `${item.key}. ${item.content}`).join('\n');
    const order = structured.correct_order.join(' -> ');
    return [items, order].filter(Boolean).join('\n');
  }
  if (isNumericStructuredData(structured)) {
    const tol = structured.tolerance !== undefined ? ` +/- ${structured.tolerance}` : '';
    const unit = structured.unit ? ` ${structured.unit}` : '';
    return `${structured.answer_value}${tol}${unit}`;
  }
  return '';
}

export function formatQuestionOptionsForDiff(question: Question): string {
  const optionLines = (question.options ?? [])
    .map((opt) => `${opt.key.trim()}. ${normalizeMultiline(opt.content)}`)
    .filter((line) => line !== '. ');
  if (optionLines.length > 0) {
    return optionLines.join('\n');
  }
  return formatStructuredOptionsFallback(question.structured_data);
}

function formatQuestionTagsForDiff(tags: readonly string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(', ');
}

export function cloneQuestionSnapshot(question: Question): Question {
  return {
    ...question,
    ...(question.options
      ? { options: question.options.map((opt) => ({ ...opt })) }
      : {}),
    ...(question.tags ? { tags: [...question.tags] } : {}),
    ...(question.images
      ? { images: question.images.map((img) => ({ ...img })) }
      : {}),
    ...(question.materials
      ? {
          materials: question.materials.map((mat) => ({
            ...mat,
            images: mat.images.map((img) => ({ ...img })),
            ...(mat.source_refs
              ? { source_refs: mat.source_refs.map((ref) => ({ ...ref })) }
              : {}),
          })),
        }
      : {}),
    ...(question.structured_data !== undefined
      ? {
          structured_data: question.structured_data
            ? (JSON.parse(JSON.stringify(question.structured_data)) as QuestionStructuredData)
            : null,
        }
      : {}),
  };
}

export function computeQuestionFieldChanges(
  before: Question,
  after: Question,
): QuestionFieldChange[] {
  const changes: QuestionFieldChange[] = [];

  const beforeStem = normalizeMultiline(before.content || before.ocrText);
  const afterStem = normalizeMultiline(after.content || after.ocrText);
  if (beforeStem !== afterStem) {
    changes.push({
      field: 'questionText',
      beforeText: beforeStem,
      afterText: afterStem,
    });
  }

  const beforeOptions = formatQuestionOptionsForDiff(before);
  const afterOptions = formatQuestionOptionsForDiff(after);
  if (beforeOptions !== afterOptions) {
    changes.push({
      field: 'options',
      beforeText: beforeOptions,
      afterText: afterOptions,
    });
  }

  const beforeAnswer = normalizeMultiline(before.answer);
  const afterAnswer = normalizeMultiline(after.answer);
  if (beforeAnswer !== afterAnswer) {
    changes.push({
      field: 'correctAnswer',
      beforeText: beforeAnswer,
      afterText: afterAnswer,
    });
  }

  const beforeExplanation = normalizeMultiline(before.explanation);
  const afterExplanation = normalizeMultiline(after.explanation);
  if (beforeExplanation !== afterExplanation) {
    changes.push({
      field: 'explanation',
      beforeText: beforeExplanation,
      afterText: afterExplanation,
    });
  }

  const beforeDifficulty = before.difficulty ?? '';
  const afterDifficulty = after.difficulty ?? '';
  if (beforeDifficulty !== afterDifficulty) {
    changes.push({
      field: 'difficulty',
      beforeText: beforeDifficulty,
      afterText: afterDifficulty,
    });
  }

  const beforeTags = formatQuestionTagsForDiff(before.tags);
  const afterTags = formatQuestionTagsForDiff(after.tags);
  if (beforeTags !== afterTags) {
    changes.push({
      field: 'tags',
      beforeText: beforeTags,
      afterText: afterTags,
    });
  }

  return changes;
}

/**
 * Builds lossless `UpdateQuestionParams` payload for `qbank_update_question`,
 * preserving empty strings/arrays so fields added by AI are cleanly cleared back
 * to the original snapshot when reverted.
 */
export function buildQuestionRevertParams(before: Question): QuestionRevertParams {
  return {
    question_label: before.questionLabel || null,
    content: before.content ?? '',
    options: before.options ? before.options.map((opt) => ({ ...opt })) : [],
    answer: before.answer ?? '',
    explanation: before.explanation ?? '',
    structured_data: before.structured_data ?? null,
    question_type: before.questionType || null,
    difficulty: before.difficulty ?? null,
    tags: before.tags ? [...before.tags] : [],
    user_note: before.userNote ?? '',
    images: before.images ? before.images.map((img) => ({ ...img })) : [],
  };
}

/** 仅撤回仍等于 Agent 结果的字段，保留用户后续编辑。 */
export function buildSelectiveQuestionRevertParams(before: Question, after: Question, current: Question): QuestionRevertParams {
  const baseline = buildQuestionRevertParams(before);
  const agent = buildQuestionRevertParams(after);
  const latest = buildQuestionRevertParams(current);
  return Object.fromEntries(Object.entries(latest).map(([key, value]) => [key,
    JSON.stringify(value) === JSON.stringify(agent[key as keyof QuestionRevertParams])
      ? baseline[key as keyof QuestionRevertParams] : value,
  ])) as unknown as QuestionRevertParams;
}

/** 后端逐题写入没有批事务；失败时保留已成功的前缀。 */
export class QuestionRevertError extends Error {
  constructor(readonly completedQuestionIds: readonly string[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'QuestionRevertError';
  }
}

export const useQbankAgentDiffStore = create<QbankAgentDiffState>((set, get) => ({
  stagedByExamId: {},
  entriesByExamId: {},

  stageBeforeRefresh: (examId, questions, entityIds, runId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId || questions.length === 0) return;

    const cleanIds = (entityIds ?? [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean);
    const requestedIdSet = new Set(cleanIds);

    const matchedCandidates =
      requestedIdSet.size > 0
        ? questions.filter(
            (q) =>
              requestedIdSet.has(q.id) ||
              (typeof q.cardId === 'string' && requestedIdSet.has(q.cardId)),
          )
        : [];

    // Fall back to staging all existing questions when entityIds is omitted/empty
    // or carries only the parent examId rather than individual question IDs.
    const targets = matchedCandidates.length > 0 ? matchedCandidates : questions;
    if (targets.length === 0) return;

    const now = Date.now();
    set((state) => {
      const prevStaged = state.stagedByExamId[trimmedExamId] ?? {};
      const existingEntries = state.entriesByExamId[trimmedExamId] ?? [];
      const existingByQuestionId = new Map(
        existingEntries.map((entry) => [entry.questionId, entry]),
      );

      const nextStaged: Record<string, StagedQuestionSnapshot> = { ...prevStaged };
      for (const question of targets) {
        if (!question?.id) continue;
        // Preserve original baseline if this question already has an unreviewed diff or staged snapshot.
        const baseline =
          prevStaged[question.id]?.before ??
          existingByQuestionId.get(question.id)?.before ??
          cloneQuestionSnapshot(question);
        nextStaged[question.id] = {
          before: baseline,
          ...(runId ? { runId } : prevStaged[question.id]?.runId ? { runId: prevStaged[question.id].runId } : {}),
          stagedAt: now,
        };
      }

      return {
        stagedByExamId: {
          ...state.stagedByExamId,
          [trimmedExamId]: nextStaged,
        },
      };
    });
  },

  reconcileAfterRefresh: (examId, nextQuestions) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId) return [];

    const state = get();
    const staged = state.stagedByExamId[trimmedExamId];
    const existingEntries = state.entriesByExamId[trimmedExamId] ?? [];
    if (!staged || Object.keys(staged).length === 0) {
      return existingEntries;
    }

    const now = Date.now();
    const nextById = new Map<string, Question>();
    for (const q of nextQuestions) {
      if (q?.id) nextById.set(q.id, q);
    }

    const existingMap = new Map(existingEntries.map((entry) => [entry.questionId, entry]));

    for (const [questionId, snapshot] of Object.entries(staged)) {
      const nextQuestion = nextById.get(questionId);
      if (!nextQuestion) {
        existingMap.delete(questionId);
        continue;
      }
      const changes = computeQuestionFieldChanges(snapshot.before, nextQuestion);
      if (changes.length === 0) {
        existingMap.delete(questionId);
        continue;
      }
      const prevEntry = existingMap.get(questionId);
      existingMap.set(questionId, {
        examId: trimmedExamId,
        questionId,
        ...(snapshot.runId
          ? { runId: snapshot.runId }
          : prevEntry?.runId
            ? { runId: prevEntry.runId }
            : {}),
        before: snapshot.before,
        after: cloneQuestionSnapshot(nextQuestion),
        changes,
        createdAt: prevEntry?.createdAt ?? now,
      });
    }

    // Prune any previously pending entry whose question was deleted from the bank.
    for (const questionId of [...existingMap.keys()]) {
      if (!nextById.has(questionId)) {
        existingMap.delete(questionId);
      }
    }

    // Order entries matching the exam's question display order.
    const orderIndex = new Map<string, number>();
    nextQuestions.forEach((q, idx) => {
      if (q?.id) orderIndex.set(q.id, idx);
    });
    const reconciled = [...existingMap.values()]
      .map((entry) => ({
        ...entry,
        orderRank: orderIndex.get(entry.questionId) ?? entry.orderRank ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => {
        const ia = a.orderRank ?? Number.MAX_SAFE_INTEGER;
        const ib = b.orderRank ?? Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return a.createdAt - b.createdAt;
      });

    set((current) => {
      const nextStagedByExam = { ...current.stagedByExamId };
      delete nextStagedByExam[trimmedExamId];
      return {
        stagedByExamId: nextStagedByExam,
        entriesByExamId: {
          ...current.entriesByExamId,
          [trimmedExamId]: reconciled,
        },
      };
    });

    return reconciled;
  },

  acceptQuestionDiff: (examId, questionId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId || !questionId) return;
    set((state) => {
      const existing = state.entriesByExamId[trimmedExamId] ?? [];
      const filtered = existing.filter((entry) => entry.questionId !== questionId);
      const staged = { ...state.stagedByExamId[trimmedExamId] };
      delete staged[questionId];
      return {
        stagedByExamId: { ...state.stagedByExamId, [trimmedExamId]: staged },
        entriesByExamId: {
          ...state.entriesByExamId,
          [trimmedExamId]: filtered,
        },
      };
    });
  },

  acceptAllExamDiffs: (examId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId) return;
    set((state) => {
      const nextStaged = { ...state.stagedByExamId };
      delete nextStaged[trimmedExamId];
      return {
        stagedByExamId: nextStaged,
        entriesByExamId: {
          ...state.entriesByExamId,
          [trimmedExamId]: [],
        },
      };
    });
  },

  consumeRevertTarget: (examId, questionId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId || !questionId) return null;
    const existing = get().entriesByExamId[trimmedExamId];
    if (!existing || existing.length === 0) return null;
    const targetEntry = existing.find((entry) => entry.questionId === questionId);
    if (!targetEntry) return null;

    set((state) => ({
      entriesByExamId: {
        ...state.entriesByExamId,
        [trimmedExamId]: (state.entriesByExamId[trimmedExamId] ?? []).filter(
          (entry) => entry.questionId !== questionId,
        ),
      },
    }));

    return cloneQuestionSnapshot(targetEntry.before);
  },

  consumeRevertAllTargets: (examId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId) return [];
    const existing = get().entriesByExamId[trimmedExamId];
    if (!existing || existing.length === 0) return [];
    const snapshots = existing.map((entry) => cloneQuestionSnapshot(entry.before));

    set((state) => {
      const nextStaged = { ...state.stagedByExamId };
      delete nextStaged[trimmedExamId];
      return {
        stagedByExamId: nextStaged,
        entriesByExamId: {
          ...state.entriesByExamId,
          [trimmedExamId]: [],
        },
      };
    });

    return snapshots;
  },

  restoreDiffEntries: (examId, entries) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId || entries.length === 0) return;
    set((state) => {
      const current = state.entriesByExamId[trimmedExamId] ?? [];
      const mergedMap = new Map(current.map((item) => [item.questionId, item]));
      for (const entry of entries) {
        if (!mergedMap.has(entry.questionId)) {
          mergedMap.set(entry.questionId, entry);
        }
      }
      const ordered = [...mergedMap.values()].sort((a, b) => {
        const ia = a.orderRank ?? Number.MAX_SAFE_INTEGER;
        const ib = b.orderRank ?? Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return a.createdAt - b.createdAt;
      });
      return {
        entriesByExamId: {
          ...state.entriesByExamId,
          [trimmedExamId]: ordered,
        },
      };
    });
  },

  clearExamDiffs: (examId) => {
    const trimmedExamId = examId.trim();
    if (!trimmedExamId) return;
    set((state) => {
      const nextStaged = { ...state.stagedByExamId };
      const nextEntries = { ...state.entriesByExamId };
      delete nextStaged[trimmedExamId];
      delete nextEntries[trimmedExamId];
      return {
        stagedByExamId: nextStaged,
        entriesByExamId: nextEntries,
      };
    });
  },

  resetAllDiffs: () => {
    set({ stagedByExamId: {}, entriesByExamId: {} });
  },
}));
