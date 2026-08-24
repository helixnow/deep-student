/**
 * 多选浮动操作条：完成 / 缩进 / 反缩进 / 复制 / 折叠 / 删除 / 清除选择。
 * 内容区内 absolute 浮层，非模态；删除走两段式内联确认（无弹窗），
 * 6 秒无操作 / Esc / 点取消自动收回。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowsInLineVertical,
  CheckCircle,
  Copy,
  TextIndent,
  TextOutdent,
  Trash,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { tweenFast, transitionInstant } from '@/styles/motion-springs';

const DELETE_CONFIRM_AUTO_DISMISS_MS = 6000;

export interface OutlineMultiselectBarProps {
  count: number;
  onComplete: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onCopy: () => void;
  onCollapse: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export const OutlineMultiselectBar: React.FC<OutlineMultiselectBarProps> = ({
  count,
  onComplete,
  onIndent,
  onOutdent,
  onCopy,
  onCollapse,
  onDelete,
  onClear,
}) => {
  const { t } = useTranslation('mindmap');
  const prefersReducedMotion = useReducedMotion();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const transition = prefersReducedMotion ? transitionInstant : tweenFast;

  // 选中集变化视为新意图，收回确认态；确认态聚焦取消（误触安全默认）+ 超时自动收回
  useEffect(() => {
    setConfirmingDelete(false);
  }, [count]);

  useEffect(() => {
    if (!confirmingDelete) return;
    cancelRef.current?.focus();
    const timer = window.setTimeout(
      () => setConfirmingDelete(false),
      DELETE_CONFIRM_AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  return (
    <div
      className="outline-multiselect-bar"
      role="toolbar"
      aria-label={t('outline.selectedCount', { count })}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirmingDelete) {
          // 确认态下 Esc 只收回确认条，不冒泡到「清除选择」
          e.preventDefault();
          e.stopPropagation();
          setConfirmingDelete(false);
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {confirmingDelete ? (
          <motion.div
            key="confirm"
            className="flex items-center gap-2"
            initial={prefersReducedMotion ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, x: 8 }}
            transition={transition}
          >
            <span
              className="text-xs text-[color:hsl(var(--destructive))] px-1"
              role="alert"
            >
              {t('outlineV2.deleteConfirmCount', {
                count,
                defaultValue: '删除 {{count}} 项及其子节点？',
              })}
            </span>
            <DsButton
              variant="danger"
              size="sm"
              className="gap-1.5 [@media(pointer:coarse)]:!min-h-11"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              <Trash size={14} />
              {t('outlineV2.confirmDelete', { defaultValue: '删除' })}
            </DsButton>
            <DsButton
              ref={cancelRef}
              variant="utility"
              size="sm"
              className="[@media(pointer:coarse)]:!min-h-11"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('outlineV2.cancel', { defaultValue: '取消' })}
            </DsButton>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            className="flex items-center gap-1"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0 }}
            transition={transition}
          >
            <span className="outline-multiselect-count">
              {t('outline.selectedCount', { count })}
            </span>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11"
              onClick={onComplete}
              title={t('outline.batchComplete')}
            >
              <CheckCircle size={16} />
              <span>{t('outline.batchComplete')}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11"
              onClick={onIndent}
              title={`${t('mindmap:outline.batchIndent', { defaultValue: '缩进' })} (Tab)`}
            >
              <TextIndent size={16} />
              <span>{t('mindmap:outline.batchIndent', { defaultValue: '缩进' })}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11"
              onClick={onOutdent}
              title={`${t('mindmap:outline.batchOutdent', { defaultValue: '反缩进' })} (Shift+Tab)`}
            >
              <TextOutdent size={16} />
              <span>{t('mindmap:outline.batchOutdent', { defaultValue: '反缩进' })}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11"
              onClick={onCopy}
              title={t('mindmap:outline.batchCopy', { defaultValue: '复制' })}
            >
              <Copy size={16} />
              <span>{t('mindmap:outline.batchCopy', { defaultValue: '复制' })}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11"
              onClick={onCollapse}
              title={t('mindmap:outline.batchCollapse', { defaultValue: '折叠' })}
            >
              <ArrowsInLineVertical size={16} />
              <span>{t('mindmap:outline.batchCollapse', { defaultValue: '折叠' })}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn destructive [@media(pointer:coarse)]:!min-h-11"
              onClick={() => setConfirmingDelete(true)}
              title={t('actions.delete')}
            >
              <Trash size={16} />
              <span>{t('actions.delete')}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="outline-multiselect-btn [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={onClear}
              title={t('outline.clearSelection')}
              aria-label={t('outline.clearSelection')}
            >
              <X size={16} />
            </DsButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
