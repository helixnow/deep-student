import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../lib/utils';
import {
  buttonBaseClassName,
  buttonSizeClassNames,
  buttonToneClassNames,
} from '@/components/ui/buttonPrimitiveContract';
import './Button.css';

const buttonVariants = cva(
  buttonBaseClassName,
  {
    variants: {
      variant: {
        default: buttonToneClassNames.primary,
        destructive: buttonToneClassNames.destructive,
        outline: buttonToneClassNames.outline,
        secondary: buttonToneClassNames.secondary,
        ghost: buttonToneClassNames.ghost,
        link: buttonToneClassNames.link,
      },
      size: {
        default: buttonSizeClassNames.default,
        sm: buttonSizeClassNames.sm,
        lg: buttonSizeClassNames.lg,
        icon: buttonSizeClassNames.icon,
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((
  { className, variant, size, asChild = false, ...props },
  ref,
) => {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-shad-button=""
      data-size={size ?? 'default'}
      className={cn(buttonVariants({ variant, size }), className)}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
