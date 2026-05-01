import React from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Copy,
  Layers3,
  MousePointer2,
  Palette,
  SlidersHorizontal,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification, type GlobalNotificationBorderTone, type GlobalNotificationType } from '@/components/UnifiedNotification';
import { CommonTooltip, type TooltipPosition, type TooltipTheme } from '@/components/shared/CommonTooltip';
// eslint-disable-next-line no-restricted-imports -- Style lab intentionally compares the legacy shad Button path against the target NotionButton path.
import { Button as ShadButton } from '@/components/ui/shad/Button';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
// eslint-disable-next-line no-restricted-imports
import {
  Tooltip as ShadTooltip,
  TooltipContent as ShadTooltipContent,
  TooltipProvider as ShadTooltipProvider,
  TooltipTrigger as ShadTooltipTrigger,
} from '@/components/ui/shad/Tooltip';
import {
  Tooltip as PromptkitTooltip,
  TooltipContent as PromptkitTooltipContent,
  TooltipProvider as PromptkitTooltipProvider,
  TooltipTrigger as PromptkitTooltipTrigger,
} from '@/promptkit/ui/tooltip';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

type AuditStatus = 'primary' | 'watch' | 'legacy' | 'target';

type ToastDebugSample = {
  type: GlobalNotificationType;
  label: string;
  title: string;
  message: string;
  buttonLabel: string;
  borderTone?: GlobalNotificationBorderTone;
};

type MixedComponentRow = {
  family: string;
  activePaths: string[];
  productCount: string;
  status: AuditStatus;
  nextStep: string;
};

type InventoryMetric = {
  label: string;
  value: string;
  detail: string;
  tone?: string;
};

type InventoryEntrySystem = {
  title: string;
  summary: string;
  examples: string[];
};

type ComponentGroup = {
  title: string;
  path: string;
  items: string[];
};

const scanScopeRows = [
  '扫描范围：src/ 和 study-ui/src/',
  '计入文件：1188 个产品源码文件，其中 520 个 TSX 文件',
  '排除：测试文件、*.source.test.*、src/debug-panel/、src/mcp-debug/、src/components/dev/',
  '数字口径：refs/files 是 JSX 或原生标签出现次数 / 涉及文件数；imports/files 是 import 语句次数 / 涉及文件数',
];

const inventoryMetrics: InventoryMetric[] = [
  {
    label: 'Native buttons',
    value: '184',
    detail: '184 refs / 66 files',
    tone: 'text-[color:hsl(var(--warning))]',
  },
  {
    label: 'Native controls',
    value: '198',
    detail: '198 refs / 83 files',
    tone: 'text-[color:hsl(var(--warning))]',
  },
  {
    label: 'CSS !important',
    value: '1,621',
    detail: 'StyleDebugPage 原写死为 1,568',
    tone: 'text-[color:hsl(var(--destructive))]',
  },
  {
    label: 'NotionButton refs',
    value: '1560',
    detail: '301 import files；1560 JSX refs / 301 files',
    tone: 'text-[color:hsl(var(--success))]',
  },
];

const entrySystems: InventoryEntrySystem[] = [
  {
    title: '主应用现行入口',
    summary: '主产品页面当前主要消费这组组件，后续校对应优先确认它们在真实页面中的状态一致性。',
    examples: ['NotionButton', 'NotionDialog', 'src/components/ui/shad/*', 'AppMenu', 'CustomScrollArea', 'UnifiedSidebar'],
  },
  {
    title: '迁移实验入口',
    summary: 'study-ui 里已经形成一套新 shell 和 primitive，用于对照迁移目标与 macOS 风格窗口体验。',
    examples: ['study-ui/src/components/ui/*', 'study-ui/src/components/shell/*', 'AppChrome', 'ShellButton', 'Titlebar'],
  },
  {
    title: '旧/业务直写入口',
    summary: '这些入口仍散落在业务页面里，是人工校对时最容易出现尺寸、hover、focus 和圆角不一致的区域。',
    examples: ['原生 <button>', '原生 <input>', '原生 <select>', '原生 <textarea>', '业务 panel/card/menu 样式'],
  },
];

