import { invoke } from '@tauri-apps/api/core';
import type { ExamSheetSessionDetail } from '@/utils/tauriApi';
import i18n from '@/i18n';

export type QuestionStatus = 'new' | 'in_progress' | 'mastered' | 'review';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'very_hard';
export type QuestionType = 
  | 'single_choice' 
  | 'multiple_choice'
  | 'indefinite_choice'
  | 'fill_blank' 
  | 'short_answer' 
  | 'essay' 
  | 'calculation' 
  | 'proof' 
  | 'true_false'
  | 'matching'
  | 'ordering'
  | 'numeric'
  | 'other';

// ============================================================================
// 结构化题目数据（structured_data 契约，与 Rust questions.structured_data 对齐）
// ============================================================================

/** 填空题单个空位定义 */
export interface FillBlankSpec {
  /** 可接受答案列表（任一匹配即该空正确） */
  answers: string[];
  /** 是否大小写敏感，默认 false */
  case_sensitive?: boolean;
  /** 是否忽略首尾空白，默认 true */
  trim?: boolean;
}

/** fill_blank 增强：{"blanks":[{"answers":["答案1","答案一"],"case_sensitive":false,"trim":true}]} */
export interface FillBlankStructuredData {
  blanks: FillBlankSpec[];
}

/** 匹配题左/右列条目 */
export interface MatchingItem {
  key: string;
  content: string;
}

/** 匹配题配对（同时也是 matching 的 user_answer.pairs 元素） */
export interface MatchingPair {
  left: string;
  right: string;
}

/** matching：pairs 即标准答案 */
export interface MatchingStructuredData {
  left: MatchingItem[];
  right: MatchingItem[];
  pairs: MatchingPair[];
}

/** 排序题条目 */
export interface OrderingItem {
  key: string;
  content: string;
}

/** ordering：correct_order 即标准答案（key 序列，严格顺序） */
export interface OrderingStructuredData {
  items: OrderingItem[];
  correct_order: string[];
}

export type NumericToleranceMode = 'absolute' | 'relative';

/** numeric：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"} */
export interface NumericStructuredData {
  answer_value: number;
  /** 容差，默认 0 */
  tolerance?: number;
  /** 展示用单位（判分时忽略用户输入中的单位后缀） */
  unit?: string;
  /** 容差模式，默认 'absolute' */
  tolerance_mode?: NumericToleranceMode;
}

/**
 * structured_data 判别联合。各变体键互斥（blanks / pairs / correct_order / answer_value），
 * 可用下方 is*StructuredData 守卫按题型收窄。true_false 不使用 structured_data。
 */
export type QuestionStructuredData =
  | FillBlankStructuredData
  | MatchingStructuredData
  | OrderingStructuredData
  | NumericStructuredData;

export function isFillBlankStructuredData(
  data: QuestionStructuredData | null | undefined
): data is FillBlankStructuredData {
  return !!data && Array.isArray((data as FillBlankStructuredData).blanks);
}

export function isMatchingStructuredData(
  data: QuestionStructuredData | null | undefined
): data is MatchingStructuredData {
  return !!data && Array.isArray((data as MatchingStructuredData).pairs);
}

export function isOrderingStructuredData(
  data: QuestionStructuredData | null | undefined
): data is OrderingStructuredData {
  return !!data && Array.isArray((data as OrderingStructuredData).correct_order);
}

export function isNumericStructuredData(
  data: QuestionStructuredData | null | undefined
): data is NumericStructuredData {
  return !!data && typeof (data as NumericStructuredData).answer_value === 'number';
}

export type PracticeMode = 'sequential' | 'random' | 'review_first' | 'review_only' | 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper';

export interface QuestionOption {
  key: string;
  content: string;
}

export interface QuestionImage {
  id: string;
  name: string;
  mime: string;
  hash: string;
}

export interface Question {
  id: string;
  cardId?: string;
  questionLabel: string;
  content: string;
  ocrText?: string;
  questionType: QuestionType;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  tags?: string[];
  status?: QuestionStatus;
  userAnswer?: string;
  isCorrect?: boolean;
  userNote?: string;
  attemptCount?: number;
  correctCount?: number;
  lastAttemptAt?: string;
  isFavorite?: boolean;
  images?: QuestionImage[];
  /** 结构化题目数据（新题型契约，snake_case 与后端对齐） */
  structured_data?: QuestionStructuredData | null;
  // AI 评判缓存
  ai_feedback?: string;
  ai_score?: number;
  ai_graded_at?: string;
}

