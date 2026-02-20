/**
 * MessageActions - 消息操作按钮组件
 */
import React, { useCallback, useState } from 'react';
import { Copy, Check, RotateCcw, Trash2, Edit3, Bug, BookmarkPlus, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';

export interface MessageActionsProps {
  messageId: string;
  isUser: boolean;
  isLocked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onCopy: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onResend?: () => Promise<void>;
  onEdit?: () => void;
  onDelete: () => Promise<void>;
  /** 🆕 复制调试信息回调 */
  onCopyDebug?: () => Promise<void>;
  /** 🆕 保存为 VFS 笔记 */
  onSaveAsNote?: () => Promise<void>;
  /** 🆕 会话分支 */
  onBranchSession?: () => Promise<void>;
  className?: string;
}

export const MessageActions: React.FC<MessageActionsProps> = ({
  messageId,
  isUser,
  isLocked,
  canEdit,
  canDelete,
  onCopy,
  onRetry,
  onResend,
  onEdit,
  onDelete,
  onSaveAsNote,
  onBranchSession,
  onCopyDebug,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isBranching, setIsBranching] = useState(false);

  const handleCopy = useCallback(async () => {
    if (copied) return;
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copied, onCopy]);

  // 🆕 保存为笔记
  const handleSaveAsNote = useCallback(async () => {
    if (!onSaveAsNote || isSavingNote) return;
    setIsSavingNote(true);
    try {
      await onSaveAsNote();
    } finally {
      setIsSavingNote(false);
    }
  }, [onSaveAsNote, isSavingNote]);

  // 🆕 会话分支
  const handleBranch = useCallback(async () => {
    if (!onBranchSession || isBranching) return;
    setIsBranching(true);
    try {
      await onBranchSession();
    } finally {
      setIsBranching(false);
    }
  }, [onBranchSession, isBranching]);

  // 🆕 复制调试信息
  const handleCopyDebug = useCallback(async () => {
    if (debugCopied || !onCopyDebug) return;
    await onCopyDebug();
    setDebugCopied(true);
    setTimeout(() => setDebugCopied(false), 2000);
  }, [debugCopied, onCopyDebug]);

  const handleRetry = useCallback(async () => {
    if (!onRetry || isLocked || isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry, isLocked, isRetrying]);

  const handleResend = useCallback(async () => {
    if (!onResend || isLocked || isResending) return;
    setIsResending(true);
    try {
      await onResend();
    } finally {
      setIsResending(false);
    }
  }, [onResend, isLocked, isResending]);

  const handleDelete = useCallback(async () => {
    if (!canDelete || isDeleting) return;
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
    }
  }, [canDelete, isDeleting, onDelete]);

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* 复制按钮 */}
      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
        {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
      </NotionButton>

      {/* 🆕 保存为笔记按钮（仅助手消息） */}
      {onSaveAsNote && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleSaveAsNote} disabled={isSavingNote} aria-label={t('messageItem.actions.saveAsNote')} title={t('messageItem.actions.saveAsNote')}>
          <BookmarkPlus className={cn('w-4 h-4', isSavingNote && 'animate-pulse')} />
        </NotionButton>
      )}

      {/* 🆕 会话分支按钮 */}
      {onBranchSession && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleBranch} disabled={isBranching || isLocked} aria-label={t('messageItem.actions.branch', '从此处分支')} title={t('messageItem.actions.branch', '从此处分支')}>
          <GitBranch className={cn('w-4 h-4', isBranching && 'animate-pulse')} />
        </NotionButton>
      )}

      {/* 🆕 复制调试信息按钮 */}
      {onCopyDebug && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopyDebug} aria-label={t('debug.copyDebugInfo', '复制调试信息')} title={t('debug.copyDebugInfo', '复制调试信息')}>
          {debugCopied ? <Check className="w-4 h-4 text-green-500" /> : <Bug className="w-4 h-4" />}
        </NotionButton>
      )}

      {/* 重试按钮（仅助手消息） */}
      {!isUser && onRetry && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRetry} disabled={isLocked || isRetrying} aria-label={t('messageItem.actions.retry')} title={t('messageItem.actions.retry')}>
          <RotateCcw className={cn('w-4 h-4', isRetrying && 'animate-spin')} />
        </NotionButton>
      )}

      {/* 重新发送按钮（仅用户消息） */}
      {isUser && onResend && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleResend} disabled={isLocked || isResending} aria-label={t('messageItem.actions.resend')} title={t('messageItem.actions.resend')}>
          <RotateCcw className={cn('w-4 h-4', isResending && 'animate-spin')} />
        </NotionButton>
      )}

      {/* 编辑按钮（仅用户消息） */}
      {isUser && onEdit && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onEdit} disabled={!canEdit} aria-label={t('messageItem.actions.edit')} title={t('messageItem.actions.edit')}>
          <Edit3 className="w-4 h-4" />
        </NotionButton>
      )}

      {/* 删除按钮 - 带二次确认 */}
      <NotionButton variant="ghost" size="icon" iconOnly disabled={!canDelete || isDeleting} className={cn(!canDelete || isDeleting ? '' : 'hover:text-destructive')} aria-label={t('messageItem.actions.delete')} title={t('messageItem.actions.delete')} onClick={() => setDeleteConfirmOpen(true)}>
        <Trash2 className={cn('w-4 h-4', isDeleting && 'animate-pulse')} />
      </NotionButton>
      <NotionAlertDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('messageItem.actions.deleteConfirmTitle', '确认删除')}
        description={t('messageItem.actions.deleteConfirmDesc', '确定要删除这条消息吗？此操作无法撤销。')}
        icon={<Trash2 className="h-5 w-5 text-red-500" />}
        confirmText={t('messageItem.actions.delete', '删除')}
        cancelText={t('common.cancel', '取消')}
        confirmVariant="danger"
        onConfirm={() => { setDeleteConfirmOpen(false); handleDelete(); }}
      />
    </div>
  );
};

export default MessageActions;
