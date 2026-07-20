/**
 * PlanGateCard — Plan mode batch confirmation (Ask/Plan/Craft).
 * Distinct from ToolApprovalCard: approving binds writes to planId only.
 *
 * 形态：输入栏上方的内联确认卡（非模态）。role="region"，不做全局焦点陷阱；
 * 初始焦点落在「拒绝」按钮上，Escape 在卡片内按下时等同拒绝，卸载时恢复焦点。
 * 视觉与 BlockingApprovalBar 对齐：warning 语义色、success 主操作、
 * destructive 次操作、tabular-nums 倒计时（临近超时转警示色）。
 *
 * 倒计时归零时前端主动发送 timeout 拒绝，与文案「N 秒后自动拒绝」语义一致
 * （后端权威超时仍然兜底，先到先得，重复响应由后端幂等处理）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Warning, CircleNotch, Clock, CaretDown, CaretUp } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';

export interface PlanGateRequestData {
  planId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  timeoutSeconds: number;
  arguments?: Record<string, unknown>;
}

export interface PlanGateCardProps {
  request: PlanGateRequestData;
  sessionId: string;
  onResolved?: (approved: boolean) => void;
  className?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

/** 剩余秒数低于该阈值时倒计时文案转警示色 */
const COUNTDOWN_URGENT_THRESHOLD = 10;
/** 参数 JSON 超过此字符数时截断显示，可手动展开（与审批栏一致） */
const ARGS_TRUNCATE_THRESHOLD = 120;

