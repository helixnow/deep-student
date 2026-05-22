import React from 'react';
import { cn } from '@/utils/cn';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface TableBlockShellProps extends React.HTMLAttributes<HTMLDivElement> {
  tableClassName?: string;
  tableProps?: React.TableHTMLAttributes<HTMLTableElement>;
}

/**
 * Shared shell for markdown tables.
 * Uses ScrollArea for consistent overlay scrollbar behaviour on wide tables.
 */
export const TableBlockShell: React.FC<TableBlockShellProps> = ({
  className,
  tableClassName,
  tableProps,
  children,
  ...props
}) => {
  return (
    <div className={cn('table-wrapper', className)} {...props}>
      <ScrollArea orientation="horizontal" className="table-scroll-area">
        <table className={cn('markdown-table', tableClassName)} {...tableProps}>
          {children}
        </table>
      </ScrollArea>
    </div>
  );
};
