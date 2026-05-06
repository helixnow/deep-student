import React from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CheckCheck,
  Copy,
  Bot,
  ExternalLink,
  Filter,
  Layers3,
  LoaderCircle,
  MousePointer2,
  Palette,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Square,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification, type GlobalNotificationBorderTone, type GlobalNotificationType } from '@/components/UnifiedNotification';
import { CommonTooltip, type TooltipPosition, type TooltipTheme } from '@/components/shared/CommonTooltip';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
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
import '@/chat-v2/styles/index.css';
import '@/chat-v2/plugins/blocks';
import { MessageItem } from '@/chat-v2/components/MessageItem';
import { createChatStore } from '@/chat-v2/core/store';
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

type LlmOutputPlaybackStepId =
  | 'waiting'
  | 'thinking'
  | 'content-intro'
  | 'tool'
  | 'tool-mcp'
  | 'tool-image-gen'
  | 'tool-rag'
  | 'tool-memory'
  | 'tool-web-search'
  | 'tool-anki'
  | 'tool-workspace'
  | 'tool-ask-user'
  | 'tool-error'
  | 'content-resume'
  | 'aborting'
  | 'error'
  | 'idle';

type LlmOutputPlaybackState = 'waiting' | 'thinking' | 'content' | 'tool' | 'error' | 'aborting' | 'idle';

type LlmOutputPlaybackFrame = {
  id: LlmOutputPlaybackStepId;
  frameId: string;
  state: LlmOutputPlaybackState;
  durationMs: number;
  thinkingContent?: string;
  introContent?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolType?: BlockType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  resumeContent?: string;
  error?: string;
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

type RepeatedEntry = {
  name: string;
  filePath: string;
  imports: number;
  refs: number;
  files: number;
};

type RepeatedLane = {
  tone: 'target' | 'mixed' | 'legacy';
  label: string;
  entries: RepeatedEntry[];
  hint?: string;
};

type RepeatedGroup = {
  title: string;
  signal: string;
  priority: 'high' | 'medium' | 'low';
  lanes: RepeatedLane[];
};

const repeatedComponentData: RepeatedGroup[] = [
  {
    title: 'Button 重复实现',
    signal: '目标：所有业务按钮最终只消费 buttonPrimitiveContract。',
    priority: 'high',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'NotionButton', filePath: 'src/components/ui/NotionButton.tsx', imports: 301, refs: 1560, files: 301 },
          { name: 'buttonPrimitiveContract', filePath: 'src/components/ui/buttonPrimitiveContract.ts', imports: 1, refs: 0, files: 1 },
        ],
        hint: 'NotionButton 已是产品主入口。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'shad Button', filePath: 'src/components/ui/shad/Button.tsx', imports: 1, refs: 1, files: 1 },
          { name: 'study-ui Button', filePath: 'study-ui/src/components/ui/button.tsx', imports: 5, refs: 5, files: 5 },
          { name: 'ShellButton', filePath: 'study-ui/src/components/shell/ShellButton.tsx', imports: 2, refs: 2, files: 2 },
        ],
        hint: '已接 token，但不是产品主入口。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: '原生 <button>', filePath: '(散布在业务代码中)', imports: 0, refs: 184, files: 66 },
        ],
        hint: '66 个文件仍有原生按钮。',
      },
    ],
  },
  {
    title: 'Form controls 重复实现',
    signal: '目标：Input、Textarea、Select、Switch、Slider 使用同一 focus/disabled/spacing token。',
    priority: 'high',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'shad Input', filePath: 'src/components/ui/shad/Input.tsx', imports: 45, refs: 60, files: 40 },
          { name: 'shad Textarea', filePath: 'src/components/ui/shad/Textarea.tsx', imports: 12, refs: 14, files: 10 },
          { name: 'shad Switch', filePath: 'src/components/ui/shad/Switch.tsx', imports: 18, refs: 20, files: 15 },
          { name: 'shad Checkbox', filePath: 'src/components/ui/shad/Checkbox.tsx', imports: 8, refs: 10, files: 7 },
          { name: 'shad Slider', filePath: 'src/components/ui/shad/Slider.tsx', imports: 3, refs: 3, files: 2 },
        ],
        hint: 'shad controls 已是主路径。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'AppSelect', filePath: 'src/components/ui/app-menu/AppSelect.tsx', imports: 49, refs: 49, files: 23 },
          { name: 'study-ui Input', filePath: 'study-ui/src/components/ui/input.tsx', imports: 2, refs: 2, files: 2 },
          { name: 'study-ui Textarea', filePath: 'study-ui/src/components/ui/textarea.tsx', imports: 1, refs: 1, files: 1 },
          { name: 'study-ui Switch', filePath: 'study-ui/src/components/ui/switch.tsx', imports: 3, refs: 3, files: 3 },
        ],
        hint: '选择器职责需要拆清。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: '原生 <input>', filePath: '(散布在业务代码中)', imports: 0, refs: 80, files: 50 },
          { name: '原生 <select>', filePath: '(散布在业务代码中)', imports: 0, refs: 45, files: 30 },
          { name: '原生 <textarea>', filePath: '(散布在业务代码中)', imports: 0, refs: 18, files: 12 },
        ],
        hint: '83 个文件仍有原生控件。',
      },
    ],
  },
  {
    title: 'Dialog / Sheet 重复实现',
    signal: '目标：一个 Dialog 主入口，一个 Sheet 主入口，共享 overlay、radius、focus-ring。',
    priority: 'high',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'NotionDialog', filePath: 'src/components/ui/NotionDialog.tsx', imports: 52, refs: 52, files: 52 },
        ],
        hint: 'NotionDialog / shell token。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'shad Dialog', filePath: 'src/components/ui/shad/Dialog.tsx', imports: 13, refs: 13, files: 13 },
          { name: 'shad Sheet', filePath: 'src/components/ui/shad/Sheet.tsx', imports: 8, refs: 8, files: 8 },
          { name: 'study-ui Dialog', filePath: 'study-ui/src/components/ui/dialog.tsx', imports: 4, refs: 4, files: 3 },
          { name: 'study-ui Sheet', filePath: 'study-ui/src/components/ui/sheet.tsx', imports: 2, refs: 2, files: 2 },
          { name: 'AppMenu', filePath: 'src/components/ui/app-menu/AppMenu.tsx', imports: 47, refs: 47, files: 46 },
        ],
        hint: 'shad Sheet / study-ui Sheet。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: '原生 <details>/<summary>', filePath: '(散布在业务代码中)', imports: 0, refs: 6, files: 6 },
        ],
        hint: '业务 Modal CSS / wrapper。',
      },
    ],
  },
  {
    title: 'Surface / Card 重复实现',
    signal: '目标：Surface、Card、Panel 语义分层，业务不再自定义容器视觉。',
    priority: 'medium',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'study-ui Surface', filePath: 'study-ui/src/components/ui/surface.tsx', imports: 4, refs: 4, files: 4 },
          { name: 'study-ui Card', filePath: 'study-ui/src/components/ui/card.tsx', imports: 2, refs: 2, files: 2 },
        ],
        hint: 'Surface token。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'shad Card', filePath: 'src/components/ui/shad/Card.tsx', imports: 31, refs: 31, files: 31 },
        ],
        hint: '部分页面已使用。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: '业务 .card / panel', filePath: '(散布在业务代码中)', imports: 0, refs: 0, files: 0 },
        ],
        hint: '圆角、阴影、背景各自定义。',
      },
    ],
  },
  {
    title: 'Tabs 重复实现',
    signal: '目标：统一 Tabs primitive，迁移期间避免同一页面内混搭。',
    priority: 'medium',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'shad Tabs', filePath: 'src/components/ui/shad/Tabs.tsx', imports: 16, refs: 16, files: 16 },
        ],
        hint: 'shad Tabs 是当前主入口。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'study-ui Tabs', filePath: 'study-ui/src/components/ui/tabs.tsx', imports: 2, refs: 2, files: 2 },
        ],
        hint: '两套 Tabs 同时存在。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [],
        hint: '暂无遗留原生 Tabs。',
      },
    ],
  },
  {
    title: 'Sidebar row 重复实现',
    signal: '目标：导航行、线程行、设置行走同一 row primitive 和选中态 token。',
    priority: 'medium',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'NotionButton (nav variant)', filePath: 'src/components/ui/NotionButton.tsx', imports: 301, refs: 1560, files: 301 },
        ],
        hint: '导航行复用 NotionButton nav variant。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'UnifiedSidebar', filePath: 'src/components/ui/unified-sidebar/UnifiedSidebar.tsx', imports: 8, refs: 8, files: 8 },
          { name: 'ModernSidebar', filePath: 'src/components/ModernSidebar.tsx', imports: 1, refs: 1, files: 1 },
          { name: 'study-ui Sidebar', filePath: 'study-ui/src/components/shell/Sidebar.tsx', imports: 2, refs: 2, files: 2 },
        ],
        hint: 'Settings / Session / Notes 各有包装。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: 'custom nav row', filePath: '(散布在业务代码中)', imports: 0, refs: 0, files: 0 },
        ],
        hint: '手工圆角、背景、hover。',
      },
    ],
  },
  {
    title: 'Status badge 重复实现',
    signal: '目标：状态色只走 success/warning/danger/info 语义 token。',
    priority: 'medium',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'shad Badge', filePath: 'src/components/ui/shad/Badge.tsx', imports: 45, refs: 50, files: 40 },
        ],
        hint: '语义 token。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'shad Badge (variant=default)', filePath: 'src/components/ui/shad/Badge.tsx', imports: 45, refs: 50, files: 40 },
          { name: 'UnifiedNotification', filePath: 'src/components/UnifiedNotification.tsx', imports: 146, refs: 146, files: 144 },
        ],
        hint: '区分局部 badge/progress 与全局 notification。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [
          { name: 'hard-coded badge', filePath: '(散布在业务代码中)', imports: 0, refs: 0, files: 0 },
        ],
        hint: '内联样式、hard-coded 颜色。',
      },
    ],
  },
  {
    title: 'Scroll 重复实现',
    signal: '目标：滚动容器集中到 CustomScrollArea，确认各页面 viewport padding 和滚动条密度。',
    priority: 'low',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'CustomScrollArea', filePath: 'src/components/custom-scroll-area.tsx', imports: 111, refs: 111, files: 111 },
        ],
        hint: 'CustomScrollArea 基本集中。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'shad ScrollArea', filePath: 'src/components/ui/shad/ScrollArea.tsx', imports: 0, refs: 0, files: 0 },
        ],
        hint: 'shad ScrollArea 已无引用。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [],
        hint: '暂无遗留原生滚动容器。',
      },
    ],
  },
  {
    title: 'Icons 重复实现',
    signal: '目标：统一图标库为 Phosphor，人工校对同屏图标的线宽、尺寸和视觉重量。',
    priority: 'high',
    lanes: [
      {
        tone: 'target',
        label: '推荐统一入口',
        entries: [
          { name: 'Phosphor (main)', filePath: 'src/ 各处', imports: 20, refs: 20, files: 11 },
          { name: 'Phosphor (study-ui)', filePath: 'study-ui/src/ 各处', imports: 20, refs: 20, files: 9 },
        ],
        hint: 'Phosphor 是迁移目标。',
      },
      {
        tone: 'mixed',
        label: '当前混用入口',
        entries: [
          { name: 'lucide-react', filePath: 'src/ 各处', imports: 370, refs: 370, files: 365 },
          { name: 'StudySidebarIcons', filePath: 'src/components/StudySidebarIcons.tsx', imports: 4, refs: 4, files: 4 },
        ],
        hint: 'lucide-react 占绝大多数。',
      },
      {
        tone: 'legacy',
        label: '旧写法样本',
        entries: [],
        hint: '暂无其他遗留图标库。',
      },
    ],
  },
];

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
    label: 'Info API / neutral toast',
    title: 'Toast 调试：Neutral',
    message: '已切换到新的学习会话。Info API 仍然可用，但视觉走 neutral，像状态回声。',
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

const llmOutputUserPrompt = '帮我把 DeepStudent 的 LLM 输出调成更像 Codex：等待、思考、正文、工具、停止这些状态都要自然。';
const llmOutputThinkingCopy = '正在整理回答结构…';
const llmOutputThinkingIntro = '正在整理';
const llmOutputToolRunningCopy = '正在检索当前 Chat V2 的样式与状态机…';
const llmOutputIntroContent = '我会先按当前 Chat V2 的真实状态机收口：首包前只显示等待点，正文开始后才出现当前内容末尾的输入态。';
const llmOutputResumeContent = '工具阶段结束后，再继续正文；手动停止时则立刻清掉活跃态，不让 cursor 残留。';
const llmOutputResumeAbortContent = '工具阶段结束后，再继续正文；手动停止时则立刻清掉活跃态，';
const llmOutputPlaybackIds = {
  userMessage: 'style-lab-llm-user',
  assistantMessage: 'style-lab-llm-assistant',
  userContent: 'style-lab-llm-user-content',
  thinking: 'style-lab-llm-thinking',
  introContent: 'style-lab-llm-content-intro',
  toolMcp: 'style-lab-llm-tool-mcp',
  toolImageGen: 'style-lab-llm-tool-image-gen',
  toolRag: 'style-lab-llm-tool-rag',
  toolMemory: 'style-lab-llm-tool-memory',
  toolWebSearch: 'style-lab-llm-tool-web-search',
  toolAnki: 'style-lab-llm-tool-anki',
  toolWorkspace: 'style-lab-llm-tool-workspace',
  toolAskUser: 'style-lab-llm-tool-ask-user',
  toolError: 'style-lab-llm-tool-error',
  resumeContent: 'style-lab-llm-content-resume',
  error: 'style-lab-llm-error',
} as const;

