/**
 * 工具审批卡片组件
 *
 * 显示敏感工具的审批请求，让用户决定是否允许执行。
 *
 * 设计文档：src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md 第 4.6 节
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Check, X, Clock, Warning, CaretDown, CaretUp } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';

// ============================================================================
// 类型定义
// ============================================================================

export interface ApprovalRequestData {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  sensitivity: 'low' | 'medium' | 'high';
  description: string;
  timeoutSeconds: number;
  resolvedStatus?: 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';
  resolvedReason?: string;
}

export interface ToolApprovalCardProps {
  request: ApprovalRequestData;
  sessionId: string;
  className?: string;
}

// ============================================================================
// 子组件
// ============================================================================

/** ★ L-023: 参数 JSON 超过此字符数时自动截断，用户可手动展开 */
const ARGS_TRUNCATE_THRESHOLD = 300;

/** 参数预览组件 - 大 JSON 自动截断，提供展开/收起切换 */
const ArgumentsPreview: React.FC<{
  arguments: Record<string, unknown>;
  isExpanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}> = React.memo(({ arguments: args, isExpanded, onToggle, t }) => {
  const fullText = useMemo(() => JSON.stringify(args, null, 2), [args]);
  const needsTruncation = fullText.length > ARGS_TRUNCATE_THRESHOLD;
  const displayText = isExpanded || !needsTruncation
    ? fullText
    : fullText.slice(0, ARGS_TRUNCATE_THRESHOLD) + ' …';

  return (
    <>
      <pre className={cn(
        'mt-1 overflow-auto rounded bg-muted p-2 text-xs',
        isExpanded ? 'max-h-64' : 'max-h-32',
      )}>
        {displayText}
      </pre>
      {needsTruncation && (
        <NotionButton variant="ghost" size="sm" onClick={onToggle} className="mt-1 text-primary hover:underline">
          {isExpanded ? (
            <>
              <CaretUp size={12} />
              {t('approval.collapseArgs')}
            </>
          ) : (
            <>
              <CaretDown size={12} />
              {t('approval.expandArgs')}
            </>
          )}
        </NotionButton>
      )}
    </>
  );
});
ArgumentsPreview.displayName = 'ArgumentsPreview';

// ============================================================================
// 组件实现
// ============================================================================

