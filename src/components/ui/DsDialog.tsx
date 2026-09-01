import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { DsButton, type DsButtonVariant, type DsButtonSize } from './DsButton';
import { CustomScrollArea } from '../custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useKeyboardHeight, getLayoutViewportObscuredHeight } from '@/hooks/useKeyboardHeight';
import { springSheet } from '@/styles/motion-springs';

/**
 * Android 系统返回键接入：DsDialog 是 framer-motion 自绘弹窗（非 Radix），
 * 没有 data-state="open"，androidBackCoordinator 的 Radix Escape 兜底匹配不到，
 * 必须显式注册 overlay 级返回 handler，否则移动端按返回键会穿透到底层导航。
 * 用 ref 保持注册稳定，避免回调变化导致注销重注、破坏多层弹窗的栈语义。
 */
function useAndroidBackClose(open: boolean, close: () => void) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      closeRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);
}

/**
 * ESC 关闭（栈语义，L-7）：每个实例各挂 document keydown 会导致多层弹窗
 * 叠开时一次 Escape 全部关闭。这里维护模块级打开栈，仅栈顶实例响应，
 * 与 Android 返回键的 BACK_PRIORITY 栈行为对齐。
 */
const escapeStack: symbol[] = [];

function useEscapeClose(open: boolean, close: () => void) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return;
    const token = Symbol('card-dialog-esc');
    escapeStack.push(token);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] !== token) return;
      closeRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => {
      const index = escapeStack.indexOf(token);
      if (index >= 0) escapeStack.splice(index, 1);
      document.removeEventListener('keydown', handler);
    };
  }, [open]);
}

// ============================================================================
// 动画变体
// ============================================================================

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const } },
};

const contentVariants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springSheet,
  },
  exit: { opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const } },
};

/** 移动端 bottom sheet 形态：从底部整体滑入/滑出（iOS/Material 范式） */
const sheetContentVariants = {
  hidden: { y: '100%' },
  visible: {
    y: 0,
    transition: springSheet,
  },
  exit: { y: '100%', transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const } },
};

const alertContentVariants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springSheet,
  },
  exit: { opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const } },
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
// DsDialog — 通用模态框
// ============================================================================