export interface QuestionBankStats {
  total: number;
  mastered: number;
  review: number;
  inProgress: number;
  newCount: number;
  correctRate: number;
}

export interface SubmitResult {
  /** 是否正确。主观题（需手动批改）时为 null，避免误判为"错误"。 */
  isCorrect: boolean | null;
  correctAnswer?: string;
  explanation?: string;
  message?: string;
  needsManualGrading?: boolean;
  /** 多选题部分正确：得分比例 0-1 */
  partialScore?: number;
  /** 多选题：漏选的选项 */
  missedOptions?: string[];
  /** 多选题：错选的选项 */
  wrongOptions?: string[];
  /** 本次作答记录 ID（用于关联 AI 评判） */
  submissionId?: string;
}

function mapQuestionType(rawType?: string): QuestionType {
  const t = rawType?.toLowerCase() || '';
  if (t.includes('single') || t.includes('单选')) return 'single_choice';
  if (t.includes('indefinite') || t.includes('不定项')) return 'indefinite_choice';
  if (t.includes('multiple') || t.includes('多选')) return 'multiple_choice';
  if (t.includes('fill') || t.includes('填空')) return 'fill_blank';
  if (t.includes('short') || t.includes('简答')) return 'short_answer';
  if (t.includes('essay') || t.includes('论述')) return 'essay';
  if (t.includes('calc') || t.includes('计算')) return 'calculation';
  if (t.includes('proof') || t.includes('证明')) return 'proof';
  if (t.includes('true') || t.includes('判断')) return 'true_false';
  if (t.includes('match') || t.includes('匹配') || t.includes('连线')) return 'matching';
  if (t.includes('order') || t.includes('排序')) return 'ordering';
  if (t.includes('numeric') || t.includes('数值')) return 'numeric';
  return 'other';
}

function mapStatus(rawStatus?: string): QuestionStatus {
  const s = rawStatus?.toLowerCase() || '';
  if (s === 'mastered' || s === '已掌握') return 'mastered';
  if (s === 'review' || s === '需复习') return 'review';
  if (s === 'in_progress' || s === '学习中') return 'in_progress';
  return 'new';
}

function mapDifficulty(rawDiff?: string): Difficulty | undefined {
  const d = rawDiff?.toLowerCase() || '';
  if (d === 'easy' || d === '简单') return 'easy';
  if (d === 'medium' || d === '中等') return 'medium';
  if (d === 'hard' || d === '困难') return 'hard';
  if (d === 'very_hard' || d === '极难') return 'very_hard';
  return undefined;
}

/**
 * @deprecated 仅供 OCR 预览上下文使用。
 * 此函数从 preview.pages[].cards[] 提取题目，与 Store 层从 qbank_list_questions 获取的数据是
 * 两个不同的数据源（preview cards vs questions 表）。在 ExamContentView 等正式答题场景中，
 * 始终使用 Store 数据（useQuestionBankSession），不要使用此函数。
 */
export function extractQuestionsFromSession(detail: ExamSheetSessionDetail): Question[] {
  const questions: Question[] = [];
  
  for (const page of detail.preview.pages) {
    for (const card of page.cards) {
      const options: QuestionOption[] | undefined = card.options?.map(opt => ({
        key: opt.key || '',
        content: opt.content || '',
      }));

      questions.push({
        id: card.card_id,
        cardId: card.card_id,
        questionLabel: card.question_label || `Q${questions.length + 1}`,
        content: card.ocr_text || '',
        ocrText: card.ocr_text,
        questionType: mapQuestionType(card.question_type),
        options,
        answer: card.answer,
        explanation: card.explanation,
        difficulty: mapDifficulty(card.difficulty),
        tags: card.tags || [],
        status: mapStatus(card.status),
        userAnswer: card.user_answer,
        isCorrect: card.is_correct,
        userNote: card.user_note,
        attemptCount: card.attempt_count || 0,
        correctCount: card.correct_count || 0,
        lastAttemptAt: card.last_attempt_at,
        isFavorite: (card as { is_favorite?: boolean }).is_favorite ?? false,
        images: (card as { images?: QuestionImage[] }).images || [],
      });
    }
  }

  return questions;
}

