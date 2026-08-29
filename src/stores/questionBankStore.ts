/**
 * 智能题目集 Store
 * 
 * 提供题目集的统一状态管理，支持：
 * - 题目 CRUD 操作
 * - 答题状态更新
 * - 统计数据缓存
 * - 筛选与分页
 */

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';
import type {
  QuestionType,
  QuestionStatus,
  Difficulty,
  PracticeMode,
  QuestionOption,
  QuestionImage,
  QuestionStructuredData,
} from '@/api/questionBankApi';

// ============================================================================
// 类型定义（基础类型从 API 层导入，Store 特有类型在此定义）
// ============================================================================

// 重新导出基础类型以保持向后兼容
export type {
  QuestionType,
  QuestionStatus,
  Difficulty,
  PracticeMode,
  QuestionOption,
  QuestionImage,
};

export type SourceType = 'ocr' | 'imported' | 'ai_generated' | 'manual';

/**
 * 历史别名：API 层 QuestionType 已并入 true_false / matching / ordering / numeric，
 * 本联合与 QuestionType 等价。保留导出名以兼容既有 import。
 */
export type ExtendedQuestionType = QuestionType;

/**
 * 练习/组卷配置界面使用的题型显示顺序。
 * 与浏览管理流 src/components/questionTypeMeta.ts 的 QUESTION_TYPE_ORDER 保持一致。
 * 只增不删；文案键位于 practice.json 的 questionType.*。
 */
export const PRACTICE_QUESTION_TYPES: readonly ExtendedQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'indefinite_choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'calculation',
  'numeric',
  'proof',
  'matching',
  'ordering',
  'other',
];

export interface Question {
  id: string;
  exam_id: string;
  card_id?: string;
  question_label?: string;
  content: string;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  question_type: ExtendedQuestionType;
  difficulty?: Difficulty;
  tags: string[];
  status: QuestionStatus;
  /**
   * 结构化题型数据（判断/配对/排序/数值等的选项与判分元数据），
   * 由 Rust 侧 structured_data JSON 列透传，前端不做二次加工。
   * 契约类型见 src/api/questionBankApi.ts（QuestionStructuredData 判别联合）。
   */
  structured_data?: QuestionStructuredData | null;
  /**
   * 作答序列化约定（与后端判分对齐）：
   * - true_false: "true" / "false"
   * - numeric: 数字字符串（如 "3.14"）
   * - fill_blank 多空: JSON 数组（如 ["答案1","答案2"]）
   * - matching: {"pairs":[{"left":"L1","right":"R1"}]}
   * - ordering: JSON 数组（如 ["B","A","C"]）
   */
  user_answer?: string;
  is_correct?: boolean;
  attempt_count: number;
  correct_count: number;
  last_attempt_at?: string;
  user_note?: string;
  is_favorite: boolean;
  /** 后端始终序列化该字段；置为可选以兼容存量本地构造 */
  is_bookmarked?: boolean;
  images: QuestionImage[];
  source_type: SourceType;
  source_ref?: string;
  parent_id?: string;
  created_at: string;
  updated_at: string;
  // AI 评判缓存
  ai_feedback?: string;
  ai_score?: number;
  ai_graded_at?: string;
}

export interface QuestionFilters {
  status?: QuestionStatus[];
  difficulty?: Difficulty[];
  question_type?: ExtendedQuestionType[];
  tags?: string[];
  search?: string;
  is_favorite?: boolean;
}

