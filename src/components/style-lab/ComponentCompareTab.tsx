import React, { useState } from 'react';
// Phosphor icons for the SegmentedControl demo — matches the production
// AppearanceTab usage so the style-lab preview reflects what users actually see.
import { Monitor, Moon, Sun } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
// eslint-disable-next-line no-restricted-imports -- Style lab intentionally compares the legacy shad Button path against the target NotionButton path.
import { Button as ShadButton } from '@/components/ui/shad/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/shad/Switch';
import { Input as ShadInput } from '@/components/ui/shad/Input';
import { Textarea as ShadTextarea } from '@/components/ui/shad/Textarea';
import { Checkbox as ShadCheckbox } from '@/components/ui/shad/Checkbox';
import {
  Select as ShadSelect,
  SelectTrigger as ShadSelectTrigger,
  SelectValue as ShadSelectValue,
  SelectContent as ShadSelectContent,
  SelectItem as ShadSelectItem,
} from '@/components/ui/shad/Select';
import { CommonTooltip, type TooltipPosition, type TooltipTheme } from '@/components/shared/CommonTooltip';
// eslint-disable-next-line no-restricted-imports
import {
  Tooltip as ShadTooltip,
  TooltipContent as ShadTooltipContent,
  TooltipProvider as ShadTooltipProvider,
  TooltipTrigger as ShadTooltipTrigger,
} from '@/components/ui/shad/Tooltip';
// eslint-disable-next-line no-restricted-imports
import { Popover as ShadPopover, PopoverTrigger as ShadPopoverTrigger, PopoverContent as ShadPopoverContent } from '@/components/ui/shad/Popover';
// eslint-disable-next-line no-restricted-imports
import {
  Dialog as ShadDialog,
  DialogTrigger as ShadDialogTrigger,
  DialogContent as ShadDialogContent,
  DialogHeader as ShadDialogHeader,
  DialogTitle as ShadDialogTitle,
  DialogDescription as ShadDialogDescription,
  DialogFooter as ShadDialogFooter,
} from '@/components/ui/shad/Dialog';
// eslint-disable-next-line no-restricted-imports
import {
  Sheet as ShadSheet,
  SheetTrigger as ShadSheetTrigger,
  SheetContent as ShadSheetContent,
  SheetHeader as ShadSheetHeader,
  SheetTitle as ShadSheetTitle,
  SheetDescription as ShadSheetDescription,
  SheetFooter as ShadSheetFooter,
} from '@/components/ui/shad/Sheet';
import { NotionDialog } from '@/components/ui/NotionDialog';
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

// ─── Form Controls 对比 ────────────────────────────────────────

function FormControlsCompareSection() {
  const [inputValue, setInputValue] = useState('DeepStudent');
  const [textareaValue, setTextareaValue] = useState('多行文本示例\n支持垂直拉伸。');
  const [switchChecked, setSwitchChecked] = useState(true);
  const [checkboxChecked, setCheckboxChecked] = useState(true);
  const [selectValue, setSelectValue] = useState('b');
  const [disabled, setDisabled] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)]">
          <Switch checked={disabled} onCheckedChange={setDisabled} />
          Disabled
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <colgroup>
            <col className="w-[12%]" />
            <col className="w-[29%]" />
            <col className="w-[29%]" />
            <col className="w-[30%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[color:var(--border-soft)]">
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">控件</th>
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">shad (目标)</th>
              <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">— 备用 —</th>
              <th className="text-left py-2 text-[color:var(--text-muted)] font-medium">原生 (遗留)</th>
            </tr>
          </thead>
          <tbody>
            {/* Input */}
            <tr className="border-b border-[color:var(--border-soft)]">
              <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">Input</td>
              <td className="py-3 pr-4 align-top">
                <ShadInput
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  placeholder="shad Input"
                  disabled={disabled}
/>
              </td>
              <td className="py-3 pr-4 align-top text-[color:var(--text-muted)]">
                <span className="text-[11px]">（Input 无备用组件路径）</span>
              </td>
              <td className="py-3 align-top">
                <input
                  type="text"
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  placeholder="native <input>"
                  disabled={disabled}
                  className="w-full px-3 py-1.5 rounded border text-sm disabled:opacity-50"
