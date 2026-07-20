/**
 * Chat V2 - 子代理重试块渲染插件
 *
 * 🆕 P38: 显示子代理因未发送消息而被重新触发的状态
 *
 * 自执行注册：import 即注册
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Warning, CheckCircle } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';

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
  resolved?: boolean;
  retry_count?: number;
  reason?: string;
}

// ============================================================================
// 子代理重试块组件
// ============================================================================

const SubagentRetryBlockComponent: React.FC<BlockComponentProps> = React.memo(({
  block,
}) => {
  const { t } = useTranslation(['chatV2']);

  const input = block.toolInput as unknown as SubagentRetryInput | undefined;
  const output = block.toolOutput as unknown as SubagentRetryOutput | undefined;

  const agentId = input?.agentSessionId || 'unknown';
  const shortAgentId = agentId.slice(-8);
  const message = output?.message || t('chatV2:workspace.subagentRetryDefault');
  // 🔧 P1 修复：reason 现在写入 toolOutput（新块），旧块回退读 toolInput
  const reason = output?.reason ?? input?.reason;
  // max_retries_exceeded 是终局失败，必须渲染红色终态而非琥珀色"重试中"
  const isExhausted = reason === 'max_retries_exceeded';
  const isFailed = isExhausted || block.status === 'error';
  const isResolved = !isFailed && (output?.resolved === true || block.status === 'success');
  const isRunning = !isFailed && !isResolved && block.status === 'running';

  return (
    <div
      className={cn(
        'rounded-lg border p-3 my-2',
        'transition-colors duration-200',
        isFailed
          ? 'bg-destructive/5 border-destructive/30'
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
              : isResolved
                ? 'bg-success/10 text-success'
                : 'bg-warning/10 text-warning'
          )}
        >
          {isFailed ? (
            <Warning size={16} />
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
                  : isResolved
                    ? 'text-success'
                    : 'text-warning'
              )}
            >
              {isFailed
                ? isExhausted
                  ? t('chatV2:workspace.subagentRetryExhaustedTitle')
                  : t('chatV2:workspace.subagentRetryFailed')
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
              {new Date(output.timestamp).toLocaleString()}
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