export interface DsDialogProps {
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

export function DsDialog({
  open,
  onOpenChange,
  children,
  closeOnOverlay = true,
  showClose = true,
  maxWidth = 'max-w-lg',
  className,
}: DsDialogProps) {
  const { t } = useTranslation('common');

  // ESC 关闭（栈语义：仅最顶层弹窗响应）
  useEscapeClose(open, () => onOpenChange(false));

  // Android 返回键 = 关闭弹窗（与 ESC 同语义）
  useAndroidBackClose(open, () => onOpenChange(false));

  // 移动端（<768，与 App shell 同源）切换为 bottom sheet 形态，
  // 视觉规格对齐全局移动设置 Sheet（rounded-t-[24px] + 顶部把手 + 贴底全宽）
  const isMobileSheet = useIsMobile();

  // Android 键盘避让（#113 bug 2）：键盘弹出时居中形态改为顶部对齐防压缩，
  // sheet 形态补偿非 adjustResize 模式下被键盘遮挡的布局高度。
  // 非 Android 平台 keyboardHeight 恒为 0，无行为变化。
  const keyboardHeight = useKeyboardHeight();
  const keyboardAvoid = keyboardHeight > 0;
  // 非 adjustResize 模式下键盘遮挡的布局高度（keyboardHeight 变化触发重渲染时重新读取）
  const obscuredHeight = keyboardAvoid ? getLayoutViewportObscuredHeight() : 0;

  // 移动 sheet 下滑关闭（M-5）：顶部把手视觉暗示可拖拽，此前没有对应手势。
  // 拖拽只从把手区启动（dragListener=false），不与内容区滚动抢手势。
  const dragControls = useDragControls();

  return (
    <ModalPortal open={open}>
      <motion.div
        data-overlay-container="true"
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          'pointer-events-auto fixed inset-0 flex',
          isMobileSheet ? 'items-end justify-center p-0' : 'items-center justify-center p-4 sm:p-6',
        )}
        style={{
          zIndex: Z_INDEX.modal,
          ...(keyboardAvoid
            ? {
                ...(isMobileSheet ? {} : { alignItems: 'flex-start', paddingTop: '12px' }),
                // adjustResize 下为 0；非 resize 模式下补偿键盘遮挡区域
                paddingBottom: `${obscuredHeight}px`,
              }
            : {}),
        }}
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
          variants={isMobileSheet ? sheetContentVariants : contentVariants}
          drag={isMobileSheet ? 'y' : false}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          onDragEnd={(_, info) => {
            if (info.offset.y > 96 || info.velocity.y > 600) {
              onOpenChange(false);
            }
          }}
          className={cn(
            'relative border bg-background text-foreground',
            'flex flex-col overflow-hidden',
            isMobileSheet
              ? 'w-full max-w-none rounded-b-none rounded-t-[24px] border-x-0 border-b-0'
              : cn('w-[92vw] rounded-[var(--radius-shell-dialog)]', maxWidth),
            className,
          )}
          style={{
            zIndex: Z_INDEX.modal + 1,
            // 键盘弹出（非 adjustResize）时 sheet 高度需扣除键盘遮挡区，否则内容被键盘盖住
            maxHeight: isMobileSheet
              ? (keyboardAvoid
                  ? `min(86dvh, calc(100dvh - ${obscuredHeight}px - 0.5rem))`
                  : 'min(86dvh, calc(100dvh - 0.5rem))')
              : 'min(85vh, 720px)',
            paddingBottom: isMobileSheet
              ? 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))'
              : undefined,
            background: 'var(--dialog-shell-surface)',
            borderColor: 'var(--dialog-shell-border)',
            boxShadow: 'var(--shadow-shell-floating)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {isMobileSheet && (
            <div
              aria-hidden
              className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="h-1 w-12 rounded-full bg-[color:var(--mobile-sheet-handle,var(--border))]" />
            </div>
          )}
          {showClose && (
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('actions.close')}
              className={cn(
                'absolute z-10 text-muted-foreground/50 hover:text-foreground',
                // 移动 sheet 形态：触控目标放大到 44px（右上角命中区）
                isMobileSheet ? 'right-2 top-2 h-11 w-11' : 'w-6 h-6 top-2.5 right-2.5',
              )}
              onClick={() => onOpenChange(false)}
            >
              <X size={16} />
            </DsButton>
          )}
          {children}
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}

// ---- 子组件 ----

export function DsDialogHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
      <div className={cn('flex-shrink-0 px-5 pt-5 pb-3 space-y-1 border-b border-transparent', className)} style={{ borderColor: 'var(--dialog-shell-border)' }} {...props}>
        {children}
      </div>
  );
}

export function DsDialogTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-base font-semibold leading-tight text-foreground', className)} {...props}>
      {children}
    </h3>
  );
}

export function DsDialogDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-[13px] text-muted-foreground leading-relaxed', className)} {...props}>
      {children}
    </p>
  );
}

export interface DsDialogBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 启用 OverlayScrollbars（自研滚动条）。默认 false — 使用原生滚动。
   *
   * **最佳实践**：弹窗内一律使用原生滚动。原因：
   *  1. DsDialog 入场动画是 scale + translateY，OverlayScrollbars 的
   *     `defer` 初始化在动画期间会读到错误的几何尺寸，可能导致 scrollbar
   *     不激活、内容被裁掉而无法滚动（见 PrivacyPolicyDialog 历史问题）。
   *  2. Modal 是 portal + overflow-hidden 容器，再嵌一层拦截 wheel 的滚动
   *     库容易出现事件吞掉、滚动锁失效等边界问题。
   *  3. 原生滚动在 trackpad 惯性、PgDn / 箭头键、辅助技术上更可靠。
   *
   * 仅在弹窗内嵌入超长虚拟列表、需要 click-track 跳转等极少数场景下才考虑
   * 开启此选项。
   */
  overlayScroll?: boolean;
}