/>
              </td>
            </tr>

            {/* Textarea */}
            <tr className="border-b border-[color:var(--border-soft)]">
              <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">Textarea</td>
              <td className="py-3 pr-4 align-top">
                <ShadTextarea
                  rows={3}
                  value={textareaValue}
                  onChange={e => setTextareaValue(e.target.value)}
                  placeholder="shad Textarea"
                  disabled={disabled}
/>
              </td>
              <td className="py-3 pr-4 align-top text-[color:var(--text-muted)]">
                <span className="text-[11px]">（Textarea 无备用组件路径）</span>
              </td>
              <td className="py-3 align-top">
                <textarea
                  rows={3}
                  value={textareaValue}
                  onChange={e => setTextareaValue(e.target.value)}
                  placeholder="native <textarea>"
                  disabled={disabled}
                  className="w-full px-3 py-1.5 rounded border text-sm disabled:opacity-50 resize-y"
/>
              </td>
            </tr>

            {/* Switch */}
            <tr className="border-b border-[color:var(--border-soft)]">
              <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">Switch</td>
              <td className="py-3 pr-4 align-top">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={switchChecked}
                    onCheckedChange={setSwitchChecked}
                    disabled={disabled}
/>
                  <Switch
                    size="sm"
                    checked={switchChecked}
                    onCheckedChange={setSwitchChecked}
                    disabled={disabled}
/>
                  <span className="text-[10px] text-[color:var(--text-muted)] leading-tight">
                    默认 44×24 / sm 28×16
                  </span>
                </div>
              </td>
              <td className="py-3 pr-4 align-top">
                <div className="flex flex-col gap-1.5">
                  {/* 历史实现：OcrEngineCard 曾手写的 28×16 迷你开关。
                      已迁移为 <Switch size="sm" />，此处保留作视觉对照与回归基线。 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={switchChecked}
                    onClick={() => !disabled && setSwitchChecked(!switchChecked)}
                    disabled={disabled}
                    className={cn(
                      'relative shrink-0 rounded-full transition-colors disabled:opacity-50',
                      'w-[28px] h-[16px]',
                      switchChecked ? 'bg-primary' : 'bg-muted-foreground/20',
                    )}
                    title="legacy mini switch"
                  >
                    <span
                      className={cn(
                        'block absolute rounded-full bg-white shadow-sm transition-transform',
                        'w-[12px] h-[12px] top-[2px]',
                        switchChecked ? 'left-[14px]' : 'left-[2px]',
                      )}
/>
                  </button>
                  <span className="text-[10px] text-[color:var(--text-muted)] leading-tight">
                    legacy mini (已被 sm 变体取代)
                  </span>
                </div>
              </td>
              <td className="py-3 align-top">
                <label className="inline-flex items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
                  <input
                    type="checkbox"
                    checked={switchChecked}
                    onChange={e => setSwitchChecked(e.target.checked)}
                    disabled={disabled}
                    size={16} />
                  native checkbox (无真正原生 switch)
                </label>
              </td>
            </tr>

            {/* Checkbox */}
            <tr className="border-b border-[color:var(--border-soft)]">
              <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">Checkbox</td>
              <td className="py-3 pr-4 align-top">
                <label className="inline-flex items-center gap-2 text-[color:var(--text-secondary)]">
                  <ShadCheckbox
                    checked={checkboxChecked}
                    onCheckedChange={v => setCheckboxChecked(v === true)}
                    disabled={disabled}