const mixedComponentRows: MixedComponentRow[] = [
  {
    family: 'Button',
    activePaths: ['NotionButton', 'shad Button', 'study-ui Button', '原生 <button>'],
    productCount: 'NotionButton 301 imports；原生 184 refs / 66 files',
    status: 'primary',
    nextStep: 'NotionButton 已是主入口；study-ui Button 是迁移实验入口；逐批替换原生按钮。',
  },
  {
    family: 'Dialog / Overlay / Menu',
    activePaths: ['NotionDialog', 'shad Sheet/Popover/Tooltip', 'study-ui Dialog/Sheet/Menu', 'AppMenu'],
    productCount: 'NotionDialog 52 imports；AppMenu 47 imports',
    status: 'watch',
    nextStep: '弹层、Sheet、菜单是最明显的多入口区域；统一 overlay、radius、focus ring。',
  },
  {
    family: 'Form controls',
    activePaths: ['shad Input/Textarea/Switch', 'AppSelect', 'study-ui controls', '原生控件'],
    productCount: 'shad controls 165 imports；原生 198 refs / 83 files',
    status: 'legacy',
    nextStep: '输入控件已有 shad 主路径；选择器和原生控件仍需要按页面收敛。',
  },
  {
    family: 'Surface / Card',
    activePaths: ['shad Card', 'study-ui Surface', '业务 .card / panel'],
    productCount: 'shad Card 31 imports；study-ui Card/Surface 6 imports',
    status: 'watch',
    nextStep: '定义 Surface、Card、Panel 的语义边界，判断业务 panel 是否继续自定义。',
  },
  {
    family: 'Tabs',
    activePaths: ['shad Tabs', 'study-ui Tabs'],
    productCount: 'shad Tabs 16 imports；study-ui Tabs 2 imports',
    status: 'watch',
    nextStep: '两套 Tabs 同时存在；迁移期间避免同一页面内混搭。',
  },
  {
    family: 'Sidebar / Shell / Layout',
    activePaths: ['ModernSidebar', 'UnifiedSidebar', 'main layout', 'study-ui shell'],
    productCount: 'UnifiedSidebar 8 imports；study-ui shell 2 imports',
    status: 'watch',
    nextStep: '重点校对导航行、标题栏、窗口控制、折叠态和 macOS safe area。',
  },
  {
    family: 'Scroll',
    activePaths: ['CustomScrollArea', 'shad ScrollArea'],
    productCount: 'CustomScrollArea 111 imports；shad ScrollArea 0 imports',
    status: 'primary',
    nextStep: '滚动容器基本集中；继续确认各页面 viewport padding 和滚动条密度。',
  },
  {
    family: 'Feedback / Status',
    activePaths: ['Badge', 'Alert', 'Progress', 'Skeleton', 'UnifiedNotification'],
    productCount: 'shad feedback 101 imports；notification 146 imports',
    status: 'watch',
    nextStep: '区分局部 badge/progress 与全局 notification，状态色只走语义 token。',
  },
  {
    family: 'Icons',
    activePaths: ['lucide-react', 'Phosphor', 'StudySidebarIcons'],
    productCount: 'lucide 370 imports；Phosphor main/study-ui 40 imports',
    status: 'legacy',
    nextStep: '人工校对同屏图标的线宽、尺寸、视觉重量和 filled/outline 风格。',
  },
  {
    family: 'Specialist widgets',
    activePaths: ['CodeMirror', 'Milkdown', 'Recharts', 'XYFlow', 'DnD libs', 'resizable panels'],
    productCount: 'CodeMirror 15；Milkdown 22；XYFlow 21；DnD 35 imports',
    status: 'target',
    nextStep: '领域组件不强行并入 primitive，但外层 shell、surface、token 要一致。',
  },
  {
    family: 'Color tokens',
    activePaths: ['theme-colors.css', 'shadcn-variables.css', '局部 Tailwind color'],
    productCount: '1,621 !important',
    status: 'target',
    nextStep: '颜色只通过语义 token 消费，业务组件不再直接发明视觉规则。',
  },
];

const mainComponentGroups: ComponentGroup[] = [
  {
    title: '当前可用主应用组件',
    path: 'src/components/ui',
    items: ['CommandPalette', 'NotionButton', 'NotionDialog', 'ProviderIcon', 'SiliconFlowLogo', 'SnappySlider'],
  },
  {
    title: '主应用 shad primitives',
    path: 'src/components/ui/shad',
    items: [
      'Alert',
      'Badge',
      'Breadcrumb',
      'Button',
      'Card',
      'Checkbox',
      'Collapsible',
      'CollapsibleModelSelector',
      'Combobox',
      'Command',
      'Dialog',
      'Input',
      'Label',
      'Popover',
      'Progress',
      'ScrollArea',
      'Separator',
      'Sheet',
      'Skeleton',
      'Slider',
      'Switch',
      'Table',
      'Tabs',
      'TagInput',
      'Textarea',
      'Tooltip',
    ],
  },
  {
    title: '主应用 menu/select',
    path: 'src/components/ui/app-menu',
    items: ['AppMenu', 'AppMenuContent', 'AppMenuGroup', 'AppMenuItem', 'AppMenuSeparator', 'AppMenuSwitchItem', 'AppMenuTrigger', 'AppSelect'],
  },
  {
    title: '主应用 sidebar',
    path: 'src/components/ui/unified-sidebar',
    items: ['MobileSidebarLayout', 'SidebarDrawer', 'SidebarSheet', 'UnifiedSidebar', 'UnifiedSidebarSection'],
  },
];

const studyUiComponentGroups: ComponentGroup[] = [
  {
    title: '当前可用 study-ui 组件',
    path: 'study-ui/src/components/ui',
    items: ['button', 'card', 'dialog', 'dropdown-menu', 'input', 'sheet', 'surface', 'switch', 'tabs', 'textarea', 'tooltip'],
  },
  {
    title: 'study-ui shell',
    path: 'study-ui/src/components/shell',
    items: ['AppChrome', 'FramelessResizeHandles', 'ShellButton', 'Sidebar', 'SidebarUpdateBadge', 'Titlebar', 'WindowControls'],
  },
];

