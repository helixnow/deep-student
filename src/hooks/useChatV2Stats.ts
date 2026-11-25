/**
 * Chat V2 统计数据 Hook
 *
 * 提供 Chat V2 会话的统计数据，用于数据统计页面展示
 */

import { startTransition, useState, useEffect, useCallback, useRef } from 'react';
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

/** 本地时区 YYYY-MM-DD（对齐热力图与番茄/复习的本地日历口径，避免 UTC 跨日偏移） */
export function formatLocalDateYmd(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface RawChatV2Payload {
  activeSessions: ChatSession[];
  archivedSessions: ChatSession[];
  messageSummary: MessageSummary | null;
  fetchedAt: number;
}

const RAW_CACHE_TTL_MS = 15_000;

/**
 * 纯函数单趟 O(N + activityDays) 聚合 Chat V2 会话统计：
 * 替代旧版 O(activityDays × allSessions) 嵌套 filter + 重复 Date/toISOString 分配。
 */
export function computeChatV2Stats(
  activeSessions: readonly ChatSession[],
  archivedSessions: readonly ChatSession[],
  messageSummary: MessageSummary | null,
  activityDays: number,
  now: Date = new Date(),
): Omit<ChatV2Stats, 'loading' | 'error'> {
  const totalSessions = activeSessions.length + archivedSessions.length;
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  let recentSessions = 0;
  const modeCount: Record<string, number> = {};
  const sessionsByDate = new Map<string, number>();
  const hourlyCount: number[] = new Array(24).fill(0);

  const accumulate = (sessions: readonly ChatSession[]) => {
    for (let idx = 0; idx < sessions.length; idx += 1) {
      const s = sessions[idx];
      const mode = s.mode || 'default';
      modeCount[mode] = (modeCount[mode] || 0) + 1;

      const created = new Date(s.createdAt);
      const createdMs = created.getTime();
      if (!Number.isNaN(createdMs)) {
        if (createdMs > sevenDaysAgoMs) {
          recentSessions += 1;
        }
        const localKey = formatLocalDateYmd(created);
        sessionsByDate.set(localKey, (sessionsByDate.get(localKey) ?? 0) + 1);
        hourlyCount[created.getHours()] += 1;
      }
    }
  };

  accumulate(activeSessions);
  accumulate(archivedSessions);

  const modeDistribution: ModeDistribution[] = Object.entries(modeCount)
    .map(([mode, count]) => ({
      mode,
      count,
      label: getModeLabel(mode),
    }))
    .sort((a, b) => b.count - a.count);

  const weekdayPrefix = t('weekdays.prefix', { defaultValue: '周' });
  const clampedDays = Math.max(1, Math.floor(activityDays));
  const dailyActivity: DailyActivity[] = new Array(clampedDays);
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth();
  const baseDay = now.getDate();

  for (let i = clampedDays - 1; i >= 0; i -= 1) {
    const date = new Date(baseYear, baseMonth, baseDay - i);
    const dateStr = formatLocalDateYmd(date);
    dailyActivity[clampedDays - 1 - i] = {
      date: dateStr,
      displayDate: `${weekdayPrefix}${getWeekdayLabel(date.getDay())}`,
      sessions: sessionsByDate.get(dateStr) ?? 0,
      messages: 0,
    };
  }

  const hourlyDistribution: HourlyDistribution[] = hourlyCount.map((count, hour) => ({
    hour,
    count,
  }));

  let totalMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;

  if (messageSummary) {
    totalMessages = messageSummary.total_messages;
    userMessages = messageSummary.user_messages;
    assistantMessages = messageSummary.assistant_messages;
  } else {
    totalMessages = totalSessions * 10;
    userMessages = Math.floor(totalMessages / 2);
    assistantMessages = totalMessages - userMessages;
  }

  const avgMessagesPerSession =
    totalSessions > 0 ? Math.round((totalMessages / totalSessions) * 10) / 10 : 0;
  const avgSessionsPerDay = Math.round((recentSessions / 7) * 10) / 10;

  return {
    totalSessions,
    activeSessions: activeSessions.length,
    archivedSessions: archivedSessions.length,
    totalMessages,
    userMessages,
    assistantMessages,
    recentSessions,
    recentMessages: Math.floor(totalMessages * 0.3),
    modeDistribution,
    dailyActivity,
    hourlyDistribution,
    avgMessagesPerSession,
    avgSessionsPerDay,
  };
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取 Chat V2 统计数据
 * @param activityDays dailyActivity 覆盖的天数（默认 7 天）
 */
export function useChatV2Stats(autoRefresh = false, refreshInterval = 30000, activityDays = 7): ChatV2Stats {
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

  const rawCacheRef = useRef<RawChatV2Payload | null>(null);
  const requestSeqRef = useRef(0);

  const loadStats = useCallback(async (forceFetch = false) => {
    const reqSeq = ++requestSeqRef.current;
    try {
      const cached = rawCacheRef.current;
      let payload: RawChatV2Payload;

      if (!forceFetch && cached && Date.now() - cached.fetchedAt < RAW_CACHE_TTL_MS) {
        payload = cached;
      } else {
        // 三个统计查询并行拉取，避免串行瀑布阻塞首帧
        const [activeSessions, archivedSessions, messageSummary] = await Promise.all([
          invoke<ChatSession[]>('chat_v2_list_sessions', {
            status: 'active',
            limit: 1000,
          }),
          invoke<ChatSession[]>('chat_v2_list_sessions', {
            status: 'archived',
            limit: 1000,
          }).catch(() => [] as ChatSession[]),
          invoke<MessageSummary>('chat_v2_get_message_summary').catch(() => null),
        ]);
        if (reqSeq !== requestSeqRef.current) return;
        payload = {
          activeSessions: Array.isArray(activeSessions) ? activeSessions : [],
          archivedSessions: Array.isArray(archivedSessions) ? archivedSessions : [],
          messageSummary,
          fetchedAt: Date.now(),
        };
        rawCacheRef.current = payload;
      }

      const computed = computeChatV2Stats(
        payload.activeSessions,
        payload.archivedSessions,
        payload.messageSummary,
        activityDays,
      );

      startTransition(() => {
        if (reqSeq !== requestSeqRef.current) return;
        setStats({
          ...computed,
          loading: false,
          error: null,
        });
      });
    } catch (error: unknown) {
      if (reqSeq !== requestSeqRef.current) return;
      console.error('[useChatV2Stats] Failed to load stats:', error);
      setStats((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t('messages.error.load_stats_failed'),
      }));
    }
  }, [activityDays]);

  // 初始加载与 activityDays 切换（命中组件内缓存时仅重算 O(N) 窗口，不重复拉取 2000 条会话）
  useEffect(() => {
    void loadStats(false);
  }, [loadStats]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      void loadStats(true);
    }, refreshInterval);
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