export interface QuestionListResult {
  questions: Question[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface QuestionBankStats {
  exam_id: string;
  total_count: number;
  new_count: number;
  in_progress_count: number;
  mastered_count: number;
  review_count: number;
  total_attempts: number;
  /** 历史累计正确**尝试**数（不按题去重）；全库统计口径，勿与 daily 的按题去重「答对题数」混用。 */
  total_correct: number;
  correct_rate: number;
  updated_at: string;
}

/**
 * 当日练习进度的权威快照（后端口径：按题去重 + 当日任一次答对即计对）。
 * 对应 Rust 侧 question_bank_service::DailyProgressSnapshot，由
 * submit/regrade 响应回带（`daily_progress`，serde snake_case）；
 * 存在时用 applyAuthoritativeDailyProgress 覆盖本地乐观增量（权威优先）。
 */
export interface DailyProgressSnapshot {
  /** 后端本地日界线的日期（YYYY-MM-DD）。与本地 dailyPractice.date 不一致时不覆盖。 */
  date: string;
  /** 题目集 ID。存在且与本地 dailyPractice.exam_id 不一致时不覆盖。 */
  exam_id?: string;
  /**
   * 今天已作答的题目 ID（按题去重、全量）。存在时覆盖本地首答去重集合
   * （本地只做乐观增量，以后端为准）。
   */
  answered_question_ids?: string[];
  /** 当日已作答题数（按题去重）。 */
  completed_count: number;
  /** 当日答对题数（按题去重 + 任一次答对即计）。 */
  correct_count: number;
  /** 后端可直接判定；缺省时前端按 completed_count >= daily_target 推导。 */
  is_completed?: boolean;
}

export interface SubmitAnswerResult {
  /** 是否正确。主观题（需手动批改）时为 null，避免误判为"错误"。 */
  is_correct: boolean | null;
  correct_answer?: string;
  needs_manual_grading: boolean;
  message: string;
  updated_question: Question;
  updated_stats: QuestionBankStats;
  /** 本次作答记录 ID（用于关联 AI 评判） */
  submission_id: string;
  /**
   * 2026-08 R4 加法字段（可选）：后端在 submit/regrade 响应中回带的当日
   * 权威 daily 进度（Rust 侧 `#[serde(default, skip_serializing_if)]`）。
   * 存在时覆盖本地乐观增量（applyAuthoritativeDailyProgress）；旧后端
   * 无此字段时为 undefined，行为不变。
   * snake_case 为 serde 默认序列化名，camelCase 兼容未来可能的载荷形态。
   */
  daily_progress?: DailyProgressSnapshot;
  /** 同 daily_progress，camelCase 兼容读。 */
  dailyProgress?: DailyProgressSnapshot;
}

function generateClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface QuestionHistory {
  id: string;
  question_id: string;
  field_name: string;
  old_value?: string;
  new_value?: string;
  operator: string;
  reason?: string;
  created_at: string;
}

/** qbank_batch_* 命令的返回（与 Rust BatchResult 对齐） */
export interface QuestionBatchResult {
  success_count: number;
  failed_count: number;
  errors: string[];
}

// ============================================================================
// CSV 导入导出类型
// ============================================================================

/** CSV 去重策略 */
export type CsvDuplicateStrategy = 'skip' | 'overwrite' | 'merge';

/** CSV 导出编码 */
export type CsvExportEncoding = 'utf8' | 'gbk' | 'utf8_bom';

/** CSV 预览结果 */
export interface CsvPreviewResult {
  /** 列名（表头） */
  headers: string[];
  /** 预览行数据 */
  rows: string[][];
  /** 总行数（不含表头） */
  total_rows: number;
  /** 检测到的编码 */
  encoding: string;
}

/** CSV 导入请求参数 */
export interface CsvImportRequest {
  /** 文件路径 */
  file_path: string;
  /** 目标题目集 ID */
  exam_id: string;
  /** 字段映射：CSV 列名 -> 题目字段名 */
  field_mapping: Record<string, string>;
  /** 去重策略 */
  duplicate_strategy?: CsvDuplicateStrategy;
  /** 文件夹 ID（创建新题目集时使用） */
  folder_id?: string;
  /** 题目集名称（创建新题目集时使用） */
  exam_name?: string;
}

/** CSV 导入错误 */
export interface CsvImportError {
  /** 行号（从 1 开始） */
  row: number;
  /** 错误信息 */
  message: string;
  /** 原始行内容（可选） */
  raw_data?: string;
}

/** CSV 导入结果 */
export interface CsvImportResult {
  /** 导入成功数 */
  success_count: number;
  /** 跳过数（重复） */
  skipped_count: number;
  /** 失败数 */
  failed_count: number;
  /** 错误详情 */
  errors: CsvImportError[];
  /** 目标题目集 ID */
  exam_id: string;
  /** 总处理行数 */
  total_rows: number;
  /** 用户取消后返回部分结果时为 true */
  cancelled?: boolean;
}

/** CSV 导出请求参数 */
export interface CsvExportRequest {
  /** 题目集 ID */
  exam_id: string;
  /** 导出文件路径 */
  file_path: string;
  /** 要导出的字段列表（为空则导出所有） */
  fields?: string[];
  /** 筛选条件 */
  filters?: QuestionFilters;
  /** 是否包含答题记录 */
  include_answers?: boolean;
  /** 输出编码 */
  encoding?: CsvExportEncoding;
}

/** CSV 导出结果 */
export interface CsvExportResult {
  /** 导出题目数 */
  exported_count: number;
  /** 文件路径 */
  file_path: string;
  /** 文件大小（字节） */
  file_size: number;
}

// ============================================================================
// FTS5 全文搜索类型
// ============================================================================

/** 搜索排序方式 */
export type SearchSortBy = 'relevance' | 'created_desc' | 'created_asc' | 'updated_desc';

/** 搜索筛选条件 */
export interface QuestionSearchFilters {
  /** 基础筛选条件 */
  base?: QuestionFilters;
  /** 搜索排序方式 */
  sort_by?: SearchSortBy;
}

/** FTS5 搜索结果项 */
export interface QuestionSearchResult {
  /** 题目实体 */
  question: Question;
  /** 匹配高亮片段（content 字段的匹配部分） */
  highlight_content?: string;
  /** 匹配高亮片段（answer 字段的匹配部分） */
  highlight_answer?: string;
  /** 匹配高亮片段（explanation 字段的匹配部分） */
  highlight_explanation?: string;
  /** BM25 相关性分数（越小越相关，负数） */
  relevance_score: number;
}

/** 搜索结果列表 */
export interface QuestionSearchListResult {
  /** 搜索结果列表 */
  results: QuestionSearchResult[];
  /** 匹配总数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页大小 */
  page_size: number;
  /** 是否有更多结果 */
  has_more: boolean;
  /** 搜索耗时（毫秒） */
  search_time_ms: number;
}

// ============================================================================
// 时间维度统计类型（2026-01 新增）
// ============================================================================

/** 学习趋势数据点 */
export interface LearningTrendPoint {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 做题数 */
  attempt_count: number;
  /** 正确数 */
  correct_count: number;
  /** 正确率（0-100） */
  correct_rate: number;
}

/** 活跃度热力图数据点 */
export interface ActivityHeatmapPoint {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 做题数 */
  count: number;
  /** 正确数 */
  correct_count: number;
  /** 活跃等级（0-4） */
  level: number;
}

/** 知识点统计 */
export interface KnowledgePoint {
  /** 标签名 */
  tag: string;
  /** 总题数 */
  total: number;
  /** 已掌握数 */
  mastered: number;
  /** 学习中数 */
  in_progress: number;
  /** 需复习数 */
  review: number;
  /** 未学习数 */
  new_count: number;
  /** 掌握度百分比（0-100） */
  mastery_rate: number;
  /** 正确率百分比（0-100） */
  correct_rate: number;
}

/** 知识点统计对比 */
export interface KnowledgeStatsComparison {
  /** 当前统计 */
  current: KnowledgePoint[];
  /** 上周统计（用于对比） */
  previous: KnowledgePoint[];
}

/** 时间范围类型（2026-07 新增 quarter = 近 90 天） */
export type DateRange = 'today' | 'week' | 'month' | 'quarter' | 'all';

// COMPAT-REMOVED 2026-07-20 (owner: learning-qbank): 题库专属 sync conflict 类型/API 已移除。
// 无生产生产者（QuestionSyncService::detect_conflicts / save_conflict 零调用）。
// 真冲突源：data_governance __sync_conflicts + RecordConflictsPanel。

// ============================================================================
// 练习模式扩展类型（2026-01 新增）
// ============================================================================

/** 限时练习会话 */
export interface TimedPracticeSession {
  id: string;
  exam_id: string;
  duration_minutes: number;
  question_count: number;
  question_ids: string[];
  started_at: string;
  ended_at?: string;
  answered_count: number;
  correct_count: number;
  is_timeout: boolean;
  is_submitted: boolean;
  paused_seconds: number;
  is_paused: boolean;
  /**
   * 本会话内已作答的题目 ID（前端补充字段，仅用于进度去重与答题卡状态，
   * 不回传后端）。2026-07 修复：此前 answered_count/correct_count 无人更新，
   * 进度永远显示 0。
   */
  answered_question_ids?: string[];
  /**
   * 本会话内每题的最近判定（前端补充字段，不回传后端）。
   * 2026-08 R4 新增：作为改判/重答差量修正的基线——已答题再次上报时按
   * 旧判定 → 新判定 更新 correct_count（可减）。已答但无基线的题
   * （旧版会话残留）保持首答锁，等后端全量重算收敛。
   */
  answered_results?: Record<string, boolean | null>;
}

/** 模拟考试配置 */
export interface MockExamConfig {
  duration_minutes: number;
  type_distribution: Record<string, number>;
  difficulty_distribution: Record<string, number>;
  total_count?: number;
  shuffle: boolean;
  include_mistakes: boolean;
  tags?: string[];
}

/** 模拟考试会话 */
export interface MockExamSession {
  id: string;
  exam_id: string;
  config: MockExamConfig;
  question_ids: string[];
  started_at: string;
  ended_at?: string;
  answers: Record<string, string>;
  results: Record<string, boolean>;
  is_submitted: boolean;
  score?: number;
  correct_rate?: number;
}

/** 题型统计项 */
export interface TypeStatItem {
  total: number;
  correct: number;
  rate: number;
}

/** 难度统计项 */
export interface DifficultyStatItem {
  total: number;
  correct: number;
  rate: number;
}

/** 模拟考试成绩单 */
export interface MockExamScoreCard {
  session_id: string;
  exam_id: string;
  total_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  unanswered_count: number;
  correct_rate: number;
  time_spent_seconds: number;
  type_stats: Record<string, TypeStatItem>;
  difficulty_stats: Record<string, DifficultyStatItem>;
  wrong_question_ids: string[];
  comment: string;
  completed_at: string;
}

/** 每日一练来源分布 */
export interface DailySourceDistribution {
  mistake_count: number;
  new_count: number;
  review_count: number;
}

/** 每日一练结果 */
export interface DailyPracticeResult {
  date: string;
  exam_id: string;
  question_ids: string[];
  daily_target: number;
  /** 当日已作答**题**数（按题去重；后端权威，前端只做会话内乐观增量）。 */
  completed_count: number;
  /**
   * 当日答对**题**数（题目维度：按题去重 + 当日任一次答对即计对；后端权威）。
   * 与 PracticeSessionProgress.totalCorrectCount（正确尝试数，尝试维度）
   * 不是同一口径，勿混用。
   */
  correct_count: number;
  source_distribution: DailySourceDistribution;
  is_completed: boolean;
  /**
   * 本会话内已作答的推荐题 ID（前端补充字段，仅用于进度去重，不回传后端）。
   * 后端在 get_daily_practice 时会按当日 answer_submissions 重算全量进度，
   * 该列表只负责会话内实时增量的幂等。
   */
  answered_question_ids?: string[];
  /**
   * 本会话内每题的最近判定（前端补充字段，不回传后端）。
   * 2026-08 R4 新增：改判/重答差量修正的基线，语义同
   * TimedPracticeSession.answered_results。
   */
  answered_results?: Record<string, boolean | null>;
}

export type QbankPracticeHandoffMode = 'timed' | 'mock_exam' | 'daily';

interface QbankPracticeHandoffBase {
  version: 1;
  kind: 'qbank_practice_session';
  handoff_id: string;
  exam_id: string;
  mode: QbankPracticeHandoffMode;
  agentCanAnswer: false;
}

export type QbankPracticeHandoff =
  | (QbankPracticeHandoffBase & { mode: 'timed'; session: TimedPracticeSession })
  | (QbankPracticeHandoffBase & { mode: 'mock_exam'; session: MockExamSession })
  | (QbankPracticeHandoffBase & { mode: 'daily'; session: DailyPracticeResult });

export type PracticeHandoffHydrationResult =
  | {
      ok: true;
      mode: QbankPracticeHandoffMode;
      handoffId: string;
      firstQuestionId: string;
      questionCount: number;
    }
  | {
      ok: false;
      code: 'INVALID_PRACTICE_HANDOFF' | 'PRACTICE_HANDOFF_EXAM_MISMATCH';
      hint: string;
    };

export type PracticeHandoffHydrationFailure = Extract<
  PracticeHandoffHydrationResult,
  { ok: false }
>;

function practiceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function practiceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function practiceInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= min
    && value <= max
    ? value
    : null;
}

function practiceQuestionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  const ids = value.map(practiceString);
  if (ids.some((id) => id == null)) return null;
  const normalized = ids as string[];
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function validPracticeTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function emptyPracticeRecord(value: unknown): value is Record<string, never> {
  const record = practiceRecord(value);
  return Boolean(record && Object.keys(record).length === 0);
}

function practiceCountMap(value: unknown): Record<string, number> | null {
  const record = practiceRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.some(([, count]) => practiceInteger(count, 1, 100) == null)) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

function invalidPracticeHandoff(hint: string): PracticeHandoffHydrationFailure {
  return { ok: false, code: 'INVALID_PRACTICE_HANDOFF', hint };
}

/** Validate and normalize a backend-created handoff before it reaches mutable UI state. */
export function validateQbankPracticeHandoff(
  value: unknown,
  expectedExamId: string,
): QbankPracticeHandoff | PracticeHandoffHydrationFailure {
  const handoff = practiceRecord(value);
  if (
    !handoff
    || handoff.version !== 1
    || handoff.kind !== 'qbank_practice_session'
    || handoff.agentCanAnswer !== false
  ) {
    return invalidPracticeHandoff('练习交接版本或来源无效');
  }
  const examId = practiceString(handoff.exam_id);
  const handoffId = practiceString(handoff.handoff_id);
  const session = practiceRecord(handoff.session);
  const mode = handoff.mode;
  if (!examId || !handoffId || !session || !['timed', 'mock_exam', 'daily'].includes(String(mode))) {
    return invalidPracticeHandoff('练习交接缺少 exam_id、handoff_id、mode 或 session');
  }
  if (examId !== expectedExamId || practiceString(session.exam_id) !== expectedExamId) {
    return {
      ok: false,
      code: 'PRACTICE_HANDOFF_EXAM_MISMATCH',
      hint: '练习交接不属于当前题目集',
    };
  }
  const questionIds = practiceQuestionIds(session.question_ids);
  if (!questionIds) return invalidPracticeHandoff('练习交接必须包含 1-100 个唯一题目 ID');

  if (mode === 'timed') {
    const id = practiceString(session.id);
    const duration = practiceInteger(session.duration_minutes, 1, 480);
    const questionCount = practiceInteger(session.question_count, 1, 100);
    if (
      !id
      || handoffId !== id
      || duration == null
      || questionCount !== questionIds.length
      || !validPracticeTimestamp(session.started_at)
      // 全新会话不允许预填 ended_at：否则恢复出的倒计时会立即结算/误报超时
      || session.ended_at != null
      || practiceInteger(session.answered_count, 0, questionIds.length) !== 0
      || practiceInteger(session.correct_count, 0, questionIds.length) !== 0
      || session.is_timeout !== false
      || session.is_submitted !== false
      || practiceInteger(session.paused_seconds, 0) !== 0
      || session.is_paused !== false
    ) {
      return invalidPracticeHandoff('限时练习 session 无效或包含 Agent 预填进度');
    }
    return {
      version: 1,
      kind: 'qbank_practice_session',
      handoff_id: id,
      exam_id: examId,
      mode: 'timed',
      agentCanAnswer: false,
      session: {
        id,
        exam_id: examId,
        duration_minutes: duration,
        question_count: questionIds.length,
        question_ids: [...questionIds],
        started_at: session.started_at as string,
        answered_count: 0,
        correct_count: 0,
        is_timeout: false,
        is_submitted: false,
        paused_seconds: 0,
        is_paused: false,
      },
    };
  }

  if (mode === 'mock_exam') {
    const id = practiceString(session.id);
    const config = practiceRecord(session.config);
    const duration = practiceInteger(config?.duration_minutes, 1, 480);
    const totalCount = config?.total_count == null
      ? undefined
      : practiceInteger(config.total_count, 1, 100);
    const typeDistribution = practiceCountMap(config?.type_distribution);
    const difficultyDistribution = practiceCountMap(config?.difficulty_distribution);
    const tags = config?.tags == null
      ? undefined
      : Array.isArray(config.tags)
        ? config.tags.map(practiceString)
        : null;
    if (
      !id
      || handoffId !== id
      || !config
      || duration == null
      || totalCount === null
      || !typeDistribution
      || !difficultyDistribution
      || config.shuffle !== true && config.shuffle !== false
      || config.include_mistakes !== true && config.include_mistakes !== false
      || tags === null
      || tags?.some((tag) => tag == null)
      || (tags?.length ?? 0) > 20
      || !validPracticeTimestamp(session.started_at)
      || session.ended_at != null
      || !emptyPracticeRecord(session.answers)
      || !emptyPracticeRecord(session.results)
      || session.is_submitted !== false
      || session.score != null
      || session.correct_rate != null
    ) {
      return invalidPracticeHandoff('模拟考 session 无效或包含 Agent 预填答案/成绩');
    }
    return {
      version: 1,
      kind: 'qbank_practice_session',
      handoff_id: id,
      exam_id: examId,
      mode: 'mock_exam',
      agentCanAnswer: false,
      session: {
        id,
        exam_id: examId,
        config: {
          duration_minutes: duration,
          type_distribution: typeDistribution,
          difficulty_distribution: difficultyDistribution,
          ...(totalCount == null ? {} : { total_count: totalCount }),
          shuffle: config.shuffle as boolean,
          include_mistakes: config.include_mistakes as boolean,
          ...(tags ? { tags: tags as string[] } : {}),
        },
        question_ids: [...questionIds],
        started_at: session.started_at as string,
        answers: {},
        results: {},
        is_submitted: false,
      },
    };
  }

  const date = practiceString(session.date);
  if (
    !date
    || handoffId !== date
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    // 上限与 UI 每日目标范围（5..=50）及 Agent 工具 schema（1..=50）对齐；
    // 此前 20 的上限会把用户目标 21-50 的合法交接误判为无效
    || practiceInteger(session.daily_target, 1, 50) == null
    || practiceInteger(session.completed_count, 0, questionIds.length) !== 0
    || practiceInteger(session.correct_count, 0, questionIds.length) !== 0
    || !practiceRecord(session.source_distribution)
    || practiceInteger((session.source_distribution as Record<string, unknown>).mistake_count, 0, questionIds.length) == null
    || practiceInteger((session.source_distribution as Record<string, unknown>).new_count, 0, questionIds.length) == null
    || practiceInteger((session.source_distribution as Record<string, unknown>).review_count, 0, questionIds.length) == null
    || session.is_completed !== false
  ) {
    return invalidPracticeHandoff('每日一练 session 无效或包含 Agent 预填进度');
  }
  const distribution = session.source_distribution as Record<string, number>;
  return {
    version: 1,
    kind: 'qbank_practice_session',
    handoff_id: date,
    exam_id: examId,
    mode: 'daily',
    agentCanAnswer: false,
    session: {
      date,
      exam_id: examId,
      question_ids: [...questionIds],
      daily_target: session.daily_target as number,
      completed_count: 0,
      correct_count: 0,
      source_distribution: {
        mistake_count: distribution.mistake_count as number,
        new_count: distribution.new_count as number,
        review_count: distribution.review_count as number,
      },
      is_completed: false,
    },
  };
}

/** 试卷导出格式 */
export type PaperExportFormat = 'preview' | 'pdf' | 'word' | 'markdown';

/** 组卷配置 */
export interface PaperConfig {
  title: string;
  type_selection: Record<string, number>;
  difficulty_filter?: string[];
  tags_filter?: string[];
  shuffle: boolean;
  include_answers: boolean;
  include_explanations: boolean;
  export_format: PaperExportFormat;
}

/** 生成的试卷 */
export interface GeneratedPaper {
  id: string;
  title: string;
  exam_id: string;
  questions: Question[];
  total_score: number;
  config: PaperConfig;
  created_at: string;
  export_path?: string;
}

/** 打卡记录 */
export interface DailyCheckIn {
  date: string;
  exam_id?: string;
  question_count: number;
  correct_count: number;
  study_duration_seconds: number;
  target_achieved: boolean;
}

/** 打卡日历数据 */
export interface CheckInCalendar {
  /** 该日历所属的题目集；null 表示跨题目集汇总。 */
  exam_id: string | null;
  year: number;
  month: number;
  days: DailyCheckIn[];
  /** 连续打卡**天**数（天数维度，只看"当日有作答"），勿与「连对」（尝试维度）混淆。 */
  streak_days: number;
  month_check_in_days: number;
  month_total_questions: number;
}

// 日历结果在 store 中只有一个槽位。保留最新请求的结果，避免快速切换题目集或月份时
// 较慢的旧请求覆盖当前日历。
let checkInCalendarRequestSeq = 0;

// ============================================================================
// Store 状态
// ============================================================================

/** 做题会话归属；同一题库的两个保活视图也必须使用不同的 viewInstanceId。 */
export interface PracticeSessionOwner {
  examId: string;
  viewInstanceId: string;
}

/** 本轮做题进度（仅内存，跨子视图切换保留，不跨进程） */
export interface PracticeSessionProgress extends PracticeSessionOwner {
  /** 当前实例允许作答的题目，用于拒绝串入其他题库的题目。 */
  questionIds: string[];
  /**
   * 「连对」——连续答对的**尝试**数（尝试维度）：明确答错清零，主观题
   * 待判定（null）不加也不中断；重做同题答对也续连。
   * 勿与 CheckInCalendar.streak_days（连续打卡**天**数）混淆。
   */
  streakCount: number;
  /**
   * 正确**尝试**数（尝试维度）：每次判对的提交都 +1，重做同题答对会计多次；
   * 按题去重的是 answeredIds，两者维度不同——用本字段除以
   * answeredIds.length 得到的"正确率"重做后可超 100%。
   * 与 DailyPracticeResult.correct_count（答对**题**数，题目维度）不是同一
   * 口径。改名/改语义（correctQuestionCount 方案）见 R1-07 §四，本轮只定名。
   */
  totalCorrectCount: number;
  /** 真实作答过的题目 ID（"访问过"不计入，完成判定以此为准） */
  answeredIds: string[];
}

export function getPracticeSessionKey(owner: PracticeSessionOwner): string | null {
  if (
    typeof owner?.examId !== 'string'
    || owner.examId.length === 0
    || typeof owner?.viewInstanceId !== 'string'
    || owner.viewInstanceId.length === 0
  ) {
    return null;
  }
  // JSON 元组避免 examId / viewInstanceId 中出现分隔符时产生键碰撞。
  return JSON.stringify([owner.examId, owner.viewInstanceId]);
}

function createEmptyPracticeSession(
  owner: PracticeSessionOwner,
  questionIds: readonly string[],
): PracticeSessionProgress {
  return {
    ...owner,
    questionIds: Array.from(new Set(questionIds.filter((id) => typeof id === 'string' && id.length > 0))),
    streakCount: 0,
    totalCorrectCount: 0,
    answeredIds: [],
  };
}

interface QuestionBankState {
  // 数据
  questions: Map<string, Question>;
  /** 保持服务端返回的题目顺序，避免依赖 Map 迭代顺序 */
  questionOrder: string[];
  currentExamId: string | null;
  currentQuestionId: string | null;
  stats: QuestionBankStats | null;
  