const llmOutputPlaybackFrames: LlmOutputPlaybackFrame[] = [
  // ===== 基本流程 =====
  {
    id: 'waiting',
    state: 'waiting',
    frameId: 'waiting',
    durationMs: 900,
  },
  {
    id: 'thinking',
    state: 'thinking',
    frameId: 'thinking-1',
    durationMs: 280,
    thinkingContent: llmOutputThinkingIntro,
  },
  {
    id: 'thinking',
    state: 'thinking',
    frameId: 'thinking-2',
    durationMs: 520,
    thinkingContent: llmOutputThinkingCopy,
  },
  {
    id: 'content-intro',
    state: 'content',
    frameId: 'content-intro-1',
    durationMs: 220,
    thinkingContent: llmOutputThinkingCopy,
    introContent: '我会先按当前 Chat V2 的真实状态机收口：',
  },
  {
    id: 'content-intro',
    state: 'content',
    frameId: 'content-intro-2',
    durationMs: 260,
    thinkingContent: llmOutputThinkingCopy,
    introContent: '我会先按当前 Chat V2 的真实状态机收口：首包前只显示等待点，',
  },
  {
    id: 'content-intro',
    state: 'content',
    frameId: 'content-intro-3',
    durationMs: 320,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
  },

  // ===== MCP 工具调用 =====
  {
    id: 'tool-mcp',
    state: 'tool',
    frameId: 'tool-mcp-running',
    durationMs: 900,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    toolInput: { topic: 'chat-v2-output-states' },
  },
  {
    id: 'tool-mcp',
    state: 'tool',
    frameId: 'tool-mcp-success',
    durationMs: 500,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    toolOutput: { results: ['文档1', '文档2'] },
  },

  // ===== 图片生成工具 =====
  {
    id: 'tool-image-gen',
    state: 'tool',
    frameId: 'tool-image-gen-running',
    durationMs: 1200,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'image_gen',
    toolName: 'image_gen',
    toolInput: { prompt: 'A beautiful sunset', size: '1024x1024' },
  },
  {
    id: 'tool-image-gen',
    state: 'tool',
    frameId: 'tool-image-gen-success',
    durationMs: 500,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'image_gen',
    toolName: 'image_gen',
    toolOutput: { url: 'https://example.com/image.png' },
  },

  // ===== RAG 检索 =====
  {
    id: 'tool-rag',
    state: 'tool',
    frameId: 'tool-rag-running',
    durationMs: 800,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'rag',
    toolName: 'rag_search',
    toolInput: { query: 'Chat V2 状态机', topK: 5 },
  },
  {
    id: 'tool-rag',
    state: 'tool',
    frameId: 'tool-rag-success',
    durationMs: 400,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'rag',
    toolName: 'rag_search',
    toolOutput: { sources: [{ title: '状态机文档', snippet: '...' }] },
  },

  // ===== 记忆检索 =====
  {
    id: 'tool-memory',
    state: 'tool',
    frameId: 'tool-memory-running',
    durationMs: 600,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'memory',
    toolName: 'memory_search',
    toolInput: { query: '用户偏好设置' },
  },
  {
    id: 'tool-memory',
    state: 'tool',
    frameId: 'tool-memory-success',
    durationMs: 300,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'memory',
    toolName: 'memory_search',
    toolOutput: { memories: ['用户喜欢简洁界面'] },
  },

  // ===== 网络搜索 =====
  {
    id: 'tool-web-search',
    state: 'tool',
    frameId: 'tool-web-search-running',
    durationMs: 1500,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'web_search',
    toolName: 'web_search',
    toolInput: { query: 'React best practices 2026' },
  },
  {
    id: 'tool-web-search',
    state: 'tool',
    frameId: 'tool-web-search-success',
    durationMs: 500,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'web_search',
    toolName: 'web_search',
    toolOutput: { results: [{ title: 'React 2026', url: 'https://example.com' }] },
  },

  // ===== Anki 卡片生成 =====
  {
    id: 'tool-anki',
    state: 'tool',
    frameId: 'tool-anki-running',
    durationMs: 1000,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'anki_cards',
    toolName: 'anki_create',
    toolInput: { front: '什么是状态机？', back: '状态机是...' },
  },
  {
    id: 'tool-anki',
    state: 'tool',
    frameId: 'tool-anki-success',
    durationMs: 400,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'anki_cards',
    toolName: 'anki_create',
    toolOutput: { cardId: 'card_123', created: true },
  },

  // ===== 工作区操作 =====
  {
    id: 'tool-workspace',
    state: 'tool',
    frameId: 'tool-workspace-running',
    durationMs: 800,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'workspace_status',
    toolName: 'workspace_create',
    toolInput: { name: '研究项目' },
  },
  {
    id: 'tool-workspace',
    state: 'tool',
    frameId: 'tool-workspace-success',
    durationMs: 400,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'workspace_status',
    toolName: 'workspace_create',
    toolOutput: { workspaceId: 'ws_123', created: true },
  },

  // ===== 用户交互 =====
  {
    id: 'tool-ask-user',
    state: 'tool',
    frameId: 'tool-ask-user-running',
    durationMs: 600,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'running',
    toolType: 'ask_user',
    toolName: 'ask_user',
    toolInput: { question: '您想要哪种风格的界面？' },
  },

  // ===== 工具调用错误 =====
  {
    id: 'tool-error',
    state: 'error',
    frameId: 'tool-error',
    durationMs: 800,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'error',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    toolInput: { topic: 'error-test' },
    error: '工具调用失败：API 超时',
  },

  // ===== 正文恢复 =====
  {
    id: 'content-resume',
    state: 'content',
    frameId: 'content-resume-1',
    durationMs: 220,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    resumeContent: '工具阶段结束后，再继续正文；',
  },
  {
    id: 'content-resume',
    state: 'content',
    frameId: 'content-resume-2',
    durationMs: 300,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    resumeContent: llmOutputResumeAbortContent,
  },

  // ===== API 错误 =====
  {
    id: 'error',
    state: 'error',
    frameId: 'error-api',
    durationMs: 1000,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    error: 'API 请求失败：429 Too Many Requests',
  },

  // ===== 用户中止 =====
  {
    id: 'aborting',
    state: 'aborting',
    frameId: 'aborting',
    durationMs: 900,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    resumeContent: llmOutputResumeAbortContent,
  },

  // ===== 完成 =====
  {
    id: 'idle',
    state: 'idle',
    frameId: 'idle',
    durationMs: 1000,
    thinkingContent: llmOutputThinkingCopy,
    introContent: llmOutputIntroContent,
    toolStatus: 'success',
    toolType: 'mcp_tool',
    toolName: 'search_docs',
    resumeContent: llmOutputResumeAbortContent,
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

const transitionDemoCss = `
/* transitions-dev — copy this :root block into your project once.
   Every transition snippet reads from these semantic names. */
:root {
  /* Card resize */
  --resize-dur: 300ms;
  --resize-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Number pop-in */
  --digit-dur: 500ms;
  --digit-distance: 8px;
  --digit-stagger: 70ms;
  --digit-blur: 2px;
  --digit-ease: cubic-bezier(0.34, 1.45, 0.64, 1);
  --digit-dir-x: 0;
  --digit-dir-y: 1;
  /* Notification badge */
  --badge-slide-dur: 260ms;
  --badge-pop-dur: 500ms;
  --badge-pop-close-dur: 180ms;
  --badge-fade-dur: 400ms;
  --badge-fade-close-dur: 180ms;
  --badge-blur: 2px;
  --badge-offset-x: -8.2px;
  --badge-offset-y: 12.4px;
  --badge-slide-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --badge-pop-ease: cubic-bezier(0.34, 1.36, 0.64, 1);
  --badge-close-ease: cubic-bezier(0.4, 0, 0.2, 1);
  /* Text states swap */
  --text-swap-dur: 200ms;
  --text-swap-translate-y: 8px;
  --text-swap-blur: 2px;
  --text-swap-ease: ease-out;
  /* Menu dropdown */
  --dropdown-open-dur: 250ms;
  --dropdown-close-dur: 150ms;
  --dropdown-pre-scale: 0.97;
  --dropdown-closing-scale: 0.99;
  --dropdown-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Modal open / close */
  --modal-open-dur: 250ms;
  --modal-close-dur: 150ms;
  --modal-scale: 0.96;
  --modal-scale-close: 0.96;
  --modal-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Panel reveal */
  --panel-open-dur: 400ms;
  --panel-close-dur: 350ms;
  --panel-translate-y: 100px;
  --panel-blur: 2px;
  --panel-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Page side-by-side */
  --page-slide-dur: 200ms;
  --page-fade-dur: 200ms;
  --page-slide-distance: 8px;
  --page-blur: 3px;
  --page-stagger: 0ms;
  --page-exit-enabled: 1;
  --page-slide-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --page-fade-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Icon swap */
  --icon-swap-dur: 200ms;
  --icon-swap-blur: 2px;
  --icon-swap-start-scale: 0.25;
  --icon-swap-ease: ease-in-out;
}

.t-resize {
  transition:
    width  var(--resize-dur) var(--resize-ease),
    height var(--resize-dur) var(--resize-ease);
  will-change: width, height;
}

@media (prefers-reduced-motion: reduce) {
  .t-resize { transition: none !important; }
}

@keyframes t-digit-pop-in {
  0%   {
    transform: translate(
      calc(var(--digit-distance) * var(--digit-dir-x)),
      calc(var(--digit-distance) * var(--digit-dir-y))
    );
    opacity: 0;
    filter: blur(var(--digit-blur));
  }
  100% { transform: translate(0, 0); opacity: 1; filter: blur(0); }
}

.t-digit-group {
  display: inline-flex;
  align-items: baseline;
}
.t-digit {
  display: inline-block;
  will-change: transform, opacity, filter;
}
.t-digit-group.is-animating .t-digit {
  animation: t-digit-pop-in var(--digit-dur) var(--digit-ease) both;
}
.t-digit-group.is-animating .t-digit[data-stagger="1"] {
  animation-delay: var(--digit-stagger);
}
.t-digit-group.is-animating .t-digit[data-stagger="2"] {
  animation-delay: calc(var(--digit-stagger) * 2);
}

@media (prefers-reduced-motion: reduce) {
  .t-digit-group .t-digit { animation: none !important; }
}

.t-text-swap {
  display: inline-block;
  transform: translateY(0);
  filter: blur(0);
  opacity: 1;
  transition:
    transform var(--text-swap-dur) var(--text-swap-ease),
    filter    var(--text-swap-dur) var(--text-swap-ease),
    opacity   var(--text-swap-dur) var(--text-swap-ease);
  will-change: transform, filter, opacity;
}
.t-text-swap.is-exit {
  transform: translateY(calc(var(--text-swap-translate-y) * -1));
  filter: blur(var(--text-swap-blur));
  opacity: 0;
}
.t-text-swap.is-enter-start {
  transform: translateY(var(--text-swap-translate-y));
  filter: blur(var(--text-swap-blur));
  opacity: 0;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .t-text-swap { transition: none !important; }
}

.t-dropdown {
  transform-origin: top left;
  transform: scale(var(--dropdown-pre-scale));
  opacity: 0;
  pointer-events: none;
  transition:
    transform var(--dropdown-open-dur) var(--dropdown-ease),
    opacity   var(--dropdown-open-dur) var(--dropdown-ease);
  will-change: transform, opacity;
}
.t-dropdown[data-origin="top-right"]     { transform-origin: top right; }
.t-dropdown[data-origin="top-center"]    { transform-origin: top center; }
.t-dropdown[data-origin="bottom-left"]   { transform-origin: bottom left; }
.t-dropdown[data-origin="bottom-center"] { transform-origin: bottom center; }
.t-dropdown[data-origin="bottom-right"]  { transform-origin: bottom right; }

.t-dropdown.is-open {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
}
.t-dropdown.is-closing {
  transform: scale(var(--dropdown-closing-scale));
  opacity: 0;
  pointer-events: none;
  transition:
    transform var(--dropdown-close-dur) var(--dropdown-ease),
    opacity   var(--dropdown-close-dur) var(--dropdown-ease);
}

@media (prefers-reduced-motion: reduce) {
  .t-dropdown { transition: none !important; }
}

.t-page-slide {
  position: relative;
}
.t-page-slide .t-page[data-page-id="1"] {
  --t-page-from-x: calc(var(--page-slide-distance) * -1);
}
.t-page-slide .t-page[data-page-id="2"] {
  --t-page-from-x: var(--page-slide-distance);
}
.t-page-slide .t-page {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transform: translateX(calc(var(--t-page-from-x, 0px) * var(--page-exit-enabled)));
  filter: blur(calc(var(--page-blur) * var(--page-exit-enabled)));
  transition:
    opacity   var(--page-fade-dur)  var(--page-fade-ease),
    transform var(--page-slide-dur) var(--page-slide-ease),
    filter    var(--page-slide-dur) var(--page-slide-ease);
  will-change: opacity, transform, filter;
}
.t-page-slide[data-page="1"] .t-page[data-page-id="1"],
.t-page-slide[data-page="2"] .t-page[data-page-id="2"] {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
  filter: blur(0);
  transition-delay: var(--page-stagger);
}

@media (prefers-reduced-motion: reduce) {
  .t-page-slide .t-page { transition: none !important; }
}

.t-icon-swap {
  position: relative;
  display: inline-grid;
}
.t-icon-swap .t-icon {
  grid-area: 1 / 1;
  transition:
    opacity   var(--icon-swap-dur) var(--icon-swap-ease),
    filter    var(--icon-swap-dur) var(--icon-swap-ease),
    transform var(--icon-swap-dur) var(--icon-swap-ease);
  will-change: opacity, filter, transform;
}
.t-icon-swap[data-state="a"] .t-icon[data-icon="a"],
.t-icon-swap[data-state="b"] .t-icon[data-icon="b"] {
  opacity: 1;
  filter: blur(0);
  transform: scale(1);
}
.t-icon-swap[data-state="a"] .t-icon[data-icon="b"],
.t-icon-swap[data-state="b"] .t-icon[data-icon="a"] {
  opacity: 0;
  filter: blur(var(--icon-swap-blur));
  transform: scale(var(--icon-swap-start-scale));
}

@media (prefers-reduced-motion: reduce) {
  .t-icon-swap .t-icon { transition: none !important; }
}
`;

const llmOutputDemoCss = `
.llm-output-playback {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--shell-workspace-border);
  border-radius: 14px;
  background: var(--surface-panel-strong);
  padding: 14px;
}

.llm-output-playback__header {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 12px;
}

.llm-output-playback__header-meta {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.llm-output-playback__title {
  min-width: 0;
}

.llm-output-playback__title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-primary);
}

.llm-output-playback__title p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.llm-output-playback__status {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.llm-output-playback__scenes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.llm-output-playback__scenes-label {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.llm-output-playback__scenes-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.llm-output-playback__scene-btn {
  font-size: 11px;
  padding: 4px 8px;
  min-height: 28px;
}

.llm-output-playback__actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.llm-output-playback__stage {
  margin-top: 14px;
}

.llm-output-playback__chat {
  min-width: 0;
  border: 1px solid var(--shell-workspace-border);
  border-radius: 12px;
  background: var(--surface-root);
  padding: 12px;
}

.llm-output-playback__chat {
  display: grid;
  gap: 10px;
}

.llm-output-playback__text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.llm-output-playback__text--muted {
  color: var(--text-secondary);
}
@media (max-width: 720px) {
  .llm-output-playback__header {
    flex-direction: column;
    align-items: stretch;
  }
}
`;

const transitionTextStates = ['Indexing', 'Synced', 'Needs review'] as const;

type TransitionDropdownState = 'open' | 'closing' | 'closed';

function readRootDurationMs(variableName: string, fallbackMs: number) {
  if (typeof window === 'undefined') return fallbackMs;

  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed)) return fallbackMs;
  return raw.endsWith('s') && !raw.endsWith('ms') ? parsed * 1000 : parsed;
}

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
          <NotionButton variant="primary">Primary</NotionButton>
          <NotionButton variant="ghost">Ghost</NotionButton>
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
          <ShadButton>shad Button</ShadButton>
          <ShadButton variant="secondary">Secondary</ShadButton>
          <ShadButton variant="outline">Outline</ShadButton>
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
          <Switch defaultChecked aria-label="Semantic token switch sample" />
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
          <NotionButton variant="ghost" onClick={copySummary} aria-label="复制 tooltip 调试配置">
            <Copy className="size-4" />
            复制配置
          </NotionButton>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {tooltipPositions.map((item) => (
            <NotionButton key={item} variant={position === item ? 'primary' : 'ghost'} onClick={() => setPosition(item)}>
              {item}
            </NotionButton>
          ))}
          {tooltipThemes.map((item) => (
            <NotionButton key={item} variant={theme === item ? 'success' : 'ghost'} onClick={() => setTheme(item)}>
              {item}
            </NotionButton>
          ))}
          <NotionButton variant={showArrow ? 'warning' : 'ghost'} onClick={() => setShowArrow((value) => !value)}>
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
              <NotionButton variant="primary">
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
                  <NotionButton variant="default">
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
                  <NotionButton variant="secondary">
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

