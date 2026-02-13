/**
 * 复习计划 Store
 *
 * 提供复习计划的统一状态管理，支持：
 * - 获取到期复习
 * - 处理复习结果（SM-2 算法）
 * - 复习统计
 * - 复习历史
 *
 * 🆕 2026-01 新增
 */

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { showGlobalNotification } from '../components/UnifiedNotification';
import i18n from '@/i18n';

// ============================================================================
// 类型定义
// ============================================================================

/** 复习计划状态 */
export type ReviewPlanStatus =
  | 'new'
  | 'learning'
  | 'reviewing'
  | 'graduated'
  | 'suspended';

/** 复习计划实体 */
export interface ReviewPlan {
  id: string;
  question_id: string;
  exam_id: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_date: string;
  last_review_date: string | null;
  status: ReviewPlanStatus;
  total_reviews: number;
  total_correct: number;
  consecutive_failures: number;
  is_difficult: boolean;
  created_at: string;
  updated_at: string;
}

/** 复习历史记录 */
export interface ReviewHistory {
  id: string;
  plan_id: string;
  question_id: string;
  quality: number;
  passed: boolean;
  ease_factor_before: number;
  ease_factor_after: number;
  interval_before: number;
  interval_after: number;
  repetitions_before: number;
  repetitions_after: number;
  reviewed_at: string;
  user_answer: string | null;
  time_spent_seconds: number | null;
}

/** 到期复习筛选参数 */
export interface DueReviewsFilter {
  exam_id?: string;
  until_date?: string;
  status?: ReviewPlanStatus[];
  difficult_only?: boolean;
  limit?: number;
  offset?: number;
}

/** 到期复习列表结果 */
export interface DueReviewsResult {
  plans: ReviewPlan[];
  total: number;
  has_more: boolean;
}

/** 复习统计 */
export interface ReviewStats {
  exam_id: string | null;
  total_plans: number;
  new_count: number;
  learning_count: number;
  reviewing_count: number;
  graduated_count: number;
  suspended_count: number;
  due_today: number;
  overdue_count: number;
  difficult_count: number;
  total_reviews: number;
  total_correct: number;
  avg_correct_rate: number;
  avg_ease_factor: number;
  updated_at: string;
}

/** 处理复习结果 */
export interface ProcessReviewResult {
  plan: ReviewPlan;
  passed: boolean;
  new_interval: number;
  next_review_date: string;
  history: ReviewHistory;
}

/** 批量创建复习计划结果 */
export interface BatchCreateResult {
  created: number;
  skipped: number;
  failed: number;
  plans: ReviewPlan[];
}

/** 复习质量评分 */
export type ReviewQuality = 0 | 1 | 2 | 3 | 4 | 5;

/** 带题目信息的复习项 */
export interface ReviewItemWithQuestion {
  plan: ReviewPlan;
  question?: {
    id: string;
    content: string;
    answer?: string;
    explanation?: string;
    question_type: string;
    difficulty?: string;
    tags: string[];
  };
}

// ============================================================================
// 复习会话状态
// ============================================================================

export interface ReviewSessionState {
  /** 是否正在进行复习会话 */
  isActive: boolean;
  /** 当前复习队列 */
  queue: ReviewItemWithQuestion[];
  /** 当前复习索引 */
  currentIndex: number;
  /** 本次复习开始时间 */
  startTime: number | null;
  /** 本次题目开始时间 */
  questionStartTime: number | null;
  /** 复习结果记录 */
  results: {
    planId: string;
    quality: ReviewQuality;
    passed: boolean;
    timeSpent: number;
  }[];
  /** 已完成数量 */
  completedCount: number;
  /** 正确数量 */
  correctCount: number;
}

// ============================================================================
// 日历热力图数据
// ============================================================================

export interface CalendarHeatmapData {
  date: string;
  count: number;
  passed: number;
  failed: number;
}

// ============================================================================
// Store 状态
// ============================================================================

interface ReviewPlanState {
  // 数据
  dueReviews: ReviewPlan[];
  allPlans: ReviewPlan[];
  stats: ReviewStats | null;
  currentExamId: string | null;

  // 复习会话
  session: ReviewSessionState;

  // 日历数据
  calendarData: CalendarHeatmapData[];

  // 加载状态
  isLoading: boolean;
  isProcessing: boolean;
  error: string | null;

