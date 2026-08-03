/**
 * Chat V2 - 工作区状态块渲染插件
 *
 * 显示多 Agent 协作工作区的实时状态：
 * - 工作区基本信息
 * - Agent 列表及状态
 * - 最近消息摘要
 * - 整体进度
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  Buildings,
  User,
  Robot,
  CaretDown,
  CaretUp,
  Chat,
  CheckCircle,
  Circle,
  CircleNotch,
  XCircle,
  Clock,
  Warning,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { useDisclosureMotion } from '../../hooks/useDisclosureMotion';
import { useWorkspaceStore } from '../../workspace/workspaceStore';
import { WorkspaceLogInline } from '../../workspace/components/WorkspaceLogInline';
import type {
  WorkspaceAgent,
  WorkspaceMessage,
  AgentStatus,
  MessageType,
} from '../../workspace/types';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取技能的本地化名称
 */
function getLocalizedSkillName(skillId: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  const translatedName = t(`skills:builtinNames.${skillId}`, { defaultValue: '' });
  return translatedName || skillId;
}

/**
 * 🆕 从 agent.metadata 安全读取后端 register_agent 持久化的 profile id
 * （metadata.agent_profile.id）。当前前端 agent 转换尚未回传该字段，
 * 读不到时由调用方回退 skillId。
 */