  // 时间维度统计数据（2026-01 新增）
  learningTrend: LearningTrendPoint[];
  activityHeatmap: ActivityHeatmapPoint[];
  knowledgeStats: KnowledgeStatsComparison | null;
  selectedDateRange: DateRange;
  
  // 分页
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
  
  // 筛选
  filters: QuestionFilters;
  practiceMode: PracticeMode;
  
  // UI 状态
  focusMode: boolean;
  
  // 加载状态
  isLoading: boolean;
  isSubmitting: boolean;
  isLoadingTrend: boolean;
  isLoadingHeatmap: boolean;
  isLoadingKnowledge: boolean;
  isLoadingPractice: boolean;
  error: string | null;
  // 并发防护
  loadRequestId: number;
  
  // Actions
  setCurrentExam: (examId: string | null) => void;
  setCurrentQuestion: (questionId: string | null) => void;
  setFilters: (filters: QuestionFilters) => void;
  setPracticeMode: (mode: PracticeMode) => void;
  setFocusMode: (focusMode: boolean) => void;
  setDateRange: (range: DateRange) => void;
  resetFilters: () => void;
  
  // API Actions
  loadQuestions: (examId: string, filters?: QuestionFilters, page?: number) => Promise<void>;
  loadMoreQuestions: () => Promise<void>;
  refreshQuestions: () => Promise<void>;
  
