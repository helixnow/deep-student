import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { ArrowSquareOut } from '@phosphor-icons/react';
import type { AgentStatus, AgentRole } from '../types';
import { getLocalizedSkillName } from '../utils';
import { useWorkspaceStore } from '../workspaceStore';

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
  cancelled: 'bg-gray-500',
};

// ============================================================================
// 共享工具（AgentOutputDrawer 也会复用）
// ============================================================================

export interface AgentTaskInfo {
  /** 最近一条派发给该 agent 的 task 消息内容 */
  taskContent: string | null;
  /** 该 task 消息的创建时间（近似任务开始时间） */
  taskCreatedAt: string | null;
}

/**
 * 从 workspace store 中选出发给该 agent 的最近一条 task 消息。
 * 用 useShallow 只订阅两个字符串字段，消息列表其他变化不会触发重渲染。
 */
export function useAgentTaskInfo(sessionId: string): AgentTaskInfo {
  return useWorkspaceStore(
    useShallow((state) => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.messageType === 'task' && m.targetSessionId === sessionId) {
          return { taskContent: m.content, taskCreatedAt: m.createdAt };
        }
      }
      return { taskContent: null, taskCreatedAt: null };
    })
  );
}

/** 压平换行并按码点截断，避免截断代理对（surrogate pair） */
export function truncateTaskTitle(content: string, maxChars = 60): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  const chars = Array.from(singleLine);
  if (chars.length <= maxChars) return singleLine;
  return `${chars.slice(0, maxChars).join('')}…`;
}

/** 将毫秒格式化为 "42s" / "3m 12s" / "1h 5m" */
export function formatElapsedDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * 运行耗时 hook：仅在 isRunning 时挂载每秒 tick，其余状态零开销。
 * 返回从 startIso 起算的毫秒数；无法计算时返回 null。
 */
export function useRunningElapsedMs(isRunning: boolean, startIso: string | null): number | null {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  if (!isRunning || !startIso) return null;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, now - start);
}

// ============================================================================
// 组件
// ============================================================================

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
    cancelled: t('chatV2:workspace.status.cancelled'),
  }[status];

  // 🆕 任务摘要标题：最近一条派发给该 agent 的 task 消息内容
  const { taskContent } = useAgentTaskInfo(sessionId);
  const taskSummary =
    role !== 'coordinator' && taskContent ? truncateTaskTitle(taskContent) : null;

  const primaryLabel =
    role === 'coordinator'
      ? t('chatV2:workspace.agent.coordinator')
      : taskSummary || skillName || shortId;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors',
        onClick ? 'cursor-pointer' : '',
        isCurrentAgent
          ? 'border-primary bg-primary/10'
          : 'border-border hover:bg-[var(--interactive-hover)]'
      )}
      onClick={onClick}
    >
      <div className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[status])} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span
            className="text-sm font-medium truncate"
            title={taskContent ? truncateTaskTitle(taskContent, 300) : undefined}
          >
            {primaryLabel}
          </span>
          {role === 'coordinator' && (
            <span className="text-xs text-muted-foreground">
              ({t('chatV2:workspace.agent.coordinator')})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground truncate font-mono">{shortId}</span>
          {/* 主标题被任务摘要占用时，技能名下移到次要行 */}
          {taskSummary && skillName && (
            <span className="text-xs text-muted-foreground truncate">{skillName}</span>
          )}
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
        <ArrowSquareOut size={14} className="text-muted-foreground flex-shrink-0" />
      )}
    </div>
  );
};
