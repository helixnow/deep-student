import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { Slot } from '@radix-ui/react-slot';
import { Button, type ButtonProps } from './Button';
import { Z_INDEX } from '@/config/zIndex';

type Ctx = { open: boolean; setOpen: (open: boolean) => void };
const AlertDialogContext = React.createContext<Ctx | null>(null);

interface AlertDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function AlertDialog({ open, defaultOpen, onOpenChange, children }: AlertDialogProps) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState<boolean>(defaultOpen ?? false);
  const valueOpen = controlled ? (open as boolean) : internalOpen;
  const setOpen = React.useCallback((v: boolean) => {
    if (!controlled) setInternalOpen(v);
    onOpenChange?.(v);
  }, [controlled, onOpenChange]);
  return (
    <AlertDialogContext.Provider value={{ open: valueOpen, setOpen }}>{children}</AlertDialogContext.Provider>
  );
}

export function AlertDialogTrigger({ asChild = false, children }: { asChild?: boolean; children: React.ReactNode }) {
  const ctx = React.useContext(AlertDialogContext);
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

// Animation variants for alert content - slightly different from Dialog for emphasis
const alertContentVariants = {
  hidden: {
    opacity: 0,
    scale: 0.92,
    y: 20
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 350,
      damping: 25,
      mass: 0.8
    }
  },
  exit: {
    opacity: 0,
    scale: 0.92,
    y: 20,
    transition: {
      duration: 0.15,
      ease: 'easeIn' as const
    }
  }
};

// Internal portal component to handle animations
function AlertDialogPortal({ children, open }: { children: React.ReactNode; open: boolean }) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence mode="wait">
      {open && children}
    </AnimatePresence>,
    document.body
  );
}

export function AlertDialogContent({ className, children }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = React.useContext(AlertDialogContext);
  if (!ctx) return null;

  return (
    <AlertDialogPortal open={ctx.open}>
      <motion.div
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ zIndex: Z_INDEX.modal }}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <motion.div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm"
          variants={overlayVariants}
          onClick={() => ctx.setOpen(false)}
        />
        <motion.div
          role="alertdialog"
          aria-modal="true"
          variants={alertContentVariants}
          className={cn(
            'relative w-[92vw] max-w-md rounded-xl border border-transparent bg-background p-6 text-foreground shadow-lg ring-1 ring-border/40',
            className
          )}
          style={{ zIndex: Z_INDEX.modal + 1 }}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </motion.div>
      </motion.div>
    </AlertDialogPortal>
  );
}

export const AlertDialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('space-y-1.5', className)} {...props} />
  )
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

export const AlertDialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  )
);
AlertDialogTitle.displayName = 'AlertDialogTitle';

export const AlertDialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  )
);
AlertDialogDescription.displayName = 'AlertDialogDescription';

export const AlertDialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mt-4 flex justify-end gap-2', className)} {...props} />
  )
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

export const AlertDialogCancel = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, children, ...props }, ref) => {
    const ctx = React.useContext(AlertDialogContext);
    return (
      <Button
        ref={ref}
        variant="outline"
        className={className}
        onClick={(e) => {
          props.onClick?.(e as any);
          ctx?.setOpen(false);
        }}
        {...props}
      >
        {children}
      </Button>
    );
  }
);
AlertDialogCancel.displayName = 'AlertDialogCancel';

export const AlertDialogAction = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, children, variant = 'destructive', ...props }, ref) => (
    <Button ref={ref} variant={variant as any} className={className} {...props}>
      {children}
    </Button>
  )
);
AlertDialogAction.displayName = 'AlertDialogAction';
