import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { Slot } from '@radix-ui/react-slot';
import { Z_INDEX } from '@/config/zIndex';
import { useKeyboardHeight, getLayoutViewportObscuredHeight } from '@/hooks/useKeyboardHeight';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/**
 * ESC / Android 返回键关闭（2026-07 移动端审计 R6）：本组件是 framer-motion
 * 自绘弹窗（非 Radix），没有 data-state="open"，androidBackCoordinator 的
 * Radix Escape 兜底匹配不到；此前也没有任何 Escape 监听——弹窗只能点遮罩
 * 或按钮关闭，移动端按返回键会穿透到底层导航。与 DsDialog 同语义：
 * 维护模块级打开栈，仅栈顶实例响应 Escape，多层弹窗一次只关最上层。
 */
const escapeStack: symbol[] = [];

function useDismissable(open: boolean, close: () => void) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!open) return;
    const token = Symbol('shad-dialog-esc');
    escapeStack.push(token);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] !== token) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const unregisterBack = registerBackHandler(() => {
      closeRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
    return () => {
      const index = escapeStack.indexOf(token);
      if (index >= 0) escapeStack.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
      unregisterBack();
    };
  }, [open]);
}

type DialogContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, defaultOpen, onOpenChange, children }: DialogProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState<boolean>(defaultOpen ?? false);
  const valueOpen = isControlled ? (open as boolean) : internalOpen;

  const setOpen = React.useCallback(
    (v: boolean) => {
      if (!isControlled) setInternalOpen(v);
      onOpenChange?.(v);
    },
    [isControlled, onOpenChange]
  );

  return <DialogContext.Provider value={{ open: valueOpen, setOpen }}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ asChild = false, children }: { asChild?: boolean; children: React.ReactNode }) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return <>{children}</>;
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp onClick={() => ctx.setOpen(true)} aria-haspopup="dialog">
      {children}
    </Comp>
  );
}

// Animation variants for overlay
const overlayVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.2, ease: 'easeOut' as const }
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15, ease: 'easeIn' as const }
  }
};

// Animation variants for content
const contentVariants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
    y: 10
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 400,
      damping: 30,
      mass: 0.8
    }
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: {
      duration: 0.15,
      ease: 'easeIn' as const
    }
  }
};

// 排除与 framer-motion 冲突的拖拽相关属性
type MotionConflictProps = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart';

interface DialogContentProps extends Omit<React.HTMLAttributes<HTMLDivElement>, MotionConflictProps> {
  closeOnOverlayClick?: boolean;
  /**
   * 指定 Dialog 渲染的容器选择器（如 '#main-content'）
   * 如果提供，遮罩和内容将相对于该容器定位而不是整个视口
   */
  containerSelector?: string;
  /**
   * 自定义遮罩层 className。默认使用 var(--overlay) 实色遮罩（无高斯模糊），
   * 颜色随主题切换，符合项目设计语义。
   */
  overlayClassName?: string;
}

// Internal portal component to handle animations
function DialogPortal({ 
  children, 
  open, 
  containerSelector 
}: { 
  children: React.ReactNode; 
  open: boolean;
  containerSelector?: string;
}) {
  const [mounted, setMounted] = React.useState(false);
  const [container, setContainer] = React.useState<Element | null>(null);

  React.useEffect(() => {
    setMounted(true);
    if (containerSelector) {
      const el = document.querySelector(containerSelector);
      setContainer(el);
    }
  }, [containerSelector]);

  if (!mounted) return null;

  const targetContainer = containerSelector ? container : document.body;
  if (!targetContainer) return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {open && children}
    </AnimatePresence>,
    targetContainer
  );
}

export function DialogContent({
  className,
  children,
  closeOnOverlayClick = true,
  containerSelector,
  overlayClassName,
  onClick,
  ...rest
}: DialogContentProps) {
  const ctx = React.useContext(DialogContext);
  // Android 键盘避让（#113 bug 2）：adjustResize 下键盘弹出会压缩 WebView，
  // 居中布局会把 Dialog 压到极小。键盘弹出时改为顶部对齐 + 限高滚动。
  // hook 仅在 Android 返回非 0，其他平台恒为 0、无行为变化。
  const keyboardHeight = useKeyboardHeight();
  const keyboardAvoid = keyboardHeight > 0;
  // ESC / Android 返回键关闭（hook 必须无条件调用，ctx 缺失时 open 恒为 false）
  useDismissable(ctx?.open ?? false, () => ctx?.setOpen(false));
  if (!ctx) return null;

  // 如果指定了容器，使用 absolute 定位；否则使用 fixed 定位
  const positionClass = containerSelector ? 'absolute' : 'fixed';

  return (
    <DialogPortal open={ctx.open} containerSelector={containerSelector}>
      {/* Overlay - 实色遮罩，无高斯模糊。颜色随主题切换。 */}
      <motion.div
        className={cn(
          'inset-0 bg-[color:var(--overlay)]',
          positionClass,
          overlayClassName
        )}
        style={{ zIndex: Z_INDEX.modal }}
        variants={overlayVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        onClick={() => {
          if (closeOnOverlayClick) ctx.setOpen(false);
        }}
      />
      {/* Content wrapper - 居中容器；键盘弹出时顶部对齐并补偿被遮挡区域 */}
      <motion.div
        className={cn(
          "inset-0 flex items-center justify-center p-4 sm:p-6 pointer-events-none",
          positionClass
        )}
        style={{
          zIndex: Z_INDEX.modal + 1,
          ...(keyboardAvoid
            ? {
                alignItems: 'flex-start',
                paddingTop: '12px',
                // adjustResize 下布局视口已随键盘缩小、该值为 0；
                // 非 resize 模式下补偿被键盘遮挡的布局高度
                paddingBottom: `${getLayoutViewportObscuredHeight()}px`,
              }
            : {}),
        }}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {/* Dialog content - 实际内容框 */}
        <motion.div
          role="dialog"
          aria-modal="true"
          variants={contentVariants}
          className={cn(
            'pointer-events-auto w-full max-w-lg rounded-xl border border-border/40 bg-background p-5 text-foreground shadow-none',
            keyboardAvoid && 'max-h-full overflow-y-auto',
            className
          )}
          onClick={(e) => {
            e.stopPropagation();
            onClick?.(e as any);
          }}
          {...rest}
        >
          {children}
        </motion.div>
      </motion.div>
    </DialogPortal>
  );
}

export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('space-y-1.5', className)} {...props} />
  )
);
DialogHeader.displayName = 'DialogHeader';

export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  )
);
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  )
);
DialogDescription.displayName = 'DialogDescription';

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mt-4 flex justify-end gap-2', className)} {...props} />
  )
);
DialogFooter.displayName = 'DialogFooter';