export function calculateStats(questions: Question[]): QuestionBankStats {
  const stats: QuestionBankStats = {
    total: questions.length,
    mastered: 0,
    review: 0,
    inProgress: 0,
    newCount: 0,
    correctRate: 0,
  };

  let totalAttempts = 0;
  let totalCorrect = 0;

  for (const q of questions) {
    switch (q.status) {
      case 'mastered': stats.mastered++; break;
      case 'review': stats.review++; break;
      case 'in_progress': stats.inProgress++; break;
      default: stats.newCount++;
    }
    totalAttempts += q.attemptCount ?? 0;
    totalCorrect += q.correctCount ?? 0;
  }

  if (totalAttempts > 0) {
    stats.correctRate = totalCorrect / totalAttempts;
  }

  return stats;
}

/**
 * @deprecated 此函数调用旧的 update_exam_sheet_cards API，不经过 QuestionBankService 的答题判定 + 统计刷新逻辑。
 * 答题数据不会进入 submissions 表、不触发状态转换、不更新统计。
 * 请使用 useQuestionBankSession 的 submitAnswer（走 Store → qbank_submit_answer）代替。
 */
export async function submitAnswer(
  sessionId: string,
  cardId: string,
  userAnswer: string,
  questionType?: QuestionType
): Promise<SubmitResult> {
  const response = await invoke<{ detail: ExamSheetSessionDetail }>('update_exam_sheet_cards', {
    request: {
      session_id: sessionId,
      cards: [{
        card_id: cardId,
        user_answer: userAnswer,
      }],
    },
  });

  const card = response.detail.preview.pages
    .flatMap(p => p.cards)
    .find(c => c.card_id === cardId);

  if (!card) {
    return { isCorrect: false, message: i18n.t('practice:editor.questionNotFound', 'Question not found') };
  }

  const isSubjective = questionType && ['essay', 'short_answer', 'calculation', 'proof'].includes(questionType);
  
  if (isSubjective) {
    return {
      isCorrect: null,
      correctAnswer: card.answer,
      message: i18n.t('practice:editor.subjectiveSubmitted', 'Subjective question submitted') + '. ' + i18n.t('practice:editor.judgeSelf', 'Please judge against the reference answer'),
      needsManualGrading: true,
    };
  }

  const isCorrect = card.is_correct ?? checkAnswerCorrectness(userAnswer, card.answer, questionType);

  return {
    isCorrect,
    correctAnswer: card.answer,
    message: isCorrect ? i18n.t('practice:editor.answerCorrect', 'Correct!') : i18n.t('practice:editor.answerWrongDetail', 'Incorrect, please check the correct answer.'),
  };
}

function checkAnswerCorrectness(userAnswer: string, correctAnswer?: string, questionType?: QuestionType): boolean {
  if (!correctAnswer) return false;
  
  const normalizeAnswer = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
  
  if (questionType === 'multiple_choice') {
    const userChoices = normalizeAnswer(userAnswer).split('').sort().join('');
    const correctChoices = normalizeAnswer(correctAnswer).split('').sort().join('');
    return userChoices === correctChoices;
  }
  
  return normalizeAnswer(userAnswer) === normalizeAnswer(correctAnswer);
}

