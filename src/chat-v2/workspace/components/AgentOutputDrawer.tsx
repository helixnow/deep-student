/**
 * 🆕 2026-01-20: AgentOutputDrawer
 * 
 * Worker Agent 输出预览抽屉组件
 * 在 WorkspacePanel 中点击 Worker 时，可以展开显示该 Worker 的对话输出预览
 * 
 * 🔧 2026-01-21 P1 修复：
 * - 使用 ChatContainer 替代简化消息列表
 * - 子代理渲染与主代理完全相同
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Bot, Maximize2, Minimize2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/shad/Dialog';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Label } from '@/components/ui/shad/Label';
import type { AgentStatus } from '../types';
import { ChatContainer } from '../../components/ChatContainer';
import { sendMessage, runAgent, cancelAgent } from '../api';
import { useWorkspaceStore } from '../workspaceStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getLocalizedSkillName } from '../utils';

interface AgentOutputDrawerProps {
  /** 所属工作区 ID */
  workspaceId: string;
  /** Agent 会话 ID */
  agentSessionId: string;
  /** Agent 状态 */
  status: AgentStatus;
  /** Skill ID（用于显示标题） */
  skillId?: string;
  /** 是否展开 */
  isExpanded: boolean;
  /** 切换展开状态 */
  onToggle: () => void;
  /** 跳转到完整会话 */
  onViewFullSession?: () => void;
  /** 当前主会话 ID（作为派发任务的 sender） */
  currentSessionId?: string;
  /** 当前网络是否在线 */
  isOnline?: boolean;
}

/**
 * 🔧 2026-01-21 P1 修复：
 * 使用 ChatContainer 替代简化消息列表，实现子代理渲染与主代理完全相同
 */
export const AgentOutputDrawer: React.FC<AgentOutputDrawerProps> = ({
  workspaceId,
  agentSessionId,
  status,
  skillId,
  isExpanded,
  onToggle,
  onViewFullSession,
  currentSessionId,
  isOnline = true,
}) => {
  const { t } = useTranslation(['chatV2', 'skills']);
  // 🆕 高度切换状态
  const [isFullHeight, setIsFullHeight] = useState(false);
  // 🆕 派发任务对话框
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);
  const [dispatchContent, setDispatchContent] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const coordinatorSessionId = useWorkspaceStore((state) =>
    state.agents.find((a) => a.workspaceId === workspaceId && a.role === 'coordinator')?.sessionId
  );

  // 状态颜色
  const statusColors: Record<AgentStatus, string> = {
    idle: 'text-gray-500',
    running: 'text-blue-500',
    completed: 'text-green-500',
    failed: 'text-red-500',
  };

  // 状态文本
  const statusText = {
    idle: t('subagent.status.idle'),
    running: t('subagent.status.running'),
    completed: t('subagent.status.completed'),
    failed: t('subagent.status.failed'),
  }[status];

  const skillName = getLocalizedSkillName(
    skillId,
    t,
    t('chatV2:workspace.agent.worker')
  );

  const handleDispatch = async () => {
    const content = dispatchContent.trim();
    if (!content) {
      setDispatchError(t('chatV2:workspace.dispatch.empty'));
      return;
    }
    const senderSessionId = currentSessionId || coordinatorSessionId;
    if (!senderSessionId) {
      setDispatchError(t('chatV2:workspace.dispatch.noSender'));
      return;
    }
    if (!isOnline) {
      setDispatchError(t('chatV2:workspace.dispatch.offline'));
      return;
    }

    try {
      setDispatching(true);
      setDispatchError(null);
      await sendMessage(senderSessionId, {
        workspace_id: workspaceId,
        content,
        target_session_id: agentSessionId,
        message_type: 'task',
      });
      try {
        await runAgent(workspaceId, agentSessionId, undefined, senderSessionId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('active stream')) {
          throw err;
        }
      }

      showGlobalNotification(
        'success',
        t('chatV2:workspace.dispatch.success', { agent: skillName || agentSessionId.slice(-8) })
      );
      setDispatchContent('');
      setIsDispatchOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDispatchError(msg);
      showGlobalNotification(
        'error',
        t('chatV2:workspace.dispatch.failed', { error: msg })
      );
    } finally {
      setDispatching(false);
    }
  };

  const handleCancel = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      const senderSessionId = currentSessionId || coordinatorSessionId;
      if (!senderSessionId) {
        throw new Error(t('chatV2:workspace.dispatch.noSender'));
      }

      const cancelled = await cancelAgent(workspaceId, agentSessionId, senderSessionId);
      if (cancelled) {
        showGlobalNotification(
          'info',
          t('chatV2:workspace.cancelled')
        );
      } else {
        showGlobalNotification(
          'warning',
          t('chatV2:workspace.cancelNoop')
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification(
        'error',
          t('chatV2:workspace.cancelFailed', { error: msg })
      );
    }
  };

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden bg-card",
      status === 'running' && "ring-2 ring-blue-500/30"
    )}>
      {/* 头部（可点击展开/收起） */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-2.5 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          )}
          <Bot className={cn('w-4 h-4 flex-shrink-0', statusColors[status])} />
          <span className="text-sm font-medium truncate">
            {skillName || t('subagent.title')}
          </span>
          {status === 'running' && (
            <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('text-xs', statusColors[status])}>{statusText}</span>
          
          {/* 派发任务按钮 */}
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              setIsDispatchOpen(true);
            }}
            disabled={!isOnline}
            title={
              !isOnline
                ? t('chatV2:workspace.dispatch.offline')
                : t('chatV2:workspace.dispatch.title')
            }
          >
            <Send className="w-3 h-3 mr-1" />
            {t('chatV2:workspace.dispatch.title')}
          </NotionButton>

          {status === 'running' && (
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              onClick={handleCancel}
            >
              {t('chatV2:workspace.cancel')}
            </NotionButton>
          )}

          {/* 高度切换按钮（仅展开时显示） */}
          {isExpanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsFullHeight(!isFullHeight);
              }}
              className="p-1 hover:bg-muted rounded transition-colors"
              title={isFullHeight ? t('subagent.collapse') : t('subagent.expand')}
            >
              {isFullHeight ? (
                <Minimize2 className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>
          )}
          
          {/* 查看完整会话按钮 */}
          {onViewFullSession && (
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onViewFullSession();
              }}
            >
              <ExternalLink className="w-3 h-3 mr-1" />
              {t('workspace.viewFull')}
            </NotionButton>
          )}
        </div>
      </button>

      {/* 🔧 核心修复：使用 ChatContainer 渲染完整聊天视图（与主代理完全相同） */}
      {isExpanded && (
        <div
          className={cn(
            "border-t border-border/50 overflow-hidden",
            isFullHeight ? "h-[500px]" : "h-[280px]"
          )}
        >
          <ChatContainer
            key={agentSessionId}
            sessionId={agentSessionId}
            showInputBar={false}
            className="h-full"
          />
        </div>
      )}

      {/* 底部元信息 */}
      <div className="flex items-center gap-2 px-2.5 py-1 border-t border-border/30 bg-muted/20 text-[10px] text-muted-foreground">
        <span className="font-mono">{agentSessionId.slice(-12)}</span>
      </div>

      {/* 派发任务对话框 */}
      <Dialog
        open={isDispatchOpen}
        onOpenChange={(open) => {
          if (dispatching) return;
          setIsDispatchOpen(open);
          if (!open) {
            setDispatchError(null);
            setDispatchContent('');
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('chatV2:workspace.dispatch.title')}</DialogTitle>
            <DialogDescription>
              {t('chatV2:workspace.dispatch.desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="text-sm text-muted-foreground">
              {t('chatV2:workspace.dispatch.target')}:
              <span className="ml-1 text-foreground">{skillName || agentSessionId.slice(-8)}</span>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`dispatch-task-${agentSessionId}`}>
                {t('chatV2:workspace.dispatch.task')}
              </Label>
              <Textarea
                id={`dispatch-task-${agentSessionId}`}
                value={dispatchContent}
                onChange={(e) => setDispatchContent(e.target.value)}
                rows={4}
                disabled={dispatching}
                placeholder={t('chatV2:workspace.dispatch.placeholder')}
              />
              {dispatchError && (
                <p className="text-xs text-destructive">{dispatchError}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setIsDispatchOpen(false)}
              disabled={dispatching}
            >
              {t('chatV2:workspace.dispatch.cancel')}
            </NotionButton>
            <NotionButton
              variant="primary"
              size="sm"
              onClick={handleDispatch}
              disabled={dispatching || !isOnline}
            >
              {dispatching ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Send className="w-3 h-3 mr-1" />
              )}
              {t('chatV2:workspace.dispatch.send')}
            </NotionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AgentOutputDrawer;