  // Actions - 数据获取
  setCurrentExam: (examId: string | null) => void;
  loadDueReviews: (examId?: string, untilDate?: string) => Promise<void>;
  loadDueReviewsWithFilter: (filter: DueReviewsFilter) => Promise<DueReviewsResult>;
  loadStats: (examId?: string) => Promise<void>;
  refreshStats: (examId?: string) => Promise<ReviewStats>;
  loadAllPlans: (examId: string) => Promise<void>;

  // Actions - 复习计划管理
  createPlan: (questionId: string, examId: string) => Promise<ReviewPlan>;
  batchCreatePlans: (questionIds: string[], examId: string) => Promise<BatchCreateResult>;
  createPlansForExam: (examId: string) => Promise<BatchCreateResult>;
  deletePlan: (planId: string) => Promise<void>;
  suspendPlan: (planId: string) => Promise<ReviewPlan>;
  resumePlan: (planId: string) => Promise<ReviewPlan>;
  getOrCreatePlan: (questionId: string, examId: string) => Promise<ReviewPlan>;
  getPlanByQuestion: (questionId: string) => Promise<ReviewPlan | null>;

  // Actions - 复习处理
  processReview: (
    planId: string,
    quality: ReviewQuality,
    userAnswer?: string,
    timeSpentSeconds?: number
  ) => Promise<ProcessReviewResult>;
  getReviewHistory: (planId: string, limit?: number) => Promise<ReviewHistory[]>;

  // Actions - 复习会话
  startSession: (items: ReviewItemWithQuestion[]) => void;
  endSession: () => void;
  submitReview: (quality: ReviewQuality, userAnswer?: string) => Promise<void>;
  skipCurrentQuestion: () => void;
  getCurrentItem: () => ReviewItemWithQuestion | null;
  getSessionProgress: () => { current: number; total: number };
  getSessionStats: () => { completed: number; correct: number; accuracy: number };

  // Actions - 日历数据
  loadCalendarData: (startDate: string, endDate: string, examId?: string) => Promise<void>;

  // Selectors
  getDueCount: () => number;
  getOverdueCount: () => number;
  getTodayDueCount: () => number;
}

// ============================================================================
// Store 实现
// ============================================================================