export function getNextQuestionIndex(
  questions: Question[],
  currentIndex: number,
  mode: PracticeMode,
  tag?: string
): number {
  if (questions.length === 0) return 0;

  const safeCurrentIndex = Math.min(Math.max(currentIndex, 0), questions.length - 1);

  switch (mode) {
    case 'random':
      return Math.floor(Math.random() * questions.length);
    case 'review_first': {
      const reviewIdx = questions.findIndex(q => q.status === 'review');
      if (reviewIdx >= 0) return reviewIdx;
      const newIdx = questions.findIndex(q => q.status === 'new');
      if (newIdx >= 0) return newIdx;
      const progressIdx = questions.findIndex(q => q.status === 'in_progress');
      if (progressIdx >= 0) return progressIdx;
      return Math.min(currentIndex + 1, questions.length - 1);
    }
    case 'review_only': {
      const reviewIdx = questions.findIndex((q, i) => i > currentIndex && q.status === 'review');
      if (reviewIdx >= 0) return reviewIdx;
      const fromStartIdx = questions.findIndex(q => q.status === 'review');
      return fromStartIdx >= 0 ? fromStartIdx : Math.min(currentIndex + 1, questions.length - 1);
    }
    case 'by_tag': {
      // `by_tag` is only meaningful with an explicit tag. Keeping the current
      // question is preferable to silently continuing in sequential mode.
      if (!tag) return safeCurrentIndex;

      const isUntaggedMode = tag === '__untagged__';
      const matchesSelectedTag = (question: Question) => (
        isUntaggedMode
          ? !question.tags || question.tags.length === 0
          : question.tags?.includes(tag)
      );

      const nextUnmastered = questions.findIndex((question, index) => (
        index > safeCurrentIndex && question.status !== 'mastered' && matchesSelectedTag(question)
      ));
      if (nextUnmastered >= 0) return nextUnmastered;

      const firstUnmastered = questions.findIndex((question) => (
        question.status !== 'mastered' && matchesSelectedTag(question)
      ));
      if (firstUnmastered >= 0) return firstUnmastered;

      // A fully mastered tag remains a valid scope. Cycle through its questions
      // rather than leaking into another tag or falling back to sequential mode.
      const nextTagged = questions.findIndex((question, index) => (
        index > safeCurrentIndex && matchesSelectedTag(question)
      ));
      if (nextTagged >= 0) return nextTagged;

      const firstTagged = questions.findIndex(matchesSelectedTag);
      return firstTagged >= 0 ? firstTagged : safeCurrentIndex;
    }
    default:
      return Math.min(currentIndex + 1, questions.length - 1);
  }
}

// ============================================================================
// user_answer 序列化契约（与后端 question_bank_service 判分引擎对齐）
//
// - true_false: "true" / "false"
// - numeric:    原始数字字符串（如 "3.14"，可带单位由后端宽松解析）
// - fill_blank: 多空为 JSON 数组字符串 ["ans1","ans2"]（后端兼容旧单串）
// - matching:   JSON 字符串 {"pairs":[{"left":"L1","right":"R1"}]}
// - ordering:   JSON 数组字符串 ["B","A","C"]
// - 其余题型:   原始文本
// ============================================================================

/** 结构化用户作答值（前端视图层统一使用，经 encodeUserAnswer 序列化后提交） */
export type UserAnswerValue =
  | { type: 'true_false'; value: boolean }
  | { type: 'numeric'; value: string }
  | { type: 'fill_blank'; blanks: string[] }
  | { type: 'matching'; pairs: MatchingPair[] }
  | { type: 'ordering'; order: string[] }
  | { type: 'text'; value: string };

/** 将结构化作答值序列化为 user_answer 字符串（提交给 qbank_submit_answer） */
export function encodeUserAnswer(value: UserAnswerValue): string {
  switch (value.type) {
    case 'true_false':
      return value.value ? 'true' : 'false';
    case 'numeric':
      return value.value.trim();
    case 'fill_blank':
      // 单空保留裸字符串：无 structured_data.blanks 的旧题走后端单串模糊比对，
      // JSON 数组形式（["ans"]）在该回退路径下会被当作原文比较导致误判。
      if (value.blanks.length <= 1) return value.blanks[0] ?? '';
      return JSON.stringify(value.blanks);
    case 'matching':
      return JSON.stringify({ pairs: value.pairs });
    case 'ordering':
      return JSON.stringify(value.order);
    case 'text':
      return value.value;
  }
}

/** 将存量 user_answer 字符串按题型解码为结构化作答值（不可解析时回退 text/null） */
export function decodeUserAnswer(
  questionType: QuestionType,
  raw: string | null | undefined
): UserAnswerValue | null {
  if (raw == null || raw.trim() === '') return null;
  const trimmed = raw.trim();

  switch (questionType) {
    case 'true_false': {
      const parsed = parseBoolAnswer(trimmed);
      return parsed == null ? { type: 'text', value: trimmed } : { type: 'true_false', value: parsed };
    }
    case 'numeric':
      return { type: 'numeric', value: trimmed };
    case 'fill_blank': {
      const parsed = tryParseJson(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return { type: 'fill_blank', blanks: parsed as string[] };
      }
      // 兼容旧单串作答
      return { type: 'fill_blank', blanks: [trimmed] };
    }
    case 'matching': {
      const pairs = parseMatchingPairs(trimmed);
      return pairs ? { type: 'matching', pairs } : { type: 'text', value: trimmed };
    }
    case 'ordering': {
      const order = parseSequenceAnswer(trimmed);
      return order ? { type: 'ordering', order } : { type: 'text', value: trimmed };
    }
    default:
      return { type: 'text', value: trimmed };
  }
}

