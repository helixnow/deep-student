import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Layers3,
  Palette,
  SlidersHorizontal,
  SplitSquareHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Button as ShadButton } from '@/components/ui/shad/Button';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';

type AuditStatus = 'primary' | 'watch' | 'legacy' | 'target';

type MixedComponentRow = {
  family: string;
  activePaths: string[];
  productCount: string;
  status: AuditStatus;
  nextStep: string;
};

const mixedComponentRows: MixedComponentRow[] = [
  {
    family: 'Button',
    activePaths: ['NotionButton', 'shad Button', 'study-ui Button', '原生 <button>'],
    productCount: '177 native / 66 files',
    status: 'primary',
    nextStep: '以 buttonPrimitiveContract 为唯一合同，逐批替换原生按钮。',
  },
  {
    family: 'Dialog / Sheet',
    activePaths: ['NotionDialog', 'UnifiedModal', 'shad Sheet', 'study-ui Sheet'],
    productCount: '46 dialog-like files',
    status: 'watch',
    nextStep: '保留一个 Dialog 主入口，一个 Sheet 主入口，统一 overlay 与 focus ring。',
  },
  {
    family: 'Form controls',
    activePaths: ['shad Input', 'AppSelect', 'ModernSelect', '原生控件'],
    productCount: '195 native controls / 83 files',
    status: 'legacy',
    nextStep: '先迁移设置页、模板页、批量编辑里的 input/select/textarea。',
  },
  {
    family: 'Surface / Card',
    activePaths: ['shad Card', 'study-ui Surface', '业务 .card / panel'],
    productCount: '184 raw card refs',
    status: 'watch',
    nextStep: '定义 Surface、Card、Panel 的语义边界，减少业务自定义容器。',
  },
  {
    family: 'Color tokens',
    activePaths: ['theme-colors.css', 'shadcn-variables.css', '局部 Tailwind color'],
    productCount: '1,568 !important',
    status: 'target',
    nextStep: '颜色只通过语义 token 消费，业务组件不再直接发明视觉规则。',
  },
];

const primitiveGoals = [
  '一个 token 系统',
  '少数稳定 primitive',
  '业务组件只组合',
  '不重新发明视觉规则',
];

const tokenSwatches = [
  ['surface-root', 'var(--surface-root)'],
  ['surface-panel', 'var(--shell-workspace-panel)'],
  ['surface-elevated', 'var(--surface-elevated)'],
  ['interactive-hover', 'var(--interactive-hover)'],
  ['interactive-selected', 'var(--interactive-selected)'],
  ['text-primary', 'var(--text-primary)'],
  ['text-secondary', 'var(--text-secondary)'],
  ['border-default', 'var(--border-default)'],
];

const statusMeta: Record<AuditStatus, { label: string; className: string }> = {
  primary: {
    label: '主入口已形成',
    className: 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]',
  },
  watch: {
    label: '需要收敛',
    className: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--text-secondary)]',
  },
  legacy: {
    label: '旧写法较多',
    className: 'border-[color:hsl(var(--warning)/0.28)] bg-[color:hsl(var(--warning)/0.12)] text-[color:hsl(var(--warning))]',
  },
  target: {
    label: '目标规则',
    className: 'border-[color:hsl(var(--success)/0.26)] bg-[color:hsl(var(--success)/0.12)] text-[color:hsl(var(--success))]',
  },
};

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-6 text-[color:var(--text-primary)]">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[color:var(--text-secondary)]">{description}</p>
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-3">
      <p className="truncate text-xs text-[color:var(--text-secondary)]">{label}</p>
      <p className={cn('mt-1 truncate text-lg font-semibold text-[color:var(--text-primary)]', tone)}>{value}</p>
    </div>
  );
}

