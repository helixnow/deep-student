import React, { useState, useMemo, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import {
  CaretDown,
  CaretRight,
  Robot,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  XCircle,
  Clock,
  ArrowsOut,
  ArrowsIn,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { WorkspaceMessage, MessageType, AgentStatus } from '../types';
import { ChatContainer } from '../../components/ChatContainer';
import { getAgentDisplayName } from '../utils';
import { useWorkspaceStore } from '../workspaceStore';

interface WorkspaceMessageItemProps {
  message: WorkspaceMessage;
  isFromCurrentAgent?: boolean;
  /** 点击查看完整会话的回调 */
  onViewFullSession?: (sessionId: string) => void;
  /** Agent 信息映射，用于展示角色/技能名 */
  agentMap?: Map<string, { role: 'coordinator' | 'worker'; skillId?: string }>;
}

// 消息类型徽章（语义 token，暗色自动跟随主题）
const typeColors: Record<MessageType, string> = {
  task: 'bg-info/10 text-info',
  progress: 'bg-warning/10 text-warning',
  result: 'bg-success/10 text-success',
  query: 'bg-primary/10 text-primary',
  correction: 'bg-destructive/10 text-destructive',
  broadcast: 'bg-muted text-muted-foreground',
};

export const WorkspaceMessageItem: React.FC<WorkspaceMessageItemProps> = ({
  message,
  isFromCurrentAgent,
  onViewFullSession,
  agentMap,
}) => {
  const { t } = useTranslation(['chatV2', 'skills']);
  const shortSenderId = message.senderSessionId.slice(-8);
  const shortTargetId = message.targetSessionId?.slice(-8);
  const senderInfo = agentMap?.get(message.senderSessionId);
  const targetInfo = message.targetSessionId ? agentMap?.get(message.targetSessionId) : undefined;
  const senderLabel = getAgentDisplayName(senderInfo, t, shortSenderId);
  const targetLabel = targetInfo ? getAgentDisplayName(targetInfo, t, shortTargetId) : shortTargetId;

  // 使用 i18n 的类型标签
  const typeLabels: Record<MessageType, string> = {
    task: t('workspace.messageType.task'),
    progress: t('workspace.messageType.progress'),
    result: t('workspace.messageType.result'),
    query: t('workspace.messageType.query'),
    correction: t('workspace.messageType.correction'),
    broadcast: t('workspace.messageType.broadcast'),
  };

  // 🆕 2026-01-20: 判断是否是分派给子代理的任务消息
  const isSubagentTask =
    message.messageType === 'task' &&
    (targetInfo?.role === 'worker' ||
      message.targetSessionId?.startsWith('subagent_') ||
      message.targetSessionId?.startsWith('agent_'));
  
  const subagentSessionId = message.targetSessionId;

  // 🆕 P1 修复：子代理嵌入视图状态
  const [isSubagentCollapsed, setIsSubagentCollapsed] = useState(false);
  const [isSubagentFullHeight, setIsSubagentFullHeight] = useState(false);

  // 🆕 状态单一真相：从 workspaceStore.agents 订阅子代理状态（由 workspace 事件维护）
  // 选择器直接返回目标 agent 的 status，未变更时引用相同，避免无关更新触发重渲染
  const storeStatus = useWorkspaceStore((s) =>
    subagentSessionId ? s.agents.find((a) => a.sessionId === subagentSessionId)?.status : undefined
  );

  // chat_v2_session_* 事件仅作为"流式进行中"的细粒度提示；终态判断以 store 为准
  const [streamHint, setStreamHint] = useState<AgentStatus | undefined>(undefined);

  // 🆕 监听子代理会话事件（细粒度流式提示）
  useEffect(() => {
    if (!isSubagentTask || !subagentSessionId) return;

    // listen 是异步注册：若组件在注册完成前卸载，需在 resolve 后立即注销，避免监听器泄漏
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const eventChannel = `chat_v2_session_${subagentSessionId}`;
    listen<{
      sessionId: string;
      eventType: string;
    }>(eventChannel, (event) => {
      const { eventType } = event.payload;
      if (eventType === 'stream_start') {
        setStreamHint('running');
      } else if (eventType === 'stream_complete') {
        setStreamHint('completed');
      } else if (eventType === 'stream_error') {
        setStreamHint('failed');
      } else if (eventType === 'stream_cancelled') {
        setStreamHint('cancelled');
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch((e: unknown) => {
      console.error('[WorkspaceMessageItem] Failed to listen subagent events:', e);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isSubagentTask, subagentSessionId]);

  // 状态推导：store 单一真相优先；store 查不到该 agent 时（如历史会话）
  // 回退到流式事件提示，仍无信息则视为已结束
  const subagentStatus: AgentStatus = storeStatus ?? streamHint ?? 'completed';

  // 子代理状态图标
  const subagentStatusIcon = useMemo(() => {
    switch (subagentStatus) {
      case 'running':
        return <CircleNotch size={16} className="text-info animate-spin" />;
      case 'queued':
        return <Clock size={16} className="text-info/80" />;
      case 'completed':
        return <CheckCircle size={16} className="text-success" />;
      case 'failed':
        return <WarningCircle size={16} className="text-destructive" />;
      case 'cancelled':
      case 'interrupted':
        return <XCircle size={16} className="text-warning" />;
      case 'closed':
        return <XCircle size={16} className="text-muted-foreground" />;
      default:
        return <Clock size={16} className="text-muted-foreground" />;
    }
  }, [subagentStatus]);

  // 子代理状态文本
  const subagentStatusText = useMemo(() => {
    switch (subagentStatus) {
      case 'running':
        return t('subagent.status.running');
      case 'queued':
        return t('subagent.status.queued');
      case 'completed':
        return t('subagent.status.completed');
      case 'failed':
        return t('subagent.status.failed');
      case 'cancelled':
        return t('subagent.status.cancelled');
      case 'interrupted':
        return t('subagent.status.interrupted');
      case 'closed':
        return t('subagent.status.closed');
      default:
        return t('subagent.status.idle');
    }
  }, [subagentStatus, t]);

  return (
    <div
      className={cn(
        'flex flex-col gap-1 p-3 rounded-lg border',
        isFromCurrentAgent ? 'bg-primary/5 border-primary/20' : 'bg-muted/30'
      )}
    >
      {/* 窄屏：发送者/目标行允许换行 + 收缩，避免长 id 溢出 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{senderLabel}</span>
          <span className="text-2xs text-muted-foreground font-mono">{shortSenderId}</span>
          {shortTargetId && (
            <>
              <span className="text-xs text-muted-foreground">→</span>
              <span className="text-xs font-medium">{targetLabel}</span>
              <span className="text-2xs text-muted-foreground font-mono">{shortTargetId}</span>
            </>
          )}
          {!shortTargetId && message.messageType === 'broadcast' && (
            <span className="text-xs text-muted-foreground">({t('workspace.messageType.broadcast')})</span>
          )}
        </div>
        <span
          className={cn(
            'px-1.5 py-0.5 text-xs rounded',
            typeColors[message.messageType]
          )}
        >
          {typeLabels[message.messageType]}
        </span>
      </div>
      <div className="text-sm whitespace-pre-wrap break-words">{message.content}</div>
      <div className="text-xs text-muted-foreground">
        {new Date(message.createdAt).toLocaleTimeString()}
      </div>

      {/* 🆕 P1 修复: 子代理任务消息嵌套显示子代理聊天视图（复用 ChatContainer） */}
      {isSubagentTask && subagentSessionId && (
        <div className={cn(
          "mt-2 rounded-lg border border-border/50 bg-card overflow-hidden",
          subagentStatus === 'running' && "ring-2 ring-primary/25"
        )}>
          {/* 头部：可点击折叠（用 div 而非 button，避免内部操作按钮形成非法的 button 嵌套） */}
          <div
            role="button"
            tabIndex={0}
            aria-expanded={!isSubagentCollapsed}
            onClick={() => setIsSubagentCollapsed(!isSubagentCollapsed)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsSubagentCollapsed(!isSubagentCollapsed);
              }
            }}
            className="flex w-full items-center gap-2 p-2 text-left cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
          >
            {isSubagentCollapsed ? (
              <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
            ) : (
              <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
            )}
            <Robot size={16} className="text-primary flex-shrink-0" />
            <span className="text-xs font-medium flex-1 truncate">
              {t('subagent.title')}
            </span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {subagentStatusIcon}
              <span className="text-xs text-muted-foreground">{subagentStatusText}</span>
            </div>

            {/* 高度切换 + 查看完整会话按钮 */}
            {!isSubagentCollapsed && (
              <div className="flex items-center gap-1">
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsSubagentFullHeight(!isSubagentFullHeight);
                  }}
                  className="!h-8 !w-8 lg:!h-6 lg:!w-6"
                  aria-label={isSubagentFullHeight ? t('subagent.collapse') : t('subagent.expand')}
                  title={isSubagentFullHeight ? t('subagent.collapse') : t('subagent.expand')}
                >
                  {isSubagentFullHeight ? (
                    <ArrowsIn size={14} className="text-muted-foreground" />
                  ) : (
                    <ArrowsOut size={14} className="text-muted-foreground" />
                  )}
                </DsButton>
                {onViewFullSession && (
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewFullSession(subagentSessionId);
                    }}
                    className="!h-8 !w-8 lg:!h-6 lg:!w-6"
                    aria-label={t('subagent.viewFull')}
                    title={t('subagent.viewFull')}
                  >
                    <ArrowSquareOut size={14} className="text-muted-foreground" />
                  </DsButton>
                )}
              </div>
            )}
          </div>

          {/* 🆕 核心复用：使用 ChatContainer 渲染子代理的完整聊天视图 */}
          {!isSubagentCollapsed && (
            <div
              className={cn(
                // 高度用视口相对值封顶，避免小屏嵌套滚动超出可视范围
                "border-t border-border/50 overflow-hidden",
                isSubagentFullHeight ? "h-[min(500px,70vh)]" : "h-[min(250px,40vh)]"
              )}
            >
              <ChatContainer
                key={subagentSessionId}
                sessionId={subagentSessionId}
                showInputBar={false}
                className="h-full"
              />
            </div>
          )}

          {/* 底部元信息 */}
          <div className="flex items-center gap-2 px-2 py-1 border-t border-border/30 bg-muted/20 text-2xs text-muted-foreground">
            <span className="font-mono">{subagentSessionId.slice(-12)}</span>
          </div>
        </div>
      )}
    </div>
  );
};
