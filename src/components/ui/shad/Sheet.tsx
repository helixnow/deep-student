import * as React from "react"
import { useTranslation } from "react-i18next"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "@phosphor-icons/react"

import { cn } from "../../../lib/utils"
import { Z_INDEX } from "@/config/zIndex"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, style, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 bg-[var(--overlay)] ui-fade-in ui-fade-out",
      className
    )}
    // 层级走 Z_INDEX.sheet（曾为 z-50：portal 到 body 后被移动顶栏 1100 /
    // 弹窗 3000 盖住，2026-07 移动端审计 H-2）。遮罩与内容同档，
    // Radix 渲染顺序（overlay 在前）保证内容盖在遮罩上。
    style={{ zIndex: Z_INDEX.sheet, ...style }}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  // 开闭动画走 ui-motion（transitions-dev token）：进场 ui-slide-in-*，
  // 离场 ui-slide-out-*（仅 data-state="closed" 时生效，Radix 等 animationend 再卸载）
  // z-index 由 SheetContent 以 Z_INDEX.sheet 内联设置（不要在此写死 z-* 类）
  "fixed gap-4 border-[color:var(--dialog-shell-border)] bg-[color:var(--dialog-shell-surface)] p-6 text-popover-foreground shadow-[var(--shadow-shell-floating)]",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 rounded-b-[var(--radius-shell-dialog)] border-b ui-slide-in-top ui-slide-out-top",
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-[var(--radius-shell-dialog)] border-x border-t ui-slide-in-bottom ui-slide-out-bottom",
        left: "inset-y-0 left-0 h-dvh w-[min(92vw,28rem)] border-r ui-slide-in-left ui-slide-out-left",
        right:
          "inset-y-0 right-0 h-dvh w-[min(92vw,28rem)] border-l ui-slide-in-right ui-slide-out-right",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** 隐藏默认关闭按钮 */
  hideCloseButton?: boolean;
  overlayClassName?: string;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, hideCloseButton = false, overlayClassName, style, ...props }, ref) => {
  const { t } = useTranslation("common")
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={ref}
        data-overlay-container="true"
        className={cn(sheetVariants({ side }), className)}
        style={{ zIndex: Z_INDEX.sheet, ...style }}
        {...props}
      >
        {children}
        {!hideCloseButton && (
          <SheetPrimitive.Close className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none lg:h-8 lg:w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11">
            <X size={16} />
            <span className="sr-only">{t('actions.close')}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
})
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-xl font-semibold leading-none text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm leading-6 text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
