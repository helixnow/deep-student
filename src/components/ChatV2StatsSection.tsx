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
// StatCard - Notion风格极简统计卡片
// ============================================================================

interface StatCardProps {
  title: string;
  value: number | string;
  description?: string;
  icon: React.ElementType;
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  description,
  icon: Icon,
}) => {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-md hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="w-4 h-4 opacity-70" />
        <span className="text-xs font-medium">{title}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight text-foreground font-mono tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {description && (
        <div className="text-[10px] text-muted-foreground/50 truncate">
          {description}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

interface ChatV2StatsProps {
  className?: string;
}

export const ChatV2StatsSection: React.FC<ChatV2StatsProps> = ({ className }) => {
  const { t } = useTranslation('common');
  const stats = useChatV2Stats(false);

  if (stats.loading) {
    return (
      <div className={cn('w-full space-y-8', className)}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-md bg-muted/10" />
          ))}
        </div>
        <div className="pt-4">
           <Skeleton className="h-40 rounded-md bg-muted/10" />
        </div>
        <div className="pt-4">
          <Skeleton className="h-64 rounded-md bg-muted/10" />
        </div>
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
      {/* 统计卡片网格 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <StatCard
          icon={MessageSquare}
          title={t('chat_stats.total_sessions')}
          value={stats.totalSessions}
          description={t('chat_stats.total_sessions_desc')}
        />
        <StatCard
          icon={Activity}
          title={t('chat_stats.active_sessions')}
          value={stats.activeSessions}
          description={t('chat_stats.active_sessions_desc')}
        />
        <StatCard
          icon={Archive}
          title={t('chat_stats.archived_sessions')}
          value={stats.archivedSessions}
          description={t('chat_stats.archived_sessions_desc')}
        />
        <StatCard
          icon={MessagesSquare}
          title={t('chat_stats.total_messages')}
          value={stats.totalMessages}
          description={t('chat_stats.total_messages_desc', { user: stats.userMessages, ai: stats.assistantMessages })}
        />
        <StatCard
          icon={Calendar}
          title={t('chat_stats.recent_sessions')}
          value={stats.recentSessions}
          description={t('chat_stats.recent_sessions_desc')}
        />
        <StatCard
          icon={Clock}
          title={t('chat_stats.avg_messages')}
          value={stats.avgMessagesPerSession}
          description={t('chat_stats.avg_messages_desc')}
        />
      </div>

      {/* 学习热力图 - 移除了显式边框，使用背景色块区分 */}
      <div className="p-1">
        <LearningHeatmap months={12} showStats={false} showLegend={true} />
      </div>
    </div>
  );
};

export default ChatV2StatsSection;