function TransitionDebugCard({
  title,
  description,
  path,
  children,
}: {
  title: string;
  description: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{description}</p>
        <code className="mt-2 block truncate text-[11px] leading-5 text-[color:var(--text-secondary)]">{path}</code>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TransitionStyleLab() {
  const [cardExpanded, setCardExpanded] = React.useState(true);
  const [dropdownState, setDropdownState] = React.useState<TransitionDropdownState>('open');
  const [page, setPage] = React.useState<'1' | '2'>('1');
  const [digitValue, setDigitValue] = React.useState(248);
  const [digitAnimating, setDigitAnimating] = React.useState(true);
  const [textIndex, setTextIndex] = React.useState(0);
  const [textSwapClassName, setTextSwapClassName] = React.useState('');
  const [iconState, setIconState] = React.useState<'a' | 'b'>('a');
  const digitGroupRef = React.useRef<HTMLSpanElement | null>(null);
  const digitReplayTimeoutRef = React.useRef<number | null>(null);
  const dropdownCloseTimeoutRef = React.useRef<number | null>(null);
  const textSwapTimeoutRef = React.useRef<number | null>(null);
  const textSwapFrameRef = React.useRef<number | null>(null);
  const textSwapRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    return () => {
      if (digitReplayTimeoutRef.current !== null) window.clearTimeout(digitReplayTimeoutRef.current);
      if (dropdownCloseTimeoutRef.current !== null) window.clearTimeout(dropdownCloseTimeoutRef.current);
      if (textSwapTimeoutRef.current !== null) window.clearTimeout(textSwapTimeoutRef.current);
      if (textSwapFrameRef.current !== null) window.cancelAnimationFrame(textSwapFrameRef.current);
    };
  }, []);

  const toggleDropdown = React.useCallback(() => {
    if (dropdownCloseTimeoutRef.current !== null) {
      window.clearTimeout(dropdownCloseTimeoutRef.current);
      dropdownCloseTimeoutRef.current = null;
    }

    if (dropdownState === 'open') {
      const closeMs = readRootDurationMs('--dropdown-close-dur', 150);
      setDropdownState('closing');
      dropdownCloseTimeoutRef.current = window.setTimeout(() => {
        setDropdownState('closed');
        dropdownCloseTimeoutRef.current = null;
      }, closeMs);
      return;
    }

    setDropdownState('open');
  }, [dropdownState]);

  const replayDigitPopIn = React.useCallback(() => {
    if (digitReplayTimeoutRef.current !== null) {
      window.clearTimeout(digitReplayTimeoutRef.current);
    }

    setDigitAnimating(false);
    setDigitValue((current) => current + 7);
    digitReplayTimeoutRef.current = window.setTimeout(() => {
      if (digitGroupRef.current) void digitGroupRef.current.offsetHeight;
      setDigitAnimating(true);
      digitReplayTimeoutRef.current = null;
    }, 0);
  }, []);

  const swapTextState = React.useCallback(() => {
    const duration = readRootDurationMs('--text-swap-dur', 200);

    if (textSwapTimeoutRef.current !== null) {
      window.clearTimeout(textSwapTimeoutRef.current);
    }
    if (textSwapFrameRef.current !== null) {
      window.cancelAnimationFrame(textSwapFrameRef.current);
    }

    setTextSwapClassName('is-exit');
    textSwapTimeoutRef.current = window.setTimeout(() => {
      setTextIndex((current) => (current + 1) % transitionTextStates.length);
      setTextSwapClassName('is-enter-start');
      textSwapFrameRef.current = window.requestAnimationFrame(() => {
        if (textSwapRef.current) void textSwapRef.current.offsetHeight;
        setTextSwapClassName('');
        textSwapFrameRef.current = null;
      });
      textSwapTimeoutRef.current = null;
    }, duration);
  }, []);

  return (
    <div className="space-y-4">
      <style>{transitionDemoCss}</style>
      <SectionHeader
        icon={SplitSquareHorizontal}
        title="transitions.dev 动效调试"
        description="把常见的尺寸变化、浮层、页面切换、数字更新、文案切换和图标切换放到同一页里，方便直接看 transition hooks 的实际效果。"
      />

      <div className="grid gap-3 xl:grid-cols-2">
        <TransitionDebugCard
          title="Card resize"
          description="容器在紧凑和展开之间平滑过渡，适合详情卡、侧栏卡和折叠区。"
          path=".t-resize"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Detail card</p>
            <NotionButton variant="ghost" onClick={() => setCardExpanded((current) => !current)}>
              {cardExpanded ? 'Compact' : 'Expand'}
            </NotionButton>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-3">
            <div
              className="t-resize overflow-hidden rounded-[12px] border border-[color:var(--button-utility-border)] bg-[color:var(--surface-panel-strong)] p-3"
              style={{
                width: cardExpanded ? 320 : 220,
                height: cardExpanded ? 152 : 96,
                maxWidth: '100%',
              }}
            >
              <div className="flex h-full flex-col justify-between">
                <div>
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">Study card</p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
                    The box resizes without layout jumps, so scanning feels calm.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--text-secondary)]">
                  <span>{cardExpanded ? 'Expanded' : 'Compact'}</span>
                  <span>{cardExpanded ? '320 x 152' : '220 x 96'}</span>
                </div>
              </div>
            </div>
          </div>
        </TransitionDebugCard>

        <TransitionDebugCard
          title="Menu dropdown"
          description="从触发点长出来的菜单，闭合时保留 closing 态，方便看 origin 和 scale。"
          path=".t-dropdown"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Origin aware menu</p>
            <NotionButton variant="primary" onClick={toggleDropdown}>
              Menu
            </NotionButton>
          </div>
          <div className="relative mt-3 h-48 overflow-hidden rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-3">
            <div
              className={cn(
                't-dropdown absolute left-3 top-3 z-10 w-56 rounded-xl border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-2 shadow-[var(--shadow-shell-soft)]',
                dropdownState === 'open' && 'is-open',
                dropdownState === 'closing' && 'is-closing'
              )}
              data-origin="top-left"
            >
              <NotionButton variant="ghost" className="w-full px-3">
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-left">Open note</span>
                  <CheckCircle2 className="size-4 shrink-0 text-[color:hsl(var(--success))]" />
                </span>
              </NotionButton>
              <NotionButton variant="ghost" className="mt-1 w-full px-3">
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-left">Archive</span>
                  <X className="size-4 shrink-0 text-[color:hsl(var(--warning))]" />
                </span>
              </NotionButton>
            </div>
            <div className="pt-20 text-xs leading-5 text-[color:var(--text-secondary)]">
              这个菜单会保留 closing 状态直到 timeout 结束。
            </div>
          </div>
        </TransitionDebugCard>

        <TransitionDebugCard
          title="Page side-by-side"
          description="两块页面并排切换，适合 list ↔ detail 或 step 1 ↔ step 2。"
          path=".t-page-slide"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Page {page}</p>
            <div className="flex gap-2">
              <NotionButton variant={page === '1' ? 'primary' : 'ghost'} onClick={() => setPage('1')}>
                Page 1
              </NotionButton>
              <NotionButton variant={page === '2' ? 'primary' : 'ghost'} onClick={() => setPage('2')}>
                Page 2
              </NotionButton>
            </div>
          </div>
          <div
            className="t-page-slide mt-3 h-40 overflow-hidden rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-3"
            data-page={page}
          >
            <section
              className="t-page rounded-xl border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4"
              data-page-id="1"
            >
              <p className="text-sm font-medium text-[color:var(--text-primary)]">List view</p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
                Overview first, then slide to the detail pane.
              </p>
            </section>
            <section
              className="t-page rounded-xl border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-4"
              data-page-id="2"
            >
              <p className="text-sm font-medium text-[color:var(--text-primary)]">Detail view</p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
                This screen stays anchored in the same region while the page swaps.
              </p>
            </section>
          </div>
        </TransitionDebugCard>

        <TransitionDebugCard
          title="Number pop-in"
          description="每一位数字独立进入，适合余额、计数器和状态分值。"
          path=".t-digit-group"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Live counter</p>
            <NotionButton variant="ghost" onClick={replayDigitPopIn}>
              Increment
            </NotionButton>
          </div>
          <div className="mt-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
            <span
              ref={digitGroupRef}
              className={cn('t-digit-group text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]', digitAnimating && 'is-animating')}
              aria-label={`Score ${digitValue}`}
            >
              {String(digitValue).split('').map((digit, index, digits) => {
                const stagger = index === digits.length - 2 ? '1' : index === digits.length - 1 ? '2' : undefined;

                return (
                  <span key={`${digitValue}-${index}`} className="t-digit" data-stagger={stagger}>
                    {digit}
                  </span>
                );
              })}
            </span>
          </div>
        </TransitionDebugCard>

        <TransitionDebugCard
          title="Text states swap"
          description="同一个文案位置里切换状态，旧文本上滑退出，新文本从下方进入。"
          path=".t-text-swap"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Status chip</p>
            <NotionButton variant="ghost" onClick={swapTextState}>
              Swap
            </NotionButton>
          </div>
          <div className="mt-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
            <span
              ref={textSwapRef}
              className={cn('t-text-swap text-sm font-medium text-[color:var(--text-primary)]', textSwapClassName)}
              aria-live="polite"
            >
              {transitionTextStates[textIndex]}
            </span>
            <p className="mt-2 text-xs leading-5 text-[color:var(--text-secondary)]">
              {textIndex === 0 ? 'Indexing documents' : textIndex === 1 ? 'Sync complete' : 'Needs review'}
            </p>
          </div>
        </TransitionDebugCard>

        <TransitionDebugCard
          title="Icon swap"
          description="同一位置里的两个 icon 交叉淡入淡出，适合 play/pause、menu/close、checked/unchecked。"
          path=".t-icon-swap"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[color:var(--text-secondary)]">Button icon</p>
            <NotionButton variant="ghost" onClick={() => setIconState((current) => (current === 'a' ? 'b' : 'a'))}>
              Toggle icon
            </NotionButton>
          </div>
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
            <span
              className="t-icon-swap size-9 shrink-0 rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)]"
              data-state={iconState}
            >
              <span className="t-icon flex items-center justify-center" data-icon="a">
                <CheckCircle2 className="size-4" />
              </span>
              <span className="t-icon flex items-center justify-center" data-icon="b">
                <X className="size-4" />
              </span>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-[color:var(--text-primary)]">
                {iconState === 'a' ? 'Ready' : 'Closed'}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
                The icons stay stacked in the same slot.
              </p>
            </div>
          </div>
        </TransitionDebugCard>
      </div>
    </div>
  );
}