function PrimitiveSampleDeck() {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card className="rounded-lg bg-[color:var(--surface-panel-strong)]">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Current primary</CardTitle>
          <CardDescription>NotionButton 走共享 primitive contract。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
          <NotionButton variant="primary" size="sm">Primary</NotionButton>
          <NotionButton variant="ghost" size="sm">Ghost</NotionButton>
          <NotionButton variant="utility" size="icon" iconOnly aria-label="Tune">
            <SlidersHorizontal className="size-4" />
          </NotionButton>
        </CardContent>
      </Card>

      <Card className="rounded-lg bg-[color:var(--surface-panel-strong)]">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Mixed wrapper</CardTitle>
          <CardDescription>shad Button 已接 token，但不是产品主入口。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
          <ShadButton size="sm">shad Button</ShadButton>
          <ShadButton variant="secondary" size="sm">Secondary</ShadButton>
          <ShadButton variant="outline" size="sm">Outline</ShadButton>
        </CardContent>
      </Card>

      <Card className="rounded-lg bg-[color:var(--surface-panel-strong)]">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">Legacy sample</CardTitle>
          <CardDescription>原生控件只作为样式校对样本保留在本页。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-md border border-[color:var(--shell-workspace-border)] bg-transparent px-3 text-sm text-[color:var(--text-secondary)] hover:bg-[color:var(--interactive-hover)]"
          >
            原生控件
          </button>
          <select className="min-h-8 rounded-md border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-2 text-sm text-[color:var(--text-primary)]">
            <option>Native select</option>
          </select>
        </CardContent>
      </Card>
    </div>
  );
}

function MixedComponentTable() {
  return (
    <div className="overflow-x-auto rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)]">
      <div className="grid min-w-[760px] grid-cols-[minmax(120px,0.7fr)_minmax(180px,1.5fr)_minmax(110px,0.7fr)_minmax(180px,1fr)] gap-0 border-b border-[color:var(--shell-workspace-border)] px-4 py-2 text-xs font-medium uppercase tracking-normal text-[color:var(--text-secondary)]">
        <span>Component family</span>
        <span>Current implementations</span>
        <span>Signal</span>
        <span>Migration note</span>
      </div>
      {mixedComponentRows.map((row) => {
        const status = statusMeta[row.status];

        return (
          <div
            key={row.family}
            className="grid min-w-[760px] grid-cols-[minmax(120px,0.7fr)_minmax(180px,1.5fr)_minmax(110px,0.7fr)_minmax(180px,1fr)] gap-0 border-b border-[color:var(--shell-workspace-border)] px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 pr-3">
              <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{row.family}</p>
              <p className="mt-1 truncate text-xs text-[color:var(--text-secondary)]">{row.productCount}</p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-1.5 pr-3">
              {row.activePaths.map((pathName) => (
                <Badge key={pathName} variant="outline" className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[color:var(--text-secondary)]">
                  {pathName}
                </Badge>
              ))}
            </div>
            <div className="min-w-0 pr-3">
              <span className={cn('inline-flex max-w-full items-center rounded px-2 py-1 text-xs font-medium', status.className)}>
                <span className="truncate">{status.label}</span>
              </span>
            </div>
            <p className="min-w-0 text-sm leading-5 text-[color:var(--text-secondary)]">{row.nextStep}</p>
          </div>
        );
      })}
    </div>
  );
}

