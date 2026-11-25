/**
 * InlineConfirmDelete — 危险操作的内联二次确认（无 Dialog）
 *
 * 首次点击把按钮原位展开为「确认删除？ [删除] [取消]」，
 * 12 秒无操作 / Esc / 点取消自动收回。确认态自动聚焦取消按钮（误触安全默认）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';

const AUTO_DISMISS_MS = 12000;

export const InlineConfirmDelete: React.FC<{
  label: string;
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** 确认态变化通知（宿主可据此释放底部栏宽度，避免确认条被挤压成竖排） */
  onConfirmingChange?: (confirming: boolean) => void;
  className?: string;
}> = ({ label, question, confirmLabel, cancelLabel, onConfirm, onConfirmingChange, className }) => {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const onConfirmingChangeRef = useRef(onConfirmingChange);
  onConfirmingChangeRef.current = onConfirmingChange;

  const setConfirmingState = useCallback((next: boolean) => {
    setConfirming(next);
    onConfirmingChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    cancelRef.current?.focus({ preventScroll: true });
    timerRef.current = window.setTimeout(() => setConfirmingState(false), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [confirming, setConfirmingState]);

  useEffect(() => {
    return () => {
      onConfirmingChangeRef.current?.(false);
    };
  }, []);

  return (
    <div
      className={cn(
        'flex items-center',
        confirming ? 'w-full min-w-0' : 'shrink-0 justify-end',
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirming) {
          // 确认态下 Esc 只收回确认条，不冒泡关闭整个面板
          e.preventDefault();
          e.stopPropagation();
          setConfirmingState(false);
        }
      }}
    >
      {confirming ? (
        <div
          data-testid="inline-confirm-delete-bar"
          className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[var(--radius-shell-control)] border border-[color:hsl(var(--destructive))]/25 bg-[color:hsl(var(--destructive))]/[0.06] px-2.5 py-1.5"
        >
          <span
            className="shrink-0 whitespace-nowrap text-xs font-medium text-[color:hsl(var(--destructive))]"
            role="alert"
          >
            {question}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
            <DsButton
              type="button"
              variant="danger"
              size="sm"
              data-testid="inline-confirm-delete-confirm"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingState(false);
                onConfirm();
              }}
              className="shrink-0 whitespace-nowrap gap-1.5 [@media(pointer:coarse)]:!min-h-11"
            >
              <Trash size={14} />
              {confirmLabel}
            </DsButton>
            <DsButton
              ref={cancelRef}
              type="button"
              variant="utility"
              size="sm"
              data-testid="inline-confirm-delete-cancel"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingState(false);
              }}
              className="shrink-0 whitespace-nowrap [@media(pointer:coarse)]:!min-h-11"
            >
              {cancelLabel}
            </DsButton>
          </div>
        </div>
      ) : (
        <DsButton
          type="button"
          variant="danger"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingState(true);
          }}
          className="shrink-0 whitespace-nowrap gap-1.5 [@media(pointer:coarse)]:!min-h-11"
        >
          <Trash size={16} />
          {label}
        </DsButton>
      )}
    </div>
  );
};

export default InlineConfirmDelete;
