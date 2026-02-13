import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { Slot } from '@radix-ui/react-slot';
import { Z_INDEX } from '@/config/zIndex';

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
  onClick, 
  ...rest 
}: DialogContentProps) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return null;

  // 如果指定了容器，使用 absolute 定位；否则使用 fixed 定位
  const positionClass = containerSelector ? 'absolute' : 'fixed';

  return (
    <DialogPortal open={ctx.open} containerSelector={containerSelector}>
      {/* Overlay - 独立层，不影响内容定位 */}
      <motion.div
        className={cn("inset-0 bg-black/40 backdrop-blur-sm", positionClass)}
        style={{ zIndex: Z_INDEX.modal }}
        variants={overlayVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        onClick={() => {
          if (closeOnOverlayClick) ctx.setOpen(false);
        }}
      />
      {/* Content wrapper - 居中容器 */}
      <motion.div
        className={cn(
          "inset-0 flex items-center justify-center p-4 sm:p-6 pointer-events-none",
          positionClass
        )}
        style={{ zIndex: Z_INDEX.modal + 1 }}
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
            'pointer-events-auto w-full max-w-lg rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl',
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
