import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/shad/Switch';
import { settingsQuietInteractiveRowClassName } from './SettingsCommon';

export const SettingRow = ({
  title,
  description,
  children,
  className,
  controlClassName,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** 右列（控件列）附加类，如滑块行需固定行程 md:w-[200px] */
  controlClassName?: string;
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
    <div className={cn('w-full min-w-0 flex-shrink-0 md:w-auto', controlClassName)}>
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
  // 结构：小标题在卡片外（划分页面区域），圆角卡片无描边、纯填充
  // bg-muted（亮 #f0f0f0 比背景深 / 暗 14% 比背景浅，双向满足对比要求）。
  <section
    className={cn(
      'min-w-0',
      // content-visibility:auto（静态、非手势期切换）：离屏分组跳过布局/绘制与
      // AX bounds 序列化——拖拽窗口时的每帧税 ∝ 参与布局的节点数（见 wb-interaction-trace）。
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
    <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4">
      <div className="space-y-px">
        {children}
      </div>
    </div>
  </section>
);

/** 紧凑滑块：PDF/OCR 设置共用（原两文件各有一份 drift 拷贝，2026-09 上提统一） */
export const SettingsSlider: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  showValue?: boolean;
  suffix?: string;
}> = ({ value, min, max, step, onChange, disabled, showValue = true, suffix = '' }) => (
  <div className="flex items-center gap-2">
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      disabled={disabled}
      className={cn(
        'settings-range-slider flex-1 h-1.5 bg-muted rounded-full appearance-none cursor-pointer',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    />
    {showValue && (
      <span className="text-xs text-muted-foreground/70 min-w-[3.5rem] text-right">
        {value}{suffix}
      </span>
    )}
  </div>
);
