/**
 * 学习热力图数据 Hook
 * 
 * 从后端获取聚合的学习活动数据，用于热力图展示
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
}

/** 学习活动数据（热力图单元） */
export interface LearningActivity {
  date: string;
  count: number;
  details: DailyActivityDetails;
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
  refresh: () => Promise<void>;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 获取日期范围（默认近一年） */
function getDateRange(months: number = 12): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
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

  const { startDate, endDate } = useMemo(() => getDateRange(months), [months]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await invoke<LearningActivity[]>('get_learning_heatmap', {
        startDate,
        endDate,
      });
      setData(result);
    } catch (err: unknown) {
      console.error('[useLearningHeatmap] Failed to load data:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
    
    return { totalActivities, activeDays, maxCount };
  }, [data]);

  return {
    data,
    heatmapData,
    loading,
    error,
    ...stats,
    refresh: loadData,
  };
}

export default useLearningHeatmap;
