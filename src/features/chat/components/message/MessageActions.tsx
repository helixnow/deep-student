/**
 * MessageActions - 消息操作按钮组件
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CopySimple, Check, ArrowCounterClockwise, Trash, PencilSimple, BookmarkSimple, GitBranch, DotsThree, FileArrowDown } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { DsButton } from '@/components/ui/DsButton';
import { IconSwap } from '@/components/ui/IconSwap';
import { AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem, AppMenuSeparator } from '@/components/ui/app-menu/AppMenu';
import { formatTokenCount } from '../TokenUsageDisplay';
import type { TokenUsage } from '../../core/types';

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
  /** 🆕 导出为 Markdown 文件 */
  onExportMarkdown?: () => Promise<void>;
  /** 🆕 会话分支 */
  onBranchSession?: () => Promise<void>;
  /** 移动端紧凑模式：仅展示主操作，其余进入更多菜单 */
  compactMobile?: boolean;
  /** M-1: 移动端 Token 用量入口——桌面在操作行内联展示，移动端放进更多菜单 */
  tokenUsage?: TokenUsage;
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
  onExportMarkdown,
  onBranchSession,
  compactMobile = false,
  tokenUsage,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isBranching, setIsBranching] = useState(false);

  // P1-1 内联两步删除确认（无模态框）：
  // 第一次点击「删除」将菜单项切换为红色「确认删除」，3.5s 内未确认自动复原；
  // 菜单为受控模式，arming 那一次点击不关闭菜单，其余交互保持原生关闭行为
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const suppressMenuCloseRef = useRef(false);
  const deleteArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmDelete = useCallback(() => {
    if (deleteArmTimerRef.current) {
      clearTimeout(deleteArmTimerRef.current);
      deleteArmTimerRef.current = null;
    }
    setDeleteArmed(false);
  }, []);

  useEffect(() => () => {
    if (deleteArmTimerRef.current) clearTimeout(deleteArmTimerRef.current);
  }, []);

  const handleMenuOpenChange = useCallback((next: boolean) => {
    if (!next && suppressMenuCloseRef.current) {
      // arming 点击触发的内部关闭：忽略，保持菜单展开等待二次确认
      suppressMenuCloseRef.current = false;
      return;
    }
    setMenuOpen(next);
    if (!next) disarmDelete();
  }, [disarmDelete]);

  // 🔧 修复：复制反馈定时器在卸载时清理，避免卸载后 setState / 定时器泄漏
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    if (copied) return;
    try {
      await onCopy();
    } catch {
      // 复制失败：错误提示由 onCopy 内部展示，这里不显示成功态对勾
      return;
    }
    setCopied(true);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
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

  // 🆕 导出为 Markdown
  const handleExportMarkdown = useCallback(async () => {
    if (!onExportMarkdown || isExporting) return;
    setIsExporting(true);
    try {
      await onExportMarkdown();
    } finally {
      setIsExporting(false);
    }
  }, [onExportMarkdown, isExporting]);

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

  // 两步删除：第一次 arming（保持菜单打开），第二次真正执行
  const handleDeleteMenuItemClick = useCallback(() => {
    if (!deleteArmed) {
      suppressMenuCloseRef.current = true;
      setDeleteArmed(true);
      deleteArmTimerRef.current = setTimeout(() => {
        deleteArmTimerRef.current = null;
        setDeleteArmed(false);
      }, 3500);
      return;
    }
    disarmDelete();
    handleDelete();
  }, [deleteArmed, disarmDelete, handleDelete]);

  // 视觉保持 36px（!h-9 !w-9），用透明伪元素把命中区扩大到 ≥44px（触控目标契约）
  const compactButtonClassName = compactMobile
    ? '!h-9 !w-9 rounded-full [&_svg]:h-[14px] [&_svg]:w-[14px] relative after:absolute after:-inset-1 after:rounded-full after:content-[\'\']'
    : undefined;

  const showInlineCopyOnly = !compactMobile;
  const showInlineRetry = !compactMobile && !isUser && Boolean(onRetry);
  const showInlineEdit = !compactMobile && isUser && Boolean(onEdit);
  const hasSecondaryActions = Boolean(
    canDelete ||
    onSaveAsNote ||
    onExportMarkdown ||
    onBranchSession ||
    (isUser && onResend) ||
    (!isUser && onRetry && !showInlineRetry)
  );
  const showOverflowMenu = compactMobile || hasSecondaryActions;
  // ≥768 触屏平板无 hover：coarse 指针下次要操作（重试/编辑/更多菜单）需常显，
  // 否则历史消息只剩复制按钮可用（与 MessageItem footer 的 coarse 指针契约一致）
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const showDesktopSecondaryActions = compactMobile || alwaysExpanded || isCoarsePointer;
  const desktopSecondaryActionsClassName = showDesktopSecondaryActions
    ? 'flex items-center gap-0.5 transition-opacity'
    : 'flex items-center gap-0.5 transition-opacity md:pointer-events-none md:w-0 md:overflow-hidden md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:w-auto md:group-hover:overflow-visible md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:w-auto md:group-focus-within:overflow-visible md:group-focus-within:opacity-100';
  const desktopCopyButton = showInlineCopyOnly ? (
    <DsButton variant="ghost" size="icon" iconOnly onClick={handleCopy} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
      <IconSwap
        active={copied}
        a={<CopySimple className="w-4 h-4" />}
        b={<Check className="w-4 h-4 text-success" />}
      />
    </DsButton>
  ) : null;

  const actionsMenu = (
    <AppMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <AppMenuTrigger asChild>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('common:more')}
          title={t('common:more')}
          className={compactButtonClassName}
        >
          <DotsThree className="w-4 h-4" weight="bold" />
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent
        align="end"
        width={compactMobile ? 168 : 188}
        className={compactMobile ? '[&_.app-menu-item]:text-[12px] [&_.app-menu-item]:min-h-10 [&_.app-menu-item-icon_svg]:h-3.5 [&_.app-menu-item-icon_svg]:w-3.5' : undefined}
      >
        {/* P0-1: 紧凑移动模式下没有内联编辑按钮，编辑入口进入溢出菜单 */}
        {compactMobile && isUser && onEdit && (
          <AppMenuItem onClick={onEdit} disabled={!canEdit} icon={<PencilSimple size={16} />}>
            {t('messageItem.actions.edit')}
          </AppMenuItem>
        )}
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
        {onExportMarkdown && (
          <AppMenuItem onClick={handleExportMarkdown} disabled={isExporting} icon={<FileArrowDown size={16} />}>
            {t('messageItem.actions.exportMarkdown')}
          </AppMenuItem>
        )}
        {onBranchSession && (
          <AppMenuItem onClick={handleBranch} disabled={isBranching || isLocked} icon={<GitBranch size={16} />}>
            {t('messageItem.actions.branch')}
          </AppMenuItem>
        )}
        <AppMenuSeparator />
        {/* P1-1: 内联两步确认——「删除」→ 红色高亮「确认删除」，超时自动复原 */}
        <AppMenuItem
          onClick={handleDeleteMenuItemClick}
          disabled={!canDelete || isDeleting}
          destructive
          icon={<Trash size={16} />}
          aria-live="polite"
          className={deleteArmed ? 'bg-destructive/10 font-medium' : undefined}
        >
          {deleteArmed ? t('messageItem.actions.deleteConfirmTitle') : t('messageItem.actions.delete')}
        </AppMenuItem>
        {/* M-1: 移动端 Token 用量只读入口（桌面在操作行有内联展示，无需重复） */}
        {compactMobile && tokenUsage && tokenUsage.totalTokens > 0 && (
          <>
            <AppMenuSeparator />
            <div
              className="px-2.5 py-1.5 text-[11px] font-mono text-muted-foreground select-none"
              aria-label={t('tokenUsage.title')}
            >
              <span className="font-medium text-foreground/70">{formatTokenCount(tokenUsage.totalTokens)}</span>
              <span className="text-primary/80"> ↑{formatTokenCount(tokenUsage.promptTokens)}</span>
              <span className="text-info/80"> ↓{formatTokenCount(tokenUsage.completionTokens)}</span>
            </div>
          </>
        )}
      </AppMenuContent>
    </AppMenu>
  );

  if (compactMobile) {
    return (
      <div className={cn('flex items-center gap-0.5', className)}>
        <DsButton
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
            b={<Check className="w-4 h-4 text-success" />}
          />
        </DsButton>
        {actionsMenu}
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {!anchorCopyToEnd && desktopCopyButton}

      <div className={desktopSecondaryActionsClassName}>
        {showInlineRetry && (
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleRetry} disabled={isLocked || isRetrying} aria-label={t('messageItem.actions.retry')} title={t('messageItem.actions.retry')}>
            <ArrowCounterClockwise className={cn('w-4 h-4', isRetrying && 'animate-spin')} />
          </DsButton>
        )}

        {showInlineEdit && (
          <DsButton variant="ghost" size="icon" iconOnly onClick={onEdit} disabled={!canEdit} aria-label={t('messageItem.actions.edit')} title={t('messageItem.actions.edit')}>
            <PencilSimple className="w-4 h-4" />
          </DsButton>
        )}

        {showOverflowMenu && actionsMenu}
      </div>
      {anchorCopyToEnd && desktopCopyButton}
    </div>
  );
};

export default MessageActions;