  // FTS5 全文搜索
  searchQuestions: (keyword: string, examId?: string, filters?: QuestionSearchFilters, page?: number) => Promise<QuestionSearchListResult>;
  rebuildFtsIndex: () => Promise<number>;
  getQuestion: (questionId: string) => Promise<Question | null>;
  updateQuestion: (questionId: string, params: Partial<Question>) => Promise<void>;
  deleteQuestion: (questionId: string) => Promise<void>;
  
  // 批量管理 API（2026-07 新增，浏览管理流消费）
  /** 批量设置难度（走 qbank_batch_update_questions，同一难度一次落库） */
  batchUpdateDifficulty: (questionIds: string[], difficulty: Difficulty) => Promise<void>;
  /** 批量增删标签（逐题合并计算后更新，保持各题既有标签） */
  batchUpdateTags: (questionIds: string[], changes: { add: string[]; remove: string[] }) => Promise<void>;
  /** 重命名标签：遍历题目集内含 oldTag 的题目；newTag 已存在时合并去重 */
  renameTag: (examId: string, oldTag: string, newTag: string) => Promise<void>;
  submitAnswer: (questionId: string, answer: string, isCorrectOverride?: boolean) => Promise<SubmitAnswerResult>;
  toggleFavorite: (questionId: string) => Promise<void>;
  loadStats: (examId: string) => Promise<void>;
  refreshStats: (examId: string) => Promise<QuestionBankStats>;
  resetProgress: (examId: string) => Promise<void>;
  
  // 时间维度统计 API（2026-01 新增）
  loadLearningTrend: (examId?: string, startDate?: string, endDate?: string) => Promise<LearningTrendPoint[]>;
  loadActivityHeatmap: (examId?: string, year?: number) => Promise<ActivityHeatmapPoint[]>;
  loadKnowledgeStats: (examId?: string) => Promise<KnowledgeStatsComparison>;
  
  // CSV 导入导出 API（2026-01 新增）
  getCsvPreview: (filePath: string, rows?: number) => Promise<CsvPreviewResult>;
  importCsv: (request: CsvImportRequest) => Promise<CsvImportResult>;
  exportCsv: (request: CsvExportRequest) => Promise<CsvExportResult>;
  getCsvExportableFields: () => Promise<Array<[string, string]>>;
  
  // 练习模式扩展 API（2026-01 新增）
  startTimedPractice: (examId: string, durationMinutes: number, questionCount: number) => Promise<TimedPracticeSession>;
  generateMockExam: (examId: string, config: MockExamConfig) => Promise<MockExamSession>;
  submitMockExam: (session: MockExamSession) => Promise<MockExamScoreCard>;
  getDailyPractice: (examId: string, count: number) => Promise<DailyPracticeResult>;
  generatePaper: (examId: string, config: PaperConfig) => Promise<GeneratedPaper>;
  getCheckInCalendar: (
    examId: string | undefined,
    year: number,
    month: number,
    dailyTarget?: number,
  ) => Promise<CheckInCalendar>;
  /**
   * 练习会话进度回写：把一次真实作答同步进 timedSession / dailyPractice。
   * 真实答题路径是 useQuestionBankSession（窗口本地），这些全局会话对象
   * 没有其他写入方——不调用本方法练习进度会恒为 0。
   * 计数规则（2026-08 R4）：
   * - 首答：completed/answered +1，correct 按判定 +0/+1（answered_question_ids 幂等）；
   * - 已答题再次上报（改判/重答）：completed 不重复计，correct 按
   *   旧判定 → 新判定 差量修正（true→false 会 -1，null→true 会 +1）；
   * - 已答但无判定基线（answered_results 缺项：旧版会话残留，或权威快照
   *   覆盖 answered_question_ids 引入的会话外题目）：保持首答锁 fail-closed，
   *   由 submit/regrade 响应的权威快照（applyAuthoritativeDailyProgress）
   *   或下次 get_daily_practice 全量重算收敛；
   * - 跨题目集 / 非会话题目忽略。
   */
  recordPracticeAnswer: (
    examId: string,
    questionId: string,
    isCorrect: boolean | null,
  ) => void;
  /**
   * 用后端权威 daily 进度覆盖本地乐观增量（权威优先）。
   * 供 submit/regrade 响应回带 daily_progress/dailyProgress 时调用；
   * 仅当 dailyPractice 存在、exam 匹配且日期一致时生效（跨零点的旧会话
   * 不覆盖，避免"昨日题单 + 今日计数"杂交，等下次 getDailyPractice 换发）。
   * 覆盖 completed_count / correct_count / is_completed，快照带
   * answered_question_ids 时同步覆盖首答去重集合；不动 question_ids /
   * answered_results / source_distribution。返回是否实际应用。
   */
  applyAuthoritativeDailyProgress: (
    examId: string,
    progress: DailyProgressSnapshot,
  ) => boolean;
  
  /**
   * 做题会话的即时进度（连对 / 已作答集合），按 examId + viewInstanceId 分片。
   * 提到 store 是为了让「做题 → 错题本 → 回做题」不清零；
   * 未持久化，所以视图卸载或进程重启后仍然从零开始。
   */
  practiceSessions: Record<string, PracticeSessionProgress>;
  /** 注册或刷新实例可作答的题目；已有实例保留仍有效的进度。 */
  ensurePracticeSession: (
    owner: PracticeSessionOwner,
    questionIds: readonly string[],
  ) => PracticeSessionProgress | null;
  /**
   * 记录一次作答并返回更新后的快照。
   * 归属无效、实例未注册或题目不属于实例时 fail-closed，不写入任何分片。
   */
  recordPracticeSessionAnswer: (
    owner: PracticeSessionOwner,
    questionId: string,
    isCorrect: boolean | null,
  ) => PracticeSessionProgress | null;
  resetPracticeSession: (owner: PracticeSessionOwner) => PracticeSessionProgress | null;
  releasePracticeSession: (owner: PracticeSessionOwner) => void;

  // 练习模式状态
  timedSession: TimedPracticeSession | null;
  mockExamSession: MockExamSession | null;
  dailyPractice: DailyPracticeResult | null;
  generatedPaper: GeneratedPaper | null;
  checkInCalendar: CheckInCalendar | null;
  mockExamScoreCard: MockExamScoreCard | null;
  
  setTimedSession: (session: TimedPracticeSession | null) => void;
  setMockExamSession: (session: MockExamSession | null) => void;
  setDailyPractice: (result: DailyPracticeResult | null) => void;
  setGeneratedPaper: (paper: GeneratedPaper | null) => void;
  hydratePracticeHandoff: (
    handoff: unknown,
    expectedExamId: string,
  ) => PracticeHandoffHydrationResult;
  
  // Navigation
  goToQuestion: (index: number) => void;
  
  // Selectors
  getCurrentQuestion: () => Question | null;
  getQuestionsByStatus: (status: QuestionStatus) => Question[];
  getFilteredQuestions: () => Question[];
  getProgress: () => { current: number; total: number };
}

// ============================================================================
// Store 实现
// ============================================================================

export const useQuestionBankStore = create<QuestionBankState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      // 初始状态
      questions: new Map(),
      questionOrder: [],
      currentExamId: null,
      currentQuestionId: null,
      stats: null,
      