export const ToolApprovalCard: React.FC<ToolApprovalCardProps> = ({
  request,
  sessionId,
  className,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const [remainingSeconds, setRemainingSeconds] = useState(request.timeoutSeconds);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [isArgsExpanded, setIsArgsExpanded] = useState(false);
  const resolvedStatus = request.resolvedStatus;
  const isResolved = Boolean(resolvedStatus);

  // 获取工具的国际化显示名称
  const displayToolName = useMemo(
    () => getReadableToolName(request.toolName, t),
    [request.toolName, t]
  );

  // 发送响应到后端（必须在 useEffect 之前定义）

  // 新的审批请求到达时重置本地状态，避免上一条请求残留导致卡片不显示
  useEffect(() => {
    setRemainingSeconds(request.timeoutSeconds);
    setHasResponded(false);
    setIsResponding(false);
  }, [request.toolCallId, request.timeoutSeconds]);

  const handleResponse = useCallback(
    async (approved: boolean, reason?: string, remember: boolean = false) => {
      if (hasResponded || isResponding || isResolved) return;

      setIsResponding(true);
      try {
        await invoke('chat_v2_tool_approval_respond', {
          sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName, // 🆕 用于"记住选择"功能
          approved,
          reason: reason ?? null,
          remember,
          arguments: request.arguments,
        });
        setHasResponded(true);
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        console.error('[ToolApprovalCard] Failed to send response:', errorMessage);
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
    [sessionId, request.toolCallId, request.toolName, request.arguments, hasResponded, isResponding, isResolved, t]
  );

  // 倒计时逻辑
  useEffect(() => {
    if (hasResponded || isResolved || remainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // 超时自动拒绝
          handleResponse(false, 'timeout');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [hasResponded, handleResponse, isResolved]);

  const resolution = useMemo(() => {
    if (!resolvedStatus) return null;
    if (resolvedStatus === 'approved') {
      return {
        label: t('approval.resolution.approved'),
        icon: Check,
        className: 'text-success',
      };
    }
    if (resolvedStatus === 'rejected') {
      return {
        label: t('approval.resolution.rejected'),
        icon: X,
        className: 'text-red-700 dark:text-red-400',
      };
    }
    if (resolvedStatus === 'timeout') {
      return {
        label: t('approval.resolution.timeout'),
        icon: Clock,
        className: 'text-yellow-700 dark:text-yellow-400',
      };
    }
    if (resolvedStatus === 'expired') {
      return {
        label: t('approval.resolution.expired'),
        icon: Warning,
        className: 'text-orange-700 dark:text-orange-400',
      };
    }
    return {
      label: t('approval.resolution.error'),
      icon: Warning,
      className: 'text-red-700 dark:text-red-400',
    };
  }, [resolvedStatus, t]);

  // 敏感等级颜色映射
  const sensitivityColors: Record<string, string> = {
    low: 'bg-success/10 text-success',
    medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    high: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };

  return (
    <Card
      className={cn(
        'border-2 border-yellow-400 dark:border-yellow-600 bg-yellow-50/85 dark:bg-yellow-950/45 backdrop-blur-md supports-[backdrop-filter]:backdrop-blur-md',
        className
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {t('approval.title')}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge className={sensitivityColors[request.sensitivity]}>
              {t(`approval.sensitivity.${request.sensitivity}`, request.sensitivity)}
            </Badge>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Clock size={16} />
            <span>{remainingSeconds}s</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 工具名称 */}
        <div>
          <span className="text-sm font-medium text-muted-foreground">
            {t('approval.toolName', { ns: 'chatV2' })}:
          </span>
          <code className="ml-2 rounded bg-muted px-2 py-0.5 text-sm font-mono">
            {displayToolName}
          </code>
        </div>

        {/* 描述 */}
        <div>
          <span className="text-sm font-medium text-muted-foreground">
            {t('approval.description')}:
          </span>
          <p className="mt-1 text-sm">{request.description}</p>
        </div>

        {/* 参数预览 - ★ L-023: 大内容截断显示，可手动展开 */}
        <div>
          <span className="text-sm font-medium text-muted-foreground">
            {t('approval.arguments')}:
          </span>
          <ArgumentsPreview
            arguments={request.arguments}
            isExpanded={isArgsExpanded}
            onToggle={() => setIsArgsExpanded(prev => !prev)}
            t={t}
          />
        </div>
      </CardContent>

      <CardFooter className="flex justify-end gap-2 pt-2">
        {resolution ? (
          <div className={cn('flex items-center gap-2 text-sm font-medium', resolution.className)}>
            <resolution.icon size={16} />
            <span>{resolution.label}</span>
          </div>
        ) : hasResponded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock size={16} />
            <span>{t('approval.resolution.pending')}</span>
          </div>
        ) : (
          <>
            {/* 始终允许按钮 */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(true, undefined, true)}
              disabled={isResponding}
              className="text-success hover:text-success/80"
            >
              {t('approval.alwaysAllow')}
            </NotionButton>

            {/* 始终拒绝按钮 */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(false, 'user_rejected', true)}
              disabled={isResponding}
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              {t('approval.alwaysDeny')}
            </NotionButton>

            {/* 拒绝按钮 */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(false, 'user_rejected')}
              disabled={isResponding}
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              <X size={16} className="mr-1" />
              {t('approval.reject')}
            </NotionButton>

            {/* 批准按钮 */}
            <NotionButton
              size="sm"
              onClick={() => handleResponse(true)}
              disabled={isResponding}
              autoFocus
              className="bg-success text-success-foreground"
            >
              <Check size={16} className="mr-1" />
              {t('approval.approve')}
            </NotionButton>
          </>
        )}
      </CardFooter>
    </Card>
  );
};

export default ToolApprovalCard;