const reviewTargets = [
  '样式调试台：src/components/style-lab/StyleDebugPage.tsx',
  '主 Shell：src/App.tsx、src/components/ModernSidebar.tsx、src/components/layout/*',
  'Chat V2：src/chat-v2/pages/ChatV2Page.tsx、src/chat-v2/components/input-bar/InputBarUI.tsx',
  'Settings：src/components/Settings.tsx、src/components/settings/*',
  'Learning Hub / Notes：src/components/learning-hub/*、src/components/notes/*',
  'study-ui demo shell：study-ui/src/App.tsx、study-ui/src/components/shell/*、study-ui/src/components/content/*',
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

const tooltipPositions: TooltipPosition[] = ['top', 'right', 'bottom', 'left'];
const tooltipThemes: TooltipTheme[] = ['dark', 'light', 'auto'];

type ButtonDebugSize = 'sm' | 'md' | 'lg';
type SwitchDebugSize = 'sm' | 'default';
type SwitchLibraryOption = {
  title: string;
  status: string;
  fit: 'recommended' | 'optional' | 'watch';
  summary: string;
  tradeoff: string;
  install: string;
  usage: string;
  showLiveSample?: boolean;
};

const buttonDebugSizes: Array<{ label: string; value: ButtonDebugSize; shadSize: 'sm' | 'default' | 'lg' }> = [
  { label: 'Small', value: 'sm', shadSize: 'sm' },
  { label: 'Medium', value: 'md', shadSize: 'default' },
  { label: 'Large', value: 'lg', shadSize: 'lg' },
];

const buttonDebugVariants = [
  {
    label: 'Primary',
    notionVariant: 'primary',
    shadVariant: 'default',
    nativeClassName: 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
  },
  {
    label: 'Default',
    notionVariant: 'default',
    shadVariant: 'secondary',
    nativeClassName: 'border-[#d8d8d8] bg-white text-[#333333] hover:bg-[#f5f5f5]',
  },
  {
    label: 'Ghost',
    notionVariant: 'ghost',
    shadVariant: 'ghost',
    nativeClassName: 'border-transparent bg-transparent text-[#555555] hover:bg-[#f3f3f3]',
  },
  {
    label: 'Outline',
    notionVariant: 'outline',
    shadVariant: 'outline',
    nativeClassName: 'border-[#cfcfcf] bg-transparent text-[#333333] hover:bg-[#f7f7f7]',
  },
  {
    label: 'Danger',
    notionVariant: 'danger',
    shadVariant: 'destructive',
    nativeClassName: 'border-red-600 bg-red-600 text-white hover:bg-red-700',
  },
] as const;

const buttonDebugTokenRows = [
  ['入口文件', '@/components/ui/buttonPrimitiveContract'],
  ['基础结构', 'buttonBaseClassName'],
  ['视觉语义', 'buttonToneClassNames'],
  ['尺寸密度', 'buttonSizeClassNames / buttonIconSizeClassNames'],
  ['迁移建议', '业务按钮优先消费 NotionButton；缺能力时回 primitive contract 补齐。'],
];

const switchDebugSizes: Array<{ label: string; value: SwitchDebugSize; detail: string }> = [
  { label: 'Small', value: 'sm', detail: 'lg:h-4 lg:w-7，贴近 28px / 16px compact' },
  { label: 'Default', value: 'default', detail: 'lg:h-5 lg:w-9，用于设置项默认密度' },
];

const switchDebugTokenRows = [
  ['入口文件', '@/components/ui/shad/Switch'],
  ['状态来源', 'Radix data-state=checked / unchecked'],
  ['轨道 token', 'button-primary / button-utility surface + border'],
  ['Compact 对照', 'w-[28px] h-[16px] + thumb 12px'],
  ['迁移建议', '业务开关保留 shad Switch 主路径；原生 compact 只作为校对样本。'],
];

const switchLibraryOptions: SwitchLibraryOption[] = [
  {
    title: 'Radix / shadcn 主路径',
    status: '当前已安装',
    fit: 'recommended',
    summary: '最适合当前项目。Radix 负责 role、键盘、表单事件和 data-state；shadcn 负责把它包装成可维护的 Tailwind 组件。',
    tradeoff: '仍然需要我们在本地组件里决定尺寸和 token，但不用自己实现交互行为。',
    install: '@radix-ui/react-switch 已在 package.json 中；可对齐 shadcn switch 源码。',
    usage: '<Switch checked={enabled} onCheckedChange={setEnabled} />',
    showLiveSample: true,
  },
  {
    title: 'Radix Themes',
    status: '需要新依赖',
    fit: 'optional',
    summary: '如果希望开关、按钮、输入框等整套控件都直接吃 Radix 的主题系统，可以考虑它的成品 Switch。',
    tradeoff: '会引入 @radix-ui/themes CSS 和主题变量，容易和当前 shell token、shadcn token 双轨并存。',
    install: 'npm install @radix-ui/themes',
    usage: 'import { Switch } from "@radix-ui/themes"',
  },
  {
    title: 'Base UI',
    status: '迁移候选',
    fit: 'watch',
    summary: '适合如果后续 study-ui 真的统一走 Base UI primitive。它和 Radix 一样偏 headless，适合做设计系统底座。',
    tradeoff: '当前项目还没装 Base UI；只为 Switch 引入会增加迁移面，不如等整套 form primitive 一起定。',
    install: 'npm install @base-ui/react',
    usage: 'import { Switch } from "@base-ui/react/switch"',
  },
  {
    title: 'React Aria Components',
    status: '可访问性优先',
    fit: 'optional',
    summary: '如果项目希望把表单控件的键盘、焦点、屏幕阅读器语义统一交给 React Aria，它的 Switch 很完整。',
    tradeoff: 'API 和 styling 模式会改变较多；对当前 Radix/shadcn 栈不是最小改动。',
    install: 'npm install react-aria-components',
    usage: 'import { Switch } from "react-aria-components"',
  },
];

const switchLibraryFitMeta: Record<SwitchLibraryOption['fit'], { label: string; className: string }> = {
  recommended: {
    label: '推荐',
    className: 'border-[color:hsl(var(--success)/0.26)] bg-[color:hsl(var(--success)/0.10)] text-[color:hsl(var(--success))]',
  },
  optional: {
    label: '可选',
    className: 'border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]',
  },
  watch: {
    label: '观察',
    className: 'border-[color:hsl(var(--warning)/0.28)] bg-[color:hsl(var(--warning)/0.10)] text-[color:hsl(var(--warning))]',
  },
};

const toastDebugSamples: ToastDebugSample[] = [
  {
    type: 'success',
    label: 'Success toast',
    title: 'Toast 调试：Success',
    message: '资料库同步完成。这个提示应该轻、稳、可快速扫读，不抢走当前任务的注意力。',
    buttonLabel: '触发 success toast',
  },
  {
    type: 'warning',
    label: 'Warning toast',
    title: 'Toast 调试：Warning',
    message: '当前索引有 3 个条目需要复核。状态要明确，但不要像错误一样刺眼。',
    buttonLabel: '触发 warning toast',
  },
  {
    type: 'error',
    label: 'Error toast',
    title: 'Toast 调试：Error',
    message: '同步失败：本地数据库被占用。错误 toast 需要更高对比度、清晰操作和稳定的关闭入口。',
    buttonLabel: '触发 error toast',
  },
  {
    type: 'info',
    label: 'Info toast',
    title: 'Toast 调试：Info',
    message: '已切换到新的学习会话。Info toast 应该像状态回声，而不是一张小广告卡片。',
    buttonLabel: '触发 info toast',
  },
  {
    type: 'success',
    label: 'Neutral border toast',
    title: 'Toast 调试：黑色边',
    message: '已归档。查看已归档的会话：',
    buttonLabel: '触发黑色边 toast',
    borderTone: 'neutral',
  },
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

function MetricTile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-3">
      <p className="truncate text-xs text-[color:var(--text-secondary)]">{label}</p>
      <p className={cn('mt-1 truncate text-lg font-semibold text-[color:var(--text-primary)]', tone)}>{value}</p>
      {detail ? <p className="mt-1 truncate text-[11px] leading-4 text-[color:var(--text-secondary)]">{detail}</p> : null}
    </div>
  );
}

