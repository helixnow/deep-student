import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../../lib/utils';
import './Switch.css';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    data-shad-switch=""
    className={cn(
      'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[color:var(--button-primary-border)] data-[state=checked]:bg-[color:var(--button-primary-foreground)] data-[state=unchecked]:border-[color:var(--button-utility-border)] data-[state=unchecked]:bg-[color:var(--button-utility-surface)]',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block rounded-full bg-[color:var(--surface-panel-strong)] shadow-none ring-1 ring-[color:var(--shell-workspace-border)] transition-transform duration-200 ease-in-out'
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = 'Switch';

export { Switch };
