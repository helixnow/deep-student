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
        isSmall
          ? 'h-[var(--touch-target-size)] min-h-[var(--touch-target-size)] w-[3.25rem] min-w-[var(--touch-target-size)] p-[3px] lg:h-4 lg:min-h-4 lg:w-7 lg:min-w-7 lg:p-[2px]'
          : 'h-[var(--touch-target-size)] min-h-[var(--touch-target-size)] w-14 min-w-[var(--touch-target-size)] p-[3px] lg:h-5 lg:min-h-5 lg:w-9 lg:min-w-9 lg:p-[2px]',
        className
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-[color:var(--surface-panel-strong)] shadow-none ring-1 ring-[color:var(--shell-workspace-border)] transition-transform duration-200 ease-in-out',
          isSmall
            ? 'h-6 w-6 data-[state=checked]:translate-x-[1.375rem] data-[state=unchecked]:translate-x-0 lg:h-3 lg:w-3 lg:data-[state=checked]:translate-x-3'
            : 'h-7 w-7 data-[state=checked]:translate-x-[1.375rem] data-[state=unchecked]:translate-x-0 lg:h-4 lg:w-4 lg:data-[state=checked]:translate-x-4'
        )}
      />
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = 'Switch';

export { Switch };
