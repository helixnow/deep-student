/**
 * Chat V2 - BlockingApprovalBar
 *
 * 紧凑型工具审批栏：嵌入输入栏框架内，替换 textarea 区域。
 * 无外边框/阴影，继承 inputContainerRef 外壳样式。
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ShieldCheck, Clock, CaretDown, CaretUp, ChatCircleText, Check, X, Warning } from '@phosphor-icons/react';
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
const HASH_PREVIEW_LENGTH = 8;

const SENSITIVITY_COLORS: Record<string, string> = {
  low: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  high: 'bg-destructive/10 text-destructive',
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
  const [isReasonOpen, setIsReasonOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // a11y：倒计时暂停（WCAG 2.2.1 Timing Adjustable）——
  // hover 暂停服务鼠标用户；键盘交互暂停服务键盘/屏幕阅读器用户（焦点离开审批栏后恢复）
  const [hoverPaused, setHoverPaused] = useState(false);
  const [interactPaused, setInteractPaused] = useState(false);
  // a11y：sr-only live region 播报内容（出现/临近超时/暂停）
  const [liveMessage, setLiveMessage] = useState('');
  // 同步互斥锁：state 更新是异步的，快速双击会让两次点击都读到 isResponding=false，
  // 用 ref 在同一事件循环内立即拦截第二次提交（从遗留 ToolApprovalCard 收敛而来）
  const respondingRef = useRef(false);
  const isCountdownPaused = hoverPaused || interactPaused;

  const isResolved = Boolean(interaction.resolvedStatus);
  // 倒计时归零 = 后端权威超时已经（或即将）触发。前端不代发拒绝（否则超时会被
  // 误报为「用户拒绝」），只进入禁用等待态，由 tool_approval_request 的
  // onEnd/onError（reason=timeout / approval_timeout）解析出已决态并出队。
  const isTimedOutLocally = !isResolved && interaction.timeoutSeconds > 0 && remainingSeconds <= 0;
  const shellScope = interaction.runtimeScope?.kind === 'shell' ? interaction.runtimeScope : null;
  const skillApprovalScope =
    interaction.runtimeScope?.kind === 'skill_install' ||
    interaction.runtimeScope?.kind === 'skill_workshop'
      ? interaction.runtimeScope
      : null;
  const skillApprovalRisk =
    skillApprovalScope?.kind === 'skill_install'
      ? (skillApprovalScope.declaredRiskLevel ?? skillApprovalScope.riskLevel)
      : skillApprovalScope?.riskLevel;
  const rememberDisabled = Boolean(interaction.runtimeScope?.rememberDisabled)
    || interaction.permissionPreset !== 'relaxed'
    || interaction.sensitivity !== 'medium';

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
  const shellCommandLabel = useMemo(() => {
    if (!shellScope) return null;
    if (shellScope.commandPrefix?.startsWith('raw:')) {
      return `hash:${shellScope.commandHash.slice(0, HASH_PREVIEW_LENGTH)}`;
    }
    return shellScope.commandPrefix || `hash:${shellScope.commandHash.slice(0, HASH_PREVIEW_LENGTH)}`;
  }, [shellScope]);
  const shellFlags = useMemo(() => {
    if (!shellScope) return [];
    return [
      shellScope.networkAllowed ? 'net' : null,
      shellScope.hasShellOperators ? 'ops' : null,
      shellScope.usesScriptRunner ? 'runner' : null,
    ].filter((value): value is string => Boolean(value));
  }, [shellScope]);
  const rootBindingLabel = shellScope?.rootBinding
    ? `bind:${shellScope.rootBinding.slice(0, HASH_PREVIEW_LENGTH)}`
    : null;
  const isExternalMcpExecution = shellScope?.executionLocation?.startsWith('external') ?? false;

  // 新请求到达时重置状态
  useEffect(() => {
    setRemainingSeconds(interaction.timeoutSeconds);
    setHasResponded(false);
    setIsResponding(false);
    setIsReasonOpen(false);
    setRejectReason('');
    setHoverPaused(false);
    setInteractPaused(false);
    respondingRef.current = false;
  }, [interaction.toolCallId, interaction.timeoutSeconds]);

  // 发送审批响应
  // customReason：用户在内联输入框填写的拒绝理由（仅拒绝路径使用）。
  // 显式传参而非读 state，避免倒计时自动拒绝把输入到一半的文本发出去。
  const handleResponse = useCallback(
    async (
      decision: 'approve' | 'allow_session' | 'reject' | 'always_allow' | 'always_deny',
      customReason?: string
    ) => {
      if (respondingRef.current || hasResponded || isResponding || isResolved) return;

      respondingRef.current = true;
      setIsResponding(true);
      try {
        const approved = decision === 'approve' || decision === 'allow_session' || decision === 'always_allow';
        const remember = decision === 'always_allow' || decision === 'always_deny';
        const rememberSession = decision === 'allow_session';
        const trimmedReason = customReason?.trim();
        // 'user_rejected' 为无理由拒绝的哨兵值，后端据此保持笼统文案（向后兼容）
        const reason = approved ? undefined : (trimmedReason || 'user_rejected');

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
            rememberSession, // 🆕 三档分级：本会话允许该工具
            arguments: interaction.arguments,
          });
        }
        setHasResponded(true);
        setIsReasonOpen(false);
      } catch (error: unknown) {
        // 发送失败允许用户重试
        respondingRef.current = false;
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

  // 带理由拒绝（Enter/「发送」按钮）
  const handleRejectWithReason = useCallback(() => {
    handleResponse('reject', rejectReason);
  }, [handleResponse, rejectReason]);

  // 直接拒绝（Esc/「直接拒绝」按钮，不带理由）
  const handleRejectImmediately = useCallback(() => {
    handleResponse('reject');
  }, [handleResponse]);

  // 倒计时（用户与审批栏交互时暂停，见 isCountdownPaused）
  // 归零后不在前端发送拒绝——后端 tokio timeout 是超时权威，会 emit
  // approval_timeout，前端只负责展示「已超时」等待态（语义收敛，避免双通道竞态）
  useEffect(() => {
    if (hasResponded || isResolved || isCountdownPaused || remainingSeconds <= 0) return;

    const timer = setTimeout(() => {
      setRemainingSeconds(remainingSeconds - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [hasResponded, isResolved, isCountdownPaused, remainingSeconds]);

  // a11y 播报：审批请求出现时
  useEffect(() => {
    setLiveMessage(
      t('approval.aria.requested', {
        tool: displayToolName,
        seconds: interaction.timeoutSeconds,
      })
    );
    // 仅在新审批请求到达时播报一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interaction.toolCallId]);

  // a11y 播报：剩余 10 秒警告
  useEffect(() => {
    if (remainingSeconds === 10 && !isCountdownPaused && !hasResponded && !isResolved) {
      setLiveMessage(t('approval.aria.countdownWarning', { seconds: remainingSeconds }));
    }
  }, [remainingSeconds, isCountdownPaused, hasResponded, isResolved, t]);

  // a11y 播报：键盘交互触发的暂停（hover 暂停不播报，避免鼠标划过刷屏）
  useEffect(() => {
    if (interactPaused) {
      setLiveMessage(t('approval.aria.countdownPaused'));
    }
  }, [interactPaused, t]);

  // a11y 播报：本地倒计时归零，等待后端超时判定
  useEffect(() => {
    if (isTimedOutLocally) {
      setLiveMessage(t('approval.timedOutWaiting'));
    }
  }, [isTimedOutLocally, t]);

  const disabled = isResponding || hasResponded || isResolved || isTimedOutLocally;

  // 已决态反馈（收敛自遗留 ToolApprovalCard）：出队前的 1s 窗口内明确告知结果，
  // 避免审批栏「无声消失」
  const resolution = useMemo(() => {
    const status = interaction.resolvedStatus;
    if (!status) return null;
    switch (status) {
      case 'approved':
        return { label: t('approval.resolution.approved'), Icon: Check, className: 'text-success' };
      case 'rejected':
        return { label: t('approval.resolution.rejected'), Icon: X, className: 'text-destructive' };
      case 'timeout':
        return { label: t('approval.resolution.timeout'), Icon: Clock, className: 'text-warning' };
      case 'expired':
        return { label: t('approval.resolution.expired'), Icon: Warning, className: 'text-warning' };
      default:
        return { label: t('approval.resolution.error'), Icon: Warning, className: 'text-destructive' };
    }
  }, [interaction.resolvedStatus, t]);

  // 已决态展示用户填写的拒绝理由（过滤哨兵值）
  const resolvedUserReason = useMemo(() => {
    if (interaction.resolvedStatus !== 'rejected') return null;
    const reason = interaction.resolvedReason?.trim();
    if (!reason || reason === 'user_rejected' || reason === 'timeout') return null;
    return reason;
  }, [interaction.resolvedStatus, interaction.resolvedReason]);

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2"
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
      onKeyDownCapture={() => setInteractPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setInteractPaused(false);
        }
      }}
    >
      {/* a11y：sr-only 状态播报区（出现 / 剩余 10 秒 / 已暂停） */}
      <span className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </span>

      {/* Row 1: 工具名 + 敏感度 + 倒计时 */}
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck size={16} className="shrink-0 text-warning" />
        <span className="text-sm font-medium truncate">{displayToolName}</span>
        <Badge className={cn('text-[10px] px-1.5 py-0', SENSITIVITY_COLORS[interaction.sensitivity])}>
          {t(`approval.sensitivity.${interaction.sensitivity}`, interaction.sensitivity)}
        </Badge>
        {resolution ? (
          <div className={cn('ml-auto flex items-center gap-1 text-xs font-medium shrink-0', resolution.className)}>
            <resolution.Icon size={14} aria-hidden="true" />
            <span>{resolution.label}</span>
          </div>
        ) : isTimedOutLocally ? (
          <div className="ml-auto flex items-center gap-1 text-xs text-warning shrink-0" role="status">
            <Clock size={14} aria-hidden="true" />
            <span>{t('approval.timedOutWaiting')}</span>
          </div>
        ) : (
          <div
            role="timer"
            className={cn(
              'ml-auto flex items-center gap-1 text-xs shrink-0 transition-colors duration-150',
              remainingSeconds <= 10 && !isCountdownPaused
                ? 'font-medium text-warning'
                : 'text-muted-foreground',
            )}
            aria-label={
              isCountdownPaused
                ? t('approval.aria.countdownPaused')
                : t('approval.aria.autoRejectCountdown', { seconds: remainingSeconds })
            }
          >
            <Clock size={14} aria-hidden="true" />
            <span aria-hidden="true" className="tabular-nums">{remainingSeconds}s</span>
            {isCountdownPaused && (
              <span aria-hidden="true" className="text-[10px]">
                {t('approval.countdownPaused')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Row 2: Runtime scope 摘要（内联 chip，不新增审批面板） */}
      {shellScope && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {isExternalMcpExecution ? (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive">
              external MCP / local sandbox not enforced
            </span>
          ) : (
            <>
              {shellScope.executionLocation && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {shellScope.executionLocation}
                </span>
              )}
              {shellScope.sandboxEnforced !== undefined && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 font-mono',
                    shellScope.sandboxEnforced
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-destructive/10 text-destructive',
                  )}
                >
                  sandbox:{shellScope.sandboxEnforced ? 'enforced' : 'unenforced'}
                </span>
              )}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={shellScope.rootPath ?? shellScope.toolSource}>
                {shellScope.rootId}
              </span>
              {shellScope.rootPath && (
                <span
                  className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono"
                  title={shellScope.rootPath}
                >
                  {shellScope.rootPath}
                </span>
              )}
              {shellScope.rootAccess && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {shellScope.rootAccess}
                </span>
              )}
              {shellScope.rootSessionScoped !== undefined && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {shellScope.rootSessionScoped ? 'session-root' : 'persistent-root'}
                </span>
              )}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={shellScope.cwd}>
                {shellScope.cwd}
              </span>
            </>
          )}
          <span className="max-w-[14rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono" title={shellScope.commandPrefix}>
            {shellCommandLabel}
          </span>
          {shellFlags.map((flag) => (
            <span key={flag} className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
              {flag}
            </span>
          ))}
          {!isExternalMcpExecution && shellScope.sandboxBackend && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              sandbox:{shellScope.sandboxBackend}
            </span>
          )}
          {!isExternalMcpExecution && shellScope.shellKind && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              shell:{shellScope.shellKind}
            </span>
          )}
          {!isExternalMcpExecution && shellScope.outputEncoding && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              encoding:{shellScope.outputEncoding}
            </span>
          )}
          {shellScope.containsPotentialSecret && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-warning">
              command:redacted
            </span>
          )}
          {!isExternalMcpExecution && shellScope.inheritEnv === true && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-warning">
              parent-env
            </span>
          )}
          {!isExternalMcpExecution && shellScope.inheritedEnvKeys && (
            <span
              className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono"
              title={shellScope.inheritedEnvKeys.join(', ') || 'none'}
            >
              inherited:{shellScope.inheritedEnvKeys.length}
              {shellScope.inheritedEnvKeys.length > 0 ? ` [${shellScope.inheritedEnvKeys.join(', ')}]` : ''}
            </span>
          )}
          {!isExternalMcpExecution && shellScope.explicitEnvKeys && (
            <span
              className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono"
              title={shellScope.explicitEnvKeys.join(', ') || 'none'}
            >
              explicit-env:{shellScope.explicitEnvKeys.length}
              {shellScope.explicitEnvKeys.length > 0 ? ` [${shellScope.explicitEnvKeys.join(', ')}]` : ''}
            </span>
          )}
          {!isExternalMcpExecution && rootBindingLabel && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={shellScope.rootBinding}>
              {rootBindingLabel}
            </span>
          )}
          {!isExternalMcpExecution && shellScope.readableRoots?.map((path) => (
            <span
              key={path}
              className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono"
              title={path}
            >
              read:{path}
            </span>
          ))}
        </div>
      )}

      {skillApprovalScope && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {skillApprovalScope.sourceSummary && (
            <span className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono" title={skillApprovalScope.sourceSummary}>
              {skillApprovalScope.sourceSummary}
            </span>
          )}
          {skillApprovalScope.expectedSha256Prefix && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={t('skillInstall.approval.sha256Prefix')}>
              sha:{skillApprovalScope.expectedSha256Prefix}
            </span>
          )}
          {skillApprovalScope.skillId && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{skillApprovalScope.skillId}</span>
          )}
          {skillApprovalScope.overwriteExisting && (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive">
              overwrite
            </span>
          )}
          {skillApprovalRisk && (
            <Badge
              className={cn(
                'text-[10px] px-1.5 py-0',
                SENSITIVITY_COLORS[skillApprovalRisk],
              )}
            >
              {t(
                `skillInstall.approval.risk.${skillApprovalRisk}`,
                skillApprovalRisk,
              )}
            </Badge>
          )}
        </div>
      )}

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

      {/* Row 3: 操作按钮 / 已决态反馈 */}
      {resolution ? (
        resolvedUserReason && (
          <p className="truncate text-xs text-muted-foreground" title={resolvedUserReason}>
            {t('approval.userReasonLabel')}: {resolvedUserReason}
          </p>
        )
      ) : hasResponded ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Clock size={13} aria-hidden="true" />
          <span>{t('approval.resolution.pending')}</span>
        </div>
      ) : (
      <div className="flex items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* 拒绝：首次点击展开理由输入行，不立即发送 */}
          <NotionButton
            variant="outline"
            size="sm"
            onClick={() => setIsReasonOpen((prev) => !prev)}
            disabled={disabled}
            className="text-destructive hover:text-destructive/80"
          >
            {t('approval.reject')}
          </NotionButton>

          {/* 🆕 本会话允许该工具 */}
          {!rememberDisabled && (
            <NotionButton
              variant="outline"
              size="sm"
              onClick={() => handleResponse('allow_session')}
              disabled={disabled}
              className="text-success hover:text-success/80"
            >
              {shellScope
                ? t('approval.allowScope')
                : t('approval.allowSession')}
            </NotionButton>
          )}

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
      )}

      {/* Row 4: 拒绝理由输入（内联展开，非模态） */}
      {isReasonOpen && !disabled && (
        <div className="flex items-center gap-1.5">
          <ChatCircleText size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleRejectWithReason();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                handleRejectImmediately();
              }
            }}
            placeholder={t('approval.rejectReasonPlaceholder')}
            autoFocus
            className={cn(
              'flex-1 min-w-0 px-2 py-1 text-xs rounded-md border border-border/50',
              'bg-background placeholder:text-muted-foreground/50',
              'focus:outline-none focus:ring-1 focus:ring-[color:var(--input-shell-focus)]'
            )}
          />
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRejectImmediately}
            disabled={disabled}
            className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
          >
            {t('approval.rejectDirectly')}
          </NotionButton>
          <NotionButton
            variant="outline"
            size="sm"
            onClick={handleRejectWithReason}
            disabled={disabled}
            className="shrink-0 text-xs text-destructive hover:text-destructive/80"
          >
            {t('approval.rejectSend')}
          </NotionButton>
        </div>
      )}
    </div>
  );
});

BlockingApprovalBar.displayName = 'BlockingApprovalBar';
