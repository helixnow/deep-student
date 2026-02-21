import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Plus, Loader2, AlertCircle, RefreshCw, WifiOff } from 'lucide-react';
import { AgentCard } from './AgentCard';
import { AgentOutputDrawer } from './AgentOutputDrawer';
import { WorkspaceTimeline } from './WorkspaceTimeline';
import { CreateAgentDialog } from './CreateAgentDialog';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '../workspaceStore';
import { refreshWorkspaceSnapshot } from '../api';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface WorkspacePanelProps {
  currentAgentId?: string;
  /** 🆕 2026-01-20: 点击 Agent 查看输出的回调 */
  onViewAgentSession?: (agentSessionId: string) => void;
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ 
  currentAgentId,
  onViewAgentSession,
}) => {
  const { t } = useTranslation();
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
        showGlobalNotification(
          'error',
          t('chatV2:workspace.refreshFailed', { defaultValue: `工作区同步失败: ${msg}` })
        );
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [workspace?.id, currentAgentId, t]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setIsOnline(navigator.onLine);
    const handleOnline = () => {
      setIsOnline(true);
      showGlobalNotification('info', t('chatV2:workspace.online', '网络已恢复，正在同步工作区...'));
      void handleRefresh({ silent: true });
    };
    const handleOffline = () => {
      setIsOnline(false);
      showGlobalNotification('warning', t('chatV2:workspace.offline', '网络已断开，部分操作不可用'));
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleRefresh, t]);

  // 🔧 修复：显示 loading 状态
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
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
        <AlertCircle className="w-6 h-6 text-destructive" />
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
          <RefreshCw className="w-3 h-3 mr-1" />
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

  // 🔧 P21 修复：按 workspaceId 过滤 agents
  const filteredAgents = useMemo(() => {
    if (!workspace?.id) return [];
    return agents.filter((a) => a.workspaceId === workspace.id);
  }, [agents, workspace?.id]);

  // 🔧 P21 修复：按 workspaceId 过滤 messages
  const filteredMessages = useMemo(() => {
    if (!workspace?.id) return [];
    return messages.filter((m) => m.workspaceId === workspace.id);
  }, [messages, workspace?.id]);

  // 🆕 2026-01-20: 分离 Coordinator 和 Worker
  const coordinatorAgents = filteredAgents.filter(a => a.role === 'coordinator');
  const workerAgents = filteredAgents.filter(a => a.role === 'worker');

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
              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                <WifiOff className="w-3 h-3" />
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
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3 mr-1" />
              )}
              {t('chatV2:workspace.refresh', '同步')}
            </NotionButton>
          </div>
        </div>
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
            onClick={() => setShowCreateAgent(true)}
          >
            <Plus className="w-3 h-3 mr-1" />
            {t('chatV2:workspace.addAgent', '添加')}
          </NotionButton>
        </div>
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
            {workerAgents.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {t('chatV2:workspace.noWorkers', '暂无 Worker')}
              </p>
            )}
          </div>
        </CustomScrollArea>
      </div>

      {/* 消息时间线 */}
      <div className="flex-1 min-h-0">
        <div className="p-3 pb-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chatV2:workspace.messages', '消息')} ({filteredMessages.length})
          </h4>
        </div>
        <WorkspaceTimeline 
          messages={filteredMessages} 
          agents={filteredAgents}
          currentAgentId={currentAgentId} 
          onViewFullSession={onViewAgentSession}
        />
      </div>

      <CreateAgentDialog
        open={showCreateAgent}
        onOpenChange={setShowCreateAgent}
        workspaceId={workspace.id}
        currentSessionId={currentAgentId}
      />
    </div>
  );
};
