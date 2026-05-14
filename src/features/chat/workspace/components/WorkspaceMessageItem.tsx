import React, { useState, useMemo, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import {
  CaretDown,
  CaretRight,
  Robot,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  Clock,
  ArrowsOut,
  ArrowsIn,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { WorkspaceMessage, MessageType } from '../types';
import { ChatContainer } from '../../components/ChatContainer';
import { getAgentDisplayName } from '../utils';

interface WorkspaceMessageItemProps {
  message: WorkspaceMessage;
  isFromCurrentAgent?: boolean;
  /** 点击查看完整会话的回调 */
  onViewFullSession?: (sessionId: string) => void;
  /** Agent 信息映射，用于展示角色/技能名 */
  agentMap?: Map<string, { role: 'coordinator' | 'worker'; skillId?: string }>;
}

const typeColors: Record<MessageType, string> = {
  task: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  progress: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  result: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  query: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  correction: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  broadcast: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
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
  const [subagentStatus, setSubagentStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');

  // 🆕 监听子代理会话事件（状态变化）
  useEffect(() => {
    if (!isSubagentTask || !subagentSessionId) return;

    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const eventChannel = `chat_v2_session_${subagentSessionId}`;
      unlisten = await listen<{
        sessionId: string;
        eventType: string;
      }>(eventChannel, (event) => {
        const { eventType } = event.payload;
        if (eventType === 'stream_start') {
          setSubagentStatus('running');
        } else if (eventType === 'stream_complete') {
          setSubagentStatus('completed');
        } else if (eventType === 'stream_error') {
          setSubagentStatus('failed');
        }
      });
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [isSubagentTask, subagentSessionId]);

  // 子代理状态图标
  const subagentStatusIcon = useMemo(() => {
    switch (subagentStatus) {
      case 'running':
        return <CircleNotch size={16} className="text-blue-500 animate-spin" />;
      case 'completed':
        return <CheckCircle size={16} className="text-green-500" />;
      case 'failed':
        return <WarningCircle size={16} className="text-red-500" />;
      default:
        return <Clock size={16} className="text-muted-foreground" />;
    }
  }, [subagentStatus]);

  // 子代理状态文本
  const subagentStatusText = useMemo(() => {
    switch (subagentStatus) {
      case 'running':
        return t('subagent.status.running');
      case 'completed':
        return t('subagent.status.completed');
      case 'failed':
        return t('subagent.status.failed');
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
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{senderLabel}</span>
          <span className="text-[10px] text-muted-foreground font-mono">{shortSenderId}</span>
          {shortTargetId && (
            <>
              <span className="text-xs text-muted-foreground">→</span>
              <span className="text-xs font-medium">{targetLabel}</span>
              <span className="text-[10px] text-muted-foreground font-mono">{shortTargetId}</span>
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
          subagentStatus === 'running' && "ring-2 ring-blue-500/30"
        )}>
          {/* 头部：可点击折叠 */}
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => setIsSubagentCollapsed(!isSubagentCollapsed)}
            className="w-full !justify-start gap-2 !p-2 text-left"
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
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsSubagentFullHeight(!isSubagentFullHeight);
                  }}
                  className="!h-6 !w-6"
                  aria-label={isSubagentFullHeight ? t('subagent.collapse') : t('subagent.expand')}
                  title={isSubagentFullHeight ? t('subagent.collapse') : t('subagent.expand')}
                >
                  {isSubagentFullHeight ? (
                    <ArrowsIn size={14} className="text-muted-foreground" />
                  ) : (
                    <ArrowsOut size={14} className="text-muted-foreground" />
                  )}
                </NotionButton>
                {onViewFullSession && (
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewFullSession(subagentSessionId);
                    }}
                    className="!h-6 !w-6"
                    aria-label={t('subagent.viewFull')}
                    title={t('subagent.viewFull')}
                  >
                    <ArrowSquareOut size={14} className="text-muted-foreground" />
                  </NotionButton>
                )}
              </div>
            )}
          </NotionButton>

          {/* 🆕 核心复用：使用 ChatContainer 渲染子代理的完整聊天视图 */}
          {!isSubagentCollapsed && (
            <div
              className={cn(
                "border-t border-border/50 overflow-hidden",
                isSubagentFullHeight ? "h-[500px]" : "h-[250px]"
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
          <div className="flex items-center gap-2 px-2 py-1 border-t border-border/30 bg-muted/20 text-[10px] text-muted-foreground">
            <span className="font-mono">{subagentSessionId.slice(-12)}</span>
          </div>
        </div>
      )}
    </div>
  );
};
