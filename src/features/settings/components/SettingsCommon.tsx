/**
 * 设置页面公共组件
 * 
 * 从 Settings.tsx 拆分：SettingSection、SettingItem
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { motion, useSpring } from 'framer-motion';
import { Textarea } from '@/components/ui/shad/Textarea';

export const settingsQuietHoverClassName = 'hover:bg-[color:var(--sidebar-quiet-hover)]';

export const settingsQuietRowBaseClassName =
  'rounded-[var(--button-radius)] transition-[background-color] duration-150 ease-out motion-reduce:transition-none';

export const settingsQuietActiveSurfaceClassName = 'bg-[color:var(--sidebar-quiet-active)]';

export const settingsQuietInteractiveRowClassName = cn(
  settingsQuietRowBaseClassName,
);

export const settingsQuietIdleRowClassName = 'text-muted-foreground';

export const settingsQuietSelectedRowClassName = cn(
  settingsQuietRowBaseClassName,
  settingsQuietActiveSurfaceClassName,
  'text-foreground font-medium',
);

export const settingsQuietButtonIdleRowClassName = cn(
  settingsQuietInteractiveRowClassName,
  settingsQuietIdleRowClassName,
  '!bg-transparent hover:!bg-[color:var(--sidebar-quiet-hover)] hover:!text-muted-foreground',
);

export const settingsQuietButtonSelectedRowClassName = cn(
  settingsQuietSelectedRowClassName,
  '!bg-[color:var(--sidebar-quiet-active)] hover:!bg-[color:var(--sidebar-quiet-active)] hover:!text-foreground',
);

export const settingsQuietTableRowClassName = cn(
  'border-border/40 transition-[background-color] duration-150 ease-out motion-reduce:transition-none',
  settingsQuietHoverClassName,
);

export interface SettingSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  hideHeader?: boolean;
  rightSlot?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  dataTourId?: string;
}

export const SettingSection: React.FC<SettingSectionProps> = ({
  title,
  description,
  children,
  hideHeader = false,
  rightSlot,
  className,
  contentClassName,
  dataTourId
}) => (
  <div
    data-tour-id={dataTourId}
    className={cn(
      'w-full py-6 first:pt-0',
      className
    )}
  >
    {/* 双栏切换点与 isSmallScreen（<768）对齐 */}
    {!hideHeader && (
      <div className="flex flex-col gap-1 mb-6 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1 min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-foreground md:text-lg">{title}</h2>
          {description && (
            <p className="text-md leading-relaxed text-muted-foreground md:text-sm">{description}</p>
          )}
        </div>
        {rightSlot && <div className="ml-0 md:ml-4 flex-shrink-0">{rightSlot}</div>}
      </div>
    )}
    <div className={cn('space-y-6 w-full', contentClassName)}>
      {children}
    </div>
  </div>
);
