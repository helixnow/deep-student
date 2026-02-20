import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '../../../lib/utils';
import './Checkbox.css';

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
      <Check className="h-3 w-3" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };

