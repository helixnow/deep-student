/**
 * AgentOutputDrawer — Worker Agent 输出预览内联折叠卡片（名称沿用历史，非侧滑抽屉）。
 *
 * 在 WorkspacePanel 中点击 Worker 时，展开显示该 Worker 的对话输出预览：
 * - 会话输出复用 ChatContainer，子代理渲染与主代理完全相同
 * - 派发任务为卡片内的内联展开条（原 DsDialog 模态框已内联化）
 * - 状态色走语义 token（info/success/warning/destructive）
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretRight, ArrowSquareOut, CircleNotch, Robot, ArrowsOut, ArrowsIn, PaperPlaneRight, Timer, WarningCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { UiPresence } from '@/components/ui/UiPresence';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Label } from '@/components/ui/shad/Label';
import type { AgentStatus } from '../types';
import { ChatContainer } from '../../components/ChatContainer';
import { sendMessage, runAgent, cancelAgent } from '../api';
import { isLegacyFrontendWorkerStartEnabled } from '../runtimeMode';
import { useWorkspaceStore } from '../workspaceStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getLocalizedSkillName } from '../utils';
import {
  useAgentTaskInfo,
  truncateTaskTitle,
  formatElapsedDuration,
  useRunningElapsedMs,
} from './AgentCard';

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
  // 派发任务内联展开条（原 DsDialog 内联化）
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);
  const [dispatchContent, setDispatchContent] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const dispatchTextareaRef = useRef<HTMLTextAreaElement>(null);

  // 展开派发条时聚焦输入框（非模态，不做焦点陷阱）
  useEffect(() => {
    if (!isDispatchOpen) return;
    const raf = window.requestAnimationFrame(() => {
      dispatchTextareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isDispatchOpen]);

  const coordinatorSessionId = useWorkspaceStore((state) =>
    state.agents.find((a) => a.workspaceId === workspaceId && a.role === 'coordinator')?.sessionId
  );

  // 🆕 任务摘要 + 耗时指标
  // lastActiveAt 由 updateAgentStatus 在每次状态变更时写入：
  // - running 期间它近似等于"进入 running 的时刻"（store 无 startedAt 字段）
  // - terminal 状态时它近似等于"结束时刻"
  const agentLastActiveAt = useWorkspaceStore(
    (state) => state.agents.find((a) => a.sessionId === agentSessionId)?.lastActiveAt ?? null
  );
  const { taskContent, taskCreatedAt } = useAgentTaskInfo(agentSessionId);
  const taskSummary = taskContent ? truncateTaskTitle(taskContent) : null;

  // 实时耗时：仅 running 时每秒 tick；起点优先取进入 running 的时刻，回退到 task 派发时刻
  const runningStartIso = agentLastActiveAt || taskCreatedAt;
  const runningElapsedMs = useRunningElapsedMs(status === 'running', runningStartIso);

  // 终态耗时：task 派发时刻 → 最后一次状态变更时刻（近似值）
  const isTerminal = status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'interrupted'
    || status === 'closed';
  let finalElapsedMs: number | null = null;
  if (isTerminal && taskCreatedAt && agentLastActiveAt) {
    const delta = new Date(agentLastActiveAt).getTime() - new Date(taskCreatedAt).getTime();
    if (Number.isFinite(delta) && delta > 0) {
      finalElapsedMs = delta;
    }
  }
  const elapsedLabel =
    status === 'running' && runningElapsedMs !== null
      ? formatElapsedDuration(runningElapsedMs)
      : finalElapsedMs !== null
        ? formatElapsedDuration(finalElapsedMs)
        : null;

  // 状态颜色（语义 token，与主题/暗色自动对齐）
  const statusColors: Record<AgentStatus, string> = {
    idle: 'text-muted-foreground',
    queued: 'text-info/80',
    running: 'text-info',
    completed: 'text-success',
    failed: 'text-destructive',
    cancelled: 'text-muted-foreground/70',
    interrupted: 'text-warning',
    closed: 'text-muted-foreground',
  };

  // 状态文本
  const statusText = {
    idle: t('subagent.status.idle'),
    queued: t('subagent.status.queued'),
    running: t('subagent.status.running'),
    completed: t('subagent.status.completed'),
    failed: t('subagent.status.failed'),
    cancelled: t('subagent.status.cancelled'),
    interrupted: t('subagent.status.interrupted'),
    closed: t('subagent.status.closed'),
  }[status];

  const skillName = getLocalizedSkillName(
    skillId,
    t,
    t('chatV2:workspace.agent.worker')
  );

  const handleDispatch = async () => {
    if (dispatching) return;
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
      if (isLegacyFrontendWorkerStartEnabled()) {
        try {
          await runAgent(workspaceId, agentSessionId, undefined, senderSessionId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('active stream')) {
            throw err;
          }
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
      "border rounded-[var(--chat-radius-md,12px)] overflow-hidden bg-card transition-shadow duration-200",
      status === 'running' && "ring-2 ring-primary/25"
    )}>
      {/* 头部（可点击展开/收起；用 div 而非 button，避免内部操作按钮形成非法的 button 嵌套；
          窄屏 flex-wrap 允许操作簇换行，避免被 overflow-hidden 裁切到不可达） */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full flex-wrap items-center justify-between gap-y-1 p-2.5 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
          ) : (
            <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
          )}
          <Robot size={16} className={cn('flex-shrink-0', statusColors[status])} />
          <span
            className="text-sm font-medium truncate"
            title={taskContent ? truncateTaskTitle(taskContent, 300) : undefined}
          >
            {taskSummary || skillName || t('subagent.title')}
          </span>
          {/* 任务摘要占用主标题时，技能名降级为次要标签 */}
          {taskSummary && skillName && (
            <span className="text-xs text-muted-foreground truncate flex-shrink-0 max-w-[120px]">
              {skillName}
            </span>
          )}
          {status === 'running' && (
            <CircleNotch size={12} className="animate-spin text-info" />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {/* 耗时指标：running 时实时计时，终态显示最终耗时（近似值） */}
          {elapsedLabel && (
            <span
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
              title={
                status === 'running'
                  ? t('chatV2:workspace.elapsed.runningHint')
                  : t('chatV2:workspace.elapsed.finalHint')
              }
            >
              <Timer size={12} />
              {elapsedLabel}
            </span>
          )}
          <span className={cn('text-xs', statusColors[status])}>{statusText}</span>
          
          {/* 派发任务按钮（切换内联派发条） */}
          <DsButton
            variant="ghost"
            size="sm"
            className={cn('h-8 lg:h-6 px-2 text-xs', isDispatchOpen && 'bg-primary/10 text-primary')}
            aria-expanded={isDispatchOpen}
            onClick={(e) => {
              e.stopPropagation();
              setIsDispatchOpen((prev) => !prev);
            }}
            disabled={!isOnline}
            title={
              !isOnline
                ? t('chatV2:workspace.dispatch.offline')
                : t('chatV2:workspace.dispatch.title')
            }
          >
            <PaperPlaneRight size={12} className="mr-1" />
            {t('chatV2:workspace.dispatch.title')}
          </DsButton>

          {status === 'running' && (
            <DsButton
              variant="ghost"
              size="sm"
              className="h-8 lg:h-6 px-2 text-xs text-destructive"
              onClick={handleCancel}
            >
              {t('chatV2:workspace.cancel')}
            </DsButton>
          )}

          {/* 高度切换按钮（仅展开时显示） */}
          {isExpanded && (
            <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); setIsFullHeight(!isFullHeight); }} className="!h-8 !w-8 lg:!h-6 lg:!w-6" aria-label={isFullHeight ? t('subagent.collapse') : t('subagent.expand')} title={isFullHeight ? t('subagent.collapse') : t('subagent.expand')}>
              {isFullHeight ? <ArrowsIn size={14} className="text-muted-foreground" /> : <ArrowsOut size={14} className="text-muted-foreground" />}
            </DsButton>
          )}
          
          {/* 查看完整会话按钮 */}
          {onViewFullSession && (
            <DsButton
              variant="ghost"
              size="sm"
              className="h-8 lg:h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onViewFullSession();
              }}
            >
              <ArrowSquareOut size={12} className="mr-1" />
              {t('workspace.viewFull')}
            </DsButton>
          )}
        </div>
      </div>

      {/* 🆕 失败提示行：store 无错误详情字段，显示通用失败文案并引导查看会话输出 */}
      {status === 'failed' && (
        <div className="flex items-start gap-1.5 px-2.5 py-1.5 border-t border-destructive/25 bg-destructive/10">
          <WarningCircle size={13} className="text-destructive flex-shrink-0 mt-px" />
          <span className="text-xs text-destructive">
            {t('chatV2:workspace.failedHint')}
          </span>
        </div>
      )}

      {/* 派发任务内联展开条（原 DsDialog 模态框内联化；关闭时保留已输入内容，仅清除错误提示） */}
      {isDispatchOpen && (
        <div
          className="ui-rise-in border-t border-border/50 bg-muted/30 px-2.5 py-2.5 space-y-2"
          role="group"
          aria-label={t('chatV2:workspace.dispatch.title')}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !dispatching) {
              e.preventDefault();
              e.stopPropagation();
              setIsDispatchOpen(false);
              setDispatchError(null);
            }
          }}
          data-testid="agent-dispatch-inline"
        >
          <div className="flex items-center justify-between gap-2">
            <Label
              htmlFor={`dispatch-task-${agentSessionId}`}
              className="text-xs font-medium"
            >
              {t('chatV2:workspace.dispatch.task')}
            </Label>
            <span className="text-[11px] text-muted-foreground truncate">
              {t('chatV2:workspace.dispatch.target')}:
              <span className="ml-1 text-foreground">{skillName || agentSessionId.slice(-8)}</span>
            </span>
          </div>
          <Textarea
            ref={dispatchTextareaRef}
            id={`dispatch-task-${agentSessionId}`}
            value={dispatchContent}
            onChange={(e) => setDispatchContent(e.target.value)}
            rows={3}
            disabled={dispatching}
            placeholder={t('chatV2:workspace.dispatch.placeholder')}
            className="resize-none text-sm bg-background"
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter 快捷派发
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleDispatch();
              }
            }}
          />
          {dispatchError && (
            <p role="alert" className="text-xs text-destructive">{dispatchError}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                if (dispatching) return;
                setIsDispatchOpen(false);
                setDispatchError(null);
              }}
              disabled={dispatching}
            >
              {t('chatV2:workspace.dispatch.cancel')}
            </DsButton>
            <DsButton
              variant="primary"
              size="sm"
              onClick={handleDispatch}
              disabled={dispatching || !isOnline}
            >
              {dispatching ? (
                <CircleNotch size={12} className="mr-1 animate-spin" />
              ) : (
                <PaperPlaneRight size={12} className="mr-1" />
              )}
              {t('chatV2:workspace.dispatch.send')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 🔧 核心修复：使用 ChatContainer 渲染完整聊天视图（与主代理完全相同） */}
      <UiPresence
        open={isExpanded}
        inClass="ui-fade-in"
        outClass="ui-fade-out"
        exitMs={200}
        className={cn(
          'border-t border-border/50 overflow-hidden transition-[height] duration-200',
          isFullHeight ? 'h-[min(500px,70vh)]' : 'h-[min(280px,45vh)]',
        )}
      >
          <ChatContainer
            key={agentSessionId}
            sessionId={agentSessionId}
            showInputBar={false}
            className="h-full"
          />
      </UiPresence>

      {/* 底部元信息 */}
      <div className="flex items-center gap-2 px-2.5 py-1 border-t border-border/30 bg-muted/20 text-2xs text-muted-foreground">
        <span className="font-mono">{agentSessionId.slice(-12)}</span>
      </div>
    </div>
  );
};

export default AgentOutputDrawer;