/>
                  shad Checkbox
                </label>
              </td>
              <td className="py-3 pr-4 align-top text-[color:var(--text-muted)]">
                <span className="text-[11px]">（Checkbox 无备用组件路径）</span>
              </td>
              <td className="py-3 align-top">
                <label className="inline-flex items-center gap-2 text-[color:var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={checkboxChecked}
                    onChange={e => setCheckboxChecked(e.target.checked)}
                    disabled={disabled}
                    size={16} />
                  native checkbox
                </label>
              </td>
            </tr>

            {/* Select */}
            <tr className="border-b border-[color:var(--border-soft)]">
              <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">Select</td>
              <td className="py-3 pr-4 align-top">
                <ShadSelect value={selectValue} onValueChange={setSelectValue} disabled={disabled}>
                  <ShadSelectTrigger>
                    <ShadSelectValue placeholder="请选择" />
                  </ShadSelectTrigger>
                  <ShadSelectContent>
                    <ShadSelectItem value="a">选项 A</ShadSelectItem>
                    <ShadSelectItem value="b">选项 B</ShadSelectItem>
                    <ShadSelectItem value="c">选项 C</ShadSelectItem>
                  </ShadSelectContent>
                </ShadSelect>
              </td>
              <td className="py-3 pr-4 align-top text-[color:var(--text-muted)]">
                <span className="text-[11px]">
                  选项多 / 需搜索时改用 Combobox；固定 2-4 项可用 SegmentedControl。
                </span>
              </td>
              <td className="py-3 align-top">
                <select
                  value={selectValue}
                  onChange={e => setSelectValue(e.target.value)}
                  disabled={disabled}
                  className="w-full px-2 py-1.5 rounded border text-sm disabled:opacity-50"
                >
                  <option value="a">选项 A</option>
                  <option value="b">选项 B</option>
                  <option value="c">选项 C</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="text-[11px] text-[color:var(--text-muted)] space-y-1 list-disc pl-4">
        <li>Input / Textarea / Select / Switch / Checkbox：业务代码保留 shad 主路径，原生元素仅作对照观察样式差异。</li>
        <li>Input / Textarea / Select 共享 <code>inputShellClass</code>，三者在同一表单中外壳视觉完全对齐。</li>
        <li>原生 <code>&lt;select&gt;</code>：不在目标设计系统内，应迁移到 shad Select；选项多 / 需搜索改用 Combobox。</li>
        <li>Switch 无对应原生元素，原生 checkbox 仅作语义近似对照。</li>
        <li>
          Switch 新增 <code>size="sm"</code> 变体（28×16）用于密集列表；OcrEngineCard 的两处手写 mini 已迁移。
          中列的 legacy mini 仅留作视觉回归基线，未来可删除。
        </li>
      </ul>
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

// ─── 弹窗对比 ─────────────────────────────────────────────────

type SheetSide = 'top' | 'right' | 'bottom' | 'left';

