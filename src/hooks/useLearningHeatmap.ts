/**
 * 学习热力图数据 Hook
 * 
 * 从后端获取聚合的学习活动数据，用于热力图展示
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEventRegistry } from './useEventRegistry';

/** 与 features/study-time/studyTimeTracker.ts 的 STUDY_TIME_FLUSHED_EVENT 同名（避免 platform → feature 反向依赖）。 */
const STUDY_TIME_FLUSHED_EVENT = 'study-time:flushed';

// ============================================================================
// 类型定义
// ============================================================================

/** 单日学习活动详情 */
export interface DailyActivityDetails {
  chatSessions: number;
  chatMessages: number;
  notesEdited: number;
  textbooksOpened: number;
  examsCreated: number;
  translationsCreated: number;
  essaysCreated: number;
  ankiCardsCreated: number;
  questionsAnswered: number;
  cardsReviewed?: number;
  todosCompleted?: number;
  pomodorosCompleted?: number;
}

/** 学习活动数据（热力图单元） */
export interface LearningActivity {
  date: string;
  count: number;
  details: DailyActivityDetails;
  /** 当日学习时长（秒；study_time_daily，「可见且在场」计时）。旧后端缺省为 0 */
  studySeconds?: number;
}

/** 热力图数据格式（@uiw/react-heat-map 格式） */
export interface HeatMapValue {
  date: string;
  count: number;
}

/** Hook 返回值 */
export interface UseLearningHeatmapResult {
  data: LearningActivity[];
  heatmapData: HeatMapValue[];
  loading: boolean;
  error: string | null;
  totalActivities: number;
  activeDays: number;
  maxCount: number;
  /** 区间内累计学习时长（秒） */
  totalStudySeconds: number;
  /** 有学习时长记录的天数 */
  studyDays: number;
  /** 单日最长学习时长（秒） */
  maxStudySeconds: number;
  refresh: () => Promise<void>;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 按本地时区格式化 YYYY-MM-DD（避免东八区 00:00–08:00 用 toISOString 截断当日数据） */
export function formatLocalDateYmd(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 获取日期范围（默认近一年，按本地日历日期计算） */
export function getHeatmapDateRange(months: number = 12, now: Date = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth() - months, end.getDate());

  return {
    startDate: formatLocalDateYmd(start),
    endDate: formatLocalDateYmd(end),
  };
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取学习热力图数据
 * @param months 获取近几个月的数据，默认 12 个月
 */
export function useLearningHeatmap(months: number = 12): UseLearningHeatmapResult {
  const [data, setData] = useState<LearningActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const { startDate, endDate } = useMemo(() => getHeatmapDateRange(months), [months]);

  const loadData = useCallback(async (silent = false) => {
    const reqSeq = ++requestSeqRef.current;
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    
    try {
      const result = await invoke<LearningActivity[]>('get_learning_heatmap', {
        startDate,
        endDate,
      });
      if (reqSeq !== requestSeqRef.current) return;
      setData(result);
    } catch (err: unknown) {
      if (reqSeq !== requestSeqRef.current) return;
      console.error('[useLearningHeatmap] Failed to load data:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent && reqSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  useEventRegistry(
    [
      {
        target: 'window',
        type: STUDY_TIME_FLUSHED_EVENT,
        listener: () => {
          void loadData(true);
        },
      },
    ],
    [loadData],
  );

  // 转换为 @uiw/react-heat-map 格式
  const heatmapData: HeatMapValue[] = useMemo(() => {
    return data.map(item => ({
      date: item.date,
      count: item.count,
    }));
  }, [data]);

  // 计算统计指标
  const stats = useMemo(() => {
    const totalActivities = data.reduce((sum, item) => sum + item.count, 0);
    const activeDays = data.filter(item => item.count > 0).length;
    const maxCount = data.reduce((max, item) => Math.max(max, item.count), 0);
    const totalStudySeconds = data.reduce((sum, item) => sum + (item.studySeconds ?? 0), 0);
    const studyDays = data.filter(item => (item.studySeconds ?? 0) > 0).length;
    const maxStudySeconds = data.reduce((max, item) => Math.max(max, item.studySeconds ?? 0), 0);

    return { totalActivities, activeDays, maxCount, totalStudySeconds, studyDays, maxStudySeconds };
  }, [data]);

  const refresh = useCallback(() => loadData(false), [loadData]);

  return {
    data,
    heatmapData,
    loading,
    error,
    ...stats,
    refresh,
  };
}

export default useLearningHeatmap;
