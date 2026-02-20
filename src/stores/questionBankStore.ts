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

export type SourceType = 'ocr' | 'imported' | 'ai_generated';

export interface Question {
  id: string;
  exam_id: string;
  card_id?: string;
  question_label?: string;
  content: string;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  question_type: QuestionType;
  difficulty?: Difficulty;
  tags: string[];
  status: QuestionStatus;
  user_answer?: string;
  is_correct?: boolean;
  attempt_count: number;
  correct_count: number;
  last_attempt_at?: string;
  user_note?: string;
  is_favorite: boolean;
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
  question_type?: QuestionType[];
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
  total_correct: number;
  correct_rate: number;
  updated_at: string;
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

/** 时间范围类型 */
export type DateRange = 'today' | 'week' | 'month' | 'all';

// ============================================================================
// 同步冲突策略类型（2026-01 新增）
// ============================================================================

/** 同步冲突解决策略 */
export type QuestionConflictStrategy = 
  | 'keep_local'    // 保留本地版本
  | 'keep_remote'   // 保留远程版本
  | 'keep_newer'    // 保留更新时间较新的版本
  | 'merge'         // 智能合并（字段级别）
  | 'manual';       // 手动选择

/** 同步状态 */
export type SyncStatus = 
  | 'local_only'    // 仅本地存在（未同步）
  | 'synced'        // 已同步（本地与远程一致）
  | 'modified'      // 本地已修改（待推送）
  | 'conflict'      // 存在冲突
  | 'deleted_remote'; // 远程已删除

/** 冲突类型 */
export type ConflictType = 
  | 'modify_modify'   // 双方都修改了同一题目
  | 'modify_delete'   // 本地修改，远程删除
  | 'delete_modify'   // 本地删除，远程修改
  | 'add_add';        // 双方都新增了相同 remote_id 的题目

/** 题目版本快照 */
export interface QuestionVersion {
  id: string;
  content: string;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  question_type: QuestionType;
  difficulty?: Difficulty;
  tags: string[];
  status: QuestionStatus;
  user_answer?: string;
  is_correct?: boolean;
  attempt_count: number;
  correct_count: number;
  user_note?: string;
  is_favorite: boolean;
  content_hash: string;
  updated_at: string;
  remote_version: number;
}

/** 同步冲突记录 */
export interface SyncConflict {
  id: string;
  question_id: string;
  exam_id: string;
  conflict_type: ConflictType;
  local_version: QuestionVersion;
  remote_version: QuestionVersion;
  status: 'pending' | 'resolved' | 'skipped';
  resolved_strategy?: string;
  resolved_at?: string;
  created_at: string;
}

/** 同步配置 */
export interface SyncConfig {
  default_strategy: QuestionConflictStrategy;
  auto_sync: boolean;
  sync_interval_secs: number;
  sync_progress: boolean;
  sync_notes: boolean;
}

/** 同步状态检查结果 */
export interface SyncStatusResult {
  sync_enabled: boolean;
  last_synced_at?: string;
  local_modified_count: number;
  pending_conflict_count: number;
  total_count: number;
  synced_count: number;
  sync_config?: SyncConfig;
}

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
  completed_count: number;
  correct_count: number;
  source_distribution: DailySourceDistribution;
  is_completed: boolean;
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
  year: number;
  month: number;
  days: DailyCheckIn[];
  streak_days: number;
  month_check_in_days: number;
  month_total_questions: number;
}

