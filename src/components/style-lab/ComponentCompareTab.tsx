import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
// eslint-disable-next-line no-restricted-imports -- Style lab intentionally compares the legacy shad Button path against the target NotionButton path.
import { Button as ShadButton } from '@/components/ui/shad/Button';
import { Switch } from '@/components/ui/shad/Switch';
import { CommonTooltip, type TooltipPosition, type TooltipTheme } from '@/components/shared/CommonTooltip';
// eslint-disable-next-line no-restricted-imports
import {
  Tooltip as ShadTooltip,
  TooltipContent as ShadTooltipContent,
  TooltipProvider as ShadTooltipProvider,
  TooltipTrigger as ShadTooltipTrigger,
} from '@/components/ui/shad/Tooltip';
import {
  showGlobalNotification,
  type GlobalNotificationBorderTone,
  type GlobalNotificationIconMode,
  type GlobalNotificationProgressMode,
  type GlobalNotificationType,
} from '@/components/UnifiedNotification';

// UnifiedNotification 的 icon/progress 实际类型是 boolean | 'auto'
// 这里用语义化的 UI 选项映射到实际值
type IconOption = { label: string; value: GlobalNotificationIconMode };
type ProgressOption = { label: string; value: GlobalNotificationProgressMode };

const ICON_OPTIONS: IconOption[] = [
  { label: 'auto', value: 'auto' },
  { label: '显示', value: true },
  { label: '隐藏', value: false },
];

const PROGRESS_OPTIONS: ProgressOption[] = [
  { label: '无', value: false },
  { label: '显示', value: true },
  { label: 'auto', value: 'auto' },
];

// ─── Button 对比 ────────────────────────────────────────────────

type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS = [
  { label: 'Primary', notionVariant: 'primary', shadVariant: 'default' },
  { label: 'Default', notionVariant: 'default', shadVariant: 'secondary' },
  { label: 'Ghost', notionVariant: 'ghost', shadVariant: 'ghost' },
  { label: 'Outline', notionVariant: 'outline', shadVariant: 'outline' },
  { label: 'Danger', notionVariant: 'danger', shadVariant: 'destructive' },
] as const;