export function DsDialogBody({ className, children, overlayScroll = false, ...props }: DsDialogBodyProps) {
  if (overlayScroll) {
    return (
      <CustomScrollArea className={cn('flex-1 min-h-0', className)} viewportClassName="px-5" {...props}>
        {children}
      </CustomScrollArea>
    );
  }
  return (
    <div
      className={cn(
        // 关键：min-h-0 让 flex 子元素能正确收缩，否则会撑爆父容器导致无法滚动
        'flex-1 min-h-0 overflow-y-auto overscroll-contain px-5',
        // macOS 风格细滚动条，与 OverlayScrollbars 视觉接近，零运行时成本
        'scroll-area--native',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DsDialogFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
      <div
      className={cn('flex-shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-transparent', className)}
      style={{ borderColor: 'var(--dialog-shell-border)' }}
      {...props}
    >
      {children}
    </div>
  );
}

// ============================================================================
// DsAlertDialog — 确认模态框
// ============================================================================

export interface DsAlertDialogProps {
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
  confirmVariant?: DsButtonVariant;
  /** 确认按钮尺寸，默认 sm */
  confirmSize?: DsButtonSize;
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

export function DsAlertDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  confirmText,
  cancelText,
  confirmVariant = 'danger',
  confirmSize = 'sm',
  onConfirm,
  onCancel,
  loading = false,
  disabled = false,
  children,
  className,
}: DsAlertDialogProps) {
  const { t } = useTranslation('common');
  const resolvedConfirmText = confirmText ?? t('actions.confirm');
  const resolvedCancelText = cancelText ?? t('actions.cancel');
  // P3-9：role=alertdialog 需要可访问名——标题/描述经 id 接线
  const titleId = React.useId();
  const descriptionId = React.useId();

  const handleCancel = React.useCallback(() => {
    onCancel?.();
    onOpenChange(false);
  }, [onCancel, onOpenChange]);

  // ESC 关闭（栈语义：仅最顶层弹窗响应）
  useEscapeClose(open, handleCancel);

  // Android 返回键 = 取消（确认框不可遮罩关闭，但返回键应等同"取消"，与 ESC 一致）
  useAndroidBackClose(open, handleCancel);

  // Android 键盘避让：与 DsDialog 同一套 useKeyboardHeight 机制（children 内含输入框时生效）
  const keyboardHeight = useKeyboardHeight();
  const keyboardAvoid = keyboardHeight > 0;
  const obscuredHeight = keyboardAvoid ? getLayoutViewportObscuredHeight() : 0;

  return (
    <ModalPortal open={open}>
      <motion.div
        data-overlay-container="true"
        onPointerDown={(e) => e.stopPropagation()}
        className="pointer-events-auto fixed inset-0 flex items-center justify-center p-4"
        style={{
          zIndex: Z_INDEX.modal,
          ...(keyboardAvoid
            ? {
                alignItems: 'flex-start',
                paddingTop: '12px',
                // adjustResize 下为 0；非 resize 模式下补偿键盘遮挡区域
                paddingBottom: `${obscuredHeight}px`,
              }
            : {}),
        }}
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
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          variants={alertContentVariants}
          className={cn(
            // 宽度对齐移动端契约上限 calc(100vw-32px)；内容可变长（如 zip 装前确认）时
            // 整体限高 + 内容区滚动，防止小屏溢出导致按钮不可达
            'relative flex max-h-[85dvh] w-[calc(100vw-32px)] max-w-md flex-col rounded-[var(--radius-shell-dialog)] border p-5 text-foreground',
            className,
          )}
          style={{
            zIndex: Z_INDEX.modal + 1,
            background: 'var(--dialog-shell-surface)',
            borderColor: 'var(--dialog-shell-border)',
            boxShadow: 'var(--shadow-shell-floating)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 标题行 */}
          <div className="flex shrink-0 items-start gap-3">
            {icon && <span className="flex-shrink-0 mt-0.5">{icon}</span>}
            <div className="flex-1 min-w-0 space-y-1.5">
              <h3 id={titleId} className="text-base font-semibold leading-tight text-foreground">{title}</h3>
              {description && (
                <p id={descriptionId} className="text-[13px] text-muted-foreground leading-relaxed">{description}</p>
              )}
            </div>
          </div>

          {/* 额外内容 */}
          {children && <div className="mt-3 min-h-0 overflow-y-auto overscroll-contain">{children}</div>}

          {/* 按钮行 */}
          <div className="mt-5 flex shrink-0 items-center justify-end gap-2">
            <DsButton variant="ghost" size={confirmSize} onClick={handleCancel} disabled={loading}>
              {resolvedCancelText}
            </DsButton>
            <DsButton
              variant={confirmVariant}
              size={confirmSize}
              onClick={onConfirm}
              disabled={disabled || loading}
            >
              {loading && (
                <svg className="w-3.5 h-3.5 animate-spin mr-1" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {resolvedConfirmText}
            </DsButton>
          </div>
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}