function TokenSwatches() {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {tokenSwatches.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-center gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
          <span className="size-9 shrink-0 rounded-md border border-[color:var(--shell-workspace-border)]" style={{ background: value }} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-[color:var(--text-primary)]">{label}</span>
            <span className="block truncate text-xs text-[color:var(--text-secondary)]">{value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function FormControlSamples() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">Primitive input path</p>
            <p className="mt-1 truncate text-xs text-[color:var(--text-secondary)]">shad Input + Switch 使用 shell token。</p>
          </div>
          <Switch defaultChecked size="sm" aria-label="Semantic token switch sample" />
        </div>
        <Input defaultValue="var(--input-shell-surface)" aria-label="Token input sample" />
      </div>

      <div className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
        <p className="text-sm font-medium text-[color:var(--text-primary)]">Legacy control path</p>
        <p className="mt-1 text-xs text-[color:var(--text-secondary)]">原生控件数量用于人工对照，不作为新增业务模式。</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input
            aria-label="Native input sample"
            defaultValue="native input"
            className="min-h-8 min-w-0 rounded-md border border-[color:var(--shell-workspace-border)] bg-transparent px-2 text-sm"
          />
          <textarea
            aria-label="Native textarea sample"
            defaultValue="native textarea"
            className="min-h-8 min-w-0 resize-none rounded-md border border-[color:var(--shell-workspace-border)] bg-transparent px-2 py-1 text-sm"
          />
        </div>
      </div>
    </div>
  );
}

function PreviewLane({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'target' | 'mixed' | 'legacy';
  children: React.ReactNode;
}) {
  const toneClassName = {
    target: 'border-[color:hsl(var(--success)/0.24)] bg-[color:hsl(var(--success)/0.08)] text-[color:hsl(var(--success))]',
    mixed: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--text-secondary)]',
    legacy: 'border-[color:hsl(var(--warning)/0.28)] bg-[color:hsl(var(--warning)/0.10)] text-[color:hsl(var(--warning))]',
  }[tone];

  return (
    <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
      <div className={cn('mb-3 inline-flex max-w-full rounded px-2 py-1 text-xs font-medium', toneClassName)}>
        <span className="truncate">{label}</span>
      </div>
      <div className="min-h-[96px] min-w-0">{children}</div>
    </div>
  );
}

