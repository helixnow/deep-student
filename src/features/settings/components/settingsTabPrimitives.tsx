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
  <div className={cn('group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 overflow-hidden', settingsQuietInteractiveRowClassName, className)}>
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
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
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) => {
  const switchLabelId = useId();
  const switchDescriptionId = `${switchLabelId}-description`;

  return (
    <div className={cn('group flex items-center justify-between gap-4 py-2.5 px-1', settingsQuietInteractiveRowClassName)}>
      <div className="flex-1 min-w-0">
        <h3 id={switchLabelId} className="text-sm text-foreground/90 leading-tight">{title}</h3>
        {description && (
          <p id={switchDescriptionId} className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
            {description}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={switchLabelId}
        aria-describedby={description ? switchDescriptionId : undefined}
      />
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