// ============================================================================
// Store 状态
// ============================================================================

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
  showSettingsPanel: boolean;
  
  // 加载状态
  isLoading: boolean;
  isSubmitting: boolean;
  isLoadingTrend: boolean;
  isLoadingHeatmap: boolean;
  isLoadingKnowledge: boolean;
  error: string | null;
  // 并发防护
  loadRequestId: number;
  
  // Actions
  setCurrentExam: (examId: string | null) => void;
  setCurrentQuestion: (questionId: string | null) => void;
  setFilters: (filters: QuestionFilters) => void;
  setPracticeMode: (mode: PracticeMode) => void;
  setFocusMode: (focusMode: boolean) => void;
  toggleSettingsPanel: () => void;
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
  getCheckInCalendar: (examId: string | undefined, year: number, month: number) => Promise<CheckInCalendar>;
  
  // 练习模式状态
  timedSession: TimedPracticeSession | null;
  mockExamSession: MockExamSession | null;
  dailyPractice: DailyPracticeResult | null;
  generatedPaper: GeneratedPaper | null;
  checkInCalendar: CheckInCalendar | null;
  mockExamScoreCard: MockExamScoreCard | null;
  
  // 同步状态（2026-01 新增）
  syncStatus: SyncStatusResult | null;
  syncConflicts: SyncConflict[];
  isSyncing: boolean;
  
  setTimedSession: (session: TimedPracticeSession | null) => void;
  setMockExamSession: (session: MockExamSession | null) => void;
  setDailyPractice: (result: DailyPracticeResult | null) => void;
  setGeneratedPaper: (paper: GeneratedPaper | null) => void;
  
  // 同步 API（2026-01 新增）
  checkSyncStatus: (examId: string) => Promise<SyncStatusResult>;
  getSyncConflicts: (examId: string) => Promise<SyncConflict[]>;
  resolveSyncConflict: (conflictId: string, strategy: QuestionConflictStrategy) => Promise<Question>;
  batchResolveSyncConflicts: (examId: string, strategy: QuestionConflictStrategy) => Promise<Question[]>;
  setSyncEnabled: (examId: string, enabled: boolean) => Promise<void>;
  updateSyncConfig: (examId: string, config: SyncConfig) => Promise<void>;
  
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
      showSettingsPanel: false,
      isLoading: false,
      isSubmitting: false,
      isLoadingTrend: false,
      isLoadingHeatmap: false,
      isLoadingKnowledge: false,
      error: null,
      
      // 并发防护：请求 ID，确保只有最新请求的结果会被应用
      loadRequestId: 0,
      
      // 练习模式状态（2026-01 新增）
      timedSession: null,
      mockExamSession: null,
      dailyPractice: null,
      generatedPaper: null,
      checkInCalendar: null,
      mockExamScoreCard: null,
      
      // 同步状态（2026-01 新增）
      syncStatus: null,
      syncConflicts: [],
      isSyncing: false,

      // 基本 Setters
      setCurrentExam: (examId) => set({ currentExamId: examId }),
      
      setCurrentQuestion: (questionId) => set({ currentQuestionId: questionId }),
      
      setFilters: (filters) => set({ filters }),
      
      setPracticeMode: (mode) => set({ practiceMode: mode }),
      
      setFocusMode: (focusMode) => set({ focusMode }),
      toggleSettingsPanel: () => set(state => ({ showSettingsPanel: !state.showSettingsPanel })),
      
      setDateRange: (range) => set({ selectedDateRange: range }),
      
      resetFilters: () => set({ filters: {} }),

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
        const { currentExamId, pagination, filters, isLoading } = get();
        if (!currentExamId || isLoading || !pagination.hasMore) return;
        
        // 保存当前 examId 用于并发检查
        const examIdAtStart = currentExamId;
        
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
          
          // 并发防护：检查 examId 是否已变更
          if (get().currentExamId !== examIdAtStart) {
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
          // 并发防护：检查 examId 是否已变更
          if (get().currentExamId !== examIdAtStart) {
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

      submitAnswer: async (questionId, answer, isCorrectOverride) => {
        set({ isSubmitting: true });
        
        try {
          const result = await invoke<SubmitAnswerResult>('qbank_submit_answer', {
            request: {
              question_id: questionId,
              user_answer: answer,
              is_correct_override: isCorrectOverride,
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
          let defaultEndDate = toLocalDateStr(now);
          
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

      startTimedPractice: async (examId, durationMinutes, questionCount) => {
        set({ isLoading: true, error: null });
        
        try {
          const session = await invoke<TimedPracticeSession>('qbank_start_timed_practice', {
            request: {
              exam_id: examId,
              duration_minutes: durationMinutes,
              question_count: questionCount,
            },
          });
          
          set({ timedSession: session, isLoading: false });
          return session;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] startTimedPractice failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      generateMockExam: async (examId, config) => {
        set({ isLoading: true, error: null });
        
        try {
          const session = await invoke<MockExamSession>('qbank_generate_mock_exam', {
            request: {
              exam_id: examId,
              config,
            },
          });
          
          set({ mockExamSession: session, isLoading: false });
          return session;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] generateMockExam failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      submitMockExam: async (session) => {
        set({ isLoading: true, error: null });
        
        try {
          const scoreCard = await invoke<MockExamScoreCard>('qbank_submit_mock_exam', {
            request: { session },
          });
          
          set({ mockExamScoreCard: scoreCard, isLoading: false });
          return scoreCard;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] submitMockExam failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      getDailyPractice: async (examId, count) => {
        set({ isLoading: true, error: null });
        
        try {
          const result = await invoke<DailyPracticeResult>('qbank_get_daily_practice', {
            request: {
              exam_id: examId,
              count,
            },
          });
          
          set({ dailyPractice: result, isLoading: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getDailyPractice failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      generatePaper: async (examId, config) => {
        set({ isLoading: true, error: null });
        
        try {
          const paper = await invoke<GeneratedPaper>('qbank_generate_paper', {
            request: {
              exam_id: examId,
              config,
            },
          });
          
          set({ generatedPaper: paper, isLoading: false });
          return paper;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] generatePaper failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      getCheckInCalendar: async (examId, year, month) => {
        set({ isLoading: true, error: null });
        
        try {
          const calendar = await invoke<CheckInCalendar>('qbank_get_check_in_calendar', {
            request: {
              exam_id: examId,
              year,
              month,
            },
          });
          
          set({ checkInCalendar: calendar, isLoading: false });
          return calendar;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getCheckInCalendar failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      // ========================================================================
      // 同步 API（2026-01 新增）
      // ========================================================================

      checkSyncStatus: async (examId) => {
        set({ isSyncing: true, error: null });
        
        try {
          const status = await invoke<SyncStatusResult>('qbank_sync_check', {
            examId,
          });
          
          set({ syncStatus: status, isSyncing: false });
          return status;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] checkSyncStatus failed:', err);
          set({ error: String(err), isSyncing: false });
          throw err;
        }
      },

      getSyncConflicts: async (examId) => {
        set({ isSyncing: true, error: null });
        
        try {
          const conflicts = await invoke<SyncConflict[]>('qbank_get_sync_conflicts', {
            examId,
          });
          
          set({ syncConflicts: conflicts, isSyncing: false });
          return conflicts;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] getSyncConflicts failed:', err);
          set({ error: String(err), isSyncing: false });
          throw err;
        }
      },

      resolveSyncConflict: async (conflictId, strategy) => {
        set({ isSyncing: true, error: null });
        
        try {
          const question = await invoke<Question>('qbank_resolve_sync_conflict', {
            conflictId,
            strategy,
          });
          
          // 更新本地题目缓存
          set((state) => {
            const newMap = new Map(state.questions);
            newMap.set(question.id, question);
            // 移除已解决的冲突
            const newConflicts = state.syncConflicts.filter(c => c.id !== conflictId);
            return { questions: newMap, syncConflicts: newConflicts, isSyncing: false };
          });
          
          return question;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] resolveSyncConflict failed:', err);
          set({ error: String(err), isSyncing: false });
          throw err;
        }
      },

      batchResolveSyncConflicts: async (examId, strategy) => {
        set({ isSyncing: true, error: null });
        
        try {
          const questions = await invoke<Question[]>('qbank_batch_resolve_conflicts', {
            examId,
            strategy,
          });
          
          // 更新本地题目缓存
          set((state) => {
            const newMap = new Map(state.questions);
            questions.forEach(q => newMap.set(q.id, q));
            return { questions: newMap, syncConflicts: [], isSyncing: false };
          });
          
          return questions;
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] batchResolveSyncConflicts failed:', err);
          set({ error: String(err), isSyncing: false });
          throw err;
        }
      },

      setSyncEnabled: async (examId, enabled) => {
        try {
          await invoke('qbank_set_sync_enabled', {
            examId,
            enabled,
          });
          
          // 刷新同步状态
          await get().checkSyncStatus(examId);
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] setSyncEnabled failed:', err);
          throw err;
        }
      },

      updateSyncConfig: async (examId, config) => {
        try {
          await invoke('qbank_update_sync_config', {
            examId,
            config,
          });
          
          // 刷新同步状态
          await get().checkSyncStatus(examId);
        } catch (err: unknown) {
          debugLog.error('[QuestionBankStore] updateSyncConfig failed:', err);
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

// 同步状态 Hooks（2026-01 新增）
export const useSyncStatus = () => useQuestionBankStore((state) => state.syncStatus);
export const useSyncConflicts = () => useQuestionBankStore((state) => state.syncConflicts);
export const useIsSyncing = () => useQuestionBankStore((state) => state.isSyncing);