      // 时间维度统计数据（2026-01 新增）
      learningTrend: [],
      activityHeatmap: [],
      knowledgeStats: null,
      selectedDateRange: 'week' as DateRange,
      
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        hasMore: false,
      },
      filters: {},
      practiceMode: 'sequential',
      focusMode: false,
      isLoading: false,
      isSubmitting: false,
      isLoadingTrend: false,
      isLoadingHeatmap: false,
      isLoadingKnowledge: false,
      isLoadingPractice: false,
      error: null,
      
      // 并发防护：请求 ID，确保只有最新请求的结果会被应用
      loadRequestId: 0,
      
      practiceSessions: {},

      // 练习模式状态（2026-01 新增）
      timedSession: null,
      mockExamSession: null,
      dailyPractice: null,
      generatedPaper: null,
      checkInCalendar: null,
      mockExamScoreCard: null,
      
      // 基本 Setters
      setCurrentExam: (examId) => set({ currentExamId: examId }),
      
      setCurrentQuestion: (questionId) => set({ currentQuestionId: questionId }),
      
      setFilters: (filters) => set({ filters }),
      
      setPracticeMode: (mode) => set({ practiceMode: mode }),
      
      setFocusMode: (focusMode) => set({ focusMode }),
      
      setDateRange: (range) => set({ selectedDateRange: range }),
      
      resetFilters: () => set({ filters: {} }),

      ensurePracticeSession: (owner, questionIds) => {
        const key = getPracticeSessionKey(owner);
        if (!key || !Array.isArray(questionIds)) return null;

        const normalizedQuestionIds = Array.from(
          new Set(questionIds.filter((id) => typeof id === 'string' && id.length > 0)),
        );
        const previous = get().practiceSessions[key];
        if (!previous) {
          const created = createEmptyPracticeSession(owner, normalizedQuestionIds);
          set((state) => ({
            practiceSessions: { ...state.practiceSessions, [key]: created },
          }));
          return created;
        }

        const allowedIds = new Set(normalizedQuestionIds);
        const answeredIds = previous.answeredIds.filter((id) => allowedIds.has(id));
        const unchanged = previous.questionIds.length === normalizedQuestionIds.length
          && previous.questionIds.every((id, index) => id === normalizedQuestionIds[index])
          && answeredIds.length === previous.answeredIds.length;
        if (unchanged) return previous;

        const next: PracticeSessionProgress = {
          ...previous,
          questionIds: normalizedQuestionIds,
          answeredIds,
        };
        set((state) => ({
          practiceSessions: { ...state.practiceSessions, [key]: next },
        }));
        return next;
      },

      recordPracticeSessionAnswer: (owner, questionId, isCorrect) => {
        const key = getPracticeSessionKey(owner);
        if (!key || typeof questionId !== 'string' || questionId.length === 0) return null;

        const previous = get().practiceSessions[key];
        if (
          !previous
          || previous.examId !== owner.examId
          || previous.viewInstanceId !== owner.viewInstanceId
          || !previous.questionIds.includes(questionId)
        ) {
          return null;
        }

        const next: PracticeSessionProgress = {
          ...previous,
          // null（主观题待判定）既不加连对也不中断
          streakCount: isCorrect === true
            ? previous.streakCount + 1
            : isCorrect === false ? 0 : previous.streakCount,
          totalCorrectCount: previous.totalCorrectCount + (isCorrect === true ? 1 : 0),
          answeredIds: previous.answeredIds.includes(questionId)
            ? previous.answeredIds
            : [...previous.answeredIds, questionId],
        };
        set((state) => ({
          practiceSessions: { ...state.practiceSessions, [key]: next },
        }));
        return next;
      },

      resetPracticeSession: (owner) => {
        const key = getPracticeSessionKey(owner);
        if (!key) return null;
        const previous = get().practiceSessions[key];
        if (!previous) return null;

        const next = createEmptyPracticeSession(owner, previous.questionIds);
        set((state) => ({
          practiceSessions: { ...state.practiceSessions, [key]: next },
        }));
        return next;
      },

      releasePracticeSession: (owner) => {
        const key = getPracticeSessionKey(owner);
        if (!key || !get().practiceSessions[key]) return;
        set((state) => {
          const practiceSessions = { ...state.practiceSessions };
          delete practiceSessions[key];
          return { practiceSessions };
        });
      },

      // API Actions
      loadQuestions: async (examId, filters, page = 1) => {
        emitExamSheetDebug('info', 'frontend:hook-state', `[Store] loadQuestions 开始: examId=${examId}, page=${page}`, { sessionId: examId });
        // 并发防护：递增请求 ID，确保只有最新请求的结果会被应用
        const requestId = get().loadRequestId + 1;
        const previousExamId = get().currentExamId;
        const isExamSwitch = examId !== previousExamId;
        
        // 内存安全检查：如果 questions Map 超过 10000 条，加载新批次前自动清理
        const currentSize = get().questions.size;
        if (currentSize > 10000) {
          debugLog.warn(
            `[QuestionBankStore] questions Map size (${currentSize}) exceeded 10000, clearing to prevent memory leak`
          );
        }
        
        if (isExamSwitch || currentSize > 10000) {
          // 切换考试或内存超限时，立即清空旧数据，防止残留
          set({ 
            isLoading: true, 
            error: null, 
            currentExamId: examId,
            loadRequestId: requestId,
            questions: new Map(),
            questionOrder: [],
            currentQuestionId: null,
            stats: null,
          });
        } else {
          set({ 
            isLoading: true, 
            error: null, 
            currentExamId: examId,
            loadRequestId: requestId,
          });
        }
        
        try {
          const result = await invoke<QuestionListResult>('qbank_list_questions', {
            request: {
              exam_id: examId,
              filters: filters || get().filters,
              page,
              page_size: get().pagination.pageSize,
            },
          });
          
          // 检查是否是最新的请求，如果不是则忽略结果
          if (get().loadRequestId !== requestId) {
            return;
          }
          
          const questionsMap = new Map<string, Question>();
          const order: string[] = [];
          result.questions.forEach((q) => {
            questionsMap.set(q.id, q);
            order.push(q.id);
          });
          
          emitExamSheetDebug('success', 'frontend:hook-state',
            `[Store] loadQuestions 成功: ${result.questions.length} 题, total=${result.total}, page=${result.page}`,
            { sessionId: examId, detail: { count: result.questions.length, total: result.total, page: result.page, hasMore: result.has_more, firstId: result.questions[0]?.id } },
          );
          
          set({
            questions: questionsMap,
            questionOrder: order,
            pagination: {
              page: result.page,
              pageSize: result.page_size,
              total: result.total,
              hasMore: result.has_more,
            },
            currentQuestionId: result.questions[0]?.id || null,
            isLoading: false,
          });
        } catch (err: unknown) {
          // 检查是否是最新的请求，如果不是则忽略错误
          if (get().loadRequestId !== requestId) {
            return;
          }
          debugLog.error('[QuestionBankStore] loadQuestions failed:', err);
          emitExamSheetDebug('error', 'frontend:hook-state', `[Store] loadQuestions 失败: ${String(err)}`, { sessionId: examId, detail: { error: String(err) } });
          set({ error: String(err), isLoading: false });
        }
      },

      loadMoreQuestions: async () => {
        const { currentExamId, pagination, filters, isLoading, loadRequestId } = get();
        if (!currentExamId || isLoading || !pagination.hasMore) return;
        
        // 保存当前 examId 与请求代际用于并发检查：
        // examId 不变但期间发生 loadQuestions（筛选变化/刷新）时，loadRequestId 会递增，
        // 旧的分页结果不能再追加到新列表上。
        const examIdAtStart = currentExamId;
        const requestIdAtStart = loadRequestId;
        
        set({ isLoading: true });
        
        try {
          const result = await invoke<QuestionListResult>('qbank_list_questions', {
            request: {
              exam_id: currentExamId,
              filters,
              page: pagination.page + 1,
              page_size: pagination.pageSize,
            },
          });
          
          // 并发防护：examId 变更或期间发生了新的 loadQuestions（筛选变化/刷新）都视为过期
          if (get().currentExamId !== examIdAtStart || get().loadRequestId !== requestIdAtStart) {
            return; // 忽略过期请求
          }
          
          const questionsMap = new Map(get().questions);
          const existingOrder = get().questionOrder;
          const existingIdSet = new Set(existingOrder);
          const newIds: string[] = [];
          result.questions.forEach((q) => {
            questionsMap.set(q.id, q);
            if (!existingIdSet.has(q.id)) {
              newIds.push(q.id);
            }
          });
          
          set({
            questions: questionsMap,
            questionOrder: [...existingOrder, ...newIds],
            pagination: {
              ...pagination,
              page: result.page,
              total: result.total,
              hasMore: result.has_more,
            },
            isLoading: false,
          });
        } catch (err: unknown) {
          // 并发防护：检查请求是否已过期
          if (get().currentExamId !== examIdAtStart || get().loadRequestId !== requestIdAtStart) {
            return; // 忽略过期请求的错误
          }
          debugLog.error('[QuestionBankStore] loadMoreQuestions failed:', err);
          set({ error: String(err), isLoading: false });
        }
      },

      refreshQuestions: async () => {
        const { currentExamId, filters } = get();
        if (!currentExamId) return;
        await get().loadQuestions(currentExamId, filters, 1);
      },

      // FTS5 全文搜索
      searchQuestions: async (keyword, examId, filters, page = 1) => {
        set({ isLoading: true, error: null });
        
        try {
          const result = await invoke<QuestionSearchListResult>('qbank_search_questions', {
            request: {
              keyword,
              exam_id: examId,
              filters: filters || {},
              page,
              page_size: get().pagination.pageSize,
            },
          });
          
          set({ isLoading: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] searchQuestions failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      rebuildFtsIndex: async () => {
        set({ isLoading: true, error: null });
        
        try {
          const count = await invoke<number>('qbank_rebuild_fts_index', {});
          set({ isLoading: false });
          return count;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] rebuildFtsIndex failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      getQuestion: async (questionId) => {
        try {
          const question = await invoke<Question | null>('qbank_get_question', {
            questionId,
          });
          
          if (question) {
            set((state) => {
              const newMap = new Map(state.questions);
              newMap.set(question.id, question);
              return { questions: newMap };
            });
          }
          
          return question;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getQuestion failed:', err);
          return null;
        }
      },

      updateQuestion: async (questionId, params) => {
        try {
          const question = await invoke<Question>('qbank_update_question', {
            request: {
              question_id: questionId,
              params,
              record_history: true,
            },
          });
          
          set((state) => {
            const newMap = new Map(state.questions);
            newMap.set(question.id, question);
            return { questions: newMap };
          });
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] updateQuestion failed:', err);
          throw err;
        }
      },

      deleteQuestion: async (questionId) => {
        try {
          await invoke('qbank_delete_question', { questionId });
          
          // 🔒 审计修复: 删除后同步更新 pagination、questionOrder、currentQuestionId 和 stats
          // 原代码只删除 Map 条目，不更新 pagination.total，不清除 currentQuestionId
          set((state) => {
            const newMap = new Map(state.questions);
            newMap.delete(questionId);
            const newOrder = state.questionOrder.filter((id) => id !== questionId);
            const updates: Partial<typeof state> = { questions: newMap, questionOrder: newOrder };
            // 更新 pagination.total
            if (state.pagination.total > 0) {
              updates.pagination = { ...state.pagination, total: state.pagination.total - 1 };
            }
            // 如果删除的是当前题目，切换到下一题（而非第一题）或置空
            if (state.currentQuestionId === questionId) {
              const deletedIndex = state.questionOrder.indexOf(questionId);
              if (newOrder.length === 0) {
                updates.currentQuestionId = null;
              } else if (deletedIndex >= newOrder.length) {
                updates.currentQuestionId = newOrder[newOrder.length - 1];
              } else {
                updates.currentQuestionId = newOrder[deletedIndex];
              }
            }
            return updates;
          });
          // 删除成功后刷新 stats（注释声称更新了 stats 但原代码缺失此步骤）
          const examId = get().currentExamId;
          if (examId) {
            get().refreshStats(examId).catch((e) =>
              debugLog.error('[QuestionBankStore] refreshStats after delete failed:', e)
            );
          }
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] deleteQuestion failed:', err);
          throw err;
        }
      },

      // ========================================================================
      // 批量管理 API（2026-07 新增）
      // ========================================================================

      batchUpdateDifficulty: async (questionIds, difficulty) => {
        if (questionIds.length === 0) return;
        try {
          const result = await invoke<QuestionBatchResult>('qbank_batch_update_questions', {
            request: {
              question_ids: questionIds,
              params: { difficulty },
            },
          });
          
          // 本地已加载的题目就地更新，未加载的由 refreshQuestions 兜底
          set((state) => {
            const newMap = new Map(state.questions);
            let touched = false;
            questionIds.forEach((id) => {
              const question = newMap.get(id);
              if (question) {
                newMap.set(id, { ...question, difficulty });
                touched = true;
              }
            });
            return touched ? { questions: newMap } : {};
          });
          get().refreshQuestions().catch((e) =>
            debugLog.error('[QuestionBankStore] refresh after batchUpdateDifficulty failed:', e)
          );
          
          if (result.failed_count > 0) {
            throw new Error(result.errors.join('; ') || `${result.failed_count} update(s) failed`);
          }
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] batchUpdateDifficulty failed:', err);
          throw err;
        }
      },

      batchUpdateTags: async (questionIds, changes) => {
        if (questionIds.length === 0) return;
        const addTags = changes.add.map((tag) => tag.trim()).filter(Boolean);
        const removeTags = new Set(changes.remove.map((tag) => tag.trim()).filter(Boolean));
        if (addTags.length === 0 && removeTags.size === 0) return;
        
        try {
          // 逐题计算合并后的标签（保留各题既有标签），结果相同的题目
          // 归为一组走一次 qbank_batch_update_questions
          const groups = new Map<string, { tags: string[]; ids: string[] }>();
          for (const id of questionIds) {
            // 优先本地缓存；未加载的题目按需拉取（getQuestion 会写回缓存）
            const question = get().questions.get(id) ?? await get().getQuestion(id);
            if (!question) continue;
            const nextTags = Array.from(new Set([
              ...question.tags.filter((tag) => !removeTags.has(tag)),
              ...addTags,
            ]));
            const unchanged = nextTags.length === question.tags.length
              && nextTags.every((tag, i) => question.tags[i] === tag);
            if (unchanged) continue;
            const groupKey = JSON.stringify(nextTags);
            const group = groups.get(groupKey) ?? { tags: nextTags, ids: [] };
            group.ids.push(id);
            groups.set(groupKey, group);
          }
          if (groups.size === 0) return;
          
          const failures: string[] = [];
          for (const { tags, ids } of groups.values()) {
            const result = await invoke<QuestionBatchResult>('qbank_batch_update_questions', {
              request: {
                question_ids: ids,
                params: { tags },
              },
            });
            if (result.failed_count > 0) failures.push(...result.errors);
            // 本地已加载的题目就地更新
            set((state) => {
              const newMap = new Map(state.questions);
              let touched = false;
              ids.forEach((id) => {
                const question = newMap.get(id);
                if (question) {
                  newMap.set(id, { ...question, tags });
                  touched = true;
                }
              });
              return touched ? { questions: newMap } : {};
            });
          }
          get().refreshQuestions().catch((e) =>
            debugLog.error('[QuestionBankStore] refresh after batchUpdateTags failed:', e)
          );
          
          if (failures.length > 0) {
            throw new Error(failures.join('; '));
          }
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] batchUpdateTags failed:', err);
          throw err;
        }
      },

      renameTag: async (examId, oldTag, newTag) => {
        const from = oldTag.trim();
        const to = newTag.trim();
        if (!from || !to || from === to) return;
        
        try {
          // 收集题目集内所有含 oldTag 的题目（分页拉全，不能只看当前加载页）
          const affected: Question[] = [];
          const pageSize = 200;
          let page = 1;
          // 上限防御：200 * 50 = 10000 题，超出视为异常数据
          for (let i = 0; i < 50; i++) {
            const result = await invoke<QuestionListResult>('qbank_list_questions', {
              request: {
                exam_id: examId,
                filters: { tags: [from] },
                page,
                page_size: pageSize,
              },
            });
            affected.push(...result.questions);
            if (!result.has_more) break;
            page += 1;
          }
          if (affected.length === 0) return;
          
          // newTag 已存在时自然合并：替换后 Set 去重
          const groups = new Map<string, { tags: string[]; ids: string[] }>();
          for (const question of affected) {
            if (!question.tags.includes(from)) continue;
            const nextTags = Array.from(new Set(
              question.tags.map((tag) => (tag === from ? to : tag)),
            ));
            const groupKey = JSON.stringify(nextTags);
            const group = groups.get(groupKey) ?? { tags: nextTags, ids: [] };
            group.ids.push(question.id);
            groups.set(groupKey, group);
          }
          
          const failures: string[] = [];
          for (const { tags, ids } of groups.values()) {
            const result = await invoke<QuestionBatchResult>('qbank_batch_update_questions', {
              request: {
                question_ids: ids,
                params: { tags },
              },
            });
            if (result.failed_count > 0) failures.push(...result.errors);
            set((state) => {
              const newMap = new Map(state.questions);
              let touched = false;
              ids.forEach((id) => {
                const question = newMap.get(id);
                if (question) {
                  newMap.set(id, { ...question, tags });
                  touched = true;
                }
              });
              return touched ? { questions: newMap } : {};
            });
          }
          if (get().currentExamId === examId) {
            get().refreshQuestions().catch((e) =>
              debugLog.error('[QuestionBankStore] refresh after renameTag failed:', e)
            );
          }
          
          if (failures.length > 0) {
            throw new Error(failures.join('; '));
          }
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] renameTag failed:', err);
          throw err;
        }
      },

      submitAnswer: async (questionId, answer, isCorrectOverride) => {
        set({ isSubmitting: true });
        
        try {
          const result = await invoke<SubmitAnswerResult>('qbank_submit_answer', {
            request: {
              question_id: questionId,
              user_answer: answer,
              is_correct_override: isCorrectOverride,
              client_request_id: generateClientRequestId(),
            },
          });
          
          set((state) => {
            const newMap = new Map(state.questions);
            newMap.set(result.updated_question.id, result.updated_question);
            return {
              questions: newMap,
              stats: result.updated_stats,
              isSubmitting: false,
            };
          });
          
          // 练习会话进度同步（限时 + 每日一练）：首答计数 + 改判差量修正
          get().recordPracticeAnswer(
            result.updated_question.exam_id,
            questionId,
            result.is_correct,
          );

          // 权威优先：后端若回带当日进度快照（R4 加法字段，旧后端无此字段
          // 时为 undefined），用它覆盖上面的本地乐观 daily 增量；timed 不受影响。
          const authoritativeDaily = result.daily_progress ?? result.dailyProgress;
          if (authoritativeDaily) {
            get().applyAuthoritativeDailyProgress(
              result.updated_question.exam_id,
              authoritativeDaily,
            );
          }

          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] submitAnswer failed:', err);
          set({ isSubmitting: false });
          throw err;
        }
      },

      toggleFavorite: async (questionId) => {
        try {
          const question = await invoke<Question>('qbank_toggle_favorite', {
            questionId,
          });
          
          set((state) => {
            const newMap = new Map(state.questions);
            newMap.set(question.id, question);
            return { questions: newMap };
          });
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] toggleFavorite failed:', err);
          throw err;
        }
      },

      loadStats: async (examId) => {
        try {
          const stats = await invoke<QuestionBankStats | null>('qbank_get_stats', {
            examId,
          });
          emitExamSheetDebug('info', 'frontend:hook-state', `[Store] loadStats 成功: total=${stats?.total_count ?? '?'}`, { sessionId: examId, detail: stats });
          set({ stats });
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] loadStats failed:', err);
          emitExamSheetDebug('error', 'frontend:hook-state', `[Store] loadStats 失败: ${String(err)}`, { sessionId: examId });
        }
      },

      refreshStats: async (examId) => {
        const stats = await invoke<QuestionBankStats>('qbank_refresh_stats', {
          examId,
        });
        set({ stats });
        return stats;
      },

      resetProgress: async (examId) => {
        set({ isLoading: true });
        try {
          const stats = await invoke<QuestionBankStats>('qbank_reset_progress', {
            examId,
          });

          // 刷新题目列表
          await get().loadQuestions(examId);
          set({ stats, isLoading: false });
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] resetProgress failed:', err);
          set({ isLoading: false });
          throw err;
        }
      },

      // 时间维度统计 API（2026-01 新增）
      loadLearningTrend: async (examId, startDate, endDate) => {
        set({ isLoadingTrend: true });
        
        try {
          // 默认日期范围：根据 selectedDateRange 计算
          const now = new Date();
          const range = get().selectedDateRange;
          let defaultStartDate: string;
          const toLocalDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const defaultEndDate = toLocalDateStr(now);
          
          switch (range) {
            case 'today':
              defaultStartDate = defaultEndDate;
              break;
            case 'week': {
              const weekAgo = new Date(now);
              weekAgo.setDate(weekAgo.getDate() - 7);
              defaultStartDate = toLocalDateStr(weekAgo);
              break;
            }
            case 'month': {
              const monthAgo = new Date(now);
              monthAgo.setMonth(monthAgo.getMonth() - 1);
              defaultStartDate = toLocalDateStr(monthAgo);
              break;
            }
            case 'quarter': {
              // 近 90 天
              const quarterAgo = new Date(now);
              quarterAgo.setDate(quarterAgo.getDate() - 90);
              defaultStartDate = toLocalDateStr(quarterAgo);
              break;
            }
            case 'all':
            default: {
              const yearAgo = new Date(now);
              yearAgo.setFullYear(yearAgo.getFullYear() - 1);
              defaultStartDate = toLocalDateStr(yearAgo);
              break;
            }
          }

          const result = await invoke<LearningTrendPoint[]>('qbank_get_learning_trend', {
            request: {
              exam_id: examId || get().currentExamId,
              start_date: startDate || defaultStartDate,
              end_date: endDate || defaultEndDate,
            },
          });
          
          set({ learningTrend: result, isLoadingTrend: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] loadLearningTrend failed:', err);
          set({ isLoadingTrend: false, error: String(err) });
          throw err;
        }
      },

      loadActivityHeatmap: async (examId, year) => {
        set({ isLoadingHeatmap: true });
        
        try {
          const currentYear = year || new Date().getFullYear();
          
          const result = await invoke<ActivityHeatmapPoint[]>('qbank_get_activity_heatmap', {
            request: {
              exam_id: examId || get().currentExamId,
              year: currentYear,
            },
          });
          
          set({ activityHeatmap: result, isLoadingHeatmap: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] loadActivityHeatmap failed:', err);
          set({ isLoadingHeatmap: false, error: String(err) });
          throw err;
        }
      },

      loadKnowledgeStats: async (examId) => {
        set({ isLoadingKnowledge: true });
        
        try {
          const result = await invoke<KnowledgeStatsComparison>('qbank_get_knowledge_stats_with_comparison', {
            request: {
              exam_id: examId || get().currentExamId,
            },
          });
          
          set({ knowledgeStats: result, isLoadingKnowledge: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] loadKnowledgeStats failed:', err);
          set({ isLoadingKnowledge: false, error: String(err) });
          throw err;
        }
      },

      // ========================================================================
      // CSV 导入导出 API（2026-01 新增）
      // ========================================================================

      getCsvPreview: async (filePath, rows = 5) => {
        try {
          const result = await invoke<CsvPreviewResult>('get_csv_preview', {
            filePath,
            rows,
          });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getCsvPreview failed:', err);
          throw err;
        }
      },

      importCsv: async (request) => {
        set({ isLoading: true, error: null });
        
        try {
          const result = await invoke<CsvImportResult>('import_questions_csv', {
            request: {
              file_path: request.file_path,
              exam_id: request.exam_id,
              field_mapping: request.field_mapping,
              duplicate_strategy: request.duplicate_strategy || 'skip',
              folder_id: request.folder_id,
              exam_name: request.exam_name,
            },
          });
          
          set({ isLoading: false });
          
          // 导入成功后刷新题目列表
          if (result.success_count > 0) {
            await get().loadQuestions(request.exam_id);
            await get().loadStats(request.exam_id);
          }
          
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] importCsv failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      exportCsv: async (request) => {
        set({ isLoading: true, error: null });
        
        try {
          const result = await invoke<CsvExportResult>('export_questions_csv', {
            request: {
              exam_id: request.exam_id,
              file_path: request.file_path,
              fields: request.fields || [],
              filters: request.filters || {},
              include_answers: request.include_answers || false,
              encoding: request.encoding || 'utf8',
            },
          });
          
          set({ isLoading: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] exportCsv failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      getCsvExportableFields: async () => {
        try {
          const fields = await invoke<Array<[string, string]>>('get_csv_exportable_fields', {});
          return fields;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getCsvExportableFields failed:', err);
          throw err;
        }
      },

      // ========================================================================
      // 练习模式扩展 API（2026-01 新增）
      // ========================================================================
      
      setTimedSession: (session) => set({ timedSession: session }),
      setMockExamSession: (session) => set({ mockExamSession: session }),
      setDailyPractice: (result) => set({ dailyPractice: result }),
      setGeneratedPaper: (paper) => set({ generatedPaper: paper }),

      // 2026-08 修复（R1-06 B1/B5 同源）：此前限时进度回写挂在本 store 的
      // submitAnswer 上，但真实答题路径是 useQuestionBankSession（本地 hook），
      // 该 action 无人调用 → 限时/每日面板进度恒为 0。现在由 ExamContentView
      // 的提交回调统一调用此方法。
      //
      // 2026-08 R4（修 R1-07 §三）：首答锁之外增加「已答题差量修正」——
      // 改判/重答不再被当成重复作答吞掉，correct 按旧判定 → 新判定 差量
      // 更新（可减）；completed/answered 仍只计首答。差量基线是
      // answered_results（与 answered_question_ids 同步写入）；已答但缺
      // 基线的题（旧版会话残留）方向不可知，保持首答锁 fail-closed。
      recordPracticeAnswer: (examId, questionId, isCorrect) => {
        // 差量口径与后端一致：null（主观题待判定）计 0，与 false 同权重。
        const correctDelta = (
          previous: boolean | null | undefined,
          next: boolean | null,
        ): number => (next === true ? 1 : 0) - (previous === true ? 1 : 0);

        const timed = get().timedSession;
        if (
          timed
          && !timed.is_submitted
          && !timed.is_timeout
          && timed.exam_id === examId
          && timed.question_ids.includes(questionId)
        ) {
          const answeredIds = timed.answered_question_ids ?? [];
          const results = timed.answered_results ?? {};
          if (!answeredIds.includes(questionId)) {
            set({
              timedSession: {
                ...timed,
                answered_question_ids: [...answeredIds, questionId],
                answered_results: { ...results, [questionId]: isCorrect },
                answered_count: Math.min(timed.question_count, timed.answered_count + 1),
                correct_count: timed.correct_count + (isCorrect === true ? 1 : 0),
              },
            });
          } else if (questionId in results && results[questionId] !== isCorrect) {
            set({
              timedSession: {
                ...timed,
                answered_results: { ...results, [questionId]: isCorrect },
                correct_count: Math.max(
                  0,
                  timed.correct_count + correctDelta(results[questionId], isCorrect),
                ),
              },
            });
          }
        }

        const daily = get().dailyPractice;
        if (
          daily
          && daily.exam_id === examId
          && daily.question_ids.includes(questionId)
        ) {
          const answeredIds = daily.answered_question_ids ?? [];
          const results = daily.answered_results ?? {};
          if (!answeredIds.includes(questionId)) {
            const completed = daily.completed_count + 1;
            set({
              dailyPractice: {
                ...daily,
                answered_question_ids: [...answeredIds, questionId],
                answered_results: { ...results, [questionId]: isCorrect },
                completed_count: completed,
                correct_count: daily.correct_count + (isCorrect === true ? 1 : 0),
                is_completed: completed >= daily.daily_target,
              },
            });
          } else if (questionId in results && results[questionId] !== isCorrect) {
            // 改判/重答：completed 与 is_completed 不动（题数没变），
            // correct 差量修正并下限 0（本地乐观值不为负）。
            set({
              dailyPractice: {
                ...daily,
                answered_results: { ...results, [questionId]: isCorrect },
                correct_count: Math.max(
                  0,
                  daily.correct_count + correctDelta(results[questionId], isCorrect),
                ),
              },
            });
          }
        }
      },

      applyAuthoritativeDailyProgress: (examId, progress) => {
        const daily = get().dailyPractice;
        if (!daily || daily.exam_id !== examId) return false;
        if (progress.exam_id != null && progress.exam_id !== examId) return false;
        // 跨零点：本地会话还是昨天的，覆盖会产生"昨日题单 + 今日计数"的
        // 杂交对象；跳过，等下次 getDailyPractice 整体换发。
        if (daily.date && progress.date && daily.date !== progress.date) return false;
        const completed = practiceInteger(progress.completed_count, 0);
        const correct = practiceInteger(progress.correct_count, 0);
        if (completed == null || correct == null) return false;
        // 首答去重集合以后端全量为准（answered_results 差量基线保留：
        // 缺基线的题在 recordPracticeAnswer 里 fail-closed，不会算错方向）。
        const answeredIds = Array.isArray(progress.answered_question_ids)
          ? progress.answered_question_ids.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
          : null;
        set({
          dailyPractice: {
            ...daily,
            ...(answeredIds ? { answered_question_ids: answeredIds } : {}),
            completed_count: completed,
            correct_count: correct,
            is_completed: typeof progress.is_completed === 'boolean'
              ? progress.is_completed
              : completed >= daily.daily_target,
          },
        });
        return true;
      },
      hydratePracticeHandoff: (value, expectedExamId) => {
        const validated = validateQbankPracticeHandoff(value, expectedExamId);
        if ('ok' in validated) return validated;
        const common = {
          currentExamId: expectedExamId,
          practiceMode: validated.mode as PracticeMode,
          error: null,
        };
        if (validated.mode === 'timed') {
          set({ ...common, timedSession: validated.session });
        } else if (validated.mode === 'mock_exam') {
          set({ ...common, mockExamSession: validated.session, mockExamScoreCard: null });
        } else {
          set({ ...common, dailyPractice: validated.session });
        }
        return {
          ok: true,
          mode: validated.mode,
          handoffId: validated.handoff_id,
          firstQuestionId: validated.session.question_ids[0]!,
          questionCount: validated.session.question_ids.length,
        };
      },

      startTimedPractice: async (examId, durationMinutes, questionCount) => {
        set({ isLoadingPractice: true, error: null });
        
        try {
          const session = await invoke<TimedPracticeSession>('qbank_start_timed_practice', {
            request: {
              exam_id: examId,
              duration_minutes: durationMinutes,
              question_count: questionCount,
            },
          });
          
          set({ timedSession: session, isLoadingPractice: false });
          return session;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] startTimedPractice failed:', err);
          set({ error: String(err), isLoadingPractice: false });
          throw err;
        }
      },

      generateMockExam: async (examId, config) => {
        set({ isLoadingPractice: true, error: null });
        
        try {
          const session = await invoke<MockExamSession>('qbank_generate_mock_exam', {
            request: {
              exam_id: examId,
              config,
            },
          });
          
          set({ mockExamSession: session, isLoadingPractice: false });
          return session;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] generateMockExam failed:', err);
          set({ error: String(err), isLoadingPractice: false });
          throw err;
        }
      },

      submitMockExam: async (session) => {
        set({ isLoadingPractice: true, error: null });
        
        try {
          const normalizedSession: MockExamSession = {
            ...session,
            ended_at: session.ended_at || new Date().toISOString(),
            is_submitted: true,
          };
          const scoreCard = await invoke<MockExamScoreCard>('qbank_submit_mock_exam', {
            request: { session: normalizedSession },
          });
          
          set({
            mockExamSession: normalizedSession,
            mockExamScoreCard: scoreCard,
            isLoadingPractice: false,
          });
          return scoreCard;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] submitMockExam failed:', err);
          set({ error: String(err), isLoadingPractice: false });
          throw err;
        }
      },

      getDailyPractice: async (examId, count) => {
        set({ isLoadingPractice: true, error: null });
        
        try {
          const result = await invoke<DailyPracticeResult>('qbank_get_daily_practice', {
            request: {
              exam_id: examId,
              count,
            },
          });
          
          set({ dailyPractice: result, isLoadingPractice: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getDailyPractice failed:', err);
          set({ error: String(err), isLoadingPractice: false });
          throw err;
        }
      },

      generatePaper: async (examId, config) => {
        set({ isLoadingPractice: true, error: null });
        
        try {
          const paper = await invoke<GeneratedPaper>('qbank_generate_paper', {
            request: {
              exam_id: examId,
              config,
            },
          });
          
          set({ generatedPaper: paper, isLoadingPractice: false });
          return paper;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] generatePaper failed:', err);
          set({ error: String(err), isLoadingPractice: false });
          throw err;
        }
      },

      getCheckInCalendar: async (examId, year, month, dailyTarget) => {
        const requestId = ++checkInCalendarRequestSeq;
        set({ isLoadingPractice: true, error: null });
        
        try {
          const calendar = await invoke<CheckInCalendar>('qbank_get_check_in_calendar', {
            request: {
              exam_id: examId,
              year,
              month,
              // 达标判定跟随用户目标（缺省后端按 10 题判定）
              daily_target: dailyTarget,
            },
          });
          
          if (requestId === checkInCalendarRequestSeq) {
            set({ checkInCalendar: calendar, isLoadingPractice: false });
          }
          return calendar;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getCheckInCalendar failed:', err);
          if (requestId === checkInCalendarRequestSeq) {
            set({ error: String(err), isLoadingPractice: false });
          }
          throw err;
        }
      },

      // Navigation — uses questionOrder[] to guarantee stable server ordering
      goToQuestion: (index) => {
        const { questionOrder } = get();
        if (index >= 0 && index < questionOrder.length) {
          set({ currentQuestionId: questionOrder[index] || null });
        }
      },

      // Selectors
      getCurrentQuestion: () => {
        const { questions, currentQuestionId } = get();
        return currentQuestionId ? questions.get(currentQuestionId) || null : null;
      },

      getQuestionsByStatus: (status) => {
        return Array.from(get().questions.values()).filter((q) => q.status === status);
      },

      getFilteredQuestions: () => {
        const { questions, filters } = get();
        let result = Array.from(questions.values());
        
        if (filters.status?.length) {
          result = result.filter((q) => filters.status!.includes(q.status));
        }
        if (filters.difficulty?.length) {
          result = result.filter((q) => q.difficulty && filters.difficulty!.includes(q.difficulty));
        }
        if (filters.question_type?.length) {
          result = result.filter((q) => filters.question_type!.includes(q.question_type));
        }
        if (filters.is_favorite !== undefined) {
          result = result.filter((q) => q.is_favorite === filters.is_favorite);
        }
        // NOTE: Client-side search only filters the currently loaded page of questions.
        // For full-text search across ALL questions, consider using SQLite FTS5 on the backend.
        if (filters.search) {
          const searchLower = filters.search.toLowerCase();
          result = result.filter((q) => q.content.toLowerCase().includes(searchLower));
        }
        
        return result;
      },

      getProgress: () => {
        const { questionOrder, currentQuestionId } = get();
        const currentIndex = currentQuestionId ? questionOrder.indexOf(currentQuestionId) : -1;
        return {
          current: currentIndex + 1,
          total: questionOrder.length,
        };
      },
    })),
    { name: 'QuestionBankStore', enabled: import.meta.env.DEV }
  )
);