export const PlanGateCard: React.FC<PlanGateCardProps> = ({
  request,
  sessionId,
  onResolved,
  className,
  restoreFocusRef,
}) => {
  const { t } = useTranslation('chatV2');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(request.timeoutSeconds);
  const [timedOut, setTimedOut] = useState(false);
  const [isArgsExpanded, setIsArgsExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const respondRef = useRef<(approved: boolean) => void>(() => undefined);
  // 同步互斥锁：state 更新是异步的，快速双击/倒计时竞态下用 ref 立即拦截
  const respondingRef = useRef(false);
  // 超时自动拒绝只触发一次（即使发送失败也不无限重试）
  const timeoutFiredRef = useRef(false);

  const respond = useCallback(
    async (approved: boolean, reason?: string) => {
      if (respondingRef.current || busy) return;
      respondingRef.current = true;
      setBusy(true);
      try {
        await invoke('chat_v2_plan_gate_respond', {
          sessionId,
          planId: request.planId,
          toolCallId: request.toolCallId,
          approved,
          reason: approved ? null : (reason ?? 'user_rejected'),
        });
        onResolved?.(approved);
      } catch (error) {
        console.error('[PlanGateCard] Failed to respond:', error);
        // 发送失败允许用户重试（超时自动拒绝除外，由 timeoutFiredRef 控制）
        respondingRef.current = false;
        setBusy(false);
      }
    },
    [busy, onResolved, request.planId, request.toolCallId, sessionId],
  );
  respondRef.current = (approved) => void respond(approved);

  // 新请求到达时重置倒计时与超时状态
  useEffect(() => {
    setRemaining(request.timeoutSeconds);
    setTimedOut(false);
    setIsArgsExpanded(false);
    timeoutFiredRef.current = false;
  }, [request.toolCallId, request.timeoutSeconds]);

  // 🔧 F-P0：倒计时递减；归零后在 effect 体内触发超时自动拒绝——
  // 此前仅递减不触发，文案承诺「自动拒绝」但前端不执行，UI 会停在 0 秒仍可点击。
  // （不放在 setState updater 里：updater 需保持纯函数，StrictMode 下会被双调用）
  useEffect(() => {
    if (busy || request.timeoutSeconds <= 0) return;

    if (remaining <= 0) {
      if (!timeoutFiredRef.current) {
        timeoutFiredRef.current = true;
        setTimedOut(true);
        void respond(false, 'timeout');
      }
      return;
    }

    const timer = window.setTimeout(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, busy, request.timeoutSeconds, respond]);

  // 非模态焦点管理：初始焦点移入卡片（拒绝按钮），卸载时恢复；
  // 不注册全局键盘监听、不做 Tab 陷阱（用户可自由 Tab 出卡片）。
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      rejectButtonRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      queueMicrotask(() => {
        const target = restoreFocusRef?.current ?? previousFocusRef.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [request.toolCallId, restoreFocusRef]);

  // Escape 仅在焦点位于卡片内时生效（卡片级快捷键，非全局劫持）
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      respondRef.current(false);
    }
  }, []);

  const argsText = useMemo(() => {
    if (!request.arguments || Object.keys(request.arguments).length === 0) return null;
    return JSON.stringify(request.arguments, null, 2);
  }, [request.arguments]);
  const argsNeedTruncation = !!argsText && argsText.length > ARGS_TRUNCATE_THRESHOLD;

  const titleId = `plan-gate-title-${request.planId}`;
  const descId = `plan-gate-desc-${request.planId}`;
  const countdownId = `plan-gate-countdown-${request.planId}`;
  const isCountdownUrgent = remaining <= COUNTDOWN_URGENT_THRESHOLD && remaining > 0 && !timedOut;

  return (
    <div
      ref={cardRef}
      className={cn(
        'rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 space-y-2',
        className,
      )}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={`${descId} ${countdownId}`}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-testid="plan-gate-card"
    >
      {/* Row 1: 标题 + 倒计时（对齐审批栏：图标 + 名称居左，倒计时居右） */}
      <div className="flex flex-wrap items-center gap-2">
        <Warning size={16} className="shrink-0 text-warning" weight="fill" aria-hidden="true" />
        <span id={titleId} className="text-sm font-medium truncate">
          {t('authority.planGate.title', '确认执行计划')}
        </span>
        <div
          id={countdownId}
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 text-xs transition-colors duration-150',
            isCountdownUrgent || timedOut ? 'font-medium text-warning' : 'text-muted-foreground',
          )}
          role="status"
          aria-live="polite"
          data-testid="plan-gate-countdown"
        >
          <Clock size={14} aria-hidden="true" />
          {timedOut ? (
            <span>{t('authority.planGate.timedOut', '已超时，自动拒绝')}</span>
          ) : (
            <span className="tabular-nums">
              {t('authority.planGate.countdown', '{{seconds}} 秒后自动拒绝', {
                seconds: remaining,
              })}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: 摘要 + 工具 chip */}
      <div className="space-y-1">
        <p
          id={descId}
          className="m-0 text-xs text-muted-foreground whitespace-pre-wrap break-words"
        >
          {request.summary || t('authority.planGate.fallbackSummary', '模型准备执行写操作')}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{t('authority.planGate.tool', '工具')}</span>
          <code className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono">
            {request.toolName}
          </code>
        </div>
      </div>

      {/* Row 3: 参数预览（可折叠，与审批栏一致） */}
      {argsText && (
        <div>
          <CustomScrollArea
            orientation="both"
            fullHeight={false}
            className={cn('rounded bg-muted', isArgsExpanded ? 'max-h-40' : 'max-h-16')}
            viewportClassName={isArgsExpanded ? 'max-h-40' : 'max-h-16'}
          >
            <pre className="m-0 px-2 py-1 text-xs font-mono text-muted-foreground">
              {isArgsExpanded || !argsNeedTruncation
                ? argsText
                : argsText.slice(0, ARGS_TRUNCATE_THRESHOLD) + ' …'}
            </pre>
          </CustomScrollArea>
          {argsNeedTruncation && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setIsArgsExpanded((prev) => !prev)}
              className="mt-0.5 flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              {isArgsExpanded ? (
                <>
                  <CaretUp size={10} />
                  {t('approval.collapseArgs', '收起')}
                </>
              ) : (
                <>
                  <CaretDown size={10} />
                  {t('approval.expandArgs', '展开')}
                </>
              )}
            </DsButton>
          )}
        </div>
      )}

      {/* Row 4: 操作按钮（层级对齐审批栏：拒绝 outline destructive，确认 success 实底） */}
      <div className="flex items-center justify-end gap-2">
        <DsButton
          ref={rejectButtonRef}
          variant="outline"
          size="sm"
          disabled={busy || timedOut}
          onClick={() => void respond(false)}
          aria-label={t('authority.planGate.reject', '拒绝')}
          className="text-destructive hover:text-destructive/80"
        >
          <XCircle size={14} className="mr-1" aria-hidden="true" />
          {t('authority.planGate.reject', '拒绝')}
        </DsButton>
        <DsButton
          size="sm"
          disabled={busy || timedOut}
          onClick={() => void respond(true)}
          aria-label={t('authority.planGate.approve', '确认执行')}
          className="bg-success text-success-foreground"
        >
          {busy && !timedOut ? (
            <CircleNotch size={14} className="mr-1 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle size={14} className="mr-1" aria-hidden="true" />
          )}
          {t('authority.planGate.approve', '确认执行')}
        </DsButton>
      </div>
    </div>
  );
};

export default PlanGateCard;
