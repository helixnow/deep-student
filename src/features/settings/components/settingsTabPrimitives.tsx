import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/shad/Switch';
import { settingsQuietInteractiveRowClassName } from './SettingsCommon';

export const SettingRow = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) => (
  // 双栏切换点与 useBreakpoint().isSmallScreen（<768，App shell 移动模式）对齐，
  // 避免 640-767px 区间「移动页面模式 + 桌面双栏行」的形态混搭
  <div className={cn('group flex flex-col md:flex-row md:items-start gap-2 py-2.5 px-1 overflow-hidden', settingsQuietInteractiveRowClassName, className)}>
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

export const SwitchRow = ({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  loading,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
}) => {
  const switchLabelId = useId();
  const switchDescriptionId = `${switchLabelId}-description`;

  return (
    // 整行可点切换（iOS/Android 设置页惯例），开关本体 stopPropagation 避免双重切换
    <div
      className={cn('group flex cursor-pointer items-center justify-between gap-4 py-2.5 px-1', settingsQuietInteractiveRowClassName)}
      onClick={() => {
        if (!disabled && !loading) onCheckedChange(!checked);
      }}
    >
      <div className="flex-1 min-w-0">
        <h3 id={switchLabelId} className="text-sm text-foreground/90 leading-tight">{title}</h3>
        {description && (
          <p id={switchDescriptionId} className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
            {description}
          </p>
        )}
      </div>
      {loading ? (
        <div
          aria-hidden="true"
          className="h-6 w-11 shrink-0 rounded-full bg-muted/50 animate-pulse"
        />
      ) : (
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            aria-labelledby={switchLabelId}
            aria-describedby={description ? switchDescriptionId : undefined}
          />
        </span>
      )}
    </div>
  );
};

export const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

export const SettingsGroup = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <section className={cn('rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4', className)}>
    <GroupTitle title={title} />
    {description ? (
      <p className="px-1 pb-3 text-xs leading-5 text-muted-foreground/80">
        {description}
      </p>
    ) : null}
    <div className="space-y-px">
      {children}
    </div>
  </section>
);
