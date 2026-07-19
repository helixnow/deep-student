/**
 * PlanGateCard — Plan mode batch confirmation (Ask/Plan/Craft).
 * Distinct from ToolApprovalCard: approving binds writes to planId only.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, XCircle, Warning } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const respondRef = useRef<(approved: boolean) => void>(() => undefined);

  useEffect(() => {
    setRemaining(request.timeoutSeconds);
    const timer = window.setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [request.toolCallId, request.timeoutSeconds]);

  const respond = useCallback(
    async (approved: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        await invoke('chat_v2_plan_gate_respond', {
          sessionId,
          planId: request.planId,
          toolCallId: request.toolCallId,
          approved,
          reason: approved ? null : 'user_rejected',
        });
        onResolved?.(approved);
      } catch (error) {
        console.error('[PlanGateCard] Failed to respond:', error);
        setBusy(false);
      }
    },
    [busy, onResolved, request.planId, request.toolCallId, sessionId],
  );
  respondRef.current = (approved) => void respond(approved);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      rejectButtonRef.current?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        respondRef.current(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      queueMicrotask(() => {
        const target = restoreFocusRef?.current ?? previousFocusRef.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [request.toolCallId, restoreFocusRef]);

  const titleId = `plan-gate-title-${request.planId}`;
  const descId = `plan-gate-desc-${request.planId}`;
  const countdownId = `plan-gate-countdown-${request.planId}`;

  return (
    <div
      ref={dialogRef}
      className={cn(
        'rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-3',
        className,
      )}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${descId} ${countdownId}`}
      aria-busy={busy || undefined}
      tabIndex={-1}
      data-testid="plan-gate-card"
    >
      <div className="flex items-start gap-2">
        <Warning className="mt-0.5 shrink-0 text-amber-600" size={18} weight="fill" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div id={titleId} className="text-sm font-medium">
            {t('authority.planGate.title', '确认执行计划')}
          </div>
          <p
            id={descId}
            className="text-xs text-muted-foreground whitespace-pre-wrap break-words"
          >
            {request.summary || t('authority.planGate.fallbackSummary', '模型准备执行写操作')}
          </p>
          <div className="text-[11px] text-muted-foreground/80 truncate">
            {t('authority.planGate.tool', '工具')}: {request.toolName}
          </div>
          <div
            id={countdownId}
            className="text-[11px] text-muted-foreground/70"
            role="status"
            aria-live="polite"
            data-testid="plan-gate-countdown"
          >
            {t('authority.planGate.countdown', '{{seconds}} 秒后自动拒绝', {
              seconds: remaining,
            })}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <NotionButton
          ref={rejectButtonRef}
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void respond(false)}
          aria-label={t('authority.planGate.reject', '拒绝')}
        >
          <XCircle size={14} className="mr-1" aria-hidden="true" />
          {t('authority.planGate.reject', '拒绝')}
        </NotionButton>
        <NotionButton
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => void respond(true)}
          aria-label={t('authority.planGate.approve', '确认执行')}
        >
          <CheckCircle size={14} className="mr-1" aria-hidden="true" />
          {t('authority.planGate.approve', '确认执行')}
        </NotionButton>
      </div>
    </div>
  );
};

export default PlanGateCard;
