/**
 * MessageTouchActionBar — 移动端长按消息呼出的内联操作条（P0-2）
 *
 * 契约：非 Sheet / 非 Portal / 非模态。操作条插在消息 DOM 流内（消息下方），
 * 用 .chat-collapse 栅格行高过渡做轻量展开动画（reduced-motion 下自动关闭）。
 *
 * 操作：复制 / 编辑（用户消息）/ 重试（助手消息）/ 删除（行内两步确认）。
 * 删除确认 3.5s 未二次点击自动复原；点击操作条外任意位置或 Escape 关闭。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CopySimple, Check, ArrowCounterClockwise, PencilSimple, Trash, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { IconSwap } from '@/components/ui/IconSwap';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

export interface MessageTouchActionBarProps {
  /** 是否展开 */
  open: boolean;
  /** 是否用户消息（决定 编辑 vs 重试） */
  isUser: boolean;
  /** 会话锁定（流式中）时禁用重试/删除 */
  isLocked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onCopy: () => Promise<void>;
  onEdit?: () => void;
  onRetry?: () => Promise<void>;
  onDelete: () => Promise<void>;
  /** 关闭操作条（外点 / Escape / 操作完成后调用） */
  onClose: () => void;
}

const DELETE_ARM_TIMEOUT_MS = 3500;

export const MessageTouchActionBar: React.FC<MessageTouchActionBarProps> = ({
  open,
  isUser,
  isLocked,
  canEdit,
  canDelete,
  onCopy,
  onEdit,
  onRetry,
  onDelete,
  onClose,
}) => {
  const { t } = useTranslation('chatV2');
  const rootRef = useRef<HTMLDivElement>(null);

  const [copied, setCopied] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    if (deleteArmTimerRef.current) clearTimeout(deleteArmTimerRef.current);
  }, []);

  const disarmDelete = useCallback(() => {
    if (deleteArmTimerRef.current) {
      clearTimeout(deleteArmTimerRef.current);
      deleteArmTimerRef.current = null;
    }
    setDeleteArmed(false);
  }, []);

  // 关闭时复位内部瞬态，避免下次打开残留"确认删除"红态
  useEffect(() => {
    if (!open) {
      disarmDelete();
      setCopied(false);
    }
  }, [open, disarmDelete]);

  // 📱 Android 系统返回键：操作条展开时先收起操作条（overlay 级），避免返回键
  // 穿透直接切走聊天视图；模式与 InputBarUI 组合面板 / DsDialog 的注册一致
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);

  // 外点关闭（pointerdown：触摸滚动/拖选不产生 mousedown）+ Escape 关闭
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const handleCopy = useCallback(async () => {
    if (copied) return;
    try {
      await onCopy();
    } catch {
      return; // 失败提示由 onCopy 内部展示，不显示成功对勾
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
      onClose();
    }, 900);
  }, [copied, onCopy, onClose]);

  const handleEdit = useCallback(() => {
    if (!onEdit || !canEdit) return;
    onClose();
    onEdit();
  }, [onEdit, canEdit, onClose]);

  const handleRetry = useCallback(async () => {
    if (!onRetry || isLocked || isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
      onClose();
    }
  }, [onRetry, isLocked, isRetrying, onClose]);

  // 行内两步删除：第一次点击进入红色「确认删除」，超时自动复原
  const handleDelete = useCallback(async () => {
    if (!canDelete || isDeleting) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      deleteArmTimerRef.current = setTimeout(() => {
        deleteArmTimerRef.current = null;
        setDeleteArmed(false);
      }, DELETE_ARM_TIMEOUT_MS);
      return;
    }
    disarmDelete();
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
      onClose();
    }
  }, [canDelete, isDeleting, deleteArmed, disarmDelete, onDelete, onClose]);

  const barButtonClassName =
    'flex-1 min-w-0 justify-center gap-1.5 !px-2 text-ui [@media(pointer:coarse)]:!min-h-11';

  return (
    <div
      ref={rootRef}
      className="chat-collapse"
      data-open={open ? 'true' : 'false'}
      data-slot="message-touch-action-bar"
      aria-hidden={!open}
    >
      <div className={cn(!open && 'pointer-events-none')}>
        <div
          role="toolbar"
          aria-label={t('messageItem.touchBar.ariaLabel')}
          className={cn(
            'mt-2 flex items-stretch gap-1 rounded-2xl border p-1',
            'border-[color:var(--composer-panel-border,hsl(var(--border)))]',
            'bg-[color:var(--surface-root,hsl(var(--background)))]',
            'shadow-[var(--shadow-shell-soft)]'
          )}
        >
          <DsButton
            variant="ghost"
            size="sm"
            className={barButtonClassName}
            onClick={handleCopy}
            tabIndex={open ? 0 : -1}
            aria-label={t('messageItem.actions.copy')}
          >
            <IconSwap
              active={copied}
              a={<CopySimple className="h-4 w-4" />}
              b={<Check className="h-4 w-4 text-success" />}
            />
            <span>{t('messageItem.actions.copy')}</span>
          </DsButton>

          {isUser && onEdit && (
            <DsButton
              variant="ghost"
              size="sm"
              className={barButtonClassName}
              onClick={handleEdit}
              disabled={!canEdit}
              tabIndex={open ? 0 : -1}
              aria-label={t('messageItem.actions.edit')}
            >
              <PencilSimple className="h-4 w-4" />
              <span>{t('messageItem.actions.edit')}</span>
            </DsButton>
          )}

          {!isUser && onRetry && (
            <DsButton
              variant="ghost"
              size="sm"
              className={barButtonClassName}
              onClick={handleRetry}
              disabled={isLocked || isRetrying}
              tabIndex={open ? 0 : -1}
              aria-label={t('messageItem.actions.retry')}
            >
              <ArrowCounterClockwise className={cn('h-4 w-4', isRetrying && 'animate-spin')} />
              <span>{t('messageItem.actions.retry')}</span>
            </DsButton>
          )}

          <DsButton
            variant="ghost"
            size="sm"
            className={cn(
              barButtonClassName,
              deleteArmed
                ? '!bg-destructive/10 !text-destructive font-medium'
                : 'hover:!text-destructive'
            )}
            onClick={handleDelete}
            disabled={!canDelete || isDeleting}
            tabIndex={open ? 0 : -1}
            aria-live="polite"
            aria-label={deleteArmed ? t('messageItem.actions.deleteConfirmTitle') : t('messageItem.actions.delete')}
          >
            <Trash className={cn('h-4 w-4', isDeleting && 'animate-pulse')} />
            <span>{deleteArmed ? t('messageItem.actions.deleteConfirmTitle') : t('messageItem.actions.delete')}</span>
          </DsButton>

          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="shrink-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            onClick={deleteArmed ? disarmDelete : onClose}
            tabIndex={open ? 0 : -1}
            aria-label={t('common.cancel')}
            title={t('common.cancel')}
          >
            <X className="h-4 w-4" />
          </DsButton>
        </div>
      </div>
    </div>
  );
};

export default MessageTouchActionBar;
