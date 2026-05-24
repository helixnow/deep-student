/**
 * MessageActions - 消息操作按钮组件
 */
import React, { useCallback, useState } from 'react';
import { CopySimple, Check, ArrowCounterClockwise, Trash, PencilSimple, Bug, BookmarkSimple, GitBranch, DotsThree } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { IconSwap } from '@/components/ui/IconSwap';
import { AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem, AppMenuSeparator } from '@/components/ui/app-menu/AppMenu';

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
  /** 移动端紧凑模式：仅展示主操作，其余进入更多菜单 */
  compactMobile?: boolean;
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
  compactMobile = false,
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

  const compactButtonClassName = compactMobile
    ? '!h-9 !w-9 rounded-full [&_svg]:h-[14px] [&_svg]:w-[14px]'
    : undefined;

  const actionsMenu = (
    <AppMenu>
      <AppMenuTrigger asChild>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('common.more', '更多操作')}
          title={t('common.more', '更多操作')}
          className={compactButtonClassName}
        >
          <DotsThree className="w-4 h-4" weight="bold" />
        </NotionButton>
      </AppMenuTrigger>
      <AppMenuContent
        align="end"
        width={compactMobile ? 168 : 188}
        className={compactMobile ? '[&_.app-menu-item]:text-[12px] [&_.app-menu-item]:py-1.5 [&_.app-menu-item-icon_svg]:h-3.5 [&_.app-menu-item-icon_svg]:w-3.5' : undefined}
      >
        {!isUser && onRetry && (
          <AppMenuItem onClick={handleRetry} disabled={isLocked || isRetrying} icon={<ArrowCounterClockwise size={16} />}>
            {t('messageItem.actions.retry')}
          </AppMenuItem>
        )}
        {isUser && onResend && (
          <AppMenuItem onClick={handleResend} disabled={isLocked || isResending} icon={<ArrowCounterClockwise size={16} />}>
            {t('messageItem.actions.resend')}
          </AppMenuItem>
        )}
        {isUser && onEdit && (
          <AppMenuItem onClick={onEdit} disabled={!canEdit} icon={<PencilSimple size={16} />}>
            {t('messageItem.actions.edit')}
          </AppMenuItem>
        )}
        {onSaveAsNote && (
          <AppMenuItem onClick={handleSaveAsNote} disabled={isSavingNote} icon={<BookmarkSimple size={16} />}>
            {t('messageItem.actions.saveAsNote')}
          </AppMenuItem>
        )}
        {onBranchSession && (
          <AppMenuItem onClick={handleBranch} disabled={isBranching || isLocked} icon={<GitBranch size={16} />}>
            {t('messageItem.actions.branch', '从此处分支')}
          </AppMenuItem>
        )}
        {onCopyDebug && (
          <AppMenuItem onClick={handleCopyDebug} icon={<Bug size={16} />}>
            {t('debug.copyDebugInfo', '复制调试信息')}
          </AppMenuItem>
        )}
        <AppMenuSeparator />
        <AppMenuItem
          onClick={() => setDeleteConfirmOpen(true)}
          disabled={!canDelete || isDeleting}
          destructive
          icon={<Trash size={16} />}
        >
          {t('messageItem.actions.delete')}
        </AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  );

  if (compactMobile) {
    return (
      <>
        <div className={cn('flex items-center gap-0.5', className)}>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            className={compactButtonClassName}
            onClick={handleCopy}
            aria-label={t('messageItem.actions.copy')}
            title={t('messageItem.actions.copy')}
          >
            <IconSwap
              active={copied}
              a={<CopySimple className="w-4 h-4" />}
              b={<Check className="w-4 h-4 text-green-500" />}
            />
          </NotionButton>
          {actionsMenu}
        </div>
        <NotionAlertDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          title={t('messageItem.actions.deleteConfirmTitle', '确认删除')}
          description={t('messageItem.actions.deleteConfirmDesc', '确定要删除这条消息吗？此操作无法撤销。')}
          icon={<Trash className="h-5 w-5 text-red-500" />}
          confirmText={t('messageItem.actions.delete', '删除')}
          cancelText={t('common.cancel', '取消')}
          confirmVariant="danger"
          onConfirm={() => { setDeleteConfirmOpen(false); handleDelete(); }}
        />
      </>
    );
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* 复制按钮 */}
      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
        <IconSwap
          active={copied}
          a={<CopySimple className="w-4 h-4" />}
          b={<Check className="w-4 h-4 text-green-500" />}
        />
      </NotionButton>

      {/* 🆕 保存为笔记按钮（仅助手消息） */}
      {onSaveAsNote && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleSaveAsNote} disabled={isSavingNote} aria-label={t('messageItem.actions.saveAsNote')} title={t('messageItem.actions.saveAsNote')}>
          <BookmarkSimple className={cn('w-4 h-4', isSavingNote && 'animate-pulse')} />
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
          <IconSwap
            active={debugCopied}
            a={<Bug className="w-4 h-4" />}
            b={<Check className="w-4 h-4 text-green-500" />}
          />
        </NotionButton>
      )}

      {/* 重试按钮（仅助手消息） */}
      {!isUser && onRetry && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRetry} disabled={isLocked || isRetrying} aria-label={t('messageItem.actions.retry')} title={t('messageItem.actions.retry')}>
          <ArrowCounterClockwise className={cn('w-4 h-4', isRetrying && 'animate-spin')} />
        </NotionButton>
      )}

      {/* 重新发送按钮（仅用户消息） */}
      {isUser && onResend && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleResend} disabled={isLocked || isResending} aria-label={t('messageItem.actions.resend')} title={t('messageItem.actions.resend')}>
          <ArrowCounterClockwise className={cn('w-4 h-4', isResending && 'animate-spin')} />
        </NotionButton>
      )}

      {/* 编辑按钮（仅用户消息） */}
      {isUser && onEdit && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onEdit} disabled={!canEdit} aria-label={t('messageItem.actions.edit')} title={t('messageItem.actions.edit')}>
          <PencilSimple className="w-4 h-4" />
        </NotionButton>
      )}

      {/* 删除按钮 - 带二次确认 */}
      <NotionButton variant="ghost" size="icon" iconOnly disabled={!canDelete || isDeleting} className={cn(!canDelete || isDeleting ? '' : 'hover:text-destructive')} aria-label={t('messageItem.actions.delete')} title={t('messageItem.actions.delete')} onClick={() => setDeleteConfirmOpen(true)}>
        <Trash className={cn('w-4 h-4', isDeleting && 'animate-pulse')} />
      </NotionButton>
      <NotionAlertDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('messageItem.actions.deleteConfirmTitle', '确认删除')}
        description={t('messageItem.actions.deleteConfirmDesc', '确定要删除这条消息吗？此操作无法撤销。')}
        icon={<Trash className="h-5 w-5 text-red-500" />}
        confirmText={t('messageItem.actions.delete', '删除')}
        cancelText={t('common.cancel', '取消')}
        confirmVariant="danger"
        onConfirm={() => { setDeleteConfirmOpen(false); handleDelete(); }}
      />
    </div>
  );
};

export default MessageActions;
