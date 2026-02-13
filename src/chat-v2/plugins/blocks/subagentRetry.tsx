/**
 * Chat V2 - 子代理重试块渲染插件
 *
 * 🆕 P38: 显示子代理因未发送消息而被重新触发的状态
 *
 * 自执行注册：import 即注册
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 类型定义
// ============================================================================

interface SubagentRetryInput {
  agentSessionId: string;
  reason: string;
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

const SubagentRetryBlockComponent: React.FC<BlockComponentProps> = ({
  block,
}) => {
  const { t } = useTranslation(['chatV2']);

  const input = block.toolInput as unknown as SubagentRetryInput | undefined;
  const output = block.toolOutput as unknown as SubagentRetryOutput | undefined;

  const agentId = input?.agentSessionId || 'unknown';
  const shortAgentId = agentId.slice(-8);
  const message = output?.message || t('chatV2:workspace.subagentRetryDefault');
  const isResolved = output?.resolved || block.status === 'success';
  const isRunning = block.status === 'running';
  const isFailed = output?.reason === 'max_retries_exceeded' || block.status === 'error';

  return (
    <div
      className={cn(
        'rounded-lg border p-3 my-2',
        'transition-all duration-200',
        isFailed
          ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
          : isResolved
            ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
      )}
    >
      <div className="flex items-start gap-3">
        {/* 图标 */}
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            isFailed
              ? 'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400'
              : isResolved
                ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400'
                : 'bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400'
          )}
        >
          {isFailed ? (
            <AlertTriangle className="w-4 h-4" />
          ) : isResolved ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : isRunning ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <AlertTriangle className="w-4 h-4" />
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                'text-sm font-medium',
                isFailed
                  ? 'text-red-700 dark:text-red-300'
                  : isResolved
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-amber-700 dark:text-amber-300'
              )}
            >
              {isFailed
                ? t('chatV2:workspace.subagentRetryFailed')
                : isResolved
                  ? t('chatV2:workspace.subagentRetryResolved')
                  : t('chatV2:workspace.subagentRetryTitle')}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {shortAgentId}
            </span>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400">
            {message}
          </p>

          {output?.timestamp && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {new Date(output.timestamp).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('subagent_retry', {
  type: 'subagent_retry',
  component: SubagentRetryBlockComponent,
});

export default SubagentRetryBlockComponent;