function ScanScopePanel() {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {scanScopeRows.map((row) => (
        <div
          key={row}
          className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2 text-xs leading-5 text-[color:var(--text-secondary)]"
        >
          {row}
        </div>
      ))}
    </div>
  );
}

function EntrySystemsPanel() {
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      {entrySystems.map((system) => (
        <section
          key={system.title}
          className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4"
        >
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{system.title}</h3>
          <p className="mt-2 text-xs leading-5 text-[color:var(--text-secondary)]">{system.summary}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {system.examples.map((example) => (
              <Badge
                key={example}
                variant="outline"
                className="max-w-full border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[color:var(--text-secondary)]"
              >
                <span className="truncate">{example}</span>
              </Badge>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ComponentGroupList({ groups }: { groups: ComponentGroup[] }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {groups.map((group) => (
        <section
          key={group.path}
          className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4"
        >
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{group.title}</h3>
            <code className="max-w-full truncate rounded bg-[color:var(--surface-root)] px-2 py-1 text-[11px] text-[color:var(--text-secondary)]">
              {group.path}
            </code>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {group.items.map((item) => (
              <Badge
                key={item}
                variant="outline"
                className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[color:var(--text-secondary)]"
              >
                {item}
              </Badge>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReviewTargetsPanel() {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {reviewTargets.map((target, index) => (
        <div
          key={target}
          className="flex min-w-0 items-start gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2"
        >
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[11px] font-semibold text-[color:var(--text-secondary)]">
            {index + 1}
          </span>
          <p className="min-w-0 text-xs leading-5 text-[color:var(--text-secondary)]">{target}</p>
        </div>
      ))}
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
          {/* eslint-disable-next-line ds-components/no-native-button -- Style lab keeps native samples visible for migration comparison. */}
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

function TooltipPreviewCard({
  title,
  path,
  description,
  children,
  note,
}: {
  title: string;
  path: string;
  description: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{description}</p>
        <code className="mt-2 block text-[11px] leading-5 text-[color:var(--text-secondary)]">{path}</code>
      </div>
      <div className="rounded-lg border border-dashed border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        {children}
      </div>
      {note ? (
        <div className="mt-3 rounded-lg border border-[color:hsl(var(--warning)/0.28)] bg-[color:hsl(var(--warning)/0.10)] px-3 py-2 text-xs leading-5 text-[color:var(--text-primary)]">
          {note}
        </div>
      ) : null}
    </section>
  );
}

function TooltipStyleLab() {
  const [position, setPosition] = React.useState<TooltipPosition>('top');
  const [theme, setTheme] = React.useState<TooltipTheme>('dark');
  const [showArrow, setShowArrow] = React.useState(true);
  const [delay, setDelay] = React.useState(0);
  const [maxWidth, setMaxWidth] = React.useState(260);

  const tooltipText = React.useMemo(
    () => `用于样式调试的示例 Tooltip
位置: ${position}
主题: ${theme}
最大宽度: ${maxWidth}px

这段文字故意稍长一点，方便观察圆角、阴影、换行、内边距和边界处理。`,
    [maxWidth, position, theme]
  );

  const copySummary = React.useCallback(async () => {
    await copyTextToClipboard([
      'Tooltip style debug',
      `position=${position}`,
      `theme=${theme}`,
      `showArrow=${showArrow}`,
      `delay=${delay}`,
      `maxWidth=${maxWidth}`,
    ].join('\n'));
  }, [delay, maxWidth, position, showArrow, theme]);

  const shadClassName = theme === 'light'
    ? 'border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2 text-xs leading-5 text-[color:var(--text-primary)] shadow-[var(--shadow-shell-soft)]'
    : 'border border-[color:var(--shell-workspace-border)] bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-50 shadow-[var(--shadow-shell-soft)] dark:bg-zinc-100 dark:text-zinc-900';

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Palette}
        title="Tooltip 对照调试"
        description="直接在现有样式调试页里横向比较 CommonTooltip、shadcn Tooltip、promptkit Tooltip 和原生 title，不额外新开入口。"
      />

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">调试参数</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              用同一组位置、宽度、延迟和箭头参数去看三套 Tooltip 的差异；原生 <code>title</code> 只做兜底对照。
            </p>
          </div>
          <NotionButton variant="ghost" size="sm" onClick={copySummary} aria-label="复制 tooltip 调试配置">
            <Copy className="size-4" />
            复制配置
          </NotionButton>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {tooltipPositions.map((item) => (
            <NotionButton key={item} size="sm" variant={position === item ? 'primary' : 'ghost'} onClick={() => setPosition(item)}>
              {item}
            </NotionButton>
          ))}
          {tooltipThemes.map((item) => (
            <NotionButton key={item} size="sm" variant={theme === item ? 'success' : 'ghost'} onClick={() => setTheme(item)}>
              {item}
            </NotionButton>
          ))}
          <NotionButton size="sm" variant={showArrow ? 'warning' : 'ghost'} onClick={() => setShowArrow((value) => !value)}>
            Arrow {showArrow ? 'on' : 'off'}
          </NotionButton>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Delay</span>
            <input type="range" min={0} max={800} step={50} value={delay} onChange={(event) => setDelay(Number(event.target.value))} className="w-full" />
            <span className="text-xs text-[color:var(--text-secondary)]">{delay} ms</span>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Max Width</span>
            <input type="range" min={180} max={420} step={20} value={maxWidth} onChange={(event) => setMaxWidth(Number(event.target.value))} className="w-full" />
            <span className="text-xs text-[color:var(--text-secondary)]">{maxWidth} px</span>
          </label>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <TooltipPreviewCard
          title="CommonTooltip"
          path="@/components/shared/CommonTooltip"
          description="项目里当前用得最多的一套。支持位置、主题、箭头、延迟、最大宽度。"
        >
          <div className="flex min-h-[120px] items-center justify-center">
            <CommonTooltip content={tooltipText} position={position} theme={theme} delay={delay} maxWidth={maxWidth} showArrow={showArrow}>
              <NotionButton variant="primary" size="sm">
                <MousePointer2 className="size-4" />
                Hover / Focus
              </NotionButton>
            </CommonTooltip>
          </div>
        </TooltipPreviewCard>

        <TooltipPreviewCard
          title="shadcn Tooltip"
          path="@/components/ui/shad/Tooltip"
          description="debug 面板历史上还在用的 Radix 风格 API。这里复用同一组位置和宽度参数。"
        >
          <div className="flex min-h-[120px] items-center justify-center">
            <ShadTooltipProvider delayDuration={delay}>
              <ShadTooltip>
                <ShadTooltipTrigger asChild>
                  <NotionButton variant="default" size="sm">
                    <MousePointer2 className="size-4" />
                    Hover / Focus
                  </NotionButton>
                </ShadTooltipTrigger>
                <ShadTooltipContent side={position} sideOffset={8} className={shadClassName} style={{ maxWidth }}>
                  {tooltipText}
                </ShadTooltipContent>
              </ShadTooltip>
            </ShadTooltipProvider>
          </div>
        </TooltipPreviewCard>

        <TooltipPreviewCard
          title="promptkit Tooltip"
          path="@/promptkit/ui/tooltip"
          description="prompt-input 里在用的轻量包装。现在这个实现更像结构占位，适合直接看 className 和内容样式。"
          note={<><strong>当前实现是轻量占位。</strong> 它不会像另外两套一样自动悬浮出层，当前内容会原地渲染，所以这里更适合调文字、边框、背景和间距。</>}
        >
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
            <PromptkitTooltipProvider>
              <PromptkitTooltip>
                <PromptkitTooltipTrigger className="inline-flex">
                  <NotionButton variant="secondary" size="sm">
                    <MousePointer2 className="size-4" />
                    Trigger
                  </NotionButton>
                </PromptkitTooltipTrigger>
                <PromptkitTooltipContent
                  className={theme === 'light'
                    ? 'rounded-md border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2 text-xs leading-5 text-[color:var(--text-primary)]'
                    : 'rounded-md border border-[color:var(--shell-workspace-border)] bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'}
                  style={{ maxWidth }}
                >
                  {tooltipText}
                </PromptkitTooltipContent>
              </PromptkitTooltip>
            </PromptkitTooltipProvider>
          </div>
        </TooltipPreviewCard>

        <TooltipPreviewCard
          title="原生 title"
          path="HTML title attribute"
          description="浏览器/系统自己画气泡，前端能控制的样式几乎没有。适合做兜底，不适合承担统一视觉。"
          note="原生 title 需要真实 hover 才会出现，这一项主要用来和前面三套对照交互与可控性。"
        >
          <div className="flex min-h-[120px] items-center justify-center">
            <NotionButton
              variant="ghost"
              size="sm"
              title={`原生 title\n位置由浏览器/系统接管\n建议只用来做基础兜底`}
            >
              <MousePointer2 className="size-4" />
              Hover 原生 title
            </NotionButton>
          </div>
        </TooltipPreviewCard>
      </div>
    </div>
  );
}

function ButtonDebugPathCard({
  title,
  path,
  description,
  children,
}: {
  title: string;
  path: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
      <div className="mb-4 min-w-0">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{description}</p>
        <code className="mt-2 block truncate text-[11px] leading-5 text-[color:var(--text-secondary)]">{path}</code>
      </div>
      <div className="grid min-w-0 gap-2">{children}</div>
    </section>
  );
}

function ButtonStyleLab() {
  const [size, setSize] = React.useState<ButtonDebugSize>('md');
  const [disabledSamples, setDisabledSamples] = React.useState(false);
  const [iconOnlySamples, setIconOnlySamples] = React.useState(false);

  const selectedSize = buttonDebugSizes.find((item) => item.value === size) ?? buttonDebugSizes[1];
  const notionSize = iconOnlySamples ? 'icon' : selectedSize.value;
  const shadSize = iconOnlySamples ? 'icon' : selectedSize.shadSize;
  const nativeSizeClassName = {
    sm: 'min-h-8 px-3 text-xs',
    md: 'min-h-9 px-3.5 text-[13px]',
    lg: 'min-h-10 px-4 text-sm',
  }[size];
  const nativeIconSizeClassName = {
    sm: 'size-8 p-0',
    md: 'size-9 p-0',
    lg: 'size-10 p-0',
  }[size];

  const copyButtonSummary = React.useCallback(async () => {
    await copyTextToClipboard([
      'Button style debug',
      `size=${size}`,
      `disabled=${disabledSamples}`,
      `iconOnly=${iconOnlySamples}`,
      'contract=buttonPrimitiveContract',
    ].join('\n'));
  }, [disabledSamples, iconOnlySamples, size]);

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={SlidersHorizontal}
        title="统一 Button 调试"
        description="把推荐主入口、token 包装和旧写法放在同一套尺寸与状态参数下，专门用来校对 Button 统一方向。"
      />

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">调试参数</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              切换尺寸、禁用态和图标按钮态，观察三条路径在高度、圆角、文字、图标间距和 disabled 表现上的差异。
            </p>
          </div>
          <NotionButton variant="ghost" size="sm" onClick={copyButtonSummary} aria-label="复制 Button 调试配置">
            <Copy className="size-4" />
            复制配置
          </NotionButton>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.5fr)]">
          <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Size</p>
            <div className="flex flex-wrap gap-2">
              {buttonDebugSizes.map((item) => (
                <NotionButton
                  key={item.value}
                  variant={size === item.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setSize(item.value)}
                >
                  {item.label}
                </NotionButton>
              ))}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Disabled</span>
              <Switch checked={disabledSamples} onCheckedChange={setDisabledSamples} size="sm" aria-label="切换 Button 禁用态" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Icon only</span>
              <Switch checked={iconOnlySamples} onCheckedChange={setIconOnlySamples} size="sm" aria-label="切换 Button 图标态" />
            </label>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <ButtonDebugPathCard
          title="NotionButton / 推荐主入口"
          path="@/components/ui/NotionButton"
          description="主应用业务按钮的推荐消费入口，直接映射到共享 primitive contract。"
        >
          {buttonDebugVariants.map((item) => (
            <NotionButton
              key={item.label}
              variant={item.notionVariant}
              size={notionSize}
              iconOnly={iconOnlySamples}
              disabled={disabledSamples}
              aria-label={iconOnlySamples ? `${item.label} NotionButton sample` : undefined}
            >
              <SlidersHorizontal className="size-4" />
              {iconOnlySamples ? null : item.label}
            </NotionButton>
          ))}
        </ButtonDebugPathCard>

        <ButtonDebugPathCard
          title="shad Button / token 包装"
          path="@/components/ui/shad/Button"
          description="已经接入相同 button token，但目前更像兼容包装，不应在新业务里继续扩散成第二主入口。"
        >
          {buttonDebugVariants.map((item) => (
            <ShadButton
              key={item.label}
              type="button"
              variant={item.shadVariant}
              size={shadSize}
              disabled={disabledSamples}
              aria-label={iconOnlySamples ? `${item.label} shad Button sample` : undefined}
            >
              <SlidersHorizontal className="size-4" />
              {iconOnlySamples ? null : item.label}
            </ShadButton>
          ))}
        </ButtonDebugPathCard>

        <ButtonDebugPathCard
          title="原生 button / 旧写法"
          path="HTML button + local className"
          description="旧页面里分散存在的手写按钮样式。这里保留对照样本，用来暴露和 token 路径的差异。"
        >
          {buttonDebugVariants.map((item) => (
            // eslint-disable-next-line ds-components/no-native-button -- Style lab keeps native samples visible for migration comparison.
            <button
              key={item.label}
              type="button"
              disabled={disabledSamples}
              aria-label={iconOnlySamples ? `${item.label} native button sample` : undefined}
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md border font-medium leading-none shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                iconOnlySamples ? nativeIconSizeClassName : nativeSizeClassName,
                item.nativeClassName
              )}
            >
              <SlidersHorizontal className="size-4" />
              {iconOnlySamples ? null : item.label}
            </button>
          ))}
        </ButtonDebugPathCard>
      </div>

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Button primitive contract</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              统一时优先看这几个 contract 是否覆盖真实页面状态，而不是继续在业务层补局部 class。
            </p>
          </div>
          <Badge variant="outline" className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]">
            buttonPrimitiveContract
          </Badge>
        </div>
        <div className="mt-4 grid gap-2 lg:grid-cols-2">
          {buttonDebugTokenRows.map(([label, value]) => (
            <div
              key={label}
              className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2"
            >
              <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">{label}</p>
              <p className="mt-1 truncate text-xs text-[color:var(--text-primary)]">{value}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const toastButtonVariantByType: Record<GlobalNotificationType, 'success' | 'warning' | 'danger' | 'primary'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  info: 'primary',
};

function ToastPreviewCard({
  sample,
  showAction,
}: {
  sample: ToastDebugSample;
  showAction: boolean;
}) {
  const displayText = `${sample.title} ${sample.message}`;

  return (
    <section className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">{sample.label}</h3>
        <Badge variant="outline" className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[color:var(--text-secondary)]">
          {sample.type}
        </Badge>
      </div>
      <div className="flex min-h-12 items-center justify-center overflow-hidden rounded-md border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-2 py-3">
        <div
          className={cn(
            'unified-notification show',
            `unified-notification-${sample.type}`,
            sample.borderTone === 'neutral' && 'unified-notification-border-neutral'
          )}
          style={{ maxWidth: 'min(320px, 100%)', minWidth: 0, width: 'fit-content' }}
          aria-label={`${sample.label} preview`}
        >
          <div className="unified-notification-content">
            <div className="unified-notification-text">{displayText}</div>
            {showAction || sample.borderTone === 'neutral' ? (
              <NotionButton variant="ghost" size="sm" className="unified-notification-action" tabIndex={-1}>
                {sample.borderTone === 'neutral' ? '设置' : '查看详情'}
              </NotionButton>
            ) : null}
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              className="unified-notification-close"
              aria-label="关闭通知预览"
              tabIndex={-1}
            >
              <X className="unified-notification-close-icon" aria-hidden="true" />
            </NotionButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function ToastStyleLab() {
  const [showAction, setShowAction] = React.useState(false);
  const [longCopy, setLongCopy] = React.useState(false);

  const triggerToast = React.useCallback((sample: ToastDebugSample) => {
    const message = longCopy
      ? `${sample.message}\n\n长文案校对：这一行用于检查 toast 的换行、最大宽度、按钮位置和关闭按钮是否还能保持清楚。`
      : sample.message;
    const action = showAction || sample.borderTone === 'neutral'
      ? {
          label: sample.borderTone === 'neutral'
            ? '设置'
            : sample.type === 'error'
              ? '查看日志'
              : '查看详情',
          onClick: () => undefined,
        }
      : undefined;

    showGlobalNotification(
      sample.type,
      message,
      sample.title,
      action || sample.borderTone
        ? {
            action,
            borderTone: sample.borderTone,
          }
        : undefined
    );
  }, [longCopy, showAction]);

  const triggerSequence = React.useCallback(() => {
    toastDebugSamples.forEach((sample, index) => {
      window.setTimeout(() => triggerToast(sample), index * 360);
    });
  }, [triggerToast]);

  const copyToastSummary = React.useCallback(async () => {
    await copyTextToClipboard([
      'Toast style debug',
      'component=UnifiedNotification',
      'shape=compact-pill',
      'structure=single-line',
      `action=${showAction}`,
      'close=true',
      `longCopy=${longCopy}`,
      'variants=success,warning,error,info,neutral-border',
    ].join('\n'));
  }, [longCopy, showAction]);

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Bell}
        title="统一 Toast 调试"
        description="在样式调试台里直接触发全局 UnifiedNotification，并把 success、warning、error、info 和黑色边变体放在同一个静态预览区；新方向参考 Codex 的顶部居中小圆条：单行短句、无状态 icon、右侧轻量关闭入口，用边框表达状态。"
      />

      <div className="flex flex-wrap gap-2">
        {['顶部居中', '小圆条', '无状态 icon', '右侧关闭', '低打扰', '参考 Codex', '单行短句', '边框表达状态', '黑色边'].map((rule) => (
          <Badge
            key={rule}
            variant="outline"
            className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]"
          >
            {rule}
          </Badge>
        ))}
      </div>

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">UnifiedNotification / 全局入口</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              这里调用真实 <code>showGlobalNotification</code>，顶部中间弹出的就是产品当前 toast；下方静态预览用来比较单行小圆条密度、短文案省略和状态边框。
            </p>
          </div>
          <NotionButton variant="ghost" size="sm" onClick={copyToastSummary} aria-label="复制 Toast 调试配置">
            <Copy className="size-4" />
            复制配置
          </NotionButton>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.45fr)]">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {toastDebugSamples.map((sample) => {
              return (
                <NotionButton
                  key={sample.label}
                  variant={toastButtonVariantByType[sample.type]}
                  size="sm"
                  onClick={() => triggerToast(sample)}
                >
                  {sample.buttonLabel}
                </NotionButton>
              );
            })}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Action button</span>
              <Switch checked={showAction} onCheckedChange={setShowAction} size="sm" aria-label="切换 Toast 操作按钮" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Long copy</span>
              <Switch checked={longCopy} onCheckedChange={setLongCopy} size="sm" aria-label="切换 Toast 长文案" />
            </label>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <NotionButton variant="default" size="sm" onClick={triggerSequence}>
            连续触发四种 toast
          </NotionButton>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">静态状态预览</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              这些预览复用 <code>.unified-notification</code> 和状态类，便于不用等待动画也能比较四种 compact toast 的实际外观。
            </p>
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {toastDebugSamples.map((sample) => (
            <ToastPreviewCard key={sample.label} sample={sample} showAction={showAction} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CompactNativeSwitchSample({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    // eslint-disable-next-line ds-components/no-native-button -- Style lab keeps the pasted native switch shape visible for migration comparison.
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={checked ? '点击禁用' : '点击启用'}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-[16px] w-[28px] shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-[color:var(--button-utility-surface)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] block h-[12px] w-[12px] rounded-full bg-white shadow-sm transition-transform',
          checked ? 'left-[14px]' : 'left-[2px]'
        )}
      />
    </button>
  );
}

function SwitchLibraryOptionCard({ option }: { option: SwitchLibraryOption }) {
  const [checked, setChecked] = React.useState(true);
  const fitMeta = switchLibraryFitMeta[option.fit];

  return (
    <section className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[color:var(--text-primary)]">{option.title}</h4>
          <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{option.summary}</p>
        </div>
        <Badge variant="outline" className={cn('shrink-0', fitMeta.className)}>
          {fitMeta.label}
        </Badge>
      </div>

      <div className="mt-4 grid gap-2">
        <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-2">
          <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Status</p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--text-primary)]">{option.status}</p>
        </div>
        <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-2">
          <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Tradeoff</p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--text-primary)]">{option.tradeoff}</p>
        </div>
        <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-2">
          <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Install</p>
          <code className="mt-1 block truncate text-[11px] leading-5 text-[color:var(--text-primary)]">{option.install}</code>
        </div>
        <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-2">
          <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Usage</p>
          <code className="mt-1 block truncate text-[11px] leading-5 text-[color:var(--text-primary)]">{option.usage}</code>
        </div>
      </div>

      {option.showLiveSample ? (
        <div className="mt-4 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-3">
          <span className="min-w-0 text-sm font-medium text-[color:var(--text-primary)]">当前项目 live sample</span>
          <Switch checked={checked} onCheckedChange={setChecked} size="sm" aria-label="Radix shadcn switch library sample" />
        </div>
      ) : null}
    </section>
  );
}

function SwitchStyleLab() {
  const [size, setSize] = React.useState<SwitchDebugSize>('sm');
  const [checkedSamples, setCheckedSamples] = React.useState(true);
  const [disabledSamples, setDisabledSamples] = React.useState(false);
  const selectedSize = switchDebugSizes.find((item) => item.value === size) ?? switchDebugSizes[0];

  const copySwitchSummary = React.useCallback(async () => {
    await copyTextToClipboard([
      'Switch style debug',
      `size=${size}`,
      `checked=${checkedSamples}`,
      `disabled=${disabledSamples}`,
      'nativeCompact=w-[28px] h-[16px] thumb=w-[12px] h-[12px] left-[14px]',
    ].join('\n'));
  }, [checkedSamples, disabledSamples, size]);

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={SlidersHorizontal}
        title="统一 Switch 调试"
        description="把 shad Switch 主路径、设置项密度和当前截图里的 28px compact 原生样本放在同一组状态下校对。"
      />

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">调试参数</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              同步切换尺寸、选中态和禁用态，观察轨道、thumb 位移、focus ring、透明度和点击目标。
            </p>
          </div>
          <NotionButton variant="ghost" size="sm" onClick={copySwitchSummary} aria-label="复制 Switch 调试配置">
            <Copy className="size-4" />
            复制配置
          </NotionButton>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.5fr)]">
          <div className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
            <p className="mb-2 text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">Size</p>
            <div className="flex flex-wrap gap-2">
              {switchDebugSizes.map((item) => (
                <NotionButton
                  key={item.value}
                  variant={size === item.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setSize(item.value)}
                >
                  {item.label}
                </NotionButton>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-[color:var(--text-secondary)]">{selectedSize.detail}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Checked</span>
              <Switch checked={checkedSamples} onCheckedChange={setCheckedSamples} size="sm" aria-label="切换 Switch 选中态" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Disabled</span>
              <Switch checked={disabledSamples} onCheckedChange={setDisabledSamples} size="sm" aria-label="切换 Switch 禁用态" />
            </label>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <ButtonDebugPathCard
          title="shad Switch / token path"
          path="@/components/ui/shad/Switch"
          description="主应用当前 Switch 入口，使用 Radix 状态和 shell/button token。"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-3">
            <span className="min-w-0 text-sm text-[color:var(--text-primary)]">{size === 'sm' ? 'Small switch' : 'Default switch'}</span>
            <Switch checked={checkedSamples} onCheckedChange={setCheckedSamples} disabled={disabledSamples} size={size} aria-label="shad Switch token sample" />
          </div>
          <p className="text-xs leading-5 text-[color:var(--text-secondary)]">
            选中态走 <code>data-[state=checked]</code>，禁用态继承 Radix disabled attribute。
          </p>
        </ButtonDebugPathCard>

        <ButtonDebugPathCard
          title="贴近当前截图的原生 switch"
          path="HTML button + span"
          description="保留你贴出的 compact 形态，方便和 shad Switch 的桌面密度直接比对。"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-3">
            <span className="min-w-0 text-sm text-[color:var(--text-primary)]">28px / 16px compact</span>
            <CompactNativeSwitchSample checked={checkedSamples} disabled={disabledSamples} onCheckedChange={setCheckedSamples} />
          </div>
          <code className="text-[11px] leading-5 text-[color:var(--text-secondary)]">
            w-[28px] h-[16px] / thumb w-[12px] h-[12px] left-[14px]
          </code>
        </ButtonDebugPathCard>

        <ButtonDebugPathCard
          title="状态矩阵"
          path="checked / unchecked / disabled"
          description="固定展示常见状态，避免只看当前交互参数时漏掉边界状态。"
        >
          <div className="grid gap-2">
            {[
              ['Checked', true, false],
              ['Unchecked', false, false],
              ['Disabled checked', true, true],
              ['Disabled unchecked', false, true],
            ].map(([label, checked, disabled]) => (
              <div key={String(label)} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-3 py-2">
                <span className="min-w-0 text-sm text-[color:var(--text-primary)]">{label}</span>
                <Switch checked={Boolean(checked)} disabled={Boolean(disabled)} size="sm" aria-label={`${label} Switch state sample`} />
              </div>
            ))}
          </div>
        </ButtonDebugPathCard>
      </div>

      <section className="space-y-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">现成库 Switch 方案</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              这里不再手写 switch 皮肤，而是按当前依赖和迁移成本对比可选库。现阶段最稳的是继续收敛 Radix / shadcn 主路径。
            </p>
          </div>
          <Badge variant="outline" className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]">
            library options
          </Badge>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {switchLibraryOptions.map((option) => (
            <SwitchLibraryOptionCard key={option.title} option={option} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Switch primitive contract</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              校对时重点看尺寸、状态 token 和 thumb 位移是否能覆盖真实设置页。
            </p>
          </div>
          <Badge variant="outline" className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-secondary)]">
            switchPrimitiveContract
          </Badge>
        </div>
        <div className="mt-4 grid gap-2 lg:grid-cols-2">
          {switchDebugTokenRows.map(([label, value]) => (
            <div
              key={label}
              className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2"
            >
              <p className="text-[11px] font-medium uppercase text-[color:var(--text-secondary)]">{label}</p>
              <p className="mt-1 truncate text-xs text-[color:var(--text-primary)]">{value}</p>
            </div>
          ))}
        </div>
      </section>
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
          {/* eslint-disable-next-line ds-components/no-native-button -- Style lab keeps native samples visible for migration comparison. */}
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
            {inventoryMetrics.map((metric) => (
              <MetricTile
                key={metric.label}
                label={metric.label}
                value={metric.value}
                detail={metric.detail}
                tone={metric.tone}
              />
            ))}
          </div>
        </section>

        <Tabs defaultValue="previews">
          <TabsList>
            <TabsTrigger value="previews">重复组件预览</TabsTrigger>
            <TabsTrigger value="buttons">Button 调试</TabsTrigger>
            <TabsTrigger value="switches">Switch 调试</TabsTrigger>
            <TabsTrigger value="tooltips">Tooltip 调试</TabsTrigger>
            <TabsTrigger value="toasts">Toast 调试</TabsTrigger>
            <TabsTrigger value="inventory">混用清单</TabsTrigger>
            <TabsTrigger value="components">组件列表</TabsTrigger>
            <TabsTrigger value="primitives">Primitive 样例</TabsTrigger>
            <TabsTrigger value="tokens">Token 校对</TabsTrigger>
          </TabsList>

          <TabsContent value="previews">
            <RepeatedComponentPreviews />
          </TabsContent>

          <TabsContent value="buttons" className="space-y-4">
            <ButtonStyleLab />
          </TabsContent>

          <TabsContent value="switches" className="space-y-4">
            <SwitchStyleLab />
          </TabsContent>

          <TabsContent value="tooltips" className="space-y-4">
            <TooltipStyleLab />
          </TabsContent>

          <TabsContent value="toasts" className="space-y-4">
            <ToastStyleLab />
          </TabsContent>

          <TabsContent value="inventory" className="space-y-4">
            <SectionHeader
              icon={SplitSquareHorizontal}
              title="当前混用组件"
              description="静态扫描结果用于人工校对真实页面状态；这些族在产品主体里同时存在多个入口，后续迁移应逐步压缩到一个 token 系统和少数稳定 primitive。"
            />
            <ScanScopePanel />
            <EntrySystemsPanel />
            <MixedComponentTable />
            <div className="space-y-3">
              <SectionHeader
                icon={CheckCircle2}
                title="人工校对页面"
                description="优先用这些真实页面区域确认组件外观、交互状态和迁移后的页面状态是否一致。"
              />
              <ReviewTargetsPanel />
            </div>
          </TabsContent>

          <TabsContent value="components" className="space-y-4">
            <SectionHeader
              icon={Layers3}
              title="当前用到的组件"
              description="这里按源码目录列出当前可用组件，方便人工从真实页面反查具体实现入口。"
            />
            <ComponentGroupList groups={mainComponentGroups} />
            <ComponentGroupList groups={studyUiComponentGroups} />
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
