import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { NotionButton, type NotionButtonVariant, type NotionButtonSize } from './NotionButton';
import { CustomScrollArea } from '../custom-scroll-area';

// ============================================================================
// 动画变体
// ============================================================================

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.18, ease: 'easeOut' as const } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: 'easeIn' as const } },
};

const contentVariants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 420, damping: 28, mass: 0.7 },
  },
  exit: { opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.12, ease: 'easeIn' as const } },
};

const alertContentVariants = {
  hidden: { opacity: 0, scale: 0.92, y: 16 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 380, damping: 26, mass: 0.75 },
  },
  exit: { opacity: 0, scale: 0.92, y: 16, transition: { duration: 0.12, ease: 'easeIn' as const } },
};

// ============================================================================
// Portal 容器
// ============================================================================

function ModalPortal({ children, open }: { children: React.ReactNode; open: boolean }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence mode="wait">{open && children}</AnimatePresence>,
    document.body,
  );
}

// ============================================================================
// NotionDialog — 通用模态框
// ============================================================================

export interface NotionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** 点击遮罩关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 显示右上角关闭按钮，默认 true */
  showClose?: boolean;
  /** 内容区最大宽度 class，默认 max-w-lg */
  maxWidth?: string;
  className?: string;
}

export function NotionDialog({
  open,
  onOpenChange,
  children,
  closeOnOverlay = true,
  showClose = true,
  maxWidth = 'max-w-lg',
  className,
}: NotionDialogProps) {
  // ESC 关闭
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  return (
    <ModalPortal open={open}>
      <motion.div
        className="fixed inset-0 flex items-center justify-center p-4 sm:p-6"
        style={{ zIndex: Z_INDEX.modal }}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {/* 遮罩 */}
        <motion.div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px]"
          variants={overlayVariants}
          onClick={() => closeOnOverlay && onOpenChange(false)}
        />
        {/* 内容 */}
        <motion.div
          role="dialog"
          aria-modal="true"
          variants={contentVariants}
          className={cn(
            'relative w-[92vw] rounded-xl border border-transparent ring-1 ring-border/40 bg-background text-foreground shadow-lg',
            'flex flex-col overflow-hidden',
            maxWidth,
            className,
          )}
          style={{ zIndex: Z_INDEX.modal + 1, maxHeight: 'min(85vh, 720px)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {showClose && (
            <NotionButton
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Close"
              className="absolute top-2.5 right-2.5 z-10 h-6 w-6 text-muted-foreground/50 hover:text-foreground"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </NotionButton>
          )}
          {children}
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}

// ---- 子组件 ----

export function NotionDialogHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex-shrink-0 px-5 pt-5 pb-3 space-y-1', className)} {...props}>
      {children}
    </div>
  );
}

export function NotionDialogTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-base font-semibold leading-tight text-foreground', className)} {...props}>
      {children}
    </h3>
  );
}

export function NotionDialogDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-[13px] text-muted-foreground leading-relaxed', className)} {...props}>
      {children}
    </p>
  );
}

export interface NotionDialogBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 禁用自研滚动条，使用原生滚动，默认 false */
  nativeScroll?: boolean;
}

export function NotionDialogBody({ className, children, nativeScroll = false, ...props }: NotionDialogBodyProps) {
  if (nativeScroll) {
    return (
      <div className={cn('flex-1 min-h-0 overflow-y-auto px-5', className)} {...props}>
        {children}
      </div>
    );
  }
  return (
    <CustomScrollArea className={cn('flex-1 min-h-0', className)} viewportClassName="px-5" {...props}>
      {children}
    </CustomScrollArea>
  );
}

export function NotionDialogFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex-shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-border/40', className)}
      {...props}
    >
      {children}
    </div>
  );
}

// ============================================================================
// NotionAlertDialog — 确认模态框
// ============================================================================

export interface NotionAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题 */
  title: React.ReactNode;
  /** 描述 */
  description?: React.ReactNode;
  /** 图标（标题前） */
  icon?: React.ReactNode;
  /** 确认按钮文字，默认 "确认" */
  confirmText?: string;
  /** 取消按钮文字，默认 "取消" */
  cancelText?: string;
  /** 确认按钮变体，默认 danger */
  confirmVariant?: NotionButtonVariant;
  /** 确认按钮尺寸，默认 sm */
  confirmSize?: NotionButtonSize;
  /** 确认回调 */
  onConfirm?: () => void;
  /** 取消回调（不传则关闭弹窗） */
  onCancel?: () => void;
  /** 确认按钮 loading */
  loading?: boolean;
  /** 确认按钮 disabled */
  disabled?: boolean;
  /** 额外内容（显示在描述下方） */
  children?: React.ReactNode;
  className?: string;
}

export function NotionAlertDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  confirmText = '确认',
  cancelText = '取消',
  confirmVariant = 'danger',
  confirmSize = 'sm',
  onConfirm,
  onCancel,
  loading = false,
  disabled = false,
  children,
  className,
}: NotionAlertDialogProps) {
  const handleCancel = React.useCallback(() => {
    onCancel?.();
    onOpenChange(false);
  }, [onCancel, onOpenChange]);

  // ESC 关闭
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, handleCancel]);

  return (
    <ModalPortal open={open}>
      <motion.div
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ zIndex: Z_INDEX.modal }}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {/* 遮罩 — 确认框不可点击遮罩关闭 */}
        <motion.div className="fixed inset-0 bg-black/35 backdrop-blur-[2px]" variants={overlayVariants} />
        {/* 内容 */}
        <motion.div
          role="alertdialog"
          aria-modal="true"
          variants={alertContentVariants}
          className={cn(
            'relative w-[92vw] max-w-md rounded-xl border border-transparent ring-1 ring-border/40 bg-background p-5 text-foreground shadow-lg',
            className,
          )}
          style={{ zIndex: Z_INDEX.modal + 1 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 标题行 */}
          <div className="flex items-start gap-3">
            {icon && <span className="flex-shrink-0 mt-0.5">{icon}</span>}
            <div className="flex-1 min-w-0 space-y-1.5">
              <h3 className="text-base font-semibold leading-tight text-foreground">{title}</h3>
              {description && (
                <p className="text-[13px] text-muted-foreground leading-relaxed">{description}</p>
              )}
            </div>
          </div>

          {/* 额外内容 */}
          {children && <div className="mt-3">{children}</div>}

          {/* 按钮行 */}
          <div className="mt-5 flex items-center justify-end gap-2">
            <NotionButton variant="ghost" size={confirmSize} onClick={handleCancel} disabled={loading}>
              {cancelText}
            </NotionButton>
            <NotionButton
              variant={confirmVariant}
              size={confirmSize}
              onClick={onConfirm}
              disabled={disabled || loading}
            >
              {loading && (
                <svg className="animate-spin h-3.5 w-3.5 mr-1" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {confirmText}
            </NotionButton>
          </div>
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}
