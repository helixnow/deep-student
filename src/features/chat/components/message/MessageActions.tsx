/**
 * MessageActions - 消息操作按钮组件
 */
import React, { useCallback, useState } from 'react';
import { CopySimple, Check, ArrowCounterClockwise, Trash, PencilSimple, BookmarkSimple, GitBranch, DotsThree } from '@phosphor-icons/react';
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
  alwaysExpanded?: boolean;
  anchorCopyToEnd?: boolean;
  onCopy: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onResend?: () => Promise<void>;
  onEdit?: () => void;
  onDelete: () => Promise<void>;
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
  alwaysExpanded = false,
  anchorCopyToEnd = false,
  onCopy,
  onRetry,
  onResend,
  onEdit,
  onDelete,
  onSaveAsNote,
  onBranchSession,
  compactMobile = false,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
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

  const showInlineCopyOnly = !compactMobile;
  const showInlineRetry = !compactMobile && !isUser && Boolean(onRetry);
  const showInlineEdit = !compactMobile && isUser && Boolean(onEdit);
  const hasSecondaryActions = Boolean(
    canDelete ||
    onSaveAsNote ||
    onBranchSession ||
    (isUser && onResend) ||
    (!isUser && onRetry && !showInlineRetry)
  );
  const showOverflowMenu = compactMobile || hasSecondaryActions;
  const showDesktopSecondaryActions = compactMobile || alwaysExpanded;
  const desktopSecondaryActionsClassName = showDesktopSecondaryActions
    ? 'flex items-center gap-0.5 transition-opacity'
    : 'flex items-center gap-0.5 transition-opacity md:pointer-events-none md:w-0 md:overflow-hidden md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:w-auto md:group-hover:overflow-visible md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:w-auto md:group-focus-within:overflow-visible md:group-focus-within:opacity-100';
  const desktopCopyButton = showInlineCopyOnly ? (
    <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
      <IconSwap
        active={copied}
        a={<CopySimple className="w-4 h-4" />}
        b={<Check className="w-4 h-4 text-green-500" />}
      />
    </NotionButton>
  ) : null;

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
        {!isUser && onRetry && !showInlineRetry && (
          <AppMenuItem onClick={handleRetry} disabled={isLocked || isRetrying} icon={<ArrowCounterClockwise size={16} />}>
            {t('messageItem.actions.retry')}
          </AppMenuItem>
        )}
        {isUser && onResend && (
          <AppMenuItem onClick={handleResend} disabled={isLocked || isResending} icon={<ArrowCounterClockwise size={16} />}>
            {t('messageItem.actions.resend')}
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
    <div className={cn('flex items-center gap-0.5', className)}>
      {!anchorCopyToEnd && desktopCopyButton}

      <div className={desktopSecondaryActionsClassName}>
        {showInlineRetry && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRetry} disabled={isLocked || isRetrying} aria-label={t('messageItem.actions.retry')} title={t('messageItem.actions.retry')}>
            <ArrowCounterClockwise className={cn('w-4 h-4', isRetrying && 'animate-spin')} />
          </NotionButton>
        )}

        {showInlineEdit && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onEdit} disabled={!canEdit} aria-label={t('messageItem.actions.edit')} title={t('messageItem.actions.edit')}>
            <PencilSimple className="w-4 h-4" />
          </NotionButton>
        )}

        {showOverflowMenu && actionsMenu}
      </div>
      {anchorCopyToEnd && desktopCopyButton}
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
