import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ExternalLink } from 'lucide-react';
import type { AgentStatus, AgentRole } from '../types';
import { getLocalizedSkillName } from '../utils';

interface AgentCardProps {
  sessionId: string;
  role: AgentRole;
  status: AgentStatus;
  skillId?: string;
  isCurrentAgent?: boolean;
  onClick?: () => void;
  /** 🆕 2026-01-20: 显示"查看输出"按钮 */
  showViewButton?: boolean;
}

const statusColors: Record<AgentStatus, string> = {
  idle: 'bg-gray-400',
  running: 'bg-green-500 animate-pulse',
  completed: 'bg-blue-500',
  failed: 'bg-red-500',
};

export const AgentCard: React.FC<AgentCardProps> = ({
  sessionId,
  role,
  status,
  skillId,
  isCurrentAgent,
  onClick,
  showViewButton,
}) => {
  const { t } = useTranslation(['chatV2', 'skills']);
  const shortId = sessionId.slice(-8);
  const skillName = getLocalizedSkillName(
    skillId,
    t,
    t('chatV2:workspace.agent.worker')
  );
  const statusLabel = {
    idle: t('chatV2:workspace.status.idle'),
    running: t('chatV2:workspace.status.running'),
    completed: t('chatV2:workspace.status.completed'),
    failed: t('chatV2:workspace.status.failed'),
  }[status];

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors',
        onClick ? 'cursor-pointer' : '',
        isCurrentAgent
          ? 'border-primary bg-primary/10'
          : 'border-border hover:bg-muted/50'
      )}
      onClick={onClick}
    >
      <div className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[status])} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium truncate">
            {role === 'coordinator'
          ? t('chatV2:workspace.agent.coordinator')
          : skillName || shortId}
        </span>
        {role === 'coordinator' && (
          <span className="text-xs text-muted-foreground">
            ({t('chatV2:workspace.agent.coordinator')})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground truncate font-mono">{shortId}</span>
          <span className={cn(
            'text-xs',
            status === 'running' ? 'text-green-600' :
            status === 'completed' ? 'text-blue-600' :
            status === 'failed' ? 'text-red-600' :
            'text-muted-foreground'
          )}>
            {statusLabel}
          </span>
        </div>
      </div>
      {showViewButton && onClick && (
        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      )}
    </div>
  );
};
