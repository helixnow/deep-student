import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";
import "./Switch.css";

export type SwitchSize = "default" | "sm";

export interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  /**
   * 尺寸变体。
   * - `default`: 24×44，用于表单与常规设置行
   * - `sm`: 16×28，用于密集列表行（如 OcrEngineCard 引擎条目）
   *
   * 具体尺寸/位移在 Switch.css 中通过 `[data-size="sm"]` 选择器声明，
   * 避免被全局 reset 覆盖。
   */
  size?: SwitchSize;
}

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(function Switch({ className, size = "default", ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      ref={ref}
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-white ring-0 transition-transform duration-150",
        )}
      />
    </SwitchPrimitive.Root>
  );
});