// ============================================================================
// 本地判分（gradeAnswerLocally）：与后端 check_answer_correctness 规则一致，
// 供前端即时反馈使用。权威结果仍以 qbank_submit_answer 返回为准。
// ============================================================================

/** gradeAnswerLocally 需要的最小题目形状（兼容 Store 层 snake_case Question） */
export interface GradableQuestion {
  question_type: QuestionType;
  answer?: string | null;
  structured_data?: QuestionStructuredData | null;
}

export interface LocalGradingResult {
  /** 是否正确；needsManualGrading 为 true 时为 null（与后端 M-063 口径一致） */
  isCorrect: boolean | null;
  needsManualGrading: boolean;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 全角字符归一化为半角（U+3000 → 空格；U+FF01..U+FF5E → 对应半角） */
export function normalizeFullwidth(s: string): string {
  let result = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) {
      result += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCodePoint(code - 0xfee0);
    } else {
      result += ch;
    }
  }
  return result;
}

/** 布尔答案宽松解析（判断题），与后端 parse_bool_answer 一致 */
function parseBoolAnswer(raw: string): boolean | null {
  const normalized = normalizeFullwidth(raw).trim().toLowerCase();
  switch (normalized) {
    case 'true': case 't': case '1': case 'yes': case 'y':
    case '对': case '正确': case '是': case '真': case '√': case '✓': case '✔':
      return true;
    case 'false': case 'f': case '0': case 'no': case 'n':
    case '错': case '错误': case '否': case '假': case '不对':
    case '×': case '✗': case '✘': case 'x':
      return false;
    default:
      return null;
  }
}

const NUMERIC_TOKEN_RE = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/;

/** 数值宽松解析：全角归一化、去千分位逗号、忽略单位后缀、支持简单分数 */
export function parseNumericInput(raw: string): number | null {
  const cleaned = normalizeFullwidth(raw).replace(/,/g, '');
  const match = cleaned.match(NUMERIC_TOKEN_RE);
  if (!match || match.index == null) return null;
  const value = Number.parseFloat(match[0]);
  if (!Number.isFinite(value)) return null;

  // 简单分数："3/4"、"3 / 4"
  const rest = cleaned.slice(match.index + match[0].length);
  const fraction = rest.match(/^\s*\/\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/);
  if (fraction) {
    const denominator = Number.parseFloat(fraction[1]);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    return value / denominator;
  }
  return value;
}

/** 序列答案解析：优先 JSON 数组，否则按常见分隔符拆分（与后端 parse_sequence_answer 一致） */
function parseSequenceAnswer(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = tryParseJson(trimmed);
  if (Array.isArray(parsed)) {
    const items: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') items.push(item);
      else if (typeof item === 'number') items.push(String(item));
      else return null;
    }
    return items.length > 0 ? items : null;
  }
  const replaced = normalizeFullwidth(trimmed)
    .replace(/->/g, ',')
    .replace(/[→⇒]/g, ',');
  const parts = replaced
    .split(/[,;、，；|\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

/** 解析 matching 作答：{"pairs":[...]} 或裸 pairs 数组 */
function parseMatchingPairs(raw: string): MatchingPair[] | null {
  const parsed = tryParseJson(raw.trim());
  const array = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { pairs?: unknown }).pairs)
      ? (parsed as { pairs: unknown[] }).pairs
      : null;
  if (!array) return null;
  const pairs: MatchingPair[] = [];
  for (const item of array) {
    if (!item || typeof item !== 'object') return null;
    const { left, right } = item as { left?: unknown; right?: unknown };
    if (typeof left !== 'string' || typeof right !== 'string') return null;
    pairs.push({ left, right });
  }
  return pairs;
}

/** 序列 key 归一化：全角归一化 + trim + 大写（matching/ordering 判分共用，UI 逐项揭示也依赖同一口径） */
export function normalizeSequenceKey(key: string): string {
  return normalizeFullwidth(key).trim().toUpperCase();
}