const llmOutputPlaybackStepLabels: Record<LlmOutputPlaybackStepId | 'ready', string> = {
  ready: '准备',
  waiting: '首包前等待',
  thinking: '思考块',
  'content-intro': '正文起笔',
  tool: '工具调用',
  'tool-mcp': 'MCP 工具调用',
  'tool-image-gen': '图片生成',
  'tool-rag': '文档检索',
  'tool-memory': '记忆检索',
  'tool-web-search': '网络搜索',
  'tool-anki': 'Anki 制卡',
  'tool-workspace': '工作区操作',
  'tool-ask-user': '用户交互',
  'tool-error': '工具错误',
  'content-resume': '正文续写',
  error: 'API 错误',
  aborting: '停止中',
  idle: '停止完成',
};

function buildLlmOutputPlaybackState(frame: LlmOutputPlaybackFrame | 'ready') {
  const userMessage = {
    id: llmOutputPlaybackIds.userMessage,
    role: 'user' as const,
    blockIds: [llmOutputPlaybackIds.userContent],
    timestamp: 1,
  };

  const userBlock = {
    id: llmOutputPlaybackIds.userContent,
    type: 'content' as const,
    status: 'success' as const,
    messageId: llmOutputPlaybackIds.userMessage,
    content: llmOutputUserPrompt,
    startedAt: 1,
    firstChunkAt: 1,
    endedAt: 1,
  };

  const assistantBlockIds: string[] = [];
  const blocks = new Map<string, any>([[userBlock.id, userBlock]]);
  let sessionStatus: 'idle' | 'streaming' | 'aborting' | 'error' = 'idle';
  let currentStreamingMessageId: string | null = null;
  let activeBlockIds = new Set<string>();

  const thinkingBlock = {
    id: llmOutputPlaybackIds.thinking,
    type: 'thinking' as const,
    status: 'success' as const,
    messageId: llmOutputPlaybackIds.assistantMessage,
    content: llmOutputThinkingCopy,
    startedAt: 10,
    firstChunkAt: 10,
    endedAt: 20,
  };

  const introContentBlock = {
    id: llmOutputPlaybackIds.introContent,
    type: 'content' as const,
    status: 'success' as const,
    messageId: llmOutputPlaybackIds.assistantMessage,
    content: llmOutputIntroContent,
    startedAt: 30,
    firstChunkAt: 30,
    endedAt: 40,
  };

  const resumeContentBlock = {
    id: llmOutputPlaybackIds.resumeContent,
    type: 'content' as const,
    status: 'success' as const,
    messageId: llmOutputPlaybackIds.assistantMessage,
    content: llmOutputResumeContent,
    startedAt: 70,
    firstChunkAt: 70,
    endedAt: 80,
  };

  // Helper function to get tool block ID based on tool type
  const getToolBlockId = (frame: LlmOutputPlaybackFrame): string => {
    if (frame.toolType === 'image_gen') return llmOutputPlaybackIds.toolImageGen;
    if (frame.toolType === 'rag') return llmOutputPlaybackIds.toolRag;
    if (frame.toolType === 'memory') return llmOutputPlaybackIds.toolMemory;
    if (frame.toolType === 'web_search') return llmOutputPlaybackIds.toolWebSearch;
    if (frame.toolType === 'anki_cards') return llmOutputPlaybackIds.toolAnki;
    if (frame.toolType === 'workspace_status') return llmOutputPlaybackIds.toolWorkspace;
    if (frame.toolType === 'ask_user') return llmOutputPlaybackIds.toolAskUser;
    return llmOutputPlaybackIds.toolMcp;
  };

  if (frame !== 'ready' && frame.id !== 'idle' && frame.id !== 'error') {
    currentStreamingMessageId = llmOutputPlaybackIds.assistantMessage;
    sessionStatus = 'streaming';
  }

  if (frame !== 'ready' && frame.id !== 'waiting') {
    assistantBlockIds.push(thinkingBlock.id);
    blocks.set(
      thinkingBlock.id,
      frame.id === 'thinking'
        ? {
            ...thinkingBlock,
            content: frame.thinkingContent ?? llmOutputThinkingCopy,
            status: 'running',
            endedAt: undefined,
          }
        : {
            ...thinkingBlock,
            content: frame.thinkingContent ?? llmOutputThinkingCopy,
          },
    );
  }

  if (frame !== 'ready' && frame.introContent) {
    assistantBlockIds.push(introContentBlock.id);
    blocks.set(
      introContentBlock.id,
      frame.id === 'content-intro'
        ? {
            ...introContentBlock,
            content: frame.introContent,
            status: 'running',
            endedAt: undefined,
          }
        : {
            ...introContentBlock,
            content: frame.introContent,
          },
    );
  }

  // Handle tool blocks
  if (frame !== 'ready' && frame.toolStatus) {
    const toolBlockId = getToolBlockId(frame);
    const toolBlock = {
      id: toolBlockId,
      type: frame.toolType ?? 'mcp_tool',
      status: 'success' as const,
      messageId: llmOutputPlaybackIds.assistantMessage,
      toolName: frame.toolName ?? 'unknown',
      toolInput: frame.toolInput ?? {},
      startedAt: 50,
      firstChunkAt: 50,
      endedAt: 60,
    };

    assistantBlockIds.push(toolBlock.id);
    blocks.set(
      toolBlock.id,
      frame.toolStatus === 'running'
        ? {
            ...toolBlock,
            status: 'running',
            content: llmOutputToolRunningCopy,
            endedAt: undefined,
          }
        : frame.toolStatus === 'error'
          ? {
              ...toolBlock,
              status: 'error',
              content: frame.error ?? '工具调用失败',
              endedAt: 60,
            }
          : {
              ...toolBlock,
              status: 'success',
              content: frame.toolOutput ? JSON.stringify(frame.toolOutput) : '',
            },
    );
  }

  if (frame !== 'ready' && frame.resumeContent) {
    assistantBlockIds.push(resumeContentBlock.id);
    blocks.set(
      resumeContentBlock.id,
      frame.id === 'content-resume' || frame.id === 'aborting'
        ? {
            ...resumeContentBlock,
            content: frame.resumeContent,
            status: 'running',
            endedAt: undefined,
          }
        : {
            ...resumeContentBlock,
            content: frame.resumeContent,
          },
    );
  }

  // Handle error block
  if (frame !== 'ready' && frame.id === 'error') {
    const errorBlock = {
      id: llmOutputPlaybackIds.error,
      type: 'content' as const,
      status: 'error' as const,
      messageId: llmOutputPlaybackIds.assistantMessage,
      content: frame.error ?? '未知错误',
      startedAt: 90,
      firstChunkAt: 90,
      endedAt: 100,
    };
    assistantBlockIds.push(errorBlock.id);
    blocks.set(errorBlock.id, errorBlock);
    sessionStatus = 'error';
    activeBlockIds = new Set();
  }

  if (frame !== 'ready' && frame.id === 'thinking') {
    activeBlockIds = new Set([llmOutputPlaybackIds.thinking]);
  } else if (frame !== 'ready' && frame.id === 'content-intro') {
    activeBlockIds = new Set([llmOutputPlaybackIds.introContent]);
  } else if (frame !== 'ready' && frame.toolStatus === 'running') {
    const toolBlockId = getToolBlockId(frame);
    activeBlockIds = new Set([toolBlockId]);
  } else if (frame !== 'ready' && frame.id === 'content-resume') {
    activeBlockIds = new Set([llmOutputPlaybackIds.resumeContent]);
  } else if (frame !== 'ready' && frame.id === 'aborting') {
    sessionStatus = 'aborting';
    activeBlockIds = new Set();
  } else if (frame !== 'ready' && frame.id === 'idle') {
    sessionStatus = 'idle';
    currentStreamingMessageId = null;
    activeBlockIds = new Set();
  }

  const assistantMessage = {
    id: llmOutputPlaybackIds.assistantMessage,
    role: 'assistant' as const,
    blockIds: assistantBlockIds,
    timestamp: 2,
    _meta: {
      modelId: 'gpt-5',
      modelDisplayName: 'GPT-5',
    },
  };

  return {
    sessionStatus,
    isDataLoaded: true,
    messageMap: new Map<string, any>([
      [userMessage.id, userMessage],
      [assistantMessage.id, assistantMessage],
    ]),
    messageOrder: [userMessage.id, assistantMessage.id],
    blocks,
    currentStreamingMessageId,
    activeBlockIds,
    streamingVariantIds: new Set<string>(),
  };
}

