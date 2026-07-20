/**
 * InlineConfirmDelete — 危险操作的内联二次确认（无 Dialog）
 *
 * 首次点击把按钮原位展开为「确认删除？ [删除] [取消]」，
 * 6 秒无操作 / Esc / 点取消自动收回。确认态自动聚焦取消按钮（误触安全默认）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Trash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { tweenFast, transitionInstant } from '@/styles/motion-springs';

const AUTO_DISMISS_MS = 6000;

export const InlineConfirmDelete: React.FC<{
  label: string;
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}> = ({ label, question, confirmLabel, cancelLabel, onConfirm }) => {
  const prefersReducedMotion = useReducedMotion();
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

  const transition = prefersReducedMotion ? transitionInstant : tweenFast;

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
      <AnimatePresence mode="wait" initial={false}>
        {confirming ? (
          <motion.div
            key="confirm"
            initial={prefersReducedMotion ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, x: 8 }}
            transition={transition}
            className="flex items-center gap-2"
          >
            <span className="text-xs text-[color:hsl(var(--destructive))]" role="alert">
              {question}
            </span>
            <DsButton variant="danger" size="sm" onClick={onConfirm} className="gap-1.5">
              <Trash size={14} />
              {confirmLabel}
            </DsButton>
            <DsButton
              ref={cancelRef}
              variant="utility"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              {cancelLabel}
            </DsButton>
          </motion.div>
        ) : (
          <motion.div
            key="trigger"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0 }}
            transition={transition}
          >
            <DsButton
              variant="danger"
              size="sm"
              onClick={() => setConfirming(true)}
              className="gap-1.5"
            >
              <Trash size={16} />
              {label}
            </DsButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default InlineConfirmDelete;
