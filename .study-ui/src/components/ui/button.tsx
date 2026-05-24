import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const buttonBaseClassName =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-[13px] font-medium leading-none tracking-[0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 ease-out outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit";

export const buttonToneClassNames = {
  primary:
    "border-[color:var(--button-prominent-border)] bg-[var(--button-prominent-bg)] text-primary-foreground hover:bg-[var(--button-prominent-hover-bg)] active:bg-[var(--button-prominent-active-bg)]",
  secondary:
    "border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-secondary-foreground hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]",
  outline:
    "border-[color:var(--button-outline-border)] bg-[var(--button-outline-bg)] text-foreground hover:bg-[var(--button-outline-hover-bg)] hover:text-foreground active:bg-[var(--button-outline-active-bg)]",
  ghost:
    "border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-muted-foreground hover:bg-[var(--button-plain-hover-bg)] hover:text-foreground active:bg-[var(--button-plain-active-bg)]",
  destructive:
    "border-[color:var(--button-destructive-border)] bg-[var(--button-destructive-bg)] text-destructive-foreground hover:bg-[var(--button-destructive-hover-bg)] active:bg-[var(--button-destructive-active-bg)]",
} as const;

export const buttonSizeClassNames = {
  default: "h-11 px-[var(--button-padding-x)] lg:h-[var(--button-height)]",
  sm: "h-[var(--touch-target-size)] px-[var(--button-padding-x-sm)] text-xs lg:h-[var(--button-height-sm)]",
  lg: "h-[var(--touch-target-size)] px-[var(--button-padding-x-lg)] text-sm lg:h-[var(--button-height-lg)]",
  icon:
    "h-[var(--touch-target-size)] w-[var(--touch-target-size)] rounded-[var(--button-radius)] lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]",
} as const;

const buttonVariants = cva(
  buttonBaseClassName,
  {
    variants: {
      variant: buttonToneClassNames,
      size: buttonSizeClassNames,
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

type ButtonIcon = React.ComponentType<{ className?: string; size?: number }>;

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    icon?: ButtonIcon;
    iconPosition?: "start" | "end";
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { asChild = false, className, icon: Icon, iconPosition = "start", size, variant, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  const iconElement = Icon ? <Icon className="size-4" size={16} /> : null;

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      ref={ref}
      {...(!asChild ? { type: props.type ?? "button" } : {})}
      {...props}
    >
      {iconPosition === "start" ? iconElement : null}
      {children}
      {iconPosition === "end" ? iconElement : null}
    </Comp>
  );
});

export { buttonVariants };
