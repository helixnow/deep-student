/**
 * 设置页面公共组件
 * 
 * 从 Settings.tsx 拆分：SettingSection、SettingItem
 */

import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { motion, useSpring } from 'framer-motion';
import { Textarea } from '@/components/ui/shad/Textarea';
import '../styles/settings-textarea-scrollbar.css';

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

export const settingsMobileSheetCloseButtonClassName = cn(
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--button-radius)] text-[color:var(--text-secondary)]',
  'transition-[background-color] duration-150 ease-out hover:bg-[color:var(--sidebar-quiet-hover)]',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] motion-reduce:transition-none',
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
    {!hideHeader && (
      <div className="flex flex-col gap-1 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {rightSlot && <div className="ml-0 sm:ml-4 flex-shrink-0">{rightSlot}</div>}
      </div>
    )}
    <div className={cn('space-y-6 w-full', contentClassName)}>
      {children}
    </div>
  </div>
);

export interface SettingItemProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  badge?: string;
}

export const SettingItem: React.FC<SettingItemProps> = ({ label, description, children, badge }) => (
  <div className="py-3 w-full">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm font-medium text-foreground">{label}</label>
          {badge && (
            <span className={`px-2 py-0.5 text-xs rounded-full ${
              badge === 'Beta' ? 'bg-primary/20 text-primary' :
              (badge === '开发中' || badge === 'In Development') ? 'bg-orange-100 text-orange-700' :
              'bg-purple-100 text-purple-700'
            }`}>
              {badge}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>
      <div className="sm:ml-4 flex-shrink-0 w-full sm:w-auto">
        {children}
      </div>
    </div>
  </div>
);

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
}

/**
 * @deprecated 改用 `@/components/ui/shad/Switch` 的 `<Switch>`。
 * 保留仅为兼容遗留引用；在当前代码库中已无调用点。
 */
export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 bg-[hsl(var(--muted-foreground))] border-2 border-[hsl(var(--border))] hover:bg-[hsl(var(--neutral))] aria-checked:bg-[hsl(var(--primary))] aria-checked:border-transparent aria-checked:hover:bg-[hsl(var(--primary)/0.9)]"
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-background shadow-[0_2px_6px_hsl(var(--foreground)/0.15)] transition duration-300 ease-in-out ${
        checked ? 'translate-x-5' : 'translate-x-1'
      }`}
    />
  </button>
);

// SettingsTextarea 组件 — 委托给 shad Textarea
export const SettingsTextarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <Textarea
      ref={ref}
      className={cn('settings-textarea-scrollbar', className)}
      {...props}
    />
  )
);
SettingsTextarea.displayName = 'SettingsTextarea';

// useAnimatedCounter Hook
export const useAnimatedCounter = (value: number, config?: { decimals?: number }) => {
  const spring = useSpring(value, { stiffness: 160, damping: 22, mass: 0.8 });
  const [current, setCurrent] = useState(value);

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  useEffect(() => {
    const unsubscribe = spring.on('change', (latest) => {
      setCurrent(latest);
    });
    return () => {
      unsubscribe();
    };
  }, [spring]);

  const decimals = config?.decimals ?? 0;
  const formatted = decimals > 0 ? current.toFixed(decimals) : Math.round(current).toString();
  return formatted;
};

// AnimatedNumber 组件
export const AnimatedNumber: React.FC<{ value: number; className?: string; decimals?: number; prefix?: string; suffix?: string }> = ({
  value,
  className,
  decimals,
  prefix,
  suffix,
}) => {
  const display = useAnimatedCounter(value, { decimals });
  return (
    <motion.span
      layout
      transition={{ type: 'spring', stiffness: 220, damping: 26 }}
      className={className}
    >
      {prefix}
      {display}
      {suffix}
    </motion.span>
  );
};
