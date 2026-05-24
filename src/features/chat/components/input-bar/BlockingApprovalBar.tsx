/**
 * Chat V2 - BlockingApprovalBar
 *
 * 紧凑型工具审批栏：嵌入输入栏框架内，替换 textarea 区域。
 * 无外边框/阴影，继承 inputContainerRef 外壳样式。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ShieldCheck, Clock, CaretDown, CaretUp } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import type { BlockingInteraction } from '../../core/types/store';
import type { PlaygroundToolApprovalInteraction } from '../../dev/playground/blockingRuntime';

// ============================================================================
// 类型定义
// ============================================================================

type ToolApprovalInteraction = Extract<BlockingInteraction, { kind: 'tool_approval' }> | PlaygroundToolApprovalInteraction;

interface BlockingApprovalBarProps {
  interaction: ToolApprovalInteraction;
  sessionId: string;
}

// ============================================================================
// 常量
// ============================================================================

const ARGS_TRUNCATE_THRESHOLD = 120;

const SENSITIVITY_COLORS: Record<string, string> = {
  low: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

// ============================================================================
// 组件实现
// ============================================================================

export const BlockingApprovalBar: React.FC<BlockingApprovalBarProps> = React.memo(({
  interaction,
  sessionId,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const [remainingSeconds, setRemainingSeconds] = useState(interaction.timeoutSeconds);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [isArgsExpanded, setIsArgsExpanded] = useState(false);

  const isResolved = Boolean(interaction.resolvedStatus);

  // 工具显示名称
  const displayToolName = useMemo(
    () => getReadableToolName(interaction.toolName, t),
    [interaction.toolName, t]
  );

  // 参数 JSON 预览
  const argsText = useMemo(
    () => JSON.stringify(interaction.arguments, null, 2),
    [interaction.arguments]
  );
  const needsTruncation = argsText.length > ARGS_TRUNCATE_THRESHOLD;

  // 新请求到达时重置状态
  useEffect(() => {
    setRemainingSeconds(interaction.timeoutSeconds);
    setHasResponded(false);
    setIsResponding(false);
  }, [interaction.toolCallId, interaction.timeoutSeconds]);

  // 发送审批响应
  const handleResponse = useCallback(
    async (decision: 'approve' | 'reject' | 'always_allow' | 'always_deny') => {
      if (hasResponded || isResponding || isResolved) return;

      setIsResponding(true);
      try {
        const approved = decision === 'approve' || decision === 'always_allow';
        const remember = decision === 'always_allow' || decision === 'always_deny';
        const reason = approved ? undefined : 'user_rejected';

        if ('respond' in interaction && typeof interaction.respond === 'function') {
          await interaction.respond({
            approved,
            remember,
            reason,
          });
        } else {
          await invoke('chat_v2_tool_approval_respond', {
            sessionId,
            toolCallId: interaction.toolCallId,
            toolName: interaction.toolName,
            approved,
            reason: reason ?? null,
            remember,
            arguments: interaction.arguments,
          });
        }
        setHasResponded(true);
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        console.error('[BlockingApprovalBar] Failed to send response:', errorMessage);
        if (errorMessage.toLowerCase().includes('approval_expired')) {
          showGlobalNotification(
            'warning',
            t('approval.notification.expiredTitle'),
            t('approval.notification.expiredDetail')
          );
        } else {
          showGlobalNotification(
            'error',
            t('approval.notification.responseFailedTitle'),
            t('approval.notification.responseFailedDetail')
          );
        }
      } finally {
        setIsResponding(false);
      }
    },
    [sessionId, interaction.toolCallId, interaction.toolName, interaction.arguments, hasResponded, isResponding, isResolved, t]
  );

  // 倒计时
  useEffect(() => {
    if (hasResponded || isResolved || remainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleResponse('reject');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [hasResponded, isResolved, handleResponse, remainingSeconds]);

  const disabled = isResponding || hasResponded || isResolved;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      {/* Row 1: 工具名 + 敏感度 + 倒计时 */}
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium truncate">{displayToolName}</span>
        <Badge className={cn('text-[10px] px-1.5 py-0', SENSITIVITY_COLORS[interaction.sensitivity])}>
          {t(`approval.sensitivity.${interaction.sensitivity}`, interaction.sensitivity)}
        </Badge>
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock size={14} />
          <span>{remainingSeconds}s</span>
        </div>
      </div>

      {/* Row 2: 参数预览（可折叠） */}
      {argsText !== '{}' && (
        <div>
          <pre className={cn(
            'overflow-hidden rounded bg-muted px-2 py-1 text-xs font-mono text-muted-foreground',
            isArgsExpanded ? 'max-h-40 overflow-y-auto' : 'max-h-16',
          )}>
            {isArgsExpanded || !needsTruncation
              ? argsText
              : argsText.slice(0, ARGS_TRUNCATE_THRESHOLD) + ' …'}
          </pre>
          {needsTruncation && (
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setIsArgsExpanded((prev) => !prev)}
              className="mt-0.5 flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              {isArgsExpanded ? (
                <>
                  <CaretUp size={10} />
                  {t('approval.collapseArgs')}
                </>
              ) : (
                <>
                  <CaretDown size={10} />
                  {t('approval.expandArgs')}
                </>
              )}
            </NotionButton>
          )}
        </div>
      )}

      {/* Row 3: 操作按钮 */}
      <div className="flex items-center gap-2">
        {/* 始终拒绝 */}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => handleResponse('always_deny')}
          disabled={disabled}
          className="text-xs text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
        >
          {t('approval.alwaysDeny')}
        </NotionButton>

        {/* 始终允许 */}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => handleResponse('always_allow')}
          disabled={disabled}
          className="text-xs text-muted-foreground hover:text-green-600 dark:hover:text-green-400"
        >
          {t('approval.alwaysAllow')}
        </NotionButton>

        <div className="ml-auto flex items-center gap-2">
          {/* 拒绝 */}
          <NotionButton
            variant="outline"
            size="sm"
            onClick={() => handleResponse('reject')}
            disabled={disabled}
            className="text-red-600 hover:text-red-700 dark:text-red-400"
          >
            {t('approval.reject')}
          </NotionButton>

          {/* 批准 */}
          <NotionButton
            size="sm"
            onClick={() => handleResponse('approve')}
            disabled={disabled}
            autoFocus
            className="bg-success text-success-foreground"
          >
            {t('approval.approve')}
          </NotionButton>
        </div>
      </div>
    </div>
  );
});

BlockingApprovalBar.displayName = 'BlockingApprovalBar';