// ============================================================================
// Hooks
// ============================================================================

export const useCurrentQuestion = () => useQuestionBankStore((state) =>
  state.currentQuestionId ? state.questions.get(state.currentQuestionId) ?? null : null
);
export const useQuestionBankStats = () => useQuestionBankStore((state) => state.stats);
export const useQuestionBankLoading = () => useQuestionBankStore((state) => state.isLoading);
export const useQuestionBankError = () => useQuestionBankStore((state) => state.error);
export const useQuestionProgress = () => useQuestionBankStore(useShallow((state) => ({
  current: state.currentQuestionId ? state.questionOrder.indexOf(state.currentQuestionId) + 1 : 0,
  total: state.questionOrder.length,
})));

// 时间维度统计 Hooks（2026-01 新增）
export const useLearningTrend = () => useQuestionBankStore((state) => state.learningTrend);
export const useActivityHeatmap = () => useQuestionBankStore((state) => state.activityHeatmap);
export const useKnowledgeStats = () => useQuestionBankStore((state) => state.knowledgeStats);
export const useSelectedDateRange = () => useQuestionBankStore((state) => state.selectedDateRange);
export const useLoadingTrend = () => useQuestionBankStore((state) => state.isLoadingTrend);
export const useLoadingHeatmap = () => useQuestionBankStore((state) => state.isLoadingHeatmap);
export const useLoadingKnowledge = () => useQuestionBankStore((state) => state.isLoadingKnowledge);