export const useReviewPlanStore = create<ReviewPlanState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      // 初始状态
      dueReviews: [],
      allPlans: [],
      stats: null,
      currentExamId: null,
      session: {
        isActive: false,
        queue: [],
        currentIndex: 0,
        startTime: null,
        questionStartTime: null,
        results: [],
        completedCount: 0,
        correctCount: 0,
      },
      calendarData: [],
      isLoading: false,
      isProcessing: false,
      error: null,

      // 基本 Setters
      setCurrentExam: (examId) => set({ currentExamId: examId }),

      // 数据获取
      loadDueReviews: async (examId, untilDate) => {
        set({ isLoading: true, error: null });

        try {
          const result = await invoke<DueReviewsResult>('review_plan_get_due', {
            examId: examId || null,
            untilDate: untilDate || null,
          });

          set({
            dueReviews: result.plans,
            isLoading: false,
          });
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] loadDueReviews failed:', err);
          set({ error: String(err), isLoading: false });
        }
      },

      loadDueReviewsWithFilter: async (filter) => {
        set({ isLoading: true, error: null });

        try {
          const result = await invoke<DueReviewsResult>('review_plan_get_due_with_filter', {
            filter,
          });

          set({
            dueReviews: result.plans,
            isLoading: false,
          });

          return result;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] loadDueReviewsWithFilter failed:', err);
          set({ error: String(err), isLoading: false });
          throw err;
        }
      },

      loadStats: async (examId) => {
        try {
          const stats = await invoke<ReviewStats>('review_plan_get_stats', {
            examId: examId || null,
          });
          set({ stats });
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] loadStats failed:', err);
        }
      },

      refreshStats: async (examId) => {
        // 🔒 审计修复: 添加 try-catch（原代码是 store 中唯一缺少错误处理的 API 方法）
        try {
          const stats = await invoke<ReviewStats>('review_plan_refresh_stats', {
            examId: examId ?? null,
          });
          set({ stats });
          return stats;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] refreshStats failed:', err);
          set({ error: String(err) });
          return get().stats;
        }
      },

      loadAllPlans: async (examId) => {
        set({ isLoading: true, error: null });

        try {
          const result = await invoke<DueReviewsResult>('review_plan_list_by_exam', {
            examId,
            limit: 1000,
            offset: 0,
          });

          set({
            allPlans: result.plans,
            currentExamId: examId,
            isLoading: false,
          });
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] loadAllPlans failed:', err);
          set({ error: String(err), isLoading: false });
        }
      },

      // 复习计划管理
      createPlan: async (questionId, examId) => {
        set({ isProcessing: true });

        try {
          const plan = await invoke<ReviewPlan>('review_plan_create', {
            questionId,
            examId,
          });

          set((state) => ({
            allPlans: [...state.allPlans, plan],
            isProcessing: false,
          }));

          return plan;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] createPlan failed:', err);
          set({ isProcessing: false });
          throw err;
        }
      },

      batchCreatePlans: async (questionIds, examId) => {
        set({ isProcessing: true });

        try {
          const result = await invoke<BatchCreateResult>('review_plan_batch_create', {
            questionIds,
            examId,
          });

          // 刷新所有计划
          await get().loadAllPlans(examId);

          set({ isProcessing: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] batchCreatePlans failed:', err);
          set({ isProcessing: false });
          throw err;
        }
      },

      createPlansForExam: async (examId) => {
        set({ isProcessing: true });

        try {
          const result = await invoke<BatchCreateResult>('review_plan_create_for_exam', {
            examId,
          });

          // 刷新所有计划
          await get().loadAllPlans(examId);
          await get().refreshStats(examId);

          set({ isProcessing: false });
          return result;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] createPlansForExam failed:', err);
          set({ isProcessing: false });
          throw err;
        }
      },

      deletePlan: async (planId) => {
        try {
          await invoke('review_plan_delete', { planId });

          set((state) => ({
            dueReviews: state.dueReviews.filter((p) => p.id !== planId),
            allPlans: state.allPlans.filter((p) => p.id !== planId),
          }));
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] deletePlan failed:', err);
          throw err;
        }
      },

      suspendPlan: async (planId) => {
        try {
          const plan = await invoke<ReviewPlan>('review_plan_suspend', { planId });

          set((state) => ({
            dueReviews: state.dueReviews.filter((p) => p.id !== planId),
            allPlans: state.allPlans.map((p) => (p.id === planId ? plan : p)),
          }));

          return plan;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] suspendPlan failed:', err);
          throw err;
        }
      },

      resumePlan: async (planId) => {
        try {
          const plan = await invoke<ReviewPlan>('review_plan_resume', { planId });

          set((state) => ({
            allPlans: state.allPlans.map((p) => (p.id === planId ? plan : p)),
          }));

          // 刷新到期复习
          await get().loadDueReviews(get().currentExamId || undefined);

          return plan;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] resumePlan failed:', err);
          throw err;
        }
      },

      getOrCreatePlan: async (questionId, examId) => {
        try {
          const plan = await invoke<ReviewPlan>('review_plan_get_or_create', {
            questionId,
            examId,
          });
          return plan;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] getOrCreatePlan failed:', err);
          throw err;
        }
      },

      getPlanByQuestion: async (questionId) => {
        try {
          const plan = await invoke<ReviewPlan | null>('review_plan_get_by_question', {
            questionId,
          });
          return plan;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] getPlanByQuestion failed:', err);
          return null;
        }
      },

      // 复习处理
      processReview: async (planId, quality, userAnswer, timeSpentSeconds) => {
        set({ isProcessing: true });

        try {
          // 🔒 审计修复: 使用 nullish coalescing(??) 替代 || null
          // 原代码将 timeSpentSeconds=0（瞬间作答）和 userAnswer=""（空答案）错误替换为 null
          const result = await invoke<ProcessReviewResult>('review_plan_process', {
            planId,
            quality,
            userAnswer: userAnswer ?? null,
            timeSpentSeconds: timeSpentSeconds ?? null,
          });

          // 更新本地状态
          set((state) => ({
            dueReviews: state.dueReviews.filter((p) => p.id !== planId),
            allPlans: state.allPlans.map((p) => (p.id === planId ? result.plan : p)),
            isProcessing: false,
          }));

          return result;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] processReview failed:', err);
          set({ isProcessing: false });
          throw err;
        }
      },

      getReviewHistory: async (planId, limit) => {
        try {
          const history = await invoke<ReviewHistory[]>('review_plan_get_history', {
            planId,
            limit: limit || 50,
          });
          return history;
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] getReviewHistory failed:', err);
          return [];
        }
      },

      // 复习会话
      startSession: (items) => {
        set({
          session: {
            isActive: true,
            queue: items,
            currentIndex: 0,
            startTime: Date.now(),
            questionStartTime: Date.now(),
            results: [],
            completedCount: 0,
            correctCount: 0,
          },
        });
      },

      endSession: () => {
        set({
          session: {
            isActive: false,
            queue: [],
            currentIndex: 0,
            startTime: null,
            questionStartTime: null,
            results: [],
            completedCount: 0,
            correctCount: 0,
          },
        });
      },

      submitReview: async (quality, userAnswer) => {
        const { session, processReview } = get();
        if (!session.isActive || session.currentIndex >= session.queue.length) return;

        const currentItem = session.queue[session.currentIndex];
        const timeSpent = session.questionStartTime
          ? Math.floor((Date.now() - session.questionStartTime) / 1000)
          : 0;

        try {
          const result = await processReview(
            currentItem.plan.id,
            quality,
            userAnswer,
            timeSpent
          );

          set((state) => {
            const newResults = [
              ...state.session.results,
              {
                planId: currentItem.plan.id,
                quality,
                passed: result.passed,
                timeSpent,
              },
            ];

            const newIndex = state.session.currentIndex + 1;
            const isComplete = newIndex >= state.session.queue.length;

            return {
              session: {
                ...state.session,
                currentIndex: newIndex,
                questionStartTime: isComplete ? null : Date.now(),
                results: newResults,
                completedCount: state.session.completedCount + 1,
                correctCount: result.passed
                  ? state.session.correctCount + 1
                  : state.session.correctCount,
              },
            };
          });
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] submitReview failed:', err);
          throw err;
        }
      },

      skipCurrentQuestion: () => {
        set((state) => {
          const newIndex = state.session.currentIndex + 1;
          const isComplete = newIndex >= state.session.queue.length;

          return {
            session: {
              ...state.session,
              currentIndex: newIndex,
              questionStartTime: isComplete ? null : Date.now(),
            },
          };
        });
      },

      getCurrentItem: () => {
        const { session } = get();
        if (!session.isActive || session.currentIndex >= session.queue.length) {
          return null;
        }
        return session.queue[session.currentIndex];
      },

      getSessionProgress: () => {
        const { session } = get();
        return {
          current: session.currentIndex + 1,
          total: session.queue.length,
        };
      },

      getSessionStats: () => {
        const { session } = get();
        const accuracy =
          session.completedCount > 0
            ? Math.round((session.correctCount / session.completedCount) * 100)
            : 0;
        return {
          completed: session.completedCount,
          correct: session.correctCount,
          accuracy,
        };
      },

      // 日历数据
      loadCalendarData: async (startDate, endDate, examId) => {
        try {
          const data = await invoke<CalendarHeatmapData[]>(
            'review_plan_get_calendar_data',
            {
              startDate: startDate || null,
              endDate: endDate || null,
              examId: examId || null,
            },
          );
          set({ calendarData: data });
        } catch (err: unknown) {
          debugLog.error('[ReviewPlanStore] loadCalendarData failed:', err);
          showGlobalNotification('error', i18n.t('common:calendar.loadFailed'));
        }
      },

      // Selectors
      getDueCount: () => {
        return get().dueReviews.length;
      },

      getOverdueCount: () => {
        const today = new Date().toISOString().split('T')[0];
        return get().dueReviews.filter((p) => p.next_review_date < today).length;
      },

      getTodayDueCount: () => {
        const today = new Date().toISOString().split('T')[0];
        return get().dueReviews.filter((p) => p.next_review_date === today).length;
      },
    })),
    { name: 'ReviewPlanStore', enabled: import.meta.env.DEV }
  )
);

// ============================================================================
// Hooks
// ============================================================================

export const useReviewStats = () => useReviewPlanStore((state) => state.stats);
export const useReviewDueCount = () => useReviewPlanStore((state) => state.getDueCount());
export const useReviewSession = () => useReviewPlanStore((state) => state.session);
export const useReviewLoading = () => useReviewPlanStore((state) => state.isLoading);
export const useReviewError = () => useReviewPlanStore((state) => state.error);