/** 选择题归一化：全角归一化 + 大写 + 仅保留字母数字 */
function normalizeChoice(s: string): string {
  return [...normalizeFullwidth(s).toUpperCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join('');
}

const MAX_CHOICE_KEYS = 8;

/**
 * 从选择题答案文本提取选项键集合（与后端 extract_choice_keys 相同的保守启发式）。
 * 支持纯键串（"A"、"a,c"、"A、C"）与结构化（"A. 内容 C. 内容"、"正确答案：A"）。
 */
function extractChoiceKeys(answer: string): Set<string> | null {
  const normalized = normalizeFullwidth(answer);
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  const isAsciiAlpha = (c: string) => /[a-zA-Z]/.test(c);

  // 形态一：纯键串
  const onlyKeyChars = [...trimmed].every(
    (c) => isAsciiAlpha(c) || /\s/.test(c) || ',，、;；/和与'.includes(c)
  );
  if (onlyKeyChars) {
    const letters = [...trimmed].filter(isAsciiAlpha).map((c) => c.toUpperCase());
    const keys = new Set(letters);
    if (keys.size > 0 && keys.size <= MAX_CHOICE_KEYS && keys.size === letters.length) {
      return keys;
    }
    return null;
  }

  // 形态二：结构化键（左邻为边界、右邻为键分隔符或串尾的独立字母）
  const chars = [...trimmed];
  const keys = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!isAsciiAlpha(c)) continue;
    const prev = i === 0 ? null : chars[i - 1];
    const leftOk = prev == null || /\s/.test(prev) || '（(，,、;；:：选'.includes(prev);
    const next = i + 1 < chars.length ? chars[i + 1] : null;
    const rightOk = next == null || '．.、:：)）。'.includes(next);
    if (leftOk && rightOk) keys.add(c.toUpperCase());
  }
  return keys.size > 0 && keys.size <= MAX_CHOICE_KEYS ? keys : null;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

const CORRECT: LocalGradingResult = { isCorrect: true, needsManualGrading: false };
const WRONG: LocalGradingResult = { isCorrect: false, needsManualGrading: false };
const MANUAL: LocalGradingResult = { isCorrect: null, needsManualGrading: true };

/**
 * 本地判分纯函数，与后端 QuestionBankService::check_answer_correctness 规则一致：
 * - single/multiple/indefinite_choice：选项键比较（全对才 correct）
 * - true_false：布尔宽松解析
 * - numeric：容差比较（absolute|relative），宽松解析用户输入
 * - ordering：严格顺序；matching：配对集合相等
 * - fill_blank：structured_data.blanks 逐空判分，否则旧单串比对
 * - 主观题与缺参考答案 → needsManualGrading
 */