function PopupCompareSection() {
  const [sheetSide, setSheetSide] = useState<SheetSide>('right');
  const [notionDialogOpen, setNotionDialogOpen] = useState(false);

  return (
    <div className="space-y-8">
      {/* ── Popover ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Popover</h3>
        <p className="text-[11px] text-[color:var(--text-muted)]">
          点击触发的浮层面板。用于表单选项、筛选菜单等轻量交互场景。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[43%]" />
              <col className="w-[43%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[color:var(--border-soft)]">
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">实现</th>
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">shad Popover (目标)</th>
                <th className="text-left py-2 text-[color:var(--text-muted)] font-medium">无对应遗留</th>
              </tr>
            </thead>
            <tbody>
              {/* 基本用法 */}
              <tr className="border-b border-[color:var(--border-soft)]">
                <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">基本</td>
                <td className="py-3 pr-4 align-top">
                  <ShadPopover>
                    <ShadPopoverTrigger asChild>
                      <NotionButton variant="outline" size="sm">打开 Popover</NotionButton>
                    </ShadPopoverTrigger>
                    <ShadPopoverContent align="start" sideOffset={8}>
                      <div className="space-y-2 p-2">
                        <p className="text-sm font-medium text-[color:var(--text-primary)]">Popover 内容</p>
                        <p className="text-[11px] text-[color:var(--text-muted)]">
                          支持 portal 定位、碰撞检测、滚动跟随。
                        </p>
                      </div>
                    </ShadPopoverContent>
                  </ShadPopover>
                </td>
                <td className="py-3 align-top text-[color:var(--text-muted)]">
                  <span className="text-[11px]">（Popover 无 Radix 遗留路径）</span>
                </td>
              </tr>
              {/* 带表单内容 */}
              <tr className="border-b border-[color:var(--border-soft)]">
                <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">表单</td>
                <td className="py-3 pr-4 align-top">
                  <ShadPopover>
                    <ShadPopoverTrigger asChild>
                      <NotionButton variant="outline" size="sm">日期筛选</NotionButton>
                    </ShadPopoverTrigger>
                    <ShadPopoverContent align="start" sideOffset={8} className="w-56">
                      <div className="space-y-2 p-2">
                        <p className="text-xs font-medium text-[color:var(--text-primary)]">时间范围</p>
                        <div className="space-y-1.5">
                          {['今天', '本周', '本月', '全部'].map(opt => (
                            <button
                              key={opt}
                              type="button"
                              className="w-full text-left px-2 py-1 rounded text-xs hover:bg-[color:var(--interactive-hover)] text-[color:var(--text-secondary)] transition-colors"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    </ShadPopoverContent>
                  </ShadPopover>
                </td>
                <td className="py-3 align-top text-[color:var(--text-muted)]">
                  <span className="text-[11px]">（无遗留路径）</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Dialog ──────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Dialog</h3>
        <p className="text-[11px] text-[color:var(--text-muted)]">
          居中模态框，带遮罩层和动画。用于确认操作、表单提交等需要用户聚焦的场景。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[43%]" />
              <col className="w-[43%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[color:var(--border-soft)]">
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">实现</th>
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">shad Dialog (遗留)</th>
                <th className="text-left py-2 text-[color:var(--text-muted)] font-medium">NotionDialog (目标)</th>
              </tr>
            </thead>
            <tbody>
              {/* 基本用法 */}
              <tr className="border-b border-[color:var(--border-soft)]">
                <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">基本</td>
                <td className="py-3 pr-4 align-top">
                  <ShadDialog>
                    <ShadDialogTrigger asChild>
                      <NotionButton variant="outline" size="sm">shad Dialog</NotionButton>
                    </ShadDialogTrigger>
                    <ShadDialogContent>
                      <ShadDialogHeader>
                        <ShadDialogTitle>shad Dialog 标题</ShadDialogTitle>
                        <ShadDialogDescription>这是 shad Dialog 的描述文字。</ShadDialogDescription>
                      </ShadDialogHeader>
                      <p className="text-sm text-[color:var(--text-secondary)]">
                        内容区域示例。shad Dialog 基于自定义 portal 实现，使用 framer-motion 动画。
                      </p>
                      <ShadDialogFooter>
                        <NotionButton variant="ghost" size="sm">取消</NotionButton>
                        <NotionButton variant="primary" size="sm">确认</NotionButton>
                      </ShadDialogFooter>
                    </ShadDialogContent>
                  </ShadDialog>
                </td>
                <td className="py-3 pr-4 align-top">
                  <NotionButton variant="outline" size="sm" onClick={() => setNotionDialogOpen(true)}>
                    NotionDialog
                  </NotionButton>
                  <NotionDialog
                    open={notionDialogOpen}
                    onOpenChange={setNotionDialogOpen}
                  >
                    <p className="text-sm text-[color:var(--text-secondary)]">
                      内容区域示例。NotionDialog 是目标设计系统的模态框，封装了 portal + 动画 + 可滚动内容区。
                    </p>
                  </NotionDialog>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Sheet ───────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Sheet</h3>
        <p className="text-[11px] text-[color:var(--text-muted)]">
          边缘滑出面板，支持四方向。用于详情面板、设置面板等较大内容区域。
        </p>
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="text-xs text-[color:var(--text-muted)]">方向:</span>
          {(['top', 'right', 'bottom', 'left'] as SheetSide[]).map(side => (
            <button
              key={side}
              type="button"
              className={cn('px-2 py-0.5 rounded text-xs', sheetSide === side ? 'bg-[color:var(--interactive-selected)]' : 'hover:bg-[color:var(--interactive-hover)]')}
              onClick={() => setSheetSide(side)}
            >
              {side}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[43%]" />
              <col className="w-[43%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[color:var(--border-soft)]">
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">实现</th>
                <th className="text-left py-2 pr-4 text-[color:var(--text-muted)] font-medium">shad Sheet (目标)</th>
                <th className="text-left py-2 text-[color:var(--text-muted)] font-medium">无对应遗留</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[color:var(--border-soft)]">
                <td className="py-3 pr-4 align-top text-[color:var(--text-secondary)]">基本</td>
                <td className="py-3 pr-4 align-top">
                  <ShadSheet>
                    <ShadSheetTrigger asChild>
                      <NotionButton variant="outline" size="sm">打开 Sheet ({sheetSide})</NotionButton>
                    </ShadSheetTrigger>
                    <ShadSheetContent side={sheetSide}>
                      <ShadSheetHeader>
                        <ShadSheetTitle>Sheet 标题</ShadSheetTitle>
                        <ShadSheetDescription>
                          从 {sheetSide} 方向滑出的面板，当前方向：{sheetSide}
                        </ShadSheetDescription>
                      </ShadSheetHeader>
                      <div className="py-4 text-sm text-[color:var(--text-secondary)]">
                        <p>Sheet 内容区域。适用于详情面板、设置、筛选器等。</p>
                        <p className="mt-2">基于 Radix Dialog 原语实现，支持四方向滑入动画。</p>
                      </div>
                      <ShadSheetFooter>
                        <NotionButton variant="primary" size="sm">完成</NotionButton>
                      </ShadSheetFooter>
                    </ShadSheetContent>
                  </ShadSheet>
                </td>
                <td className="py-3 align-top text-[color:var(--text-muted)]">
                  <span className="text-[11px]">（Sheet 无遗留路径）</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 迁移建议 */}
      <ul className="text-[11px] text-[color:var(--text-muted)] space-y-1 list-disc pl-4">
        <li>Popover：业务代码统一使用 shad Popover；无 Radix 遗留，点击触发 + portal 定位 + 碰撞检测。</li>
        <li>Dialog：新代码优先消费 NotionDialog（封装了 actions、scrollable、icon header 等高阶 API）；shad Dialog 保留用于需精细控制 content 的场景。</li>
        <li>Sheet：统一使用 shad Sheet；无遗留路径，四方向滑出 + Radix 原语。</li>
        <li>三者共享 <code>OverlayCoordinator</code> 避免 z-index 冲突；弹窗嵌套时由 coordinator 统一管理层级。</li>
      </ul>
    </div>
  );
}

// ─── SegmentedControl 对比 ─────────────────────────────────────

type ThemeMode = 'light' | 'dark' | 'system';
type TriggerMode = 'hold' | 'toggle';

function SegmentedCompareSection() {
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('hold');
  const [legacyThemeMode, setLegacyThemeMode] = useState<ThemeMode>('light');

  const themeOptions = [
    { value: 'light' as const, label: (
      <>
        <Sun className="h-[18px] w-[18px]" weight="bold" aria-hidden="true" />
        <span>亮色</span>
      </>
    ) },
    { value: 'dark' as const, label: (
      <>
        <Moon className="h-[18px] w-[18px]" weight="bold" aria-hidden="true" />
        <span>暗色</span>
      </>
    ) },
    { value: 'system' as const, label: (
      <>
        <Monitor className="h-[18px] w-[18px]" weight="bold" aria-hidden="true" />
        <span>系统默认</span>
      </>
    ), title: '匹配系统外观设置' },
  ];

  const triggerOptions = [
    { value: 'hold' as const, label: '按住', ariaLabel: '按住听写快捷键' },
    { value: 'toggle' as const, label: '切换', ariaLabel: '按一次开始，再按一次停止' },
  ];

  return (
    <div className="space-y-4">
      {/* 两种规格并排 — 卡片式预览 */}
      <div className="grid gap-3 lg:grid-cols-2">
        {/* default */}
        <div className="rounded-[var(--radius-shell-row)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-[color:var(--text-primary)]">size="default"</span>
              <span className="rounded-full bg-[color:var(--surface-muted)] px-2 py-0.5 text-[10px] text-[color:var(--text-muted)]">stretch</span>
            </div>
            <span className="text-[10px] text-[color:var(--text-muted)]">主题 · 语言 · 会话粒度</span>
          </div>
          <SegmentedControl<ThemeMode>
            ariaLabel="选择主题模式"
            value={themeMode}
            onValueChange={setThemeMode}
            options={themeOptions}
            stretch
/>
          <p className="text-[11px] text-[color:var(--text-muted)]">
            胶囊外壳 · 44px 高 · 图标 + 文案。窄屏下配 <code className="font-mono">stretch</code> 占满宽度。
          </p>
        </div>

        {/* compact */}
        <div className="rounded-[var(--radius-shell-row)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-[color:var(--text-primary)]">size="compact"</span>
            </div>
            <span className="text-[10px] text-[color:var(--text-muted)]">内联表单 · 2-3 项</span>
          </div>
          <div className="flex min-h-[44px] items-center">
            <SegmentedControl<TriggerMode>
              ariaLabel="触发方式"
              value={triggerMode}
              onValueChange={setTriggerMode}
              options={triggerOptions}
              size="compact"
/>
          </div>
          <p className="text-[11px] text-[color:var(--text-muted)]">
            28px 高 · <code className="font-mono">muted/40</code> 背景。密集表单或侧栏的二选一场景。
          </p>
        </div>
      </div>

      {/* 遗留形态 — 迁移基线，视觉弱化 */}
      <details className="rounded-[var(--radius-shell-row)] border border-dashed border-[color:var(--border-soft)] bg-[color:var(--surface-muted)]/50 px-4 py-3 group">
        <summary className="cursor-pointer list-none text-[11px] text-[color:var(--text-muted)] flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--text-muted)]" />
          <span>遗留形态（手写 div + button，禁止新增）</span>
          <span className="ml-auto text-[10px] opacity-60 group-open:hidden">展开查看</span>
        </summary>
        <div className="mt-3 flex items-center gap-3">
          <div
            role="radiogroup"
            aria-label="选择主题模式（遗留示例）"
            className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-panel-strong)] p-1"
          >
            {(['light', 'dark', 'system'] as const).map(mode => {
              const selected = legacyThemeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setLegacyThemeMode(mode)}
                  className={cn(
                    'px-3 py-1 rounded-full text-xs transition-colors',
                    selected
                      ? 'bg-[color:var(--interactive-selected)] text-[color:var(--text-primary)]'
                      : 'text-[color:var(--text-muted)] hover:bg-[color:var(--interactive-hover)]',
                  )}
                >
                  {mode === 'light' ? '亮色' : mode === 'dark' ? '暗色' : '系统'}
                </button>
              );
            })}
          </div>
          <span className="text-[10px] text-[color:var(--text-muted)]">
            无键盘导航 · 无 aria-label · 已被迁移契约守护
          </span>
        </div>
      </details>

      {/* 迁移要点 — 紧凑信息条 */}
      <div className="rounded-[var(--radius-shell-row)] bg-[color:var(--surface-muted)]/60 px-4 py-3 text-[11px] text-[color:var(--text-secondary)] leading-relaxed">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-sm bg-[color:var(--brand-200)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--text-primary)]">APG</span>
          <div className="space-y-1">
            <p>
              <code className="font-mono">role="radiogroup"</code> + 箭头 / Home / End 键盘导航；选项 &gt; 4 或需搜索 → 改用
              <code className="font-mono"> shad Select</code> / <code className="font-mono">Combobox</code>。
            </p>
            <p className="text-[color:var(--text-muted)]">
              迁移契约：<code className="font-mono">tests/vitest/segmentedControlMigrationContract.test.ts</code> 守护 3 个已迁移 surface。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 导出主组件 ─────────────────────────────────────────────────

type CompareSection = 'button' | 'form' | 'segmented' | 'tooltip' | 'toast' | 'popup';

export function ComponentCompareTab() {
  const [activeSection, setActiveSection] = useState<CompareSection>('button');

  const sections: Array<{ id: CompareSection; label: string }> = [
    { id: 'button', label: 'Button' },
    { id: 'form', label: 'Form Controls' },
    { id: 'segmented', label: 'Segmented' },
    { id: 'tooltip', label: 'Tooltip' },
    { id: 'toast', label: 'Toast' },
    { id: 'popup', label: '弹窗' },
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
        {activeSection === 'form' && <FormControlsCompareSection />}
        {activeSection === 'segmented' && <SegmentedCompareSection />}
        {activeSection === 'tooltip' && <TooltipCompareSection />}
        {activeSection === 'toast' && <ToastCompareSection />}
        {activeSection === 'popup' && <PopupCompareSection />}
      </div>
    </div>
  );
}
