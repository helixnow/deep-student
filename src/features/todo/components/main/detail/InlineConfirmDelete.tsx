/**
 * InlineConfirmDelete — 危险操作的内联二次确认（无 Dialog）
 *
 * 首次点击把按钮原位展开为「确认删除？ [删除] [取消]」，
 * 6 秒无操作 / Esc / 点取消自动收回。确认态自动聚焦取消按钮（误触安全默认）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';

const AUTO_DISMISS_MS = 12000;

export const InlineConfirmDelete: React.FC<{
  label: string;
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}> = ({ label, question, confirmLabel, cancelLabel, onConfirm }) => {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!confirming) return;
    cancelRef.current?.focus();
    timerRef.current = window.setTimeout(() => setConfirming(false), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [confirming]);

  return (
    <div
      className="flex items-center justify-end"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirming) {
          // 确认态下 Esc 只收回确认条，不冒泡关闭整个面板
          e.preventDefault();
          e.stopPropagation();
          setConfirming(false);
        }
      }}
    >
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[color:hsl(var(--destructive))]" role="alert">
            {question}
          </span>
          <DsButton
            variant="danger"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
              onConfirm();
            }}
            className="gap-1.5 [@media(pointer:coarse)]:!min-h-11"
          >
            <Trash size={14} />
            {confirmLabel}
          </DsButton>
          <DsButton
            ref={cancelRef}
            variant="utility"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {cancelLabel}
          </DsButton>
        </div>
      ) : (
        <DsButton
          variant="danger"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          className="gap-1.5 [@media(pointer:coarse)]:!min-h-11"
        >
          <Trash size={16} />
          {label}
        </DsButton>
      )}
    </div>
  );
};

export default InlineConfirmDelete;
