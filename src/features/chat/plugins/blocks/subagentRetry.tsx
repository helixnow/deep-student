/**
 * Chat V2 - 子代理重试块渲染插件
 *
 * 🆕 P38: 显示子代理因未发送消息而被重新触发的状态
 *
 * 自执行注册：import 即注册
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CheckCircle, MinusCircle, WarningCircle } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { PulseDot } from '@/components/ui/PulseDot';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
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

  const titleText = isFailed
    ? isExhausted
      ? t('chatV2:workspace.subagentRetryExhaustedTitle')
      : t('chatV2:workspace.subagentRetryFailed')
    : isCancelled
      ? t('workspace:subagentRetry.finalCancelled')
      : isResolved
        ? t('chatV2:workspace.subagentRetryResolved')
        : t('chatV2:workspace.subagentRetryTitle');

  const statusIndicator = isFailed ? (
    <WarningCircle size={16} className="w-4 h-4 text-destructive shrink-0" />
  ) : isCancelled ? (
    <MinusCircle size={16} className="w-4 h-4 text-muted-foreground shrink-0" />
  ) : isResolved ? (
    <CheckCircle size={16} weight="fill" className="w-4 h-4 text-success shrink-0" />
  ) : isRunning ? (
    <PulseDot className="w-1.5 h-1.5 text-warning shrink-0" />
  ) : null;

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80',
        isFailed ? 'border-destructive/30' : 'border-border/50'
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolActivitySweep
            active={isRunning}
            className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
          >
            <ArrowClockwise size={16} className="text-muted-foreground" />
          </ToolActivitySweep>

          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ToolActivitySweep active={isRunning} className="min-w-0 max-w-full leading-4">
                {isRunning ? (
                  <TextShimmer
                    className="text-xs font-medium leading-4 text-muted-foreground"
                    duration={1.5}
                    spread={3}
                  >
                    {titleText}
                  </TextShimmer>
                ) : (
                  <span
                    className={cn(
                      'block truncate text-xs font-medium leading-4',
                      isFailed ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {titleText}
                  </span>
                )}
              </ToolActivitySweep>
              <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-2xs font-mono leading-none text-muted-foreground">
                {shortAgentId}
              </span>
            </div>

            {output?.timestamp && (
              <span className="text-2xs leading-4 text-muted-foreground/70 tabular-nums">
                {new Date(output.timestamp).toLocaleString(locale)}
              </span>
            )}
          </div>
        </div>

        {statusIndicator && (
          <div className="flex shrink-0 items-center gap-1.5">
            {statusIndicator}
          </div>
        )}
      </div>

      <div className="border-t border-border/30 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
        {message}
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
