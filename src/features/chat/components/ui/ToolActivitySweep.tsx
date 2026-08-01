import React from 'react';
import { cn } from '@/utils/cn';
import './ToolActivitySweep.css';

interface ToolActivitySweepProps {
  active: boolean;
  children: React.ReactNode;
  className?: string;
}

/** A subtle shared sweep for tool calls that are still preparing or running. */
export function ToolActivitySweep({ active, children, className }: ToolActivitySweepProps) {
  return (
    <span className={cn('tool-activity-sweep', active && 'tool-activity-sweep--active', className)}>
      {children}
    </span>
  );
}
