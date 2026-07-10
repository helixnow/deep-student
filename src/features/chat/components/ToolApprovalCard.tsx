/**
 * 工具审批卡片组件
 *
 * 显示敏感工具的审批请求，让用户决定是否允许执行。
 *
 * 设计文档：src/features/chat/docs/29-ChatV2-Agent能力增强改造方案.md 第 4.6 节
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import type { ShellRuntimeApprovalScope } from '@/features/chat/core/types/store';

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
  runtimeScope?: ShellRuntimeApprovalScope;
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
  const [isReasonOpen, setIsReasonOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // 同步互斥锁：state 更新是异步的，快速双击会让两次点击都读到 isResponding=false，
  // 用 ref 在同一事件循环内立即拦截第二次提交
  const respondingRef = useRef(false);
  // 超时自动拒绝只触发一次（即使发送失败也不无限重试）
  const timeoutFiredRef = useRef(false);
  const resolvedStatus = request.resolvedStatus;
  const isResolved = Boolean(resolvedStatus);

  // 获取工具的国际化显示名称
  const displayToolName = useMemo(
    () => getReadableToolName(request.toolName, t),
    [request.toolName, t]
  );

  const shellScope = request.runtimeScope?.kind === 'shell' ? request.runtimeScope : null;
  const shellCommandLabel = useMemo(() => {
    if (!shellScope) return '';
    if (shellScope.hasShellOperators || shellScope.usesScriptRunner) {
      return `hash:${shellScope.commandHash.slice(0, 8)}`;
    }
    return shellScope.commandPrefix;
  }, [shellScope]);
  const shellFlags = useMemo(() => {
    if (!shellScope) return [] as string[];
    const flags: string[] = [];
    if (shellScope.networkAllowed) flags.push('net');
    if (shellScope.hasShellOperators) flags.push('ops');
    if (shellScope.usesScriptRunner) flags.push('runner');
    return flags;
  }, [shellScope]);

  // 发送响应到后端（必须在 useEffect 之前定义）

  // 新的审批请求到达时重置本地状态，避免上一条请求残留导致卡片不显示
  useEffect(() => {
    setRemainingSeconds(request.timeoutSeconds);
    setHasResponded(false);
    setIsResponding(false);
    setIsReasonOpen(false);
    setRejectReason('');
    respondingRef.current = false;
    timeoutFiredRef.current = false;
  }, [request.toolCallId, request.timeoutSeconds]);

  const handleResponse = useCallback(
    async (approved: boolean, reason?: string, remember: boolean = false, rememberSession: boolean = false) => {
      if (respondingRef.current || hasResponded || isResponding || isResolved) return;

      respondingRef.current = true;
      setIsResponding(true);
      try {
        await invoke('chat_v2_tool_approval_respond', {
          sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName, // 🆕 用于"记住选择"功能
          approved,
          reason: reason ?? null,
          remember,
          rememberSession, // 🆕 三档分级：本会话允许该工具
          arguments: request.arguments,
        });
        setHasResponded(true);
        setIsReasonOpen(false);
      } catch (error: unknown) {
        // 发送失败允许用户重试
        respondingRef.current = false;
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

  // 带理由拒绝（Enter/「发送」按钮）；'user_rejected' 为无理由哨兵值
  const handleRejectWithReason = useCallback(() => {
    const trimmed = rejectReason.trim();
    handleResponse(false, trimmed || 'user_rejected');
  }, [handleResponse, rejectReason]);

  // 直接拒绝（Esc/「直接拒绝」按钮，不带理由）
  const handleRejectImmediately = useCallback(() => {
    handleResponse(false, 'user_rejected');
  }, [handleResponse]);

  // 已决态展示用户填写的拒绝理由（过滤哨兵值）
  const resolvedUserReason = useMemo(() => {
    if (resolvedStatus !== 'rejected') return null;
    const reason = request.resolvedReason?.trim();
    if (!reason || reason === 'user_rejected' || reason === 'timeout') return null;
    return reason;
  }, [resolvedStatus, request.resolvedReason]);

  // 倒计时逻辑（每秒递减；归零后在 effect 体内触发超时自动拒绝，
  // 避免在 setState updater 内执行副作用——StrictMode 下 updater 可能被调用两次）
  useEffect(() => {
    if (hasResponded || isResolved || request.timeoutSeconds <= 0) return;

    if (remainingSeconds <= 0) {
      if (!timeoutFiredRef.current) {
        timeoutFiredRef.current = true;
        handleResponse(false, 'timeout');
      }
      return;
    }

    const timer = setTimeout(() => {
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [remainingSeconds, hasResponded, handleResponse, isResolved, request.timeoutSeconds]);

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

  // 卡片仍处于等待用户操作的状态（已决/已发送后不再显示倒计时）
  const isAwaitingDecision = !isResolved && !hasResponded;

  return (
    <Card
      className={cn(
        'border-2 backdrop-blur-md supports-[backdrop-filter]:backdrop-blur-md',
        // 高风险操作用醒目的红色边框区分（低/中风险保持黄色警示）
        request.sensitivity === 'high'
          ? 'border-red-400 dark:border-red-800 bg-yellow-50/85 dark:bg-yellow-950/45'
          : 'border-yellow-400 dark:border-yellow-600 bg-yellow-50/85 dark:bg-yellow-950/45',
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
            {isAwaitingDecision && request.timeoutSeconds > 0 && (
              <div
                className="flex items-center gap-1 text-sm text-muted-foreground"
                role="timer"
                aria-label={t('approval.aria.autoRejectCountdown', { seconds: remainingSeconds })}
              >
                <Clock size={16} />
                <span>{remainingSeconds}s</span>
              </div>
            )}
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

        {shellScope && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={t('approval.runtimeRoot', { defaultValue: '运行目录' })}>
              {shellScope.rootId}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={t('approval.runtimeCwd', { defaultValue: '工作目录' })}>
              {shellScope.cwd}
            </span>
            <span
              className="max-w-[14rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono"
              title={shellScope.commandPrefix}
            >
              {shellCommandLabel}
            </span>
            {shellFlags.map((flag) => (
              <span
                key={flag}
                className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                {flag}
              </span>
            ))}
          </div>
        )}

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

      <CardFooter className="flex flex-wrap justify-end gap-2 pt-2">
        {resolution ? (
          <div className="flex w-full flex-col items-end gap-1">
            <div className={cn('flex items-center gap-2 text-sm font-medium', resolution.className)}>
              <resolution.icon size={16} />
              <span>{resolution.label}</span>
            </div>
            {resolvedUserReason && (
              <p className="max-w-full truncate text-xs text-muted-foreground" title={resolvedUserReason}>
                {t('approval.userReasonLabel')}: {resolvedUserReason}
              </p>
            )}
          </div>
        ) : hasResponded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock size={16} />
            <span>{t('approval.resolution.pending')}</span>
          </div>
        ) : (
          <>
            {/* 低频档：始终允许/始终拒绝（持久化白名单，设置页可管理） */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(true, undefined, true)}
              disabled={isResponding}
              className="text-success hover:text-success/80"
            >
              {t('approval.alwaysAllow')}
            </NotionButton>

            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(false, 'user_rejected', true)}
              disabled={isResponding}
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              {t('approval.alwaysDeny')}
            </NotionButton>

            <div className="flex-1" />

            {/* 拒绝按钮：首次点击展开理由输入行，不立即发送 */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => setIsReasonOpen((prev) => !prev)}
              disabled={isResponding}
              className="text-red-600 hover:text-red-700 dark:text-red-400"
            >
              <X size={16} className="mr-1" />
              {t('approval.reject')}
            </NotionButton>

            {/* 🆕 三档分级中间档：本会话允许该工具（重复任务不再反复弹卡） */}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse(true, undefined, false, true)}
              disabled={isResponding}
              className="text-success hover:text-success/80"
            >
              {t('approval.allowSession', 'Allow for session')}
            </NotionButton>

            {/* 批准按钮（仅此次） */}
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

            {/* 拒绝理由输入（内联展开，非模态） */}
            {isReasonOpen && (
              <div className="flex w-full items-center gap-1.5">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleRejectWithReason();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      handleRejectImmediately();
                    }
                  }}
                  placeholder={t('approval.rejectReasonPlaceholder')}
                  autoFocus
                  disabled={isResponding}
                  className={cn(
                    'flex-1 min-w-0 px-2 py-1 text-xs rounded-md border border-border/50',
                    'bg-background placeholder:text-muted-foreground/50',
                    'focus:outline-none focus:ring-1 focus:ring-[color:var(--input-shell-focus)]',
                    isResponding && 'opacity-50 cursor-not-allowed'
                  )}
                />
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleRejectImmediately}
                  disabled={isResponding}
                  className="shrink-0 text-xs text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                >
                  {t('approval.rejectDirectly')}
                </NotionButton>
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={handleRejectWithReason}
                  disabled={isResponding}
                  className="shrink-0 text-xs text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  {t('approval.rejectSend')}
                </NotionButton>
              </div>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
};

export default ToolApprovalCard;