function LlmOutputPlaybackBody({
  stepId,
  store,
}: {
  stepId: LlmOutputPlaybackStepId | 'ready';
  store: ReturnType<typeof createChatStore>;
}) {
  return (
    <div className="llm-output-playback__chat chat-v2" aria-live="polite">
      <MessageItem
        messageId={llmOutputPlaybackIds.userMessage}
        store={store}
        showActions={false}
        isFirst
      />
      {stepId === 'ready' ? (
        <p className="llm-output-playback__text llm-output-playback__text--muted px-4 pb-4">
          点击开始后，下面这一条 assistant message 会按当前 Chat V2 的真实渲染链自动走完一遍。这里固定模拟一条“工具后继续输出，再手动停止”的真实路径。
        </p>
      ) : (
        <MessageItem
          messageId={llmOutputPlaybackIds.assistantMessage}
          store={store}
          showActions={false}
        />
      )}
    </div>
  );
}

// Scene definitions for different playback scenarios
const llmOutputScenes = [
  { id: 'full', label: '完整流程', description: '等待 → 思考 → 正文 → 工具 → 恢复 → 停止' },
  { id: 'mcp-tool', label: 'MCP 工具', description: 'MCP 工具调用流程' },
  { id: 'image-gen', label: '图片生成', description: '图片生成工具调用' },
  { id: 'rag', label: '文档检索', description: 'RAG 检索流程' },
  { id: 'memory', label: '记忆检索', description: '记忆检索流程' },
  { id: 'web-search', label: '网络搜索', description: '网络搜索流程' },
  { id: 'anki', label: 'Anki 制卡', description: 'Anki 卡片生成' },
  { id: 'workspace', label: '工作区', description: '工作区操作' },
  { id: 'ask-user', label: '用户交互', description: '用户交互流程' },
  { id: 'tool-error', label: '工具错误', description: '工具调用失败' },
  { id: 'api-error', label: 'API 错误', description: 'API 请求失败' },
  { id: 'abort', label: '用户中止', description: '用户中止流程' },
] as const;

type SceneId = typeof llmOutputScenes[number]['id'];

function getSceneFrames(sceneId: SceneId): LlmOutputPlaybackFrame[] {
  const base: LlmOutputPlaybackFrame[] = [
    { id: 'waiting', state: 'waiting', frameId: 'waiting', durationMs: 900 },
    { id: 'thinking', state: 'thinking', frameId: 'thinking-1', durationMs: 280, thinkingContent: llmOutputThinkingIntro },
    { id: 'thinking', state: 'thinking', frameId: 'thinking-2', durationMs: 520, thinkingContent: llmOutputThinkingCopy },
  ];

  const contentIntro: LlmOutputPlaybackFrame[] = [
    { id: 'content-intro', state: 'content', frameId: 'content-intro-1', durationMs: 220, thinkingContent: llmOutputThinkingCopy, introContent: '我会先按当前 Chat V2 的真实状态机收口：' },
    { id: 'content-intro', state: 'content', frameId: 'content-intro-2', durationMs: 260, thinkingContent: llmOutputThinkingCopy, introContent: '我会先按当前 Chat V2 的真实状态机收口：首包前只显示等待点，' },
    { id: 'content-intro', state: 'content', frameId: 'content-intro-3', durationMs: 320, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent },
  ];

  const getToolFrames = (toolType: BlockType, toolName: string, toolInput: Record<string, unknown>, toolOutput?: unknown): LlmOutputPlaybackFrame[] => [
    {
      id: `tool-${toolType === 'mcp_tool' ? 'mcp' : toolType.replace('_', '-')}` as LlmOutputPlaybackStepId,
      state: 'tool',
      frameId: `tool-${toolType}-running`,
      durationMs: 900,
      thinkingContent: llmOutputThinkingCopy,
      introContent: llmOutputIntroContent,
      toolStatus: 'running',
      toolType,
      toolName,
      toolInput,
    },
    {
      id: `tool-${toolType === 'mcp_tool' ? 'mcp' : toolType.replace('_', '-')}` as LlmOutputPlaybackStepId,
      state: 'tool',
      frameId: `tool-${toolType}-success`,
      durationMs: 500,
      thinkingContent: llmOutputThinkingCopy,
      introContent: llmOutputIntroContent,
      toolStatus: 'success',
      toolType,
      toolName,
      toolOutput,
    },
  ];

  const resumeAndEnd: LlmOutputPlaybackFrame[] = [
    { id: 'content-resume', state: 'content', frameId: 'content-resume-1', durationMs: 220, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'mcp_tool', toolName: 'search_docs', resumeContent: '工具阶段结束后，再继续正文；' },
    { id: 'content-resume', state: 'content', frameId: 'content-resume-2', durationMs: 300, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'mcp_tool', toolName: 'search_docs', resumeContent: llmOutputResumeAbortContent },
    { id: 'idle', state: 'idle', frameId: 'idle', durationMs: 1000, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'mcp_tool', toolName: 'search_docs', resumeContent: llmOutputResumeAbortContent },
  ];

  switch (sceneId) {
    case 'full':
      return [
        ...base,
        ...contentIntro,
        ...getToolFrames('mcp_tool', 'search_docs', { topic: 'chat-v2-output-states' }, { results: ['文档1', '文档2'] }),
        ...resumeAndEnd,
      ];

    case 'mcp-tool':
      return [
        ...base,
        ...getToolFrames('mcp_tool', 'search_docs', { topic: 'chat-v2-output-states' }, { results: ['文档1', '文档2'] }),
        ...resumeAndEnd,
      ];

    case 'image-gen':
      return [
        ...base,
        ...getToolFrames('image_gen', 'image_gen', { prompt: 'A beautiful sunset', size: '1024x1024' }, { url: 'https://example.com/image.png' }),
        ...resumeAndEnd,
      ];

    case 'rag':
      return [
        ...base,
        ...getToolFrames('rag', 'rag_search', { query: 'Chat V2 状态机', topK: 5 }, { sources: [{ title: '状态机文档', snippet: '...' }] }),
        ...resumeAndEnd,
      ];

    case 'memory':
      return [
        ...base,
        ...getToolFrames('memory', 'memory_search', { query: '用户偏好设置' }, { memories: ['用户喜欢简洁界面'] }),
        ...resumeAndEnd,
      ];

    case 'web-search':
      return [
        ...base,
        ...getToolFrames('web_search', 'web_search', { query: 'React best practices 2026' }, { results: [{ title: 'React 2026', url: 'https://example.com' }] }),
        ...resumeAndEnd,
      ];

    case 'anki':
      return [
        ...base,
        ...getToolFrames('anki_cards', 'anki_create', { front: '什么是状态机？', back: '状态机是...' }, { cardId: 'card_123', created: true }),
        ...resumeAndEnd,
      ];

    case 'workspace':
      return [
        ...base,
        ...getToolFrames('workspace_status', 'workspace_create', { name: '研究项目' }, { workspaceId: 'ws_123', created: true }),
        ...resumeAndEnd,
      ];

    case 'ask-user':
      return [
        ...base,
        ...getToolFrames('ask_user', 'ask_user', { question: '您想要哪种风格的界面？' }),
        { id: 'content-resume', state: 'content', frameId: 'content-resume-1', durationMs: 220, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'ask_user', toolName: 'ask_user', resumeContent: '收到用户回复后，继续正文；' },
        { id: 'content-resume', state: 'content', frameId: 'content-resume-2', durationMs: 300, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'ask_user', toolName: 'ask_user', resumeContent: llmOutputResumeAbortContent },
        { id: 'idle', state: 'idle', frameId: 'idle', durationMs: 1000, thinkingContent: llmOutputThinkingCopy, introContent: llmOutputIntroContent, toolStatus: 'success', toolType: 'ask_user', toolName: 'ask_user', resumeContent: llmOutputResumeAbortContent },
      ];

    case 'tool-error':
      return [
        ...base,
        ...contentIntro,
        {
          id: 'tool-error',
          state: 'error',
          frameId: 'tool-error',
          durationMs: 800,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          toolStatus: 'error',
          toolType: 'mcp_tool',
          toolName: 'search_docs',
          toolInput: { topic: 'error-test' },
          error: '工具调用失败：API 超时',
        },
        { id: 'idle', state: 'idle', frameId: 'idle', durationMs: 1000 },
      ];

    case 'api-error':
      return [
        ...base,
        ...contentIntro,
        {
          id: 'error',
          state: 'error',
          frameId: 'error-api',
          durationMs: 1000,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          error: 'API 请求失败：429 Too Many Requests',
        },
        { id: 'idle', state: 'idle', frameId: 'idle', durationMs: 1000 },
      ];

    case 'abort':
      return [
        ...base,
        ...contentIntro,
        ...getToolFrames('mcp_tool', 'search_docs', { topic: 'chat-v2-output-states' }, { results: ['文档1', '文档2'] }),
        {
          id: 'content-resume',
          state: 'content',
          frameId: 'content-resume-1',
          durationMs: 220,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          toolStatus: 'success',
          toolType: 'mcp_tool',
          toolName: 'search_docs',
          resumeContent: '工具阶段结束后，再继续正文；',
        },
        {
          id: 'content-resume',
          state: 'content',
          frameId: 'content-resume-2',
          durationMs: 300,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          toolStatus: 'success',
          toolType: 'mcp_tool',
          toolName: 'search_docs',
          resumeContent: llmOutputResumeAbortContent,
        },
        {
          id: 'aborting',
          state: 'aborting',
          frameId: 'aborting',
          durationMs: 900,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          toolStatus: 'success',
          toolType: 'mcp_tool',
          toolName: 'search_docs',
          resumeContent: llmOutputResumeAbortContent,
        },
        {
          id: 'idle',
          state: 'idle',
          frameId: 'idle',
          durationMs: 1000,
          thinkingContent: llmOutputThinkingCopy,
          introContent: llmOutputIntroContent,
          toolStatus: 'success',
          toolType: 'mcp_tool',
          toolName: 'search_docs',
          resumeContent: llmOutputResumeAbortContent,
        },
      ];

    default:
      return llmOutputPlaybackFrames;
  }
}

