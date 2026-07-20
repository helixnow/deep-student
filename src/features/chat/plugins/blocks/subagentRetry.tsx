/**
 * Chat V2 - 子代理重试块渲染插件
 *
 * 🆕 P38: 显示子代理因未发送消息而被重新触发的状态
 *
 * 自执行注册：import 即注册
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Warning, CheckCircle, XCircle } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { useWorkspaceStore } from '../../workspace/workspaceStore';

// ============================================================================
// 类型定义
// ============================================================================

interface SubagentRetryInput {
  agentSessionId: string;
  /** 兼容旧持久化块：reason 曾被误写入 toolInput，现统一写入 toolOutput */
  reason?: string;
}

interface SubagentRetryOutput {
  message: string;
  timestamp: string;
  /** events.ts 在 AGENT_COMPLETION（completed）时写入 true */
  resolved?: boolean;
  retry_count?: number;
  reason?: string;
  /** events.ts 在 AGENT_COMPLETION（failed/cancelled/interrupted/closed）时写入 */
  final_status?: string;
}

// ============================================================================
// 子代理重试块组件
// ============================================================================

const SubagentRetryBlockComponent: React.FC<BlockComponentProps> = React.memo(({
  block,
}) => {
  const { t, i18n } = useTranslation(['chatV2', 'workspace']);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const input = block.toolInput as unknown as SubagentRetryInput | undefined;
  const output = block.toolOutput as unknown as SubagentRetryOutput | undefined;

  const agentId = input?.agentSessionId || 'unknown';
  const shortAgentId = agentId.slice(-8);
  const message = output?.message || t('chatV2:workspace.subagentRetryDefault');
  // 🔧 P1 修复：reason 现在写入 toolOutput（新块），旧块回退读 toolInput
  const reason = output?.reason ?? input?.reason;
  // max_retries_exceeded 是终局失败，必须渲染红色终态而非琥珀色"重试中"
  const isExhausted = reason === 'max_retries_exceeded';
  // 🆕 渲染自愈：events.ts 的写回登记是内存态（重启/监听器重建后丢失）。
  // 块本身仍是 running 而 workspaceStore 已观察到该 agent 的运行终态时，
  // 直接按 store 终态渲染，避免"永远重试中"的陈旧展示。
  const storeAgentStatus = useWorkspaceStore((state) =>
    state.agents.find((a) => a.sessionId === agentId)?.status
  );
  const selfHealedStatus =
    block.status === 'running' && !output?.final_status && output?.resolved !== true
      ? storeAgentStatus === 'completed'
        ? 'completed'
        : storeAgentStatus === 'failed'
          ? 'failed'
          : storeAgentStatus === 'cancelled'
            ? 'cancelled'
            : undefined
      : undefined;
  // 🆕 events.ts 的 AGENT_COMPLETION 写回的运行终态（自愈态优先级更低，仅兜底）
  const finalStatus = output?.final_status
    ?? (selfHealedStatus && selfHealedStatus !== 'completed' ? selfHealedStatus : undefined);
  const isSelfHealedResolved = selfHealedStatus === 'completed';
  // 取消/中断是"主动终止"，用中性终态而非红色失败
  const isCancelled = !isExhausted
    && (finalStatus === 'cancelled' || finalStatus === 'interrupted');
  const isFailed = !isCancelled
    && (isExhausted || finalStatus === 'failed' || finalStatus === 'closed' || block.status === 'error');
  const isResolved = !isFailed && !isCancelled
    && (output?.resolved === true || block.status === 'success' || isSelfHealedResolved);
  const isRunning = !isFailed && !isCancelled && !isResolved && block.status === 'running';

  return (
    <div
      className={cn(
        'rounded-lg border p-3 my-2',
        'transition-colors duration-200',
        isFailed
          ? 'bg-destructive/5 border-destructive/30'
          : isCancelled
            ? 'bg-muted/30 border-border/50'
            : isResolved
              ? 'bg-success/5 border-success/30'
              : 'bg-warning/5 border-warning/30'
      )}
    >
      <div className="flex items-start gap-3">
        {/* 图标 */}
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            isFailed
              ? 'bg-destructive/10 text-destructive'
              : isCancelled
                ? 'bg-muted/50 text-muted-foreground'
                : isResolved
                  ? 'bg-success/10 text-success'
                  : 'bg-warning/10 text-warning'
          )}
        >
          {isFailed ? (
            <Warning size={16} />
          ) : isCancelled ? (
            <XCircle size={16} />
          ) : isResolved ? (
            <CheckCircle size={16} />
          ) : isRunning ? (
            <ArrowClockwise size={16} className="animate-spin" />
          ) : (
            <Warning size={16} />
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                'text-sm font-medium',
                isFailed
                  ? 'text-destructive'
                  : isCancelled
                    ? 'text-muted-foreground'
                    : isResolved
                      ? 'text-success'
                      : 'text-warning'
              )}
            >
              {isFailed
                ? isExhausted
                  ? t('chatV2:workspace.subagentRetryExhaustedTitle')
                  : t('chatV2:workspace.subagentRetryFailed')
                : isCancelled
                  ? t('workspace:subagentRetry.finalCancelled')
                  : isResolved
                    ? t('chatV2:workspace.subagentRetryResolved')
                    : t('chatV2:workspace.subagentRetryTitle')}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              {shortAgentId}
            </span>
          </div>

          <p className="text-sm text-muted-foreground">
            {message}
          </p>

          {output?.timestamp && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              {new Date(output.timestamp).toLocaleString(locale)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('subagent_retry', {
  type: 'subagent_retry',
  // 🔧 P1 修复：显式声明中断行为，与其它多 Agent 状态块（sleep/subagent_embed）一致
  onAbort: 'keep-content',
  component: SubagentRetryBlockComponent,
});

export default SubagentRetryBlockComponent;
