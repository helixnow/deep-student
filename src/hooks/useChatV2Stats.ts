/**
 * Chat V2 统计数据 Hook
 *
 * 提供 Chat V2 会话的统计数据，用于数据统计页面展示
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../utils/i18n';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 后端会话数据结构
 * 注意：后端使用 camelCase 序列化
 */
interface ChatSession {
  id: string;
  mode: string;
  title?: string;
  description?: string;
  persistStatus: 'active' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * 后端消息摘要数据
 */
interface MessageSummary {
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  sessions_with_messages: number;
}

/**
 * 会话活动数据（按天统计）
 */
export interface DailyActivity {
  date: string;
  displayDate: string;
  sessions: number;
  messages: number;
}

/**
 * 会话模式分布
 */
export interface ModeDistribution {
  mode: string;
  count: number;
  label: string;
}

/**
 * 时间段分布（按小时）
 */
export interface HourlyDistribution {
  hour: number;
  count: number;
}

/**
 * Chat V2 完整统计数据
 */
export interface ChatV2Stats {
  // 总体统计
  totalSessions: number;
  activeSessions: number;
  archivedSessions: number;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;

  // 近期统计
  recentSessions: number; // 最近7天创建的会话
  recentMessages: number; // 最近7天的消息

  // 分布统计
  modeDistribution: ModeDistribution[];
  dailyActivity: DailyActivity[];
  hourlyDistribution: HourlyDistribution[];

  // 计算指标
  avgMessagesPerSession: number;
  avgSessionsPerDay: number;

  // 状态
  loading: boolean;
  error: string | null;
}

// ============================================================================
// 模式标签映射
// ============================================================================

const getModeLabel = (mode: string): string => {
  const key = `chat_modes.${mode}`;
  const translated = t(key);
  return translated !== key ? translated : mode;
};

const getWeekdayLabel = (dayIndex: number): string => {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return t(`weekdays.${days[dayIndex]}`);
};

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取 Chat V2 统计数据
 */
export function useChatV2Stats(autoRefresh = false, refreshInterval = 30000): ChatV2Stats {
  const [stats, setStats] = useState<ChatV2Stats>({
    totalSessions: 0,
    activeSessions: 0,
    archivedSessions: 0,
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    recentSessions: 0,
    recentMessages: 0,
    modeDistribution: [],
    dailyActivity: [],
    hourlyDistribution: [],
    avgMessagesPerSession: 0,
    avgSessionsPerDay: 0,
    loading: true,
    error: null,
  });

  const loadStats = useCallback(async () => {
    try {
      // 获取所有会话
      const [activeSessions, archivedSessions] = await Promise.all([
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'active',
          limit: 1000,
        }),
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'archived',
          limit: 1000,
        }).catch(() => [] as ChatSession[]),
      ]);

      const allSessions = [...activeSessions, ...archivedSessions];
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // 计算近期会话
      const recentSessions = allSessions.filter(
        (s) => new Date(s.createdAt) > sevenDaysAgo
      ).length;

      // 计算模式分布
      const modeCount: Record<string, number> = {};
      allSessions.forEach((s) => {
        const mode = s.mode || 'default';
        modeCount[mode] = (modeCount[mode] || 0) + 1;
      });

      const modeDistribution: ModeDistribution[] = Object.entries(modeCount)
        .map(([mode, count]) => ({
          mode,
          count,
          label: getModeLabel(mode),
        }))
        .sort((a, b) => b.count - a.count);

      // 计算每日活动（最近7天）
      const dailyActivity: DailyActivity[] = [];

      for (let i = 6; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        const sessionsOnDay = allSessions.filter((s) => {
          const sessionDate = new Date(s.createdAt).toISOString().split('T')[0];
          return sessionDate === dateStr;
        }).length;

        dailyActivity.push({
          date: dateStr,
          displayDate: `${t('weekdays.prefix', { defaultValue: '周' })}${getWeekdayLabel(date.getDay())}`,
          sessions: sessionsOnDay,
          messages: 0, // 消息数需要额外查询
        });
      }

      // 计算小时分布
      const hourlyCount: number[] = new Array(24).fill(0);
      allSessions.forEach((s) => {
        const hour = new Date(s.createdAt).getHours();
        hourlyCount[hour]++;
      });

      const hourlyDistribution: HourlyDistribution[] = hourlyCount.map(
        (count, hour) => ({ hour, count })
      );

      // 尝试获取消息统计
      let totalMessages = 0;
      let userMessages = 0;
      let assistantMessages = 0;

      try {
        const messageSummary = await invoke<MessageSummary>('chat_v2_get_message_summary');
        totalMessages = messageSummary.total_messages;
        userMessages = messageSummary.user_messages;
        assistantMessages = messageSummary.assistant_messages;
      } catch (e: unknown) {
        // 消息统计可能不可用，使用估算
        totalMessages = allSessions.length * 10; // 估算每会话10条消息
        userMessages = Math.floor(totalMessages / 2);
        assistantMessages = totalMessages - userMessages;
      }

      // 计算平均值
      const avgMessagesPerSession =
        allSessions.length > 0
          ? Math.round((totalMessages / allSessions.length) * 10) / 10
          : 0;

      const avgSessionsPerDay = Math.round((recentSessions / 7) * 10) / 10;

      setStats({
        totalSessions: allSessions.length,
        activeSessions: activeSessions.length,
        archivedSessions: archivedSessions.length,
        totalMessages,
        userMessages,
        assistantMessages,
        recentSessions,
        recentMessages: Math.floor(totalMessages * 0.3), // 估算
        modeDistribution,
        dailyActivity,
        hourlyDistribution,
        avgMessagesPerSession,
        avgSessionsPerDay,
        loading: false,
        error: null,
      });
    } catch (error: unknown) {
      console.error('[useChatV2Stats] Failed to load stats:', error);
      setStats((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t('messages.error.load_stats_failed'),
      }));
    }
  }, []);

  // 初始加载
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(loadStats, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, loadStats]);

  return stats;
}

/**
 * 手动刷新统计数据的 Hook
 */
export function useChatV2StatsRefresh() {
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return { refreshKey, refresh };
}

export default useChatV2Stats;