function LlmOutputPlayback() {
  const [selectedScene, setSelectedScene] = React.useState<SceneId>('full');
  const [playbackIndex, setPlaybackIndex] = React.useState(-1);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const timeoutRef = React.useRef<number | null>(null);
  const store = React.useMemo(() => {
    const nextStore = createChatStore('style-lab-llm-output-playback');
    nextStore.setState(buildLlmOutputPlaybackState('ready'));
    return nextStore;
  }, []);

  const frames = React.useMemo(() => getSceneFrames(selectedScene), [selectedScene]);
  const currentFrame = playbackIndex >= 0 ? frames[playbackIndex] : null;
  const currentState = currentFrame?.state ?? 'ready';
  const currentStepId = currentFrame?.id ?? 'ready';
  const currentFrameId = currentFrame?.frameId ?? 'ready';
  const currentStepLabel = llmOutputPlaybackStepLabels[currentStepId];
  const isFinished = currentStepId === 'idle' && !isPlaying;
  const canStepForward = playbackIndex < frames.length - 1;
  const canStepBack = playbackIndex > 0;

  const clearPlaybackTimer = React.useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startPlayback = React.useCallback(() => {
    clearPlaybackTimer();
    setPlaybackIndex(0);
    setIsPlaying(true);
  }, [clearPlaybackTimer]);

  const resetPlayback = React.useCallback(() => {
    clearPlaybackTimer();
    setPlaybackIndex(-1);
    setIsPlaying(false);
  }, [clearPlaybackTimer]);

  const stepForward = React.useCallback(() => {
    clearPlaybackTimer();
    setIsPlaying(false);
    setPlaybackIndex((prev) => Math.min(prev + 1, frames.length - 1));
  }, [clearPlaybackTimer, frames.length]);

  const stepBackward = React.useCallback(() => {
    clearPlaybackTimer();
    setIsPlaying(false);
    setPlaybackIndex((prev) => Math.max(prev - 1, 0));
  }, [clearPlaybackTimer]);

  const handleSceneChange = React.useCallback((sceneId: SceneId) => {
    clearPlaybackTimer();
    setSelectedScene(sceneId);
    setPlaybackIndex(-1);
    setIsPlaying(false);
  }, [clearPlaybackTimer]);

  React.useEffect(() => {
    store.setState(buildLlmOutputPlaybackState(currentFrame ?? 'ready'));
  }, [currentFrame, store]);

  React.useEffect(() => {
    if (!isPlaying || playbackIndex < 0) return;

    const frame = frames[playbackIndex];
    if (!frame) return;

    if (playbackIndex >= frames.length - 1) {
      setIsPlaying(false);
      return;
    }

    timeoutRef.current = window.setTimeout(() => {
      const nextIndex = playbackIndex + 1;
      setPlaybackIndex(nextIndex);
      if (nextIndex >= frames.length - 1) {
        setIsPlaying(false);
      }
    }, frame.durationMs);

    return clearPlaybackTimer;
  }, [clearPlaybackTimer, isPlaying, playbackIndex, frames]);

  // 键盘快捷键支持
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 忽略输入框中的按键事件
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          if (isPlaying) {
            clearPlaybackTimer();
            setIsPlaying(false);
          } else {
            startPlayback();
          }
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (canStepBack && !isPlaying) {
            stepBackward();
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (canStepForward && !isPlaying) {
            stepForward();
          }
          break;
        case 'r':
          event.preventDefault();
          resetPlayback();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, canStepBack, canStepForward, clearPlaybackTimer, startPlayback, stepBackward, stepForward, resetPlayback]);

  return (
    <section
      className="llm-output-playback"
      data-current-frame={currentFrameId}
      data-current-state={currentState}
      data-current-step={currentStepId}
    >
      <div className="llm-output-playback__header">
        <div className="llm-output-playback__header-meta">
          <div className="llm-output-playback__title">
            <h3>真实输出回放</h3>
            <p>覆盖所有 LLM 输出场景：文本生成、工具调用、错误处理、用户中止等。</p>
          </div>
          <div className="llm-output-playback__status">
            <Badge
              variant="outline"
              className="border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] text-[color:var(--text-secondary)]"
            >
              {currentStepLabel}
            </Badge>
            <span className="llm-output-playback__text">
              帧 {playbackIndex + 1} / {frames.length}
            </span>
          </div>
        </div>

        {/* Scene selector */}
        <div className="llm-output-playback__scenes">
          <p className="llm-output-playback__scenes-label">场景选择：</p>
          <div className="llm-output-playback__scenes-grid">
            {llmOutputScenes.map((scene) => (
              <NotionButton
                key={scene.id}
               
                variant={selectedScene === scene.id ? 'primary' : 'ghost'}
                onClick={() => handleSceneChange(scene.id)}
                className="llm-output-playback__scene-btn"
              >
                {scene.label}
              </NotionButton>
            ))}
          </div>
        </div>

        <div className="llm-output-playback__actions">
          <NotionButton
           
            variant="ghost"
            onClick={stepBackward}
            disabled={!canStepBack || isPlaying}
          >
            <RotateCcw className="size-3.5" />
            上一步
          </NotionButton>
          <NotionButton
           
            variant="primary"
            onClick={isPlaying ? clearPlaybackTimer : startPlayback}
          >
            {isPlaying ? (
              <>
                <Square className="size-3.5" />
                暂停
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                {isFinished ? '重新回放' : '开始回放'}
              </>
            )}
          </NotionButton>
          <NotionButton
           
            variant="ghost"
            onClick={stepForward}
            disabled={!canStepForward || isPlaying}
          >
            下一步
            <RotateCcw className="size-3.5 rotate-180" />
          </NotionButton>
          <NotionButton
           
            variant="ghost"
            onClick={resetPlayback}
            disabled={playbackIndex < 0 && !isPlaying}
          >
            <RotateCcw className="size-3.5" />
            重置
          </NotionButton>
        </div>
      </div>

      <div className="llm-output-playback__stage">
        <LlmOutputPlaybackBody stepId={currentStepId} store={store} />
      </div>
    </section>
  );
}

