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
  <div className={cn('group flex min-w-0 flex-col gap-2 overflow-hidden px-1 py-2.5 md:flex-row md:items-start', settingsQuietInteractiveRowClassName, className)}>
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground/70 md:line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="w-full min-w-0 flex-shrink-0 md:w-auto">
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
          <p id={switchDescriptionId} className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground/70 md:line-clamp-2">
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

export const GroupTitle = ({
  title,
  titleId,
  actions,
}: {
  title: string;
  titleId?: string;
  actions?: React.ReactNode;
}) => (
  <div className={cn('mb-3 mt-0 min-w-0 px-1', actions && 'flex flex-wrap items-center justify-between gap-2')}>
    <h3 id={titleId} className="text-base font-semibold text-foreground">{title}</h3>
    {actions && <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">{actions}</div>}
  </div>
);

export const SettingsGroup = ({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  /** 标题行右侧操作区（如刷新/新建按钮）。 */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section
    className={cn(
      // content-visibility:auto（静态、非手势期切换）：离屏分组跳过布局/绘制与
      // AX bounds 序列化——拖拽窗口时的每帧税 ∝ 参与布局的节点数（见 wb-interaction-trace）。
      'min-w-0 rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4',
      '[content-visibility:auto] [contain-intrinsic-size:auto_360px]',
      className,
    )}
  >
    <GroupTitle title={title} actions={actions} />
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
