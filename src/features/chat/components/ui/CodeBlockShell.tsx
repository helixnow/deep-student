import React from 'react';
import { cn } from '@/utils/cn';

export interface CodeBlockShellProps extends React.HTMLAttributes<HTMLDivElement> {
  header?: React.ReactNode;
  bodyClassName?: string;
  bodyProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * Shared shell for block-level code outputs.
 * Keeps the legacy CSS hooks while moving structure into a dedicated component.
 */
export const CodeBlockShell: React.FC<CodeBlockShellProps> = ({
  className,
  header,
  bodyClassName,
  bodyProps,
  children,
  ...props
}) => {
  const { className: bodyClassNameFromProps, ...restBodyProps } = bodyProps ?? {};

  return (
    <div className={cn('code-block-wrapper', className)} {...props}>
      {header}
      <div className={cn(bodyClassName, bodyClassNameFromProps)} {...restBodyProps}>
        {children}
      </div>
    </div>
  );
};