function readAgentProfileId(metadata: Record<string, unknown> | undefined): string | undefined {
  const profile = metadata?.agent_profile;
  if (profile !== null && typeof profile === 'object' && !Array.isArray(profile)) {
    const id = (profile as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

// ============================================================================
// 类型定义
// ============================================================================

/** 工作区状态块的工具输入数据 */
export interface WorkspaceStatusInput {
  workspaceId: string;
  workspaceName?: string;
}

/** 工作区状态块的工具输出数据 */
export interface WorkspaceStatusOutput {
  workspace_id: string;
  status: string;
  message?: string;
  // 🆕 历史快照数据（用于数据库加载时渲染）
  snapshotAgents?: Array<{
    session_id: string;
    role: string;
    status: string;
    skill_id?: string | null;
  }>;
  snapshotName?: string;
  snapshotCreatedAt?: string;
}

// ============================================================================
// Agent 状态图标组件
// ============================================================================

interface AgentStatusIconProps {
  status: AgentStatus;
}

const AgentStatusIcon: React.FC<AgentStatusIconProps> = ({ status }) => {
  switch (status) {
    case 'running':
      return <CircleNotch size={14} className="text-primary animate-spin" />;
    case 'completed':
      return <CheckCircle size={14} className="text-success" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-destructive" />;
    default: // idle
      return <Circle className="w-3.5 h-3.5 text-muted-foreground" />;
  }
};

// ============================================================================
// 消息类型标签组件
// ============================================================================

interface MessageTypeBadgeProps {
  type: MessageType;
}

const messageTypeClassNames: Record<MessageType, string> = {
  task: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  progress: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300',
  result: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  query: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
  correction: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  broadcast: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const MessageTypeBadge: React.FC<MessageTypeBadgeProps> = ({ type }) => {
  const { t } = useTranslation('chatV2');
  const className = messageTypeClassNames[type];
  return (
    <span className={cn('px-1.5 py-0.5 text-2xs font-medium rounded', className)}>
      {t(`workspace.messageType.${type}`)}
    </span>
  );
};

// ============================================================================
// Agent 列表项组件
// ============================================================================

interface AgentItemProps {
  agent: WorkspaceAgent;
  isCurrentUser: boolean;
}

const AgentItem: React.FC<AgentItemProps> = ({ agent, isCurrentUser }) => {
  const { t } = useTranslation(['chatV2', 'skills', 'workspace']);
  const shortId = agent.sessionId.slice(-8);
  const skillName = agent.skillId 
    ? getLocalizedSkillName(agent.skillId, t) 
    : (agent.role === 'coordinator' ? '-' : t('chatV2:workspace.agent.worker'));
  // 🆕 skill/profile 小标签：优先持久化的 profile id，回退 skillId，两者都无则不显示
  const profileTag = readAgentProfileId(agent.metadata) ?? agent.skillId;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-md',
        isCurrentUser && 'bg-primary/5'
      )}
    >
      {agent.role === 'coordinator' ? (
        <User className="w-4 h-4 text-primary" />
      ) : (
        <Robot size={16} className="text-muted-foreground" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">
            {agent.role === 'coordinator' 
              ? t('workspace.agent.coordinator')
              : skillName}
          </span>
          {/* 🆕 skill/profile 小标签（紧凑 chip） */}
          {profileTag && (
            <span className="px-1 py-px rounded border border-border/60 text-2xs text-muted-foreground flex-shrink-0 max-w-[96px] truncate">
              {profileTag}
            </span>
          )}
          {/* 🆕 C12: inbox 待消费计数小徽标（琥珀色，>0 时显示） */}
          {typeof agent.pendingInboxCount === 'number' && agent.pendingInboxCount > 0 && (
            <span
              className="px-1 py-px rounded border border-warning/40 bg-warning/10 text-2xs text-warning flex-shrink-0"
              title={t('workspace:subagentEmbed.pendingInboxHint')}
            >
              {t('workspace:subagentEmbed.pendingInbox', { count: String(agent.pendingInboxCount) })}
            </span>
          )}
          {isCurrentUser && (
            <span className="text-2xs text-muted-foreground">
              ({t('workspace.agent.you')})
            </span>
          )}
        </div>
        <div className="text-2xs text-muted-foreground truncate">
          ID: {shortId}
        </div>
      </div>
      <AgentStatusIcon status={agent.status} />
    </div>
  );
};

// ============================================================================
// 消息列表项组件
// ============================================================================

interface MessageItemProps {
  message: WorkspaceMessage;
}

const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const { i18n } = useTranslation('chatV2');
  const shortSenderId = message.senderSessionId.slice(-6);
  const shortTargetId = message.targetSessionId?.slice(-6);
  const time = new Date(message.createdAt).toLocaleTimeString(
    i18n.resolvedLanguage ?? i18n.language,
    {
    hour: '2-digit',
    minute: '2-digit',
    },
  );

  // 截断消息内容
  const truncatedContent = message.content.length > 50
    ? message.content.slice(0, 50) + '...'
    : message.content;

  return (
    <div className="flex flex-col gap-0.5 py-1 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-muted-foreground">{time}</span>
        <MessageTypeBadge type={message.messageType} />
        <span className="text-2xs text-muted-foreground">
          {shortSenderId}
          {shortTargetId && ` → ${shortTargetId}`}
        </span>
      </div>
      <div className="text-xs text-foreground/80 pl-1 truncate">
        {truncatedContent}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

const WorkspaceStatusBlockComponent: React.FC<BlockComponentProps> = React.memo(({
  block,
  store,
}) => {
  const status = block.status;
  const { t, i18n } = useTranslation('chatV2');
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [isExpanded, setIsExpanded] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const disclosureMotion = useDisclosureMotion();
  const prefersReduced = useReducedMotion();

  // 从 Store 获取工作区数据
  const { workspace, agents: storeAgents, messages, currentWorkspaceId } = useWorkspaceStore(
    useShallow((state) => ({
      workspace: state.workspace,
      agents: state.agents,
      messages: state.messages,
      currentWorkspaceId: state.currentWorkspaceId,
    }))
  );

  // 从块数据中获取快照（历史模式）
  const blockOutput = block.toolOutput as unknown as WorkspaceStatusOutput | undefined;
  const snapshotAgents = blockOutput?.snapshotAgents;
  const snapshotName = blockOutput?.snapshotName;
  const snapshotCreatedAt = blockOutput?.snapshotCreatedAt;

  // 判断是否为历史模式（store 中没有对应的工作区数据）
  const isHistoricalMode = !workspace && !!blockOutput?.workspace_id;

  // 从块数据中获取工作区 ID（块自身记录的 workspaceId）
  const blockWorkspaceId = useMemo(() => {
    const input = block.toolInput as unknown as WorkspaceStatusInput | undefined;
    const output = block.toolOutput as unknown as WorkspaceStatusOutput | undefined;
    return input?.workspaceId || output?.workspace_id;
  }, [block.toolInput, block.toolOutput]);

  // 🔧 修复：检查 workspaceId 隔离
  // 如果块记录的 workspaceId 与当前活跃的 workspaceId 不一致，显示提示
  const isWorkspaceMismatch = blockWorkspaceId && currentWorkspaceId && blockWorkspaceId !== currentWorkspaceId;

  // 最终使用的 workspaceId
  const workspaceId = blockWorkspaceId || currentWorkspaceId;

  // 合并 agents 数据：优先使用 store 数据，其次使用快照
  // 🔧 P21 修复：按 workspaceId 过滤
  const agents: WorkspaceAgent[] = useMemo(() => {
    // 优先使用 store 数据（按 workspaceId 过滤）
    const filteredStoreAgents = workspaceId 
      ? storeAgents.filter(a => a.workspaceId === workspaceId)
      : [];
    if (filteredStoreAgents.length > 0) return filteredStoreAgents;
    // 其次使用快照
    if (snapshotAgents) {
      return snapshotAgents.map(a => ({
        sessionId: a.session_id,
        workspaceId: blockWorkspaceId || '',
        role: a.role as WorkspaceAgent['role'],
        skillId: a.skill_id ?? undefined,
        status: a.status as WorkspaceAgent['status'],
        joinedAt: snapshotCreatedAt || '',
        lastActiveAt: snapshotCreatedAt || '',
      }));
    }
    return [];
  }, [storeAgents, snapshotAgents, blockWorkspaceId, snapshotCreatedAt, workspaceId]);

  // 计算进度
  const progress = useMemo(() => {
    if (agents.length === 0) return { completed: 0, total: 0, percent: 0 };
    const completed = agents.filter(a => a.status === 'completed').length;
    const total = agents.length;
    const percent = Math.round((completed / total) * 100);
    return { completed, total, percent };
  }, [agents]);

  // 最近消息（最多显示 5 条）
  // 🔧 P21 修复：按 workspaceId 过滤
  const recentMessages = useMemo(() => {
    return messages
      .filter(m => workspaceId ? m.workspaceId === workspaceId : true)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5);
  }, [messages, workspaceId]);

  // 当前用户的 session ID（Coordinator）
  const currentSessionId = workspace?.creatorSessionId;

  // 工作区名称
  const workspaceName = useMemo(() => {
    const input = block.toolInput as unknown as WorkspaceStatusInput | undefined;
    if (isWorkspaceMismatch) {
      return input?.workspaceName || snapshotName || t('workspace.defaultName');
    }
    // 历史模式优先使用快照名称
    if (isHistoricalMode) {
      return snapshotName || input?.workspaceName || t('workspace.defaultName');
    }
    return input?.workspaceName || workspace?.name || t('workspace.defaultName');
  }, [block.toolInput, isWorkspaceMismatch, isHistoricalMode, snapshotName, workspace?.name, t]);

  // 如果没有工作区数据，显示简化状态
  if (!workspaceId && status !== 'running') {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border/50">
        <Buildings size={16} className="text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          {t('workspace.status.noWorkspace')}
        </span>
      </div>
    );
  }

  // 🆕 历史模式：显示历史快照提示
  if (isHistoricalMode) {
    return (
      <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
        <div className="flex items-center gap-2 p-3 bg-info/10 border-b border-info/30">
          <Clock size={16} className="text-info" />
          <span className="text-sm text-info">
            {t('workspace.status.historicalWorkspace')}
          </span>
        </div>
        <div className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Buildings size={16} className="text-primary" />
            <span className="text-sm font-medium">{workspaceName}</span>
          </div>
          {/* Agent 列表 */}
          {agents.length > 0 && (
            <div className="mt-2">
              <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                {t('workspace.status.agentsCount', { count: agents.length })}
              </div>
              <div className="space-y-0.5">
                {agents.map((agent) => (
                  <AgentItem
                    key={agent.sessionId}
                    agent={agent}
                    isCurrentUser={false}
                  />
                ))}
              </div>
            </div>
          )}
          {snapshotCreatedAt && (
            <div className="flex items-center gap-1 mt-2 text-2xs text-muted-foreground">
              <Clock size={12} />
              <span>
                {t('workspace.status.createdAt')}: {new Date(snapshotCreatedAt).toLocaleString(locale)}
              </span>
            </div>
          )}
          <p className="text-2xs text-muted-foreground mt-2">
            ID: {blockWorkspaceId?.slice(-12)}
          </p>
        </div>
      </div>
    );
  }

  // 🔧 修复：如果工作区不匹配，显示历史快照提示
  if (isWorkspaceMismatch) {
    return (
      <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
        <div className="flex items-center gap-2 p-3 bg-warning/10 border-b border-warning/30">
          <Warning size={16} className="text-warning" />
          <span className="text-sm text-warning">
            {t('workspace.status.workspaceSwitched')}
          </span>
        </div>
        <div className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Buildings size={16} className="text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">{workspaceName}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('workspace.status.historicalSnapshot')}
          </p>
          <p className="text-2xs text-muted-foreground mt-1">
            ID: {blockWorkspaceId?.slice(-12)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
      {/* 头部 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Buildings size={16} className="text-primary" />
          <span className="text-sm font-medium">{workspaceName}</span>
          {status === 'running' && (
            <CircleNotch size={14} className="text-info animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 进度指示 */}
          {agents.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {progress.completed}/{progress.total} {t('workspace.status.agentsDone')}
            </span>
          )}
          {isExpanded ? (
            <CaretUp size={16} className="text-muted-foreground" />
          ) : (
            <CaretDown size={16} className="text-muted-foreground" />
          )}
        </div>
      </div>

      {/* 进度条 */}
      {agents.length > 0 && (
        <div className="px-3 pb-2">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-primary rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress.percent}%` }}
              transition={{ duration: prefersReduced ? 0 : 0.3 }}
            />
          </div>
        </div>
      )}

      {/* 展开内容 */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div {...disclosureMotion}>
            {/* Agent 列表 */}
            <div className="px-3 pb-2">
              <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                {t('workspace.status.agentsCount', { count: agents.length })}
              </div>
              <div className="space-y-0.5">
                {agents.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-2 text-center">
                    {t('workspace.status.noAgents')}
                  </div>
                ) : (
                  agents.map((agent) => (
                    <AgentItem
                      key={agent.sessionId}
                      agent={agent}
                      isCurrentUser={agent.sessionId === currentSessionId}
                    />
                  ))
                )}
              </div>
            </div>

            {/* 最近消息（可折叠） */}
            {recentMessages.length > 0 && (
              <div className="border-t border-border/50">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={showMessages}
                  className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMessages(!showMessages);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowMessages(!showMessages);
                    }
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <Chat size={14} className="text-muted-foreground" />
                    <span className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">
                      {t('workspace.status.recentMessagesCount', {
                        count: recentMessages.length,
                      })}
                    </span>
                  </div>
                  {showMessages ? (
                    <CaretUp size={14} className="text-muted-foreground" />
                  ) : (
                    <CaretDown size={14} className="text-muted-foreground" />
                  )}
                </div>

                <AnimatePresence>
                  {showMessages && (
                    <motion.div
                      {...disclosureMotion}
                      className="px-3 pb-2"
                    >
                      {recentMessages.map((msg) => (
                        <MessageItem key={msg.id} message={msg} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* 时间戳 */}
            {workspace?.createdAt && (
              <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border/50 text-2xs text-muted-foreground">
                <Clock size={12} />
                <span>
                  {t('workspace.status.createdAt')}: {new Date(workspace.createdAt).toLocaleString(locale)}
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 🆕 2026-01-21: 工作区日志内联组件 - 附着在消息底部 */}
      <WorkspaceLogInline className="mx-0" defaultExpanded={false} store={store} />
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('workspace_status', {
  type: 'workspace_status',
  component: WorkspaceStatusBlockComponent,
  onAbort: 'mark-error',
});

export { WorkspaceStatusBlockComponent };
