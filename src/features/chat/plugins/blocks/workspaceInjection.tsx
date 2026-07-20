/**
 * Chat V2 - 工作区消息注入块渲染插件
 *
 * 🆕 C11 注入可见化：主代理中途给运行中的子代理发消息时，
 * 后端在子代理会话的当前 assistant 消息上持久化本块。
 * 本块出现在子代理会话里（经 subagent_embed 的 ChatContainer 嵌入渲染），
 * 样式保持低调（muted 边框/背景），不喧宾夺主。
 *
 * 数据契约：
 * - content：注入的格式化文本（"[工作区消息]\n来自 X: [type] 内容…"）
 * - toolOutput：{ workspace_id, message_count, senders, message_types, injected_at }
 *
 * 自执行注册：import 即注册
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, EnvelopeSimple } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { useWorkspaceStore, isWorkerSessionId } from '../../workspace/workspaceStore';
import type { MessageType } from '../../workspace/types';

// ============================================================================
// 消息类型语义色 chip（语义 token，与 WorkspaceMessageItem.typeColors /
// WorkspaceLogInline 同一语义映射，暗色模式自动跟随主题；
// workspaceStatus 的硬编码调色板是遗留写法，新代码不沿用）
// ============================================================================

const messageTypeClassNames: Record<MessageType, string> = {
  task: 'bg-info/10 text-info',
  progress: 'bg-warning/10 text-warning',
  result: 'bg-success/10 text-success',
  query: 'bg-primary/10 text-primary',
  correction: 'bg-destructive/10 text-destructive',
  broadcast: 'bg-muted text-muted-foreground',
};

/** 语义色消息类型徽标；未知类型回退中性 chip（workspaceSend 复用） */
export const WorkspaceMessageTypeChip: React.FC<{ type: string }> = ({ type }) => {
  const { t } = useTranslation('workspace');
  const colorClass =
    messageTypeClassNames[type as MessageType]
    ?? 'border border-border/60 text-muted-foreground';
  return (
    <span className={cn('px-1.5 py-0.5 text-2xs font-medium rounded flex-shrink-0', colorClass)}>
      {t(`messageType.${type}`, { defaultValue: type })}
    </span>
  );
};

// ============================================================================
// 类型定义
// ============================================================================

/** C11：workspace_injection 块的 toolOutput（snake_case） */
interface WorkspaceInjectionOutput {
  workspace_id?: string;
  message_count?: number;
  senders?: string[];
  message_types?: string[];
  injected_at?: string;
}

/** 折叠阈值：正文超过 6 行时默认收起 */
const COLLAPSE_LINE_THRESHOLD = 6;

// ============================================================================
// 工作区消息注入块组件
// ============================================================================

const WorkspaceInjectionBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('workspace');
  const [isExpanded, setIsExpanded] = useState(false);

  const output = (block.toolOutput ?? undefined) as WorkspaceInjectionOutput | undefined;
  const rawSenders = output?.senders;
  const rawMessageTypes = output?.message_types;
  const senders = useMemo(
    () =>
      Array.isArray(rawSenders)
        ? rawSenders.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [],
    [rawSenders]
  );
  const messageTypes = useMemo(
    () =>
      Array.from(
        new Set(
          Array.isArray(rawMessageTypes)
            ? rawMessageTypes.filter(
                (mt): mt is string => typeof mt === 'string' && mt.length > 0
              )
            : []
        )
      ),
    [rawMessageTypes]
  );

  // 标题判定：senders 全部是 coordinator（或非 worker 会话）→ "来自主代理的消息"，
  // 含非 coordinator 发送者 → 通用 "来自工作区的消息"。
  // 流式期间 toolOutput 尚未落地（senders 为空）时按最常见情况显示主代理标题。
  const storeAgents = useWorkspaceStore((s) => s.agents);
  const isFromCoordinatorOnly = useMemo(() => {
    if (senders.length === 0) return true;
    return senders.every((sender) => {
      const agent = storeAgents.find((a) => a.sessionId === sender);
      if (agent) return agent.role === 'coordinator';
      return !isWorkerSessionId(sender);
    });
  }, [senders, storeAgents]);

  const content = block.content ?? '';
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const isCollapsible = lineCount > COLLAPSE_LINE_THRESHOLD;

  const injectedAt = output?.injected_at;

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 my-1">
      {/* 头部：图标 + 标题 + 消息类型徽标 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <EnvelopeSimple size={14} className="text-muted-foreground flex-shrink-0" />
        <span className="text-xs font-medium text-muted-foreground">
          {isFromCoordinatorOnly
            ? t('workspaceInjection.titleFromCoordinator')
            : t('workspaceInjection.titleFromWorkspace')}
        </span>
        {messageTypes.map((mt) => (
          <WorkspaceMessageTypeChip key={mt} type={mt} />
        ))}
        {block.status === 'running' && (
          <CircleNotch size={12} className="text-muted-foreground animate-spin flex-shrink-0" />
        )}
        {injectedAt && (
          <span className="ml-auto text-2xs text-muted-foreground/70 flex-shrink-0">
            {new Date(injectedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* 正文：超 6 行折叠可展开 */}
      {content && (
        <div
          className={cn(
            'mt-1.5 text-xs text-foreground/80 whitespace-pre-wrap break-words',
            isCollapsible && !isExpanded && 'line-clamp-6'
          )}
        >
          {content}
        </div>
      )}

      {isCollapsible && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-2xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer relative after:absolute after:-inset-2 after:content-['']"
        >
          {isExpanded ? t('workspaceInjection.collapse') : t('workspaceInjection.expand')}
        </button>
      )}

      {/* 错误态：保留已注入内容，仅附一行错误说明 */}
      {block.status === 'error' && block.error && (
        <div className="mt-1 text-2xs text-destructive break-words">
          {block.error}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('workspace_injection', {
  type: 'workspace_injection',
  component: WorkspaceInjectionBlockComponent,
  // 中断保留已注入内容（与 subagent_embed / subagent_retry 一致）
  onAbort: 'keep-content',
});

export { WorkspaceInjectionBlockComponent };
export default WorkspaceInjectionBlockComponent;
