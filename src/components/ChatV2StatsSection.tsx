/**
 * Chat V2 统计组件
 *
 * 遵循 Notion 风格设计：极简、大留白、精致排版
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  MessagesSquare,
  Calendar,
  Clock,
  Archive,
  Activity,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Skeleton } from './ui/shad/Skeleton';
import { useChatV2Stats } from '../hooks/useChatV2Stats';
import { LearningHeatmap } from './LearningHeatmap';

// ============================================================================
// PropRow - 制卡任务风格 property 行
// ============================================================================

const PropRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => (
  <div className="grid grid-cols-[120px_1fr] sm:grid-cols-[150px_1fr] items-center py-2 group border-b border-border/20 last:border-0">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0">
        {icon}
      </span>
      <span className="text-[13px] text-muted-foreground truncate">
        {label}
      </span>
    </div>
    <div className="flex items-center gap-1 text-[13px] text-foreground min-w-0 flex-wrap">
      {children}
    </div>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

interface ChatV2StatsProps {
  className?: string;
  statsOnly?: boolean;
}

export const ChatV2StatsSection: React.FC<ChatV2StatsProps> = ({ className, statsOnly }) => {
  const { t } = useTranslation('common');
  const stats = useChatV2Stats(false);

  if (stats.loading) {
    return (
      <div className={cn('w-full', statsOnly ? '' : 'space-y-8', className)}>
        <div className="space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full max-w-md rounded bg-muted/10" />
          ))}
        </div>
        {!statsOnly && (
          <div className="pt-4">
            <Skeleton className="h-40 rounded-md bg-muted/10" />
          </div>
        )}
      </div>
    );
  }

  if (stats.error) {
    return (
      <div className={cn('w-full', className)}>
        <div className="py-12 text-center">
          <p className="text-muted-foreground text-sm">{t('chat_stats.no_data')}</p>
          <p className="text-xs text-muted-foreground/50 mt-1 font-mono">{stats.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)}>
      {/* 统计属性列表 */}
      <div className={statsOnly ? 'space-y-0' : 'space-y-0 mb-8'}>
        <PropRow icon={<MessageSquare className="h-3.5 w-3.5" />} label={t('chat_stats.total_sessions')}>
          <span className="font-semibold tabular-nums">{stats.totalSessions.toLocaleString()}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.total_sessions_desc')}
          </span>
        </PropRow>
        <PropRow icon={<Activity className="h-3.5 w-3.5" />} label={t('chat_stats.active_sessions')}>
          <span className="font-semibold tabular-nums">{stats.activeSessions.toLocaleString()}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.active_sessions_desc')}
          </span>
        </PropRow>
        <PropRow icon={<Archive className="h-3.5 w-3.5" />} label={t('chat_stats.archived_sessions')}>
          <span className="tabular-nums">{stats.archivedSessions.toLocaleString()}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.archived_sessions_desc')}
          </span>
        </PropRow>
        <PropRow icon={<MessagesSquare className="h-3.5 w-3.5" />} label={t('chat_stats.total_messages')}>
          <span className="font-semibold tabular-nums">{stats.totalMessages.toLocaleString()}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.total_messages_desc', { user: stats.userMessages, ai: stats.assistantMessages })}
          </span>
        </PropRow>
        <PropRow icon={<Calendar className="h-3.5 w-3.5" />} label={t('chat_stats.recent_sessions')}>
          <span className="tabular-nums">{stats.recentSessions.toLocaleString()}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.recent_sessions_desc')}
          </span>
        </PropRow>
        <PropRow icon={<Clock className="h-3.5 w-3.5" />} label={t('chat_stats.avg_messages')}>
          <span className="tabular-nums">{stats.avgMessagesPerSession}</span>
          <span className="text-muted-foreground/50 ml-1 text-[12px]">
            {t('chat_stats.avg_messages_desc')}
          </span>
        </PropRow>
      </div>

      {/* 学习热力图 - 移除了显式边框，使用背景色块区分 */}
      {!statsOnly && (
        <div className="p-1">
          <LearningHeatmap months={12} showStats={false} showLegend={true} />
        </div>
      )}
    </div>
  );
};

export default ChatV2StatsSection;