function LlmOutputStyleLab() {
  return (
    <div className="space-y-4">
      <style>{llmOutputDemoCss}</style>
      <SectionHeader
        icon={Bot}
        title="LLM 输出真实回放"
        description="这里不再拆假状态卡，只保留一条真实消息的自动回放，直接对照当前 Chat V2 的实际输出状态。"
      />

      <LlmOutputPlayback />
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
          <NotionButton variant="ghost" onClick={copyButtonSummary} aria-label="复制 Button 调试配置">
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
              <Switch checked={disabledSamples} onCheckedChange={setDisabledSamples} aria-label="切换 Button 禁用态" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Icon only</span>
              <Switch checked={iconOnlySamples} onCheckedChange={setIconOnlySamples} aria-label="切换 Button 图标态" />
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

const toastVisualClassByType: Record<GlobalNotificationType, string> = {
  success: 'unified-notification-success',
  warning: 'unified-notification-warning',
  error: 'unified-notification-error',
  info: 'unified-notification-neutral',
};

const toastVisualLabelByType: Record<GlobalNotificationType, string> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  info: 'info -> neutral',
};

const toastButtonVariantByType: Record<GlobalNotificationType, 'success' | 'warning' | 'danger' | 'default'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  info: 'default',
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
          {sample.borderTone === 'neutral' ? 'neutral border' : toastVisualLabelByType[sample.type]}
        </Badge>
      </div>
      <div className="flex min-h-12 items-center justify-center overflow-hidden rounded-md border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] px-2 py-3">
        <div
          className={cn(
            'unified-notification show',
            toastVisualClassByType[sample.type],
            sample.borderTone === 'neutral' && 'unified-notification-border-neutral'
          )}
          style={{ maxWidth: 'min(320px, 100%)', minWidth: 0, width: 'fit-content' }}
          aria-label={`${sample.label} preview`}
        >
          <div className="unified-notification-content">
            <div className="unified-notification-text">{displayText}</div>
            {showAction || sample.borderTone === 'neutral' ? (
              <NotionButton variant="ghost" className="unified-notification-action" tabIndex={-1}>
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
      'variants=success,warning,error,info->neutral,neutral-border',
    ].join('\n'));
  }, [longCopy, showAction]);

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Bell}
        title="统一 Toast 调试"
        description="在样式调试台里直接触发全局 UnifiedNotification，并把 success、warning、error、info-as-neutral 和黑色边变体放在同一个静态预览区；新方向参考 Codex 的顶部居中小圆条：单行短句、无状态 icon、右侧轻量关闭入口，用边框表达状态。"
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
          <NotionButton variant="ghost" onClick={copyToastSummary} aria-label="复制 Toast 调试配置">
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
              <Switch checked={showAction} onCheckedChange={setShowAction} aria-label="切换 Toast 操作按钮" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Long copy</span>
              <Switch checked={longCopy} onCheckedChange={setLongCopy} aria-label="切换 Toast 长文案" />
            </label>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <NotionButton variant="default" onClick={triggerSequence}>
            连续触发四种 toast
          </NotionButton>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">静态状态预览</h3>
            <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">
              这些预览复用 <code>.unified-notification</code> 和状态类，便于不用等待动画也能比较三种状态色、info-neutral 和黑色边 toast 的实际外观。
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
          <Switch checked={checked} onCheckedChange={setChecked} aria-label="Radix shadcn switch library sample" />
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
          <NotionButton variant="ghost" onClick={copySwitchSummary} aria-label="复制 Switch 调试配置">
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
              <Switch checked={checkedSamples} onCheckedChange={setCheckedSamples} aria-label="切换 Switch 选中态" />
            </label>
            <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
              <span className="min-w-0 text-sm text-[color:var(--text-primary)]">Disabled</span>
              <Switch checked={disabledSamples} onCheckedChange={setDisabledSamples} aria-label="切换 Switch 禁用态" />
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
            <Switch checked={checkedSamples} onCheckedChange={setCheckedSamples} disabled={disabledSamples} aria-label="shad Switch token sample" />
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
                <Switch checked={Boolean(checked)} disabled={Boolean(disabled)} aria-label={`${label} Switch state sample`} />
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
  priority,
  children,
}: {
  title: string;
  signal: string;
  priority: 'high' | 'medium' | 'low';
  children: React.ReactNode;
}) {
  const priorityConfig = {
    high: { label: '高优先', className: 'border-[color:hsl(var(--destructive)/0.3)] bg-[color:hsl(var(--destructive)/0.1)] text-[color:hsl(var(--destructive))]' },
    medium: { label: '中优先', className: 'border-[color:hsl(var(--warning)/0.3)] bg-[color:hsl(var(--warning)/0.1)] text-[color:hsl(var(--warning))]' },
    low: { label: '低优先', className: 'border-[color:hsl(var(--success)/0.3)] bg-[color:hsl(var(--success)/0.1)] text-[color:hsl(var(--success))]' },
  }[priority];

  return (
    <section className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-4">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
            <span className={cn('inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none', priorityConfig.className)}>
              {priorityConfig.label}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[color:var(--text-secondary)]">{signal}</p>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function EntryRow({
  entry,
  onMarkCleaned,
  cleanedEntries,
}: {
  entry: RepeatedEntry;
  onMarkCleaned: (name: string) => void;
  cleanedEntries: Set<string>;
}) {
  const isCleaned = cleanedEntries.has(entry.name);
  return (
    <div className={cn('flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-xs', isCleaned
      ? 'border-[color:hsl(var(--success)/0.24)] bg-[color:hsl(var(--success)/0.06)] opacity-60'
      : 'border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)]'
    )}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate font-medium', isCleaned ? 'text-[color:hsl(var(--success))] line-through' : 'text-[color:var(--text-primary)]')}>
            {entry.name}
          </span>
          {isCleaned && <CheckCircle2 className="size-3 shrink-0 text-[color:hsl(var(--success))]" />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[color:var(--text-secondary)]">
          <span className="inline-flex items-center gap-1" title="文件路径">
            <ExternalLink className="size-3 shrink-0" />
            <span className="max-w-[200px] truncate">{entry.filePath}</span>
          </span>
          {entry.refs > 0 && <span>{entry.refs} refs</span>}
          {entry.files > 0 && <span>{entry.files} files</span>}
          {entry.imports > 0 && <span>{entry.imports} imports</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {!isCleaned && (
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onMarkCleaned(entry.name)}
          >
            标记已清理
          </NotionButton>
        )}
      </div>
    </div>
  );
}

function RepeatedComponentPreviews() {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [priorityFilter, setPriorityFilter] = React.useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [cleanedEntries, setCleanedEntries] = React.useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('style-lab-cleaned-entries');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const handleMarkCleaned = React.useCallback((name: string) => {
    setCleanedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      try {
        localStorage.setItem('style-lab-cleaned-entries', JSON.stringify([...next]));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const filteredGroups = React.useMemo(() => {
    return repeatedComponentData.filter((group) => {
      if (priorityFilter !== 'all' && group.priority !== priorityFilter) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      if (group.title.toLowerCase().includes(q)) return true;
      if (group.signal.toLowerCase().includes(q)) return true;
      return group.lanes.some((lane) =>
        lane.entries.some((entry) =>
          entry.name.toLowerCase().includes(q) || entry.filePath.toLowerCase().includes(q)
        )
      );
    });
  }, [searchQuery, priorityFilter]);

  const totalEntries = React.useMemo(() =>
    repeatedComponentData.reduce((sum, g) => sum + g.lanes.reduce((s, l) => s + l.entries.length, 0), 0),
    []
  );
  const totalCleaned = cleanedEntries.size;

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Layers3}
        title="重复组件预览"
        description="每组都把推荐统一入口、当前混用入口、旧写法样本放在同一行，方便直接比较尺寸、圆角、颜色语义、密度和交互状态。"
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel-strong)] p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--text-secondary)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索组件名、文件路径…"
            className="h-8 w-full rounded-md border border-[color:var(--input-shell-border)] bg-[color:var(--input-shell-surface)] pl-8 pr-3 text-xs text-[color:var(--text-primary)] placeholder:text-[color:var(--text-secondary)] focus:outline-none focus:ring-1 focus:ring-[color:var(--button-primary-bg)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="size-3.5 text-[color:var(--text-secondary)]" />
          {(['all', 'high', 'medium', 'low'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPriorityFilter(p)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                priorityFilter === p
                  ? 'bg-[color:var(--button-primary-bg)] text-[color:var(--button-primary-fg)]'
                  : 'text-[color:var(--text-secondary)] hover:bg-[color:var(--button-utility-surface)]'
              )}
            >
              {p === 'all' ? '全部' : p === 'high' ? '高优先' : p === 'medium' ? '中优先' : '低优先'}
            </button>
          ))}
        </div>
        <div className="ml-auto text-xs text-[color:var(--text-secondary)]">
          已清理 <span className="font-semibold text-[color:hsl(var(--success))]">{totalCleaned}</span> / {totalEntries} 项
        </div>
      </div>

      {filteredGroups.length === 0 && (
        <div className="rounded-lg border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root)] p-8 text-center text-sm text-[color:var(--text-secondary)]">
          没有匹配的重复组件组。
        </div>
      )}

      {filteredGroups.map((group) => (
        <RepeatedPreviewGroup key={group.title} title={group.title} signal={group.signal} priority={group.priority}>
          {group.lanes.map((lane) => (
            <PreviewLane key={lane.label} label={lane.label} tone={lane.tone}>
              {lane.entries.length === 0 ? (
                <p className="text-xs text-[color:var(--text-secondary)]">暂无数据</p>
              ) : (
                <div className="space-y-1.5">
                  {lane.entries.map((entry) => (
                    <EntryRow key={entry.name} entry={entry} onMarkCleaned={handleMarkCleaned} cleanedEntries={cleanedEntries} />
                  ))}
                </div>
              )}
              {lane.hint && <p className="mt-2 text-xs text-[color:var(--text-secondary)]">{lane.hint}</p>}
            </PreviewLane>
          ))}
        </RepeatedPreviewGroup>
      ))}
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
            <TabsTrigger value="llm-output">LLM 输出</TabsTrigger>
            <TabsTrigger value="transitions">Transition 动效</TabsTrigger>
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

          <TabsContent value="llm-output" className="space-y-4">
            <LlmOutputStyleLab />
          </TabsContent>

          <TabsContent value="transitions" className="space-y-4">
            <TransitionStyleLab />
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