function RepeatedPreviewGroup({
  title,
  signal,
  children,
}: {
  title: string;
  signal: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{signal}</p>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function DialogShellPreview({ variant }: { variant: 'target' | 'mixed' | 'legacy' }) {
  const isLegacy = variant === 'legacy';
  const isMixed = variant === 'mixed';

  return (
    <div className={cn(
      'mx-auto flex min-h-[112px] w-full max-w-[260px] flex-col justify-between rounded-lg border p-3',
      isLegacy
        ? 'border-[#d7d7d7] bg-white shadow-[0_10px_24px_rgba(15,23,42,0.14)]'
        : 'border-[color:var(--dialog-shell-border)] bg-[color:var(--dialog-shell-surface)] shadow-[var(--shadow-shell-soft)]'
    )}>
      <div>
        <div className={cn('h-2.5 w-24 rounded-full', isLegacy ? 'bg-[#d8d8d8]' : 'bg-[color:var(--text-secondary)]/25')} />
        <div className={cn('mt-2 h-2 w-36 rounded-full', isLegacy ? 'bg-[#eeeeee]' : 'bg-[color:var(--surface-muted)]')} />
      </div>
      <div className="flex justify-end gap-2">
        <span className={cn('h-7 w-14 rounded-md', isLegacy ? 'bg-[#f2f2f2]' : 'bg-[color:var(--button-utility-surface)]')} />
        <span className={cn('h-7 w-16 rounded-md', isMixed ? 'bg-primary' : isLegacy ? 'bg-[#333333]' : 'bg-[color:var(--button-prominent-bg)]')} />
      </div>
    </div>
  );
}

function RepeatedComponentPreviews() {
  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Layers3}
        title="重复组件预览"
        description="每组都把推荐统一入口、当前混用入口、旧写法样本放在同一行，方便直接比较尺寸、圆角、颜色语义、密度和交互状态。"
      />

      <RepeatedPreviewGroup title="Button 重复实现" signal="目标：所有业务按钮最终只消费 buttonPrimitiveContract。">
        <PreviewLane label="推荐统一入口" tone="target">
          <div className="flex flex-wrap gap-2">
            <NotionButton variant="primary" size="sm">保存</NotionButton>
            <NotionButton variant="ghost" size="sm">取消</NotionButton>
            <NotionButton variant="utility" size="icon" iconOnly aria-label="Button preview settings">
              <SlidersHorizontal className="size-4" />
            </NotionButton>
          </div>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <div className="flex flex-wrap gap-2">
            <ShadButton size="sm">shad Button</ShadButton>
            <ShadButton variant="outline" size="sm">Outline</ShadButton>
          </div>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">已接 token，但不是产品主入口。</p>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <button type="button" className="rounded-md border border-[#d8d8d8] bg-white px-3 py-1.5 text-sm text-[#333] shadow-sm">
            native button
          </button>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">66 个文件仍有原生按钮。</p>
        </PreviewLane>
      </RepeatedPreviewGroup>

      <RepeatedPreviewGroup title="Form controls 重复实现" signal="目标：Input、Textarea、Select、Switch、Slider 使用同一 focus/disabled/spacing token。">
        <PreviewLane label="推荐统一入口" tone="target">
          <div className="space-y-2">
            <Input defaultValue="shad Input token path" aria-label="Recommended input preview" />
            <div className="flex items-center justify-between gap-3 text-sm text-[color:var(--text-secondary)]">
              <span>Semantic switch</span>
              <Switch defaultChecked size="sm" aria-label="Recommended switch preview" />
            </div>
          </div>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <select className="min-h-8 w-full rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--input-shell-surface)] px-2 text-sm">
            <option>AppSelect / ModernSelect / native select</option>
          </select>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">选择器职责需要拆清。</p>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <div className="grid gap-2">
            <input className="min-h-8 rounded border border-[#cfcfcf] px-2 text-sm" defaultValue="native input" aria-label="Legacy input preview" />
            <textarea className="min-h-10 resize-none rounded border border-[#cfcfcf] px-2 py-1 text-sm" defaultValue="native textarea" aria-label="Legacy textarea preview" />
          </div>
        </PreviewLane>
      </RepeatedPreviewGroup>

      <RepeatedPreviewGroup title="Dialog / Sheet 重复实现" signal="目标：一个 Dialog 主入口，一个 Sheet 主入口，共享 overlay、radius、focus-ring。">
        <PreviewLane label="推荐统一入口" tone="target">
          <DialogShellPreview variant="target" />
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">NotionDialog / shell token。</p>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <DialogShellPreview variant="mixed" />
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">shad Sheet / study-ui Sheet。</p>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <DialogShellPreview variant="legacy" />
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">业务 Modal CSS / wrapper。</p>
        </PreviewLane>
      </RepeatedPreviewGroup>

      <RepeatedPreviewGroup title="Surface / Card 重复实现" signal="目标：Surface、Card、Panel 语义分层，业务不再自定义容器视觉。">
        <PreviewLane label="推荐统一入口" tone="target">
          <div className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">Surface token</p>
            <p className="mt-1 text-xs text-[color:var(--text-secondary)]">panel / elevated / muted</p>
          </div>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <Card className="rounded-lg">
            <CardHeader className="p-3">
              <CardTitle className="text-sm">shad Card</CardTitle>
              <CardDescription>部分页面已使用。</CardDescription>
            </CardHeader>
          </Card>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <div className="rounded-2xl border border-[#dddddd] bg-[#fafafa] p-3 shadow-[0_8px_20px_rgba(0,0,0,0.08)]">
            <p className="text-sm font-semibold text-[#222]">business .card</p>
            <p className="mt-1 text-xs text-[#666]">圆角、阴影、背景各自定义。</p>
          </div>
        </PreviewLane>
      </RepeatedPreviewGroup>

      <RepeatedPreviewGroup title="Sidebar row 重复实现" signal="目标：导航行、线程行、设置行走同一 row primitive 和选中态 token。">
        <PreviewLane label="推荐统一入口" tone="target">
          <NotionButton variant="nav" size="md" className="w-full">
            <span className="flex min-w-0 items-center gap-2">
              <Palette className="size-4 shrink-0" />
              <span className="truncate">样式调试</span>
            </span>
          </NotionButton>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <div className="rounded-lg bg-[color:var(--sidebar-quiet-hover)] px-3 py-2 text-sm text-[color:var(--shell-navigation-foreground)]">
            UnifiedSidebar item
          </div>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">Settings / Session / Notes 各有包装。</p>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <div className="rounded-xl bg-[#f3f3f3] px-3 py-2 text-sm font-semibold text-[#333]">
            custom nav row
          </div>
        </PreviewLane>
      </RepeatedPreviewGroup>

      <RepeatedPreviewGroup title="Status badge 重复实现" signal="目标：状态色只走 success/warning/danger/info 语义 token。">
        <PreviewLane label="推荐统一入口" tone="target">
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-[color:hsl(var(--success)/0.12)] text-[color:hsl(var(--success))]">Ready</Badge>
            <Badge className="bg-[color:hsl(var(--warning)/0.12)] text-[color:hsl(var(--warning))]">Review</Badge>
          </div>
        </PreviewLane>
        <PreviewLane label="当前混用入口" tone="mixed">
          <div className="flex flex-wrap gap-2">
            <Badge variant="default">primary</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
          </div>
        </PreviewLane>
        <PreviewLane label="旧写法样本" tone="legacy">
          <span className="inline-flex rounded-full bg-orange-100 px-2 py-1 text-xs font-bold text-orange-700">
            hard-coded
          </span>
        </PreviewLane>
      </RepeatedPreviewGroup>
    </div>
  );
}

export function StyleDebugPage() {
  return (
    <CustomScrollArea className="h-full w-full" viewportClassName="h-full w-full">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-5 lg:px-8 lg:py-7">
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-md border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-2.5 py-1 text-xs font-medium text-[color:var(--text-secondary)]">
              <Palette className="size-3.5" />
              UI style lab
            </div>
            <h1 className="mt-4 text-2xl font-semibold leading-tight text-[color:var(--text-primary)]">样式调试台</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[color:var(--text-secondary)]">
              这里集中展示当前混用组件、语义颜色 token、primitive 样例和迁移目标，用于后续人工校对真实页面状态。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {primitiveGoals.map((goal) => (
                <span key={goal} className="rounded-md border border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] px-2.5 py-1 text-xs font-medium text-[color:var(--text-secondary)]">
                  {goal}
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <MetricTile label="Native buttons" value="177" tone="text-[color:hsl(var(--warning))]" />
            <MetricTile label="Native controls" value="195" tone="text-[color:hsl(var(--warning))]" />
            <MetricTile label="CSS !important" value="1,568" tone="text-[color:hsl(var(--destructive))]" />
            <MetricTile label="NotionButton refs" value="302" tone="text-[color:hsl(var(--success))]" />
          </div>
        </section>

        <Tabs defaultValue="previews">
          <TabsList>
            <TabsTrigger value="previews">重复组件预览</TabsTrigger>
            <TabsTrigger value="inventory">混用清单</TabsTrigger>
            <TabsTrigger value="primitives">Primitive 样例</TabsTrigger>
            <TabsTrigger value="tokens">Token 校对</TabsTrigger>
          </TabsList>

          <TabsContent value="previews">
            <RepeatedComponentPreviews />
          </TabsContent>

          <TabsContent value="inventory" className="space-y-4">
            <SectionHeader
              icon={SplitSquareHorizontal}
              title="当前混用组件"
              description="这些族在产品主体里同时存在多个入口；后续迁移应逐步压缩到一个 token 系统和少数稳定 primitive。"
            />
            <MixedComponentTable />
          </TabsContent>

          <TabsContent value="primitives" className="space-y-4">
            <SectionHeader
              icon={Layers3}
              title="Primitive 对照"
              description="同一行里放置主入口、混用包装和原生样本，方便人工比较尺寸、圆角、文字、hover 与 focus 状态。"
            />
            <PrimitiveSampleDeck />
            <FormControlSamples />
          </TabsContent>

          <TabsContent value="tokens" className="space-y-4">
            <SectionHeader
              icon={CheckCircle2}
              title="语义颜色 token"
              description="颜色目标不是建立色板词典，而是让业务组件只读取 surface、text、border、interactive、status 等语义。"
            />
            <TokenSwatches />
            <div className="rounded-lg border border-[color:hsl(var(--warning)/0.28)] bg-[color:hsl(var(--warning)/0.10)] p-4 text-sm leading-6 text-[color:var(--text-primary)]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[color:hsl(var(--warning))]" />
                <p className="min-w-0">
                  新业务组件只组合 primitive，不直接新建按钮、弹层、卡片、输入框、颜色状态或滚动条规则；确实缺失的能力回到 primitive 层补齐。
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </CustomScrollArea>
  );
}

export default StyleDebugPage;
