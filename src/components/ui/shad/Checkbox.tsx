import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from '@phosphor-icons/react';
import { cn } from '../../../lib/utils';
import './Checkbox.css';

/**
 * coarse 触控热区已在基元层保证：Checkbox.css 对
 * `[data-radix-checkbox-root]` 在 @media (pointer: coarse) 下用居中
 * 透明 ::after 撑出 ≥44×44 命中区（视觉仍 16×16，与 Switch.css 同款，
 * 属 coarseHit.ts 所述伪元素逃生舱的基元级下沉）。
 * 调用点【不要】再手抄 before:-inset-3.5 / !min-h-11 之类散点补丁。
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    data-radix-checkbox-root=""
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-[3px] border border-border/40 bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-radix-checkbox-indicator=""
      className={cn('flex items-center justify-center text-white')}
    >
      <Check size={12} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };

