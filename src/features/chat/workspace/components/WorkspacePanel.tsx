/**
 * @deprecated 2026-07（分区 M 评估）：全仓无生产挂载点的工作区面板视图。
 *
 * 现状：
 * - 工作区数据层（workspaceStore / events / useWorkspaceRestore）在 ChatContainer 中正常运转；
 * - 主聊天页的工作区「前端视图」由 `AgentTaskPanel`（贴在输入栏上方的内联条）承担；
 * - 本组件仅被 `components/index.ts` re-export，没有任何页面/布局引用。
 *
 * 决策：本轮不接线进页面骨架，避免与 AgentTaskPanel 形成两套并行的工作区视图。
 * 若后续要恢复独立工作区视图，建议挂到 ChatV2Page 桌面次级面板
 * （DesktopSecondaryPanelMode）作为新模式，并与 AgentTaskPanel 收敛为一套入口。
 * 在此之前请勿在新代码中引用本组件。
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { Plus, CircleNotch, WarningCircle, ArrowClockwise, WifiSlash } from '@phosphor-icons/react';
import { AgentCard } from './AgentCard';
import { AgentOutputDrawer } from './AgentOutputDrawer';
import { WorkspaceTimeline } from './WorkspaceTimeline';
import { CreateAgentCard } from './CreateAgentCard';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '../workspaceStore';
import { refreshWorkspaceSnapshot } from '../api';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useEventRegistry } from '@/hooks/useEventRegistry';

interface WorkspacePanelProps {
  currentAgentId?: string;
  /** 🆕 2026-01-20: 点击 Agent 查看输出的回调 */
  onViewAgentSession?: (agentSessionId: string) => void;
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ 
  currentAgentId,
  onViewAgentSession,
}) => {
  const { t } = useTranslation('chatV2');
  const { workspace, agents, messages, isLoading, error } = useWorkspaceStore(
    useShallow((state) => ({
      workspace: state.workspace,
      agents: state.agents,
      messages: state.messages,
      isLoading: state.isLoading,
      error: state.error,
    }))
  );
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  // 🆕 2026-01-20: 展开的 Worker ID（用于内联预览）
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // 🆕 2026-01-20: 处理 Agent 卡片点击（跳转到会话）
  const handleAgentClick = useCallback((sessionId: string) => {
    if (onViewAgentSession) {
      onViewAgentSession(sessionId);
    }
  }, [onViewAgentSession]);

  // 🆕 2026-01-20: 切换 Worker 内联预览
  const handleToggleWorkerPreview = useCallback((sessionId: string) => {
    setExpandedWorkerId(prev => prev === sessionId ? null : sessionId);
  }, []);

  const handleRefresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!workspace?.id) {
      useWorkspaceStore.getState().setError(null);
      useWorkspaceStore.getState().setLoading(false);
      return;
    }
    if (!currentAgentId) {
      useWorkspaceStore.getState().setError(t('chatV2:workspace.missingSession', '缺少当前会话，无法同步工作区'));
      return;
    }
    setIsRefreshing(true);
    try {
      await refreshWorkspaceSnapshot(currentAgentId, workspace.id);
      useWorkspaceStore.getState().setError(null);
      if (!opts?.silent) {
        showGlobalNotification(
          'success',
          t('chatV2:workspace.refreshSuccess', '工作区已同步')
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      useWorkspaceStore.getState().setError(msg);
      if (!opts?.silent) {
        // refreshFailed 文案不含 {{message}} 插值，错误详情作为通知正文传递
        showGlobalNotification(
          'error',
          msg,
          t('chatV2:workspace.refreshFailed', '刷新失败')
        );
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [workspace?.id, currentAgentId, t]);

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsOnline(navigator.onLine);
    }
  }, []);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    showGlobalNotification('info', t('chatV2:workspace.online'));
    void handleRefresh({ silent: true });
  }, [handleRefresh, t]);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    showGlobalNotification('warning', t('chatV2:workspace.offline'));
  }, [t]);

  useEventRegistry(
    [
      { target: 'window', type: 'online', listener: handleOnline },
      { target: 'window', type: 'offline', listener: handleOffline },
    ],
    [handleOnline, handleOffline]
  );

  // 🔧 P21 修复：按 workspaceId 过滤 agents / messages
  // （hooks 必须在 loading/error/empty 的 early return 之前）
  const filteredAgents = useMemo(() => {
    if (!workspace?.id) return [];
    return agents.filter((a) => a.workspaceId === workspace.id);
  }, [agents, workspace?.id]);

  const filteredMessages = useMemo(() => {
    if (!workspace?.id) return [];
    return messages.filter((m) => m.workspaceId === workspace.id);
  }, [messages, workspace?.id]);

  // 🔧 修复：显示 loading 状态
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <CircleNotch size={24} className="text-primary animate-spin" />
        <span className="text-sm text-muted-foreground">
          {t('chatV2:workspace.loading', '正在恢复工作区...')}
        </span>
      </div>
    );
  }

  // 🔧 修复：显示 error 状态（含重试按钮）
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
        <WarningCircle size={24} className="text-destructive" />
        <span className="text-sm text-destructive text-center">
          {t('chatV2:workspace.restoreError', '工作区恢复失败')}
        </span>
        <p className="text-xs text-muted-foreground text-center max-w-[200px]">
          {error}
        </p>
        <NotionButton
          variant="outline"
          size="sm"
          onClick={() => handleRefresh()}
          className="mt-2"
        >
          <ArrowClockwise size={12} className="mr-1" />
          {t('chatV2:workspace.retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('chatV2:workspace.noActive', '无活跃工作区')}
      </div>
    );
  }

  // 🆕 2026-01-20: 分离 Coordinator 和 Worker
  const coordinatorAgents = filteredAgents.filter(a => a.role === 'coordinator');
  const workerAgents = filteredAgents.filter(a => a.role === 'worker');

  // 🆕 Worker 聚合进度：completed/failed/cancelled 计入已结束
  const workerTotal = workerAgents.length;
  const workerRunning = workerAgents.filter((a) => a.status === 'running').length;
  const workerFailed = workerAgents.filter((a) => a.status === 'failed').length;
  const workerCancelled = workerAgents.filter((a) => a.status === 'cancelled').length;
  const workerFinished =
    workerAgents.filter((a) => a.status === 'completed').length + workerFailed + workerCancelled;
  const workerSummarySegments: string[] = [];
  if (workerTotal > 0) {
    workerSummarySegments.push(
      t('chatV2:workspace.summary.finished', {
        done: workerFinished,
        total: workerTotal,
        defaultValue: '{{done}}/{{total}} 已完成',
      })
    );
    // 全部结束时不显示运行中段
    if (workerRunning > 0) {
      workerSummarySegments.push(
        t('chatV2:workspace.summary.running', {
          count: workerRunning,
          defaultValue: '{{count}} 运行中',
        })
      );
    }
    if (workerFailed > 0) {
      workerSummarySegments.push(
        t('chatV2:workspace.summary.failed', {
          count: workerFailed,
          defaultValue: '{{count}} 失败',
        })
      );
    }
    if (workerCancelled > 0) {
      workerSummarySegments.push(
        t('chatV2:workspace.summary.cancelled', {
          count: workerCancelled,
          defaultValue: '{{count}} 已取消',
        })
      );
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-medium text-sm">
              {t('chatV2:workspace.title', '工作区')}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              {workspace.name || workspace.id.slice(-12)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!isOnline && (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <WifiSlash size={12} />
                {t('chatV2:workspace.offlineTag', '离线')}
              </span>
            )}
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => handleRefresh()}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <CircleNotch size={12} className="mr-1 animate-spin" />
              ) : (
                <ArrowClockwise size={12} className="mr-1" />
              )}
              {t('chatV2:workspace.refresh', '同步')}
            </NotionButton>
          </div>
        </div>
        {/* 🆕 Worker 聚合状态行 */}
        {workerSummarySegments.length > 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {workerSummarySegments.join(' · ')}
          </p>
        )}
      </div>

      {/* Coordinator 区域 */}
      {coordinatorAgents.length > 0 && (
        <div className="p-3 border-b">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">
            {t('chatV2:workspace.coordinator', '协调者')}
          </h4>
          <div className="flex flex-col gap-1">
            {coordinatorAgents.map((agent) => (
              <AgentCard
                key={agent.sessionId}
                sessionId={agent.sessionId}
                role={agent.role}
                status={agent.status}
                skillId={agent.skillId}
                isCurrentAgent={agent.sessionId === currentAgentId}
              />
            ))}
          </div>
        </div>
      )}

      {/* 🆕 Worker 区域 - 可展开查看内联预览 */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chatV2:workspace.workers', 'Worker')} ({workerAgents.length})
          </h4>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            aria-expanded={showCreateAgent}
            onClick={() => setShowCreateAgent((prev) => !prev)}
          >
            <Plus
              size={12}
              className={cn(
                'mr-1 transition-transform duration-150',
                showCreateAgent && 'rotate-45'
              )}
            />
            {t('chatV2:workspace.addAgent', '添加')}
          </NotionButton>
        </div>
        {/* 内联展开的创建 Worker 卡片（原 CreateAgentDialog 模态框） */}
        {showCreateAgent && (
          <CreateAgentCard
            className="mb-2"
            workspaceId={workspace.id}
            currentSessionId={currentAgentId}
            onClose={() => setShowCreateAgent(false)}
          />
        )}
        <CustomScrollArea className="max-h-[400px]">
          <div className="flex flex-col gap-2">
            {workerAgents.map((agent) => (
              <AgentOutputDrawer
                key={agent.sessionId}
                workspaceId={workspace.id}
                agentSessionId={agent.sessionId}
                status={agent.status}
                skillId={agent.skillId}
                isExpanded={expandedWorkerId === agent.sessionId}
                onToggle={() => handleToggleWorkerPreview(agent.sessionId)}
                onViewFullSession={onViewAgentSession ? () => handleAgentClick(agent.sessionId) : undefined}
                currentSessionId={currentAgentId}
                isOnline={isOnline}
              />
            ))}
            {workerAgents.length === 0 && !showCreateAgent && (
              <div className="rounded-[var(--chat-radius-sm,8px)] border border-dashed border-border/70 px-3 py-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {t('chatV2:workspace.noWorkers', '暂无 Worker')}
                </p>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 h-6 px-2 text-xs text-primary"
                  onClick={() => setShowCreateAgent(true)}
                >
                  <Plus size={12} className="mr-1" />
                  {t('chatV2:workspace.addAgent', '添加')}
                </NotionButton>
              </div>
            )}
          </div>
        </CustomScrollArea>
      </div>

      {/* 消息时间线（flex 布局：标题固定，列表占据剩余高度内滚动，避免 h-full 溢出容器） */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="p-3 pb-1 shrink-0">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chatV2:workspace.messages', '消息')} ({filteredMessages.length})
          </h4>
        </div>
        <div className="flex-1 min-h-0">
          <WorkspaceTimeline 
            messages={filteredMessages} 
            agents={filteredAgents}
            currentAgentId={currentAgentId} 
            onViewFullSession={onViewAgentSession}
          />
        </div>
      </div>

    </div>
  );
};
