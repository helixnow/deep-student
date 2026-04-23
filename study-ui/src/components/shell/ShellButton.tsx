import React from "react";

import {
  buttonBaseClassName,
  buttonSizeClassNames,
  buttonToneClassNames,
} from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ShellButtonVariant = "default" | "ghost" | "outline" | "secondary" | "icon" | "nav";
type ShellButtonSize = "default" | "sm" | "icon";

type ShellButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ShellButtonVariant;
  size?: ShellButtonSize;
};

const shellNavBaseClassName =
  "inline-flex shrink-0 appearance-none items-center gap-2 whitespace-nowrap text-[13px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit";

export const ShellButton = React.forwardRef<HTMLButtonElement, ShellButtonProps>(
  function ShellButton({ className, variant = "default", size = "default", ...props }, ref) {
    const variants: Record<ShellButtonVariant, string> = {
      default: buttonToneClassNames.primary,
      ghost: buttonToneClassNames.ghost,
      outline: buttonToneClassNames.outline,
      secondary: buttonToneClassNames.secondary,
      icon: cn(buttonToneClassNames.ghost, buttonSizeClassNames.icon, "justify-center"),
      nav:
        "border-transparent bg-transparent text-muted-foreground flex min-h-[2.75rem] lg:min-h-9 w-full min-w-0 justify-start gap-2.5 overflow-hidden rounded-2xl px-2.5 py-1.5 text-left text-sm font-normal",
    };

    const sizes: Record<ShellButtonSize, string> = {
      default: buttonSizeClassNames.default,
      sm: buttonSizeClassNames.sm,
      icon: `flex ${buttonSizeClassNames.icon} items-center justify-center`,
    };

    return (
      <button
        ref={ref}
        className={cn(
          variant === "nav" ? shellNavBaseClassName : buttonBaseClassName,
          variants[variant],
          variant !== "icon" && variant !== "nav" && sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