function ButtonCompareSection() {
  const [size, setSize] = useState<ButtonSize>('md');
  const [disabled, setDisabled] = useState(false);

  const shadSize = size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          {(['sm', 'md', 'lg'] as const).map(s => (
            <button
              key={s}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', size === s ? 'bg-[color:var(--interactive-selected)] text-[color:var(--text-primary)]' : 'text-[color:var(--text-muted)] hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setSize(s)}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)]">
          <Switch checked={disabled} onCheckedChange={setDisabled} />
          Disabled
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[color:var(--border-soft)]">
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">Variant</th>
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">NotionButton (目标)</th>
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">shad Button (遗留)</th>
              <th className="text-left py-2 text-[color:var(--text-muted)] font-medium">原生 button</th>
            </tr>
          </thead>
          <tbody>
            {BUTTON_VARIANTS.map(v => (
              <tr key={v.label} className="border-b border-[color:var(--border-soft)]">
                <td className="py-3 pr-4 text-[color:var(--text-secondary)]">{v.label}</td>
                <td className="py-3 pr-4">
                  <NotionButton variant={v.notionVariant as any} size={size} disabled={disabled}>
                    {v.label}
                  </NotionButton>
                </td>
                <td className="py-3 pr-4">
                  <ShadButton variant={v.shadVariant as any} size={shadSize} disabled={disabled}>
                    {v.label}
                  </ShadButton>
                </td>
                <td className="py-3">
                  <button
                    type="button"
                    disabled={disabled}
                    className="px-3 py-1.5 rounded border text-xs disabled:opacity-50"
                  >
                    {v.label}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-[color:var(--text-muted)]">
        迁移建议：业务按钮优先消费 NotionButton；缺能力时回 buttonPrimitiveContract 补齐。
      </p>
    </div>
  );
}

// ─── Switch 对比 ────────────────────────────────────────────────

function SwitchCompareSection() {
  const [checked, setChecked] = useState(true);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6">
        <div className="space-y-2">
          <p className="text-xs text-[color:var(--text-muted)]">shad Switch (Radix, 推荐)</p>
          <div className="flex items-center gap-3">
            <Switch checked={checked} onCheckedChange={setChecked} />
            <Switch checked={checked} onCheckedChange={setChecked} className="scale-[0.8]" />
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-[color:var(--text-muted)]">原生 checkbox (对照)</p>
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="w-4 h-4" />
        </div>
      </div>
      <p className="text-[11px] text-[color:var(--text-muted)]">
        迁移建议：业务开关保留 shad Switch 主路径。Radix 负责 role、键盘、表单事件和 data-state。
      </p>
    </div>
  );
}

// ─── Tooltip 对比 ───────────────────────────────────────────────

const TOOLTIP_POSITIONS: TooltipPosition[] = ['top', 'right', 'bottom', 'left'];
const TOOLTIP_THEMES: TooltipTheme[] = ['dark', 'light', 'auto'];

function TooltipCompareSection() {
  const [position, setPosition] = useState<TooltipPosition>('top');
  const [theme, setTheme] = useState<TooltipTheme>('dark');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[color:var(--text-muted)]">位置:</span>
          {TOOLTIP_POSITIONS.map(p => (
            <button
              key={p}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', position === p ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setPosition(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[color:var(--text-muted)]">主题:</span>
          {TOOLTIP_THEMES.map(t => (
            <button
              key={t}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', theme === t ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-8 py-6 justify-center">
        <div className="text-center space-y-2">
          <p className="text-[11px] text-[color:var(--text-muted)]">CommonTooltip (目标)</p>
          <CommonTooltip content="这是 CommonTooltip" position={position} theme={theme}>
            <NotionButton variant="outline" size="sm">Hover me</NotionButton>
          </CommonTooltip>
        </div>

        <div className="text-center space-y-2">
          <p className="text-[11px] text-[color:var(--text-muted)]">shad Tooltip (遗留)</p>
          <ShadTooltipProvider>
            <ShadTooltip>
              <ShadTooltipTrigger asChild>
                <NotionButton variant="outline" size="sm">Hover me</NotionButton>
              </ShadTooltipTrigger>
              <ShadTooltipContent side={position === 'left' ? 'left' : position === 'right' ? 'right' : position === 'bottom' ? 'bottom' : 'top'}>
                这是 shad Tooltip
              </ShadTooltipContent>
            </ShadTooltip>
          </ShadTooltipProvider>
        </div>

        <div className="text-center space-y-2">
          <p className="text-[11px] text-[color:var(--text-muted)]">原生 title (对照)</p>
          <NotionButton variant="outline" size="sm" title="这是原生 title">Hover me</NotionButton>
        </div>
      </div>
    </div>
  );
}

// ─── Toast 对比 ─────────────────────────────────────────────────

type ToastSample = {
  type: GlobalNotificationType;
  label: string;
  title: string;
  message: string;
  actionLabel?: string;
  borderTone?: GlobalNotificationBorderTone;
  icon?: GlobalNotificationIconMode;
  progress?: GlobalNotificationProgressMode;
};

const TOAST_SAMPLES: ToastSample[] = [
  {
    type: 'success',
    label: 'Success',
    title: '同步完成',
    message: '资料库同步完成。',
    actionLabel: '查看',
  },
  {
    type: 'warning',
    label: 'Warning',
    title: '需要复核',
    message: '当前索引有 3 个条目需要复核。',
    actionLabel: '重试',
  },
  {
    type: 'error',
    label: 'Error',
    title: '同步失败',
    message: '本地数据库被占用。',
    actionLabel: '重试',
  },
  {
    type: 'info',
    label: 'Info',
    title: '已切换会话',
    message: '已切换到新的学习会话。',
    actionLabel: '撤销',
  },
];

function ToastCompareSection() {
  const [iconIdx, setIconIdx] = useState(0);
  const [progressIdx, setProgressIdx] = useState(0);
  const [borderTone, setBorderTone] = useState<GlobalNotificationBorderTone | undefined>(undefined);

  const currentIcon = ICON_OPTIONS[iconIdx].value;
  const currentProgress = PROGRESS_OPTIONS[progressIdx].value;

  const fireToast = (sample: ToastSample) => {
    showGlobalNotification(sample.type, sample.message, sample.title, {
      icon: currentIcon,
      progress: currentProgress,
      borderTone: borderTone || sample.borderTone,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[color:var(--text-muted)]">Icon:</span>
          {ICON_OPTIONS.map((opt, idx) => (
            <button
              key={opt.label}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', iconIdx === idx ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setIconIdx(idx)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[color:var(--text-muted)]">Progress:</span>
          {PROGRESS_OPTIONS.map((opt, idx) => (
            <button
              key={opt.label}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', progressIdx === idx ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setProgressIdx(idx)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[color:var(--text-muted)]">Border:</span>
          {([undefined, 'neutral', 'brand'] as const).map(b => (
            <button
              key={b ?? 'auto'}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', borderTone === b ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setBorderTone(b)}
            >
              {b ?? 'auto'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {TOAST_SAMPLES.map(sample => (
          <NotionButton
            key={sample.label}
            variant="outline"
            size="sm"
            onClick={() => fireToast(sample)}
          >
            触发 {sample.label}
          </NotionButton>
        ))}
      </div>
    </div>
  );
}

// ─── 导出主组件 ─────────────────────────────────────────────────

type CompareSection = 'button' | 'switch' | 'tooltip' | 'toast';

export function ComponentCompareTab() {
  const [activeSection, setActiveSection] = useState<CompareSection>('button');

  const sections: Array<{ id: CompareSection; label: string }> = [
    { id: 'button', label: 'Button' },
    { id: 'switch', label: 'Switch' },
    { id: 'tooltip', label: 'Tooltip' },
    { id: 'toast', label: 'Toast' },
  ];

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-[color:var(--border-soft)] pb-0">
        {sections.map(s => (
          <button
            key={s.id}
            type="button"
            className={cn(
              'px-3 py-1.5 text-xs rounded-t-md transition-colors -mb-px border-b-2',
              activeSection === s.id
                ? 'border-[color:var(--button-primary-foreground)] text-[color:var(--text-primary)] bg-[color:var(--surface-elevated)]'
                : 'border-transparent text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]',
            )}
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="pt-2">
        {activeSection === 'button' && <ButtonCompareSection />}
        {activeSection === 'switch' && <SwitchCompareSection />}
        {activeSection === 'tooltip' && <TooltipCompareSection />}
        {activeSection === 'toast' && <ToastCompareSection />}
      </div>
    </div>
  );
}
