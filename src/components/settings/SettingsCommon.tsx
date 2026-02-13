/**
 * 设置页面公共组件
 * 
 * 从 Settings.tsx 拆分：SettingSection、SettingItem
 */

import React, { useState, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { motion, useSpring } from 'framer-motion';

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

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    style={{
      backgroundColor: checked ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
      border: checked ? 'none' : '2px solid hsl(var(--border))'
    }}
    onMouseEnter={(e) => {
      if (checked) {
        e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.9)';
      } else {
        e.currentTarget.style.backgroundColor = 'hsl(var(--neutral))';
      }
    }}
    onMouseLeave={(e) => {
      if (checked) {
        e.currentTarget.style.backgroundColor = 'hsl(var(--primary))';
      } else {
        e.currentTarget.style.backgroundColor = 'hsl(var(--muted-foreground))';
      }
    }}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-background transition duration-300 ease-in-out ${
        checked ? 'translate-x-5' : 'translate-x-1'
      }`}
      style={{
        boxShadow: '0 2px 6px hsl(var(--foreground) / 0.15)'
      }}
    />
  </button>
);

// SettingsTextarea 组件
export const SettingsTextarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={
        ['flex w-full rounded-md border border-[hsl(var(--border))] bg-transparent px-3 py-2 text-sm',
         'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40',
         'resize-y settings-textarea-scrollbar',
         className
        ].filter(Boolean).join(' ')
      }
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