export function gradeAnswerLocally(
  question: GradableQuestion,
  userAnswer: string
): LocalGradingResult {
  const user = userAnswer.trim();
  const answer = question.answer?.trim() || null;
  const structured = question.structured_data ?? null;

  switch (question.question_type) {
    case 'single_choice': {
      if (!answer) return MANUAL;
      if (normalizeChoice(user) === normalizeChoice(answer)) return CORRECT;
      const userKeys = extractChoiceKeys(user);
      const correctKeys = extractChoiceKeys(answer);
      if (userKeys && correctKeys && setsEqual(userKeys, correctKeys)) return CORRECT;
      return WRONG;
    }
    case 'multiple_choice':
    case 'indefinite_choice': {
      if (!answer) return MANUAL;
      const sortChars = (s: string) => [...normalizeChoice(s)].sort().join('');
      if (sortChars(user) === sortChars(answer)) return CORRECT;
      const userKeys = extractChoiceKeys(user);
      const correctKeys = extractChoiceKeys(answer);
      if (userKeys && correctKeys && setsEqual(userKeys, correctKeys)) return CORRECT;
      return WRONG;
    }
    case 'true_false': {
      if (!answer) return MANUAL;
      const correctVal = parseBoolAnswer(answer);
      if (correctVal == null) return MANUAL;
      const userVal = parseBoolAnswer(user);
      if (userVal == null) return WRONG;
      return userVal === correctVal ? CORRECT : WRONG;
    }
    case 'numeric': {
      if (isNumericStructuredData(structured)) {
        const userVal = parseNumericInput(user);
        if (userVal == null) return WRONG;
        const target = structured.answer_value;
        const tolerance = Math.abs(structured.tolerance ?? 0);
        const limit = structured.tolerance_mode === 'relative'
          ? tolerance * Math.abs(target)
          : tolerance;
        // 浮点噪声补偿叠加在容差上（与后端 grade_numeric 一致）
        const epsilon = Number.EPSILON * Math.max(Math.abs(target), 1) * 4;
        return Math.abs(userVal - target) <= limit + epsilon ? CORRECT : WRONG;
      }
      if (!answer) return MANUAL;
      const correctVal = parseNumericInput(answer);
      if (correctVal == null) return MANUAL;
      const userVal = parseNumericInput(user);
      if (userVal == null) return WRONG;
      const scale = Math.max(Math.abs(correctVal), 1);
      return Math.abs(userVal - correctVal) <= 1e-9 * scale ? CORRECT : WRONG;
    }
    case 'ordering': {
      const correctOrder = isOrderingStructuredData(structured) && structured.correct_order.length > 0
        ? structured.correct_order
        : answer
          ? parseSequenceAnswer(answer)
          : null;
      if (!correctOrder || correctOrder.length === 0) return MANUAL;
      const userOrder = parseSequenceAnswer(user);
      if (!userOrder) return WRONG;
      const normalizedCorrect = correctOrder.map(normalizeSequenceKey);
      const normalizedUser = userOrder.map(normalizeSequenceKey);
      const equal = normalizedUser.length === normalizedCorrect.length
        && normalizedUser.every((key, index) => key === normalizedCorrect[index]);
      return equal ? CORRECT : WRONG;
    }
    case 'matching': {
      const correctPairs = isMatchingStructuredData(structured) && structured.pairs.length > 0
        ? structured.pairs
        : null;
      if (!correctPairs) return MANUAL;
      const userPairs = parseMatchingPairs(user);
      if (!userPairs) return WRONG;
      const pairKey = (p: MatchingPair) =>
        `${normalizeSequenceKey(p.left)}\u0000${normalizeSequenceKey(p.right)}`;
      const userSet = new Set(userPairs.map(pairKey));
      const correctSet = new Set(correctPairs.map(pairKey));
      // 集合相等且用户提交无重复配对
      const equal = userPairs.length === userSet.size && setsEqual(userSet, correctSet);
      return equal ? CORRECT : WRONG;
    }
    case 'fill_blank': {
      if (isFillBlankStructuredData(structured) && structured.blanks.length > 0) {
        const blanks = structured.blanks;
        const parsed = tryParseJson(user);
        // 回退单串时用 trim 后的 user（与后端 grade_fill_blank 的 user_answer.trim() 同口径）
        const userValues: string[] = Array.isArray(parsed)
          ? parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
          : [user];
        if (userValues.length !== blanks.length) return WRONG;

        const normalizeBlank = (s: string, caseSensitive: boolean, trim: boolean) => {
          let value = normalizeFullwidth(s);
          if (trim) value = value.trim();
          if (!caseSensitive) value = value.toLowerCase();
          return value;
        };

        for (let i = 0; i < blanks.length; i++) {
          const blank = blanks[i];
          if (!Array.isArray(blank.answers) || blank.answers.length === 0) return MANUAL;
          const caseSensitive = blank.case_sensitive ?? false;
          const trim = blank.trim ?? true;
          const normalizedUser = normalizeBlank(userValues[i], caseSensitive, trim);
          const matched = blank.answers.some(
            (accepted) => normalizeBlank(accepted, caseSensitive, trim) === normalizedUser
          );
          if (!matched) return WRONG;
        }
        return CORRECT;
      }
      if (!answer) return MANUAL;
      const normalizeLoose = (s: string) =>
        normalizeFullwidth(s).replace(/\s+/g, '').toLowerCase();
      return normalizeLoose(user) === normalizeLoose(answer) ? CORRECT : WRONG;
    }
    case 'short_answer':
    case 'essay':
    case 'calculation':
    case 'proof':
      return MANUAL;
    default: {
      // other：精确匹配判正确，否则手动批改
      if (!answer) return MANUAL;
      return user.toLowerCase() === answer.toLowerCase() ? CORRECT : MANUAL;
    }
  }
}
