import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../../lib/utils';

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  size?: 'sm' | 'default';
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, size = 'default', ...props }, ref) => {
  const isSmall = size === 'sm';

  return (
    <SwitchPrimitives.Root
      data-size={size}
      className={cn(
        'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[color:var(--button-primary-border)] data-[state=checked]:bg-[color:var(--button-primary-foreground)] data-[state=unchecked]:border-[color:var(--button-utility-border)] data-[state=unchecked]:bg-[color:var(--button-utility-surface)]',
        isSmall ? 'h-4 w-7 p-[2px]' : 'h-5 w-9 p-[2px]',
        className
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-[color:var(--surface-panel-strong)] shadow-none ring-1 ring-[color:var(--shell-workspace-border)] transition-transform duration-200 ease-in-out',
          isSmall
            ? 'h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0'
            : 'h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
        )}
      />
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = 'Switch';

export { Switch };
