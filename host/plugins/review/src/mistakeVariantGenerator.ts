import type { LlmRawPrompt } from '../../llm/api.ts';
import type { QbankService } from '../../qbank/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Difficulty, QuestionOption, QuestionType, SourceType, VfsReposService } from '../../vfs-repos/api.ts';
import { errorText } from './errors.ts';
import type {
  GenerateMistakeVariantResult,
  SprintMistakeQuestionOption,
} from './examHorizonScheduler.ts';
import type { ReviewPlan } from './review-plan-types.ts';

export const DEFAULT_VARIANT_TIMEOUT_MS = 8000;
export const MAX_VARIANT_LRU_ENTRIES = 256;
export const MAX_CACHED_VARIANTS_PER_QUESTION = 3;

const CHOICE_TYPES_REQUIRING_OPTIONS = new Set([
  'single_choice',
  'multiple_choice',
  'indefinite_choice',
]);

const CANONICAL_TRUE_FALSE_ANSWERS = new Set([
  'true',
  'false',
  't',
  'f',
  '对',
  '错',
  '正确',
  '错误',
  '是',
  '否',
]);

export interface MistakeQuestionRecord {
  id: string;
  exam_id: string;
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown;
  question_type: QuestionType;
  difficulty: Difficulty | null;
  tags: string[];
  attempt_count: number;
  correct_count: number;
  last_attempt_at: string | null;
  source_type: SourceType;
  source_ref: string | null;
  images: ReadonlyArray<{ id: string }>;
  materials?: ReadonlyArray<{ images: ReadonlyArray<{ id: string }> }>;
  parent_id: string | null;
  created_at: string;
}

export interface VariantEligibility {
  eligible: boolean;
  badgeReason: 'high_lapses' | 'repeated_wrong' | null;
}

export interface MistakeVariantGeneratorDeps {
  getVfsDb: () => SqlExecutor | null;
  getVfsRepos: () => Pick<VfsReposService, 'questions'> | null;
  getRawPrompt: () => LlmRawPrompt | null;
  getQbank: () => Pick<QbankService, 'createQuestion' | 'getQuestion'> | null;
  debug?: (message: string) => void;
  timeoutMs?: number;
}

export interface ResolveMistakeVariantOptions {
  originalQuestion: MistakeQuestionRecord;
  plan?: ReviewPlan | null;
  forceRegenerate?: boolean;
  allowLiveGeneration?: boolean;
  signal?: AbortSignal;
}

interface CachedVariantBucket {
  variants: MistakeQuestionRecord[];
  rotationCursor: number;
}

interface ValidatedVariantPayload {
  content: string;
  options: QuestionOption[] | null;
  answer: string;
  explanation: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure 32-bit FNV-1a hex digest (zero Node crypto dependency; mobile-safe).
 */
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const lo = code & 0xff;
    const hi = (code >>> 8) & 0xff;
    hash ^= lo;
    hash = Math.imul(hash, 0x01000193);
    if (hi !== 0) {
      hash ^= hi;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildVariantCacheKey(
  question: Pick<MistakeQuestionRecord, 'id' | 'content' | 'answer'>,
): string {
  const fingerprint = fnv1a32Hex(`${question.content}|${question.answer ?? ''}`);
  return `${question.id}:${fingerprint}`;
}

export function resolveVariantEligibility(
  plan: Pick<ReviewPlan, 'consecutive_failures' | 'is_difficult'> | null | undefined,
  question: Pick<MistakeQuestionRecord, 'attempt_count' | 'correct_count' | 'images' | 'materials'>,
): VariantEligibility {
  const hasQuestionImages = Array.isArray(question.images) && question.images.length > 0;
  const hasMaterialImages =
    Array.isArray(question.materials) &&
    question.materials.some((material) => Array.isArray(material.images) && material.images.length > 0);
  if (hasQuestionImages || hasMaterialImages) {
    return { eligible: false, badgeReason: null };
  }

  const consecutiveFailures = plan?.consecutive_failures ?? 0;
  const isDifficult = plan?.is_difficult === true;
  if (consecutiveFailures >= 2 || isDifficult) {
    return { eligible: true, badgeReason: 'high_lapses' };
  }

  if (
    question.attempt_count >= 2 &&
    question.correct_count / Math.max(1, question.attempt_count) < 0.60
  ) {
    return { eligible: true, badgeReason: 'repeated_wrong' };
  }

  return { eligible: false, badgeReason: null };
}

export function shouldUseMistakeVariant(
  plan: Pick<ReviewPlan, 'consecutive_failures' | 'is_difficult'> | null | undefined,
  question: Pick<MistakeQuestionRecord, 'attempt_count' | 'correct_count' | 'images' | 'materials'>,
): boolean {
  return resolveVariantEligibility(plan, question).eligible;
}

function normalizePromptCompareText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function toWireOptions(options: readonly QuestionOption[] | null | undefined): SprintMistakeQuestionOption[] | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  return options.map((opt) => ({
    key: String(opt.key),
    content: String(opt.content),
  }));
}

function toResultFromQuestion(
  question: MistakeQuestionRecord,
  originalQuestionId: string,
  params: {
    isVariant: boolean;
    fromCache: boolean;
    fallbackReason: string | null;
  },
): GenerateMistakeVariantResult {
  return {
    variantQuestionId: question.id,
    originalQuestionId,
    isVariant: params.isVariant,
    fromCache: params.fromCache,
    content: question.content,
    options: toWireOptions(question.options),
    answer: question.answer ?? null,
    explanation: question.explanation ?? null,
    structuredData: question.structured_data ?? null,
    questionType: question.question_type,
    fallbackReason: params.fallbackReason,
  };
}

function stripJsonCodeFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced !== null && fenced[1] !== undefined) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function extractAnswerTokens(answer: string, optionKeys: ReadonlySet<string>): string[] {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return [];
  if (optionKeys.has(trimmed)) return [trimmed];
  if (optionKeys.has(trimmed.toUpperCase())) return [trimmed.toUpperCase()];

  const delimited = trimmed
    .split(/[\s,;/|、]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (delimited.length > 1) {
    return delimited.map((token) => (optionKeys.has(token) ? token : token.toUpperCase()));
  }

  const allSingleAsciiKeys = [...optionKeys].every((k) => /^[A-Z0-9]$/i.test(k));
  if (allSingleAsciiKeys && /^[A-Za-z0-9]+$/.test(trimmed)) {
    return [...trimmed].map((ch) => (optionKeys.has(ch) ? ch : ch.toUpperCase()));
  }
  return [trimmed];
}

export function parseAndValidateVariantJson(
  rawText: string,
  originalQuestion: Pick<MistakeQuestionRecord, 'content' | 'question_type' | 'options'>,
): { ok: true; value: ValidatedVariantPayload } | { ok: false; reason: string } {
  const candidateJson = stripJsonCodeFence(rawText);
  if (candidateJson.length === 0) {
    return { ok: false, reason: 'empty_llm_output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateJson);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'json_not_object' };
  }

  const rawContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
  if (rawContent.length < 6) {
    return { ok: false, reason: 'content_too_short' };
  }
  if (normalizePromptCompareText(rawContent) === normalizePromptCompareText(originalQuestion.content)) {
    return { ok: false, reason: 'content_identical_to_original' };
  }

  const rawAnswer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (rawAnswer.length === 0) {
    return { ok: false, reason: 'empty_answer' };
  }

  const rawExplanation =
    typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
      ? parsed.explanation.trim()
      : null;

  const qType = originalQuestion.question_type;
  const originalHadOptions =
    Array.isArray(originalQuestion.options) && originalQuestion.options.length >= 2;
  const requiresOptions =
    CHOICE_TYPES_REQUIRING_OPTIONS.has(qType) ||
    (qType === 'true_false' && (originalHadOptions || Array.isArray(parsed.options)));

  if (requiresOptions) {
    if (!Array.isArray(parsed.options) || parsed.options.length < 2) {
      return { ok: false, reason: 'missing_choice_options' };
    }
    const validatedOptions: QuestionOption[] = [];
    const seenKeys = new Set<string>();
    for (const entry of parsed.options) {
      if (!isPlainRecord(entry)) {
        return { ok: false, reason: 'invalid_option_item' };
      }
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      const optContent = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (key.length === 0 || optContent.length === 0) {
        return { ok: false, reason: 'empty_option_key_or_content' };
      }
      const upperKey = key.toUpperCase();
      if (seenKeys.has(upperKey)) {
        return { ok: false, reason: 'duplicate_option_keys' };
      }
      seenKeys.add(upperKey);
      validatedOptions.push({ key: upperKey, content: optContent });
    }

    if (
      originalHadOptions &&
      originalQuestion.options !== null &&
      validatedOptions.length !== originalQuestion.options.length
    ) {
      return { ok: false, reason: 'option_count_mismatch' };
    }

    const tokens = extractAnswerTokens(rawAnswer, seenKeys);
    if (tokens.length === 0 || !tokens.every((token) => seenKeys.has(token))) {
      return { ok: false, reason: 'invalid_choice_answer_key' };
    }
    if ((qType === 'single_choice' || qType === 'true_false') && tokens.length !== 1) {
      return { ok: false, reason: 'single_choice_multiple_answers' };
    }

    const normalizedAnswer =
      qType === 'single_choice' || qType === 'true_false' ? tokens[0]! : [...new Set(tokens)].join('');

    return {
      ok: true,
      value: {
        content: rawContent,
        options: validatedOptions,
        answer: normalizedAnswer,
        explanation: rawExplanation,
      },
    };
  }

  if (qType === 'true_false') {
    if (!CANONICAL_TRUE_FALSE_ANSWERS.has(rawAnswer.toLowerCase())) {
      return { ok: false, reason: 'invalid_true_false_answer' };
    }
  }

  return {
    ok: true,
    value: {
      content: rawContent,
      options: null,
      answer: rawAnswer,
      explanation: rawExplanation,
    },
  };
}

export function buildIsomorphicVariantPrompt(original: MistakeQuestionRecord): string {
  const optionsBlock =
    Array.isArray(original.options) && original.options.length > 0
      ? original.options.map((opt) => `${opt.key}. ${opt.content}`).join('\n')
      : '(none)';
  const tagsLine = original.tags.length > 0 ? original.tags.join(', ') : '(none)';
  const optionRule =
    Array.isArray(original.options) && original.options.length >= 2
      ? `Keep exact option count (${original.options.length}) with distinct uppercase keys (${original.options.map((o) => o.key.toUpperCase()).join(', ')}), and change which option key holds the correct answer when feasible so position memorization fails.`
      : 'Set "options" to null.';

  return [
    'You are generating a structurally isomorphic practice variant for a mistake-review question.',
    'Strict constraints:',
    `1. Preserve the exact underlying theorem/concept, question_type ("${original.question_type}"), and reasoning depth.`,
    '2. Mutate the surface scenario, entities, and numeric parameters so memorized surface text or option positions cannot solve it.',
    `3. ${optionRule}`,
    '4. Do not output any emoji characters anywhere.',
    '5. Respond with a single valid JSON object only (no markdown prose):',
    '{"content":"...","options":[{"key":"A","content":"..."}] | null,"answer":"...","explanation":"..."}',
    '',
    'Original mistake question:',
    `- question_type: ${original.question_type}`,
    `- tags: ${tagsLine}`,
    `- content: ${original.content}`,
    `- options:\n${optionsBlock}`,
    `- canonical_answer: ${original.answer ?? ''}`,
    `- explanation: ${original.explanation ?? ''}`,
  ].join('\n');
}

export class MistakeVariantGenerator {
  private readonly deps: MistakeVariantGeneratorDeps;
  private readonly lru: Map<string, CachedVariantBucket>;

  constructor(deps: MistakeVariantGeneratorDeps) {
    this.deps = deps;
    this.lru = new Map();
  }

  private debug(message: string): void {
    if (this.deps.debug !== undefined) {
      this.deps.debug(message);
    }
  }

  private touchBucket(key: string): CachedVariantBucket | null {
    const existing = this.lru.get(key);
    if (existing === undefined) return null;
    this.lru.delete(key);
    this.lru.set(key, existing);
    return existing;
  }

  private setBucket(
    key: string,
    variants: MistakeQuestionRecord[],
    rotationCursor = 0,
  ): CachedVariantBucket {
    if (this.lru.has(key)) {
      this.lru.delete(key);
    }
    const trimmed = variants.slice(0, MAX_CACHED_VARIANTS_PER_QUESTION);
    const bucket: CachedVariantBucket = {
      variants: trimmed,
      rotationCursor,
    };
    this.lru.set(key, bucket);
    while (this.lru.size > MAX_VARIANT_LRU_ENTRIES) {
      const oldestKey = this.lru.keys().next().value;
      if (oldestKey === undefined) break;
      this.lru.delete(oldestKey);
    }
    return bucket;
  }

  private loadPersistentVariants(
    original: MistakeQuestionRecord,
    sourcePrefix: string,
  ): MistakeQuestionRecord[] {
    const vfsDb = this.deps.getVfsDb();
    const repos = this.deps.getVfsRepos();
    if (vfsDb === null || repos === null) return [];

    const matches: MistakeQuestionRecord[] = [];
    const sourceRef = `${sourcePrefix}${buildVariantCacheKey(original).slice(original.id.length + 1)}`;
    try {
      for (let page = 1; ; page += 1) {
        const listed = repos.questions.listQuestions(vfsDb, original.exam_id, {}, page, 100);
        for (const q of listed.questions) {
          if (q.id === original.id) continue;
          if (q.source_type !== 'ai_generated') continue;
          const isChild = q.parent_id === original.id &&
            q.source_ref === sourceRef;
          if (isChild) {
            matches.push(q);
          }
        }
        if (!listed.has_more || listed.questions.length === 0) break;
      }
    } catch (error) {
      this.debug(`[mistake-variant] VFS child lookup failed for ${original.id}: ${errorText(error)}`);
      return [];
    }

    matches.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    return matches.slice(-MAX_CACHED_VARIANTS_PER_QUESTION);
  }

  private pickRotatedVariant(bucket: CachedVariantBucket): MistakeQuestionRecord | null {
    if (bucket.variants.length === 0) return null;
    if (bucket.variants.length === 1) {
      bucket.rotationCursor = 1;
      return bucket.variants[0]!;
    }

    const indexed = bucket.variants.map((variant, index) => ({ variant, index }));
    indexed.sort((a, b) => {
      const aLast = a.variant.last_attempt_at;
      const bLast = b.variant.last_attempt_at;
      if (aLast === null && bLast !== null) return -1;
      if (aLast !== null && bLast === null) return 1;
      if (aLast !== null && bLast !== null && aLast !== bLast) {
        return aLast < bLast ? -1 : 1;
      }
      if (a.variant.attempt_count !== b.variant.attempt_count) {
        return a.variant.attempt_count - b.variant.attempt_count;
      }
      return a.index - b.index;
    });

    const topLast = indexed[0]!.variant.last_attempt_at;
    const topAttempts = indexed[0]!.variant.attempt_count;
    const tied = indexed.filter(
      (entry) =>
        entry.variant.last_attempt_at === topLast && entry.variant.attempt_count === topAttempts,
    );
    const chosen = tied[bucket.rotationCursor % tied.length]!;
    bucket.rotationCursor = (bucket.rotationCursor + 1) % MAX_CACHED_VARIANTS_PER_QUESTION;
    return chosen.variant;
  }

  getCachedVariant(original: MistakeQuestionRecord): MistakeQuestionRecord | null {
    const cacheKey = buildVariantCacheKey(original);
    const sourcePrefix = `isomorphic_variant:${original.id}:`;
    let bucket = this.touchBucket(cacheKey);
    if (bucket === null) {
      const persistent = this.loadPersistentVariants(original, sourcePrefix);
      if (persistent.length > 0) {
        bucket = this.setBucket(cacheKey, persistent, 0);
      }
    }
    if (bucket === null) return null;
    const qbank = this.deps.getQbank();
    if (qbank !== null) {
      bucket.variants = bucket.variants.flatMap((variant) => {
        try {
          const current = qbank.getQuestion(variant.id);
          return current === null ? [] : [current];
        } catch (error) {
          this.debug(`[mistake-variant] Cached question refresh failed for ${variant.id}: ${errorText(error)}`);
          return [variant];
        }
      });
    }
    return this.pickRotatedVariant(bucket);
  }

  async resolveOrGenerateVariant(
    options: ResolveMistakeVariantOptions,
  ): Promise<GenerateMistakeVariantResult> {
    const original = options.originalQuestion;
    const forceRegenerate = options.forceRegenerate === true;
    const allowLiveGeneration = options.allowLiveGeneration !== false;

    const cacheKey = buildVariantCacheKey(original);
    const sourcePrefix = `isomorphic_variant:${original.id}:`;

    if (!forceRegenerate) {
      const cached = this.getCachedVariant(original);
      if (cached !== null) {
        return toResultFromQuestion(cached, original.id, {
          isVariant: true,
          fromCache: true,
          fallbackReason: null,
        });
      }
    }

    if (!allowLiveGeneration) {
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: 'live_generation_budget_exhausted',
      });
    }

    if (options.signal?.aborted) {
      this.debug(`[mistake-variant] Aborted before synthesis for ${original.id}`);
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: 'aborted',
      });
    }

    const rawPrompt = this.deps.getRawPrompt();
    if (rawPrompt === null) {
      this.debug(`[mistake-variant] llmRawPrompt unavailable for ${original.id}`);
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: 'llm_unavailable',
      });
    }

    const qbank = this.deps.getQbank();
    if (qbank === null) {
      this.debug(`[mistake-variant] qbank service unavailable for ${original.id}`);
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: 'qbank_unavailable',
      });
    }

    const timeoutMs = Number.isFinite(this.deps.timeoutMs)
      ? Math.max(100, this.deps.timeoutMs!) : DEFAULT_VARIANT_TIMEOUT_MS;
    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let timedOut = false;
    const onCallerAbort = (): void => {
      controller.abort(options.signal?.reason ?? new Error('aborted'));
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onCallerAbort();
      } else {
        options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('variant_timeout'));
    }, timeoutMs);

    let llmText: string;
    try {
      const prompt = buildIsomorphicVariantPrompt(original);
      const output = await Promise.race([rawPrompt.callModel2RawPromptOpts(
        prompt,
        true,
        'exam_sheet',
        'mistake_isomorphic_variant',
        controller.signal,
      ), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (output.cancelled) {
        this.debug(`[mistake-variant] LLM output marked cancelled for ${original.id}`);
        return toResultFromQuestion(original, original.id, {
          isVariant: false,
          fromCache: false,
          fallbackReason: timedOut ? 'timeout' : 'aborted',
        });
      }
      llmText = output.assistant_message;
    } catch (error) {
      const reason = timedOut
        ? 'timeout'
        : options.signal?.aborted
          ? 'aborted'
          : 'llm_call_failed';
      this.debug(
        `[mistake-variant] Synthesis failed (${reason}) for ${original.id}: ${errorText(error)}`,
      );
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: reason,
      });
    } finally {
      clearTimeout(timer);
      if (options.signal !== undefined) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }
    }

    const validated = parseAndValidateVariantJson(llmText, original);
    if (validated.ok === false) {
      this.debug(
        `[mistake-variant] Validation failed (${validated.reason}) for ${original.id}`,
      );
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: validated.reason,
      });
    }

    const hashPart = cacheKey.slice(original.id.length + 1);
    let persisted: MistakeQuestionRecord;
    try {
      persisted = qbank.createQuestion({
        exam_id: original.exam_id,
        content: validated.value.content,
        options: validated.value.options,
        answer: validated.value.answer,
        explanation: validated.value.explanation,
        question_type: original.question_type,
        difficulty: original.difficulty,
        tags: original.tags,
        source_type: 'ai_generated',
        source_ref: `${sourcePrefix}${hashPart}`,
        parent_id: original.id,
      });
    } catch (error) {
      this.debug(
        `[mistake-variant] qbank.createQuestion failed for ${original.id}: ${errorText(error)}`,
      );
      return toResultFromQuestion(original, original.id, {
        isVariant: false,
        fromCache: false,
        fallbackReason: 'persist_failed',
      });
    }

    const existingBucket = this.touchBucket(cacheKey);
    const existingList =
      existingBucket !== null
        ? existingBucket.variants
        : this.loadPersistentVariants(original, sourcePrefix);
    const merged = [
      ...existingList.filter((item) => item.id !== persisted.id),
      persisted,
    ].slice(-MAX_CACHED_VARIANTS_PER_QUESTION);
    this.setBucket(cacheKey, merged, existingBucket?.rotationCursor ?? 0);

    return toResultFromQuestion(persisted, original.id, {
      isVariant: true,
      fromCache: false,
      fallbackReason: null,
    });
  }
}
